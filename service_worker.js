import {
  DEFAULT_SETTINGS,
  generateCopilotGoals,
  generateCopilotReply,
  generateWakeLine,
  normalizeMemory,
  normalizeGoalRequest,
  normalizeRequest,
  normalizeSettings,
  normalizeApiKey,
  rewriteReply,
  sanitizeScalar,
  sanitizeText,
  stripSecretSettings,
  testAiConnection
} from "./ai_service.js";

const STORAGE = {
  settings: "es_settings",
  memory: "es_memory",
  diagnostics: "es_diagnostics",
  apiKey: "es_api_key",
  favorites: "es_favorites"
};

const PRUNE_ALARM = "es_prune_memory";
const BACKEND_TOKEN_FILE = "backend-proxy/es-backend-token.txt";
const OPERATOR_HUB_URL = "https://127.0.0.1:8789/v1/operator/events";
const OPERATOR_COMMAND_BASE_URL = "https://127.0.0.1:8789/v1/operator/commands";
const OPERATOR_COMMAND_POLL_MS = 1250;
const OPERATOR_COMMAND_MAX_AGE_MS = 2 * 60 * 1000;
const OPERATOR_SYNC_ERROR_COOLDOWN_MS = 60 * 1000;
const VIEWER_TTL_MS = 90 * 60 * 1000;
const FAVORITE_LIMIT = 50;
const DEFAULT_MEMORY = {
  summary: "",
  turns: [],
  viewers: {},
  generated: [],
  lastPrunedAt: 0
};
let backendTokenPromise;
let memoryMutationQueue = Promise.resolve();
let lastOperatorSyncErrorAt = 0;
let operatorCommandPollTimer = 0;
let operatorCommandPollInFlight = false;
const roomPanelPorts = new Set();

chrome.runtime.onInstalled.addListener(() => {
  initializeExtension();
});

chrome.runtime.onStartup.addListener(() => {
  initializeExtension();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PRUNE_ALARM) {
    pruneAndPersistMemory().catch((error) => logDiagnostic("prune_error", error.message));
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && changes[STORAGE.settings]) {
    broadcastToTabs({
      type: "SETTINGS_CHANGED",
      settings: stripSecretSettings(normalizeSettings(changes[STORAGE.settings].newValue || {}))
    });
    refreshOperatorCommandPolling();
  }
  if (areaName === "sync" && changes[STORAGE.favorites]) {
    const favorites = (Array.isArray(changes[STORAGE.favorites].newValue)
      ? changes[STORAGE.favorites].newValue
      : []
    )
      .map(normalizeFavorite)
      .filter((item) => item.text)
      .slice(-FAVORITE_LIMIT);
    broadcastToTabs({ type: "FAVORITES_CHANGED", favorites });
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "es-room-panel") return;

  roomPanelPorts.add(port);
  refreshOperatorCommandPolling();
  port.postMessage({ type: "PORT_READY", at: Date.now() });
  port.onDisconnect.addListener(() => {
    roomPanelPorts.delete(port);
    if (!roomPanelPorts.size) stopOperatorCommandPolling();
  });
  port.onMessage.addListener((message) => {
    handleMessage(message, port.sender)
      .then((response) => port.postMessage({ type: "PORT_RESPONSE", requestId: message?.requestId, response }))
      .catch((error) =>
        port.postMessage({
          type: "PORT_RESPONSE",
          requestId: message?.requestId,
          response: { ok: false, error: error.message || String(error) }
        })
      );
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      logDiagnostic("message_error", error.message || String(error));
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

async function initializeExtension() {
  await restrictSessionStorage();
  const settings = await getSettings();
  await setSettings(settings);
  const memory = await getMemory();
  await setMemory(pruneMemory(memory, settings));
  await ensurePruneAlarm();
}

async function handleMessage(message = {}, sender = {}) {
  const type = message.type || message.action || "";
  const availabilityError = await enforceActionAvailability(type);
  if (availabilityError) return availabilityError;

  if (type === "GET_STATE") {
    const [settings, memory, diagnostics, favorites] = await Promise.all([
      getSettings(),
      getMemory(),
      getDiagnostics(),
      getFavorites()
    ]);
    return {
      ok: true,
      settings: stripSecretSettings(settings),
      hasApiKey: Boolean(settings.apiKey),
      memory: summarizeMemory(memory),
      diagnostics: diagnostics.slice(-12),
      favorites
    };
  }

  if (type === "SAVE_SETTINGS") {
    const settings = await saveSettings(message.settings || {}, message.apiKey ?? undefined);
    await logDiagnostic("settings_saved", `Mode: ${settings.aiMode}`);
    const response = { ok: true, settings: stripSecretSettings(settings), hasApiKey: Boolean(settings.apiKey) };
    await broadcastToTabs({ type: "SETTINGS_CHANGED", ...response });
    await refreshOperatorCommandPolling();
    return response;
  }

  if (type === "TEST_CONNECTION") {
    const settings = await getSettings({ includeSecret: true });
    const result = await testAiConnection(await withBackendAuth(settings));
    await logDiagnostic("connection_test", result.message, {
      source: result.source,
      requestId: result.requestId || ""
    });
    return result;
  }

  if (type === "GENERATE") {
    return generateAndRemember(message.request || {}, sender, message.meta || {});
  }

  if (type === "RECORD_TURN") {
    const turn = await recordTurn(message.turn || {}, sender);
    return { ok: true, turn };
  }

  if (type === "RECORD_TURNS") {
    const turns = await recordTurns(message.turns || [], sender);
    return { ok: true, turns, memory: summarizeMemory(await getMemory()) };
  }

  if (type === "RESET_MEMORY") {
    await withMemoryMutation(() => setMemory({ ...DEFAULT_MEMORY }));
    await logDiagnostic("memory_reset", "Live room memory was reset.");
    broadcastToTabs({ type: "MEMORY_CHANGED", memory: summarizeMemory(DEFAULT_MEMORY) });
    return { ok: true, memory: summarizeMemory(DEFAULT_MEMORY) };
  }

  if (type === "PRUNE_MEMORY") {
    const memory = await pruneAndPersistMemory();
    return { ok: true, memory: summarizeMemory(memory) };
  }

  if (type === "GOALS") {
    return generateGoalsAndRemember(message.payload || {}, sender);
  }

  if (type === "ROOM_TOPIC") {
    return generateRoomTopicsAndRemember(message.payload || {}, sender);
  }

  if (type === "WAKE_LINE") {
    return generateQuickLineAndRemember("wake_line", message.payload || {}, sender);
  }

  if (type === "TIP_REACTION") {
    return generateQuickLineAndRemember("tip_reaction", message.payload || {}, sender);
  }

  if (type === "QUICK_CHALLENGES") {
    return generateQuickLinesAndRemember("quick_challenges", message.payload || {}, sender);
  }

  if (type === "TOGGLE_FAVORITE") {
    return toggleFavorite(message.favorite || {});
  }

  if (type === "CLEAR_FAVORITES") {
    await setFavorites([]);
    await logDiagnostic("favorites_cleared", "Saved lines were cleared.");
    return { ok: true, favorites: [] };
  }

  if (type === "REWRITE_REPLY") {
    return {
      ok: true,
      text: rewriteReply(message.text || "", message.mode || "shorter")
    };
  }

  if (type === "INJECT_ACTIVE_TAB") {
    return injectActiveTab();
  }

  if (type === "OPEN_OPTIONS") {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }

  if (type === "CONNECT_DASHBOARD") {
    return enableOperatorBridgeAndOpenDashboard();
  }

  if (type === "SMART_COPILOT" || type === "GET_SMART_SUGGESTIONS") {
    return getSmartCopilotSuggestions(message.payload || {}, sender);
  }

  if (type === "COPILOT_QUERY") {
    return getSmartCopilotSuggestions({ query: message.query || message.payload?.query }, sender);
  }

  return { ok: false, error: `Unknown message type: ${type || "missing"}` };
}

async function generateAndRemember(requestInput, sender, meta = {}) {
  const settings = await withBackendAuth(await getSettings({ includeSecret: true }));
  const memory = await getMemory();
  const request = normalizeRequest({
    ...requestInput,
    source: requestInput.source || sender?.tab?.url || "manual"
  });

  if (request.message) {
    await recordTurn(
      {
        viewer: request.viewerName || viewerFromType(request.viewerType),
        text: request.message,
        kind: request.intent,
        source: request.source
      },
      sender
    );
  }

  const freshMemory = await getMemory();
  const result = await generateCopilotReply(request, {
    settings,
    memory: freshMemory,
    meta
  });

  const generated = (result.replies || []).map((text) => ({
    id: crypto.randomUUID(),
    kind: "reply",
    text: sanitizeText(text, 300),
    intent: request.intent,
    tone: request.tone,
    source: result.source,
    ts: Date.now()
  }));
  const memorySummary = await withMemoryMutation(async () => {
    const nextMemory = await getMemory();
    nextMemory.generated = [...(nextMemory.generated || []), ...generated].slice(-120);
    const pruned = pruneMemory(nextMemory, settings);
    await setMemory(pruned);
    return summarizeMemory(pruned);
  });

  await logDiagnostic("generate", `Generated ${generated.length} replies via ${result.source}.`, {
    source: result.source,
    requestId: result.diagnostics?.requestId || "",
    promptTokens: result.diagnostics?.promptTokens || 0,
    fallbackReason: result.diagnostics?.fallbackReason || ""
  });

  const payload = {
    ok: true,
    replies: result.replies,
    source: result.source,
    diagnostics: result.diagnostics || {},
    memory: memorySummary
  };
  return payload;
}

async function generateGoalsAndRemember(payloadInput, sender = {}) {
  const settings = await withBackendAuth(await getSettings({ includeSecret: true }));
  const memory = await getMemory();
  const latestTurn = memory.turns?.[memory.turns.length - 1];
  const request = normalizeGoalRequest({
    ...payloadInput,
    latestMessage: payloadInput.latestMessage || latestTurn?.text || "",
    roomMood: payloadInput.roomMood || memory.summary || ""
  });

  const result = await generateCopilotGoals(request, {
    settings,
    memory,
    meta: { source: sender?.tab?.url || "manual" }
  });

  const generated = (result.goals || []).flatMap((goal) => [
    {
      id: crypto.randomUUID(),
      kind: "goal",
      name: sanitizeText(goal.name, 80),
      text: sanitizeText(`${goal.name} ${goal.description} ${goal.chat_line || ""}`, 520),
      amount: goal.amount,
      theme: request.theme,
      style: request.style,
      source: result.source,
      ts: Date.now()
    }
  ]);
  const memorySummary = await withMemoryMutation(async () => {
    const nextMemory = await getMemory();
    nextMemory.generated = [...(nextMemory.generated || []), ...generated].slice(-160);
    const pruned = pruneMemory(nextMemory, settings);
    await setMemory(pruned);
    return summarizeMemory(pruned);
  });

  await logDiagnostic("goals", `Generated ${generated.length} goals via ${result.source}.`, {
    source: result.source,
    requestId: result.diagnostics?.requestId || "",
    promptTokens: result.diagnostics?.promptTokens || 0,
    fallbackReason: result.diagnostics?.fallbackReason || ""
  });

  const response = {
    ok: true,
    goals: result.goals,
    source: result.source,
    diagnostics: result.diagnostics || {},
    memory: memorySummary
  };
  return response;
}

async function generateRoomTopicsAndRemember(payloadInput = {}, sender = {}) {
  const settings = await withBackendAuth(await getSettings({ includeSecret: true }));
  const memory = await getMemory();
  const latestTurn = memory.turns?.[memory.turns.length - 1];
  const brief = sanitizeText(payloadInput.brief || payloadInput.roomMood || memory.summary || "", 500);
  const style = sanitizeScalar(payloadInput.style || "stream_title", 40);
  const tone = sanitizeScalar(payloadInput.tone || "playful", 40);
  const latestMessage = sanitizeText(payloadInput.latestMessage || latestTurn?.text || "", 300);
  let topics = [];
  let source = "local";
  let diagnostics = {};

  if (settings.aiMode !== "local") {
    const request = normalizeRequest({
      message: [brief, latestMessage].filter(Boolean).join(" | "),
      viewerType: "registered",
      intent: "keep_chat",
      tone,
      instruction: roomTopicInstruction(style),
      source: "room_topic"
    });
    const result = await generateCopilotReply(request, {
      settings,
      memory,
      meta: { source: sender?.tab?.url || "manual", roomTopic: style }
    });
    source = result.source || "local";
    diagnostics = result.diagnostics || {};
    topics = (result.replies || []).map((item) => sanitizeText(item, 90)).filter(Boolean).slice(0, 3);
  }

  if (!topics.length) {
    topics = localRoomTopics({ brief, style, tone, latestMessage });
    source = "local";
  }

  const memorySummary = await withMemoryMutation(async () => {
    const nextMemory = await getMemory();
    nextMemory.generated = [
      ...(nextMemory.generated || []),
      ...topics.map((text) => ({
        id: crypto.randomUUID(),
        kind: "topic",
        type: style,
        text,
        tone,
        source,
        ts: Date.now()
      }))
    ].slice(-160);
    const pruned = pruneMemory(nextMemory, settings);
    await setMemory(pruned);
    return summarizeMemory(pruned);
  });

  await logDiagnostic("room_topic", `Generated ${topics.length} room topics via ${source}.`, {
    source,
    requestId: diagnostics.requestId || "",
    promptTokens: diagnostics.promptTokens || 0,
    fallbackReason: diagnostics.fallbackReason || ""
  });

  return {
    ok: true,
    topics,
    source,
    diagnostics,
    memory: memorySummary
  };
}

function roomTopicInstruction(style) {
  const styleLabel = {
    stream_title: "stream room titles",
    room_topic: "room topic lines",
    game_title: "game-and-chat stream titles",
    goal_title: "token goal titles"
  }[style] || "stream room titles";
  return [
    `Create exactly three ${styleLabel}.`,
    "Each option must read like a title, not a chat prompt, question, reaction, or sentence to viewers.",
    "Use headline casing or clean title casing.",
    "Each option must be short enough for a public StripChat title or room topic.",
    "Use the current room mood and creator persona.",
    "Do not write tip reactions or thank-you lines.",
    "Do not ask questions.",
    "Avoid generic filler. Make each option distinct, useful, and paste-ready.",
    "Keep wording adult-only, platform-safe, non-graphic, and consensual."
  ].join(" ");
}

function localRoomTopics({ brief = "", style = "stream_title", latestMessage = "" } = {}) {
  const context = titleCase(cleanTitleContext(brief || latestMessage || ""));
  if (style === "goal_title") {
    return [
      "Warm Up the Room",
      "Control the Vibe",
      "Final Room Focus"
    ];
  }
  if (style === "game_title") {
    return [
      "Call of Duty & Chill",
      "Shy Gamer, Flirty Vibes",
      "Distract Me While I Play"
    ];
  }
  if (style === "room_topic") {
    return [
      context ? `${context} Night` : "Soft Start, Flirty Room",
      "Shy Start, Warm Vibes",
      "Playful Room Energy"
    ];
  }
  return [
    context ? `${context} Live` : "Call of Duty & Chill",
    "Shy Start, Flirty Finish",
    "Interactive Chill Night"
  ];
}

function cleanTitleContext(value = "") {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[^\w\s&'-]/g, " ")
    .replace(/\b(example|tonight|today|later|room|topic|title|please|make|build)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 42);
}

function titleCase(value = "") {
  const lowerWords = new Set(["and", "or", "the", "a", "an", "to", "of", "for", "in"]);
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && lowerWords.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

async function generateQuickLineAndRemember(kind, payloadInput = {}, sender = {}) {
  const response = await generateQuickLinesAndRemember(kind, payloadInput, sender);
  return {
    ...response,
    text: response.lines?.[0] || ""
  };
}

async function getSmartCopilotSuggestions(payload = {}, sender = {}) {
  const settings = await withBackendAuth(await getSettings({ includeSecret: true }));
  const memory = await getMemory();

  const result = await generateSmartCopilot(payload, {
    settings,
    memory
  });

  // Record the copilot interaction for deeper future memory
  if (payload.query) {
    await withMemoryMutation(async () => {
      const next = await getMemory();
      next.generated = [...(next.generated || []), {
        id: crypto.randomUUID(),
        kind: "copilot",
        text: payload.query,
        ts: Date.now()
      }].slice(-80);
      await setMemory(pruneMemory(next, settings));
    });
  }

  await logDiagnostic("smart_copilot", `Smart copilot generated ${result.suggestions?.length || 0} suggestions`, {
    source: result.source,
    hasQuery: !!payload.query
  });

  return {
    ok: true,
    source: result.source,
    analysis: result.analysis,
    suggestions: result.suggestions || [],
    memory: summarizeMemory(await getMemory()),
    diagnostics: result.diagnostics || {}
  };
}

async function generateQuickLinesAndRemember(kind, payloadInput = {}, sender = {}) {
  const settings = await withBackendAuth(await getSettings({ includeSecret: true }));
  const memory = await getMemory();
  const latestTurn = memory.turns?.[memory.turns.length - 1];
  const payload = {
    ...payloadInput,
    amount: Number(payloadInput.amount || 0),
    viewerName: sanitizeScalar(payloadInput.viewerName || "", 60),
    viewerType: sanitizeScalar(payloadInput.viewerType || "registered", 50),
    tone: sanitizeScalar(payloadInput.tone || "playful", 50),
    message: sanitizeText(payloadInput.message || latestTurn?.text || "", 500)
  };

  let lines = [];
  let source = "local";
  let diagnostics = {};

  if (settings.aiMode !== "local") {
    const request = normalizeRequest({
      message: payload.message,
      viewerName: payload.viewerName,
      viewerType: payload.viewerType,
      intent: quickLineIntent(kind, payload),
      tone: payload.tone,
      amount: payload.amount,
      instruction: quickLineInstruction(kind, payload),
      source: "quick_line"
    });
    const result = await generateCopilotReply(request, {
      settings,
      memory,
      meta: { source: sender?.tab?.url || "manual", quickLine: kind }
    });
    lines = (result.replies || [])
      .map((text) => sanitizeText(text, 300))
      .filter(Boolean)
      .slice(0, kind === "quick_challenges" ? 3 : 1);
    source = result.source || "local";
    diagnostics = result.diagnostics || {};
  }

  if (!lines.length) {
    lines = localQuickLines(kind, payload);
    source = "local";
  }

  const memorySummary = await withMemoryMutation(async () => {
    const nextMemory = await getMemory();
    nextMemory.generated = [
      ...(nextMemory.generated || []),
      ...lines.map((text) => ({
        id: crypto.randomUUID(),
        kind: "quick_line",
        type: kind,
        text,
        tone: payload.tone,
        source,
        ts: Date.now()
      }))
    ].slice(-160);
    const pruned = pruneMemory(nextMemory, settings);
    await setMemory(pruned);
    return summarizeMemory(pruned);
  });

  await logDiagnostic("quick_line", `Generated ${lines.length} ${kind.replace(/_/g, " ")} line(s) via ${source}.`, {
    source,
    requestId: diagnostics.requestId || "",
    promptTokens: diagnostics.promptTokens || 0,
    fallbackReason: diagnostics.fallbackReason || ""
  });

  return {
    ok: true,
    lines,
    text: lines[0] || "",
    source,
    diagnostics,
    memory: memorySummary
  };
}

function quickLineIntent(kind, payload) {
  if (kind === "wake_line") return "wake_chat";
  if (kind === "tip_reaction") return "thank_tipper";
  if (kind === "quick_challenges") return "wake_chat";
  return "reply";
}

function quickLineInstruction(kind, payload) {
  if (kind === "wake_line") {
    return "Write room-wakeup lines for a slow chat. Make them magnetic, conversational, and easy to paste.";
  }
  if (kind === "tip_reaction") {
    return `Write a short public-room reaction for a ${payload.amount || "recent"} tk tip. Thank the viewer, keep the energy moving, and do not suggest private chat.`;
  }
  if (kind === "quick_challenges") {
    return "Write exactly three short public-room challenges that invite safe, consensual chat or tip-menu participation. Make each one distinct and easy to paste.";
  }
  return "Write paste-ready live-chat lines.";
}

function localQuickLines(kind, payload) {
  if (kind === "tip_reaction") {
    const viewer = sanitizeScalar(payload.viewerName || "", 60);
    const amount = Number(payload.amount || 0);
    return [
      `${viewer ? `${viewer}, ` : ""}${amount > 0 ? `${amount} tk got my attention` : "that tip got my attention"}. keep that room energy moving.`
    ];
  }
  if (kind === "quick_challenges") {
    return [
      "room challenge: pick the next vibe in three words.",
      "tiny tips choose it: chill, playful, or bold?",
      "wake-up round: make me laugh before the next goal moves."
    ];
  }
  return [generateWakeLine(payload)];
}

async function recordTurn(turnInput = {}, sender = {}) {
  const settings = await getSettings();
  const viewer = sanitizeScalar(
    turnInput.viewer || turnInput.viewerName || turnInput.author || "viewer",
    70
  );
  const text = sanitizeText(turnInput.text || turnInput.message || "", 700);
  const turn = {
    id: turnInput.id || crypto.randomUUID(),
    viewer,
    text,
    kind: sanitizeScalar(turnInput.kind || "chat", 40),
    source: sanitizeScalar(turnInput.source || sender?.tab?.url || "content", 300),
    ts: Number(turnInput.ts) || Date.now()
  };

  if (!turn.text) return turn;

  const memorySummary = await withMemoryMutation(async () => {
    const memory = await getMemory();
    memory.turns = [...(memory.turns || []), turn];
    const currentViewer = memory.viewers[viewer] || { count: 0, notes: [] };
    currentViewer.count = (currentViewer.count || 0) + 1;
    currentViewer.lastSeen = turn.ts;
    currentViewer.notes = [...(currentViewer.notes || []), turn.text].slice(-8);
    memory.viewers[viewer] = currentViewer;
    const pruned = pruneMemory(memory, settings);
    await setMemory(pruned);
    return summarizeMemory(pruned);
  });
  broadcastToTabs({ type: "MEMORY_CHANGED", memory: memorySummary });
  syncOperatorEvent(buildOperatorEvent(turn, memorySummary));
  return turn;
}

async function recordTurns(turnsInput = [], sender = {}) {
  const settings = await getSettings();
  const accepted = [];

  for (const turnInput of Array.isArray(turnsInput) ? turnsInput : []) {
    const viewer = sanitizeScalar(
      turnInput.viewer || turnInput.viewerName || turnInput.author || "viewer",
      70
    );
    const text = sanitizeText(turnInput.text || turnInput.message || "", 700);
    if (!text) continue;
    const turn = {
      id: turnInput.id || crypto.randomUUID(),
      viewer,
      text,
      kind: sanitizeScalar(turnInput.kind || "chat", 40),
      source: sanitizeScalar(turnInput.source || sender?.tab?.url || "content", 300),
      ts: Number(turnInput.ts) || Date.now()
    };
    accepted.push(turn);
  }

  if (!accepted.length) return [];
  const persistedTurns = [];
  const memorySummary = await withMemoryMutation(async () => {
    const memory = await getMemory();
    const knownIds = new Set((memory.turns || []).map((turn) => turn.id).filter(Boolean));
    for (const turn of accepted) {
      if (knownIds.has(turn.id)) continue;
      knownIds.add(turn.id);
      persistedTurns.push(turn);
      memory.turns = [...(memory.turns || []), turn];
      const currentViewer = memory.viewers[turn.viewer] || { count: 0, notes: [] };
      currentViewer.count = (currentViewer.count || 0) + 1;
      currentViewer.lastSeen = turn.ts;
      currentViewer.notes = [...(currentViewer.notes || []), turn.text].slice(-8);
      memory.viewers[turn.viewer] = currentViewer;
    }
    const pruned = pruneMemory(memory, settings);
    await setMemory(pruned);
    return summarizeMemory(pruned);
  });
  if (!persistedTurns.length) return [];
  broadcastToTabs({ type: "MEMORY_CHANGED", memory: memorySummary });
  const priorityTurns = persistedTurns.filter((turn) => /tip|return/i.test(turn.kind || ""));
  const operatorTurns = priorityTurns.length ? priorityTurns : [persistedTurns[persistedTurns.length - 1]];
  for (const turn of operatorTurns) {
    syncOperatorEvent(buildOperatorEvent(turn, memorySummary, persistedTurns.length));
  }
  return persistedTurns;
}

async function injectActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: "No active tab found." };
  if (!isAllowedStripChatUrl(tab.url)) {
    return { ok: false, error: "Open a StripChat page before opening the room panel." };
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["page_key_guard.js"],
    world: "MAIN"
  });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content_script.js"]
  });
  await chrome.tabs.sendMessage(tab.id, { type: "SHOW_OVERLAY" }).catch(() => null);
  return { ok: true, tabId: tab.id };
}

async function enableOperatorBridgeAndOpenDashboard() {
  const settings = await getSettings({ includeSecret: true });
  const nextSettings = normalizeSettings({
    ...settings,
    operatorBridgeEnabled: true
  });
  await setSettings(nextSettings);
  await refreshOperatorCommandPolling();
  await chrome.tabs.create({ url: "https://127.0.0.1:8789/dashboard" });
  const token = await getBackendAuthToken();
  await logDiagnostic("operator_bridge_enabled", token ? "Dashboard bridge enabled (token loaded from backend-proxy)." : "Dashboard bridge enabled (WARNING: backend-proxy/es-backend-token.txt missing or empty – bridge will fail until token file is present).");
  return {
    ok: true,
    settings: stripSecretSettings(nextSettings),
    operatorToken: token || ""
  };
}

async function withBackendAuth(settings) {
  const normalized = normalizeSettings(settings);
  if (normalized.aiMode !== "backend") return normalized;
  return {
    ...normalized,
    backendAuthToken: await getBackendAuthToken()
  };
}

async function getBackendAuthToken() {
  if (!backendTokenPromise) {
    backendTokenPromise = fetch(chrome.runtime.getURL(BACKEND_TOKEN_FILE))
      .then((response) => (response.ok ? response.text() : ""))
      .then((value) => normalizeApiKey(value))
      .catch(() => "");
  }
  return backendTokenPromise;
}

function isAllowedStripChatUrl(value = "") {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "stripchat.com" || url.hostname.endsWith(".stripchat.com"));
  } catch {
    return false;
  }
}

async function getSettings({ includeSecret = true } = {}) {
  const result = await chrome.storage.sync.get(STORAGE.settings);
  const settings = normalizeSettings(result[STORAGE.settings] || DEFAULT_SETTINGS);
  if (!includeSecret) return settings;

  const keyStores = await Promise.all([
    chrome.storage.session?.get(STORAGE.apiKey).catch(() => ({})) || {},
    chrome.storage.local.get(STORAGE.apiKey).catch(() => ({}))
  ]);
  const sessionKey = keyStores[0]?.[STORAGE.apiKey] || "";
  const localKey = keyStores[1]?.[STORAGE.apiKey] || "";
  return {
    ...settings,
    apiKey: settings.rememberApiKey ? localKey : sessionKey || localKey
  };
}

async function setSettings(settingsInput = {}) {
  const normalized = normalizeSettings(settingsInput);
  await chrome.storage.sync.set({ [STORAGE.settings]: stripSecretSettings(normalized) });
  return normalized;
}

async function saveSettings(settingsInput = {}, apiKeyValue) {
  const previous = await getSettings({ includeSecret: true });
  const normalized = normalizeSettings({ ...previous, ...settingsInput });
  await chrome.storage.sync.set({ [STORAGE.settings]: stripSecretSettings(normalized) });

  const nextApiKey =
    apiKeyValue !== undefined
      ? normalizeApiKey(apiKeyValue)
      : normalizeApiKey(previous.apiKey || "");
  const shouldMoveApiKey = apiKeyValue !== undefined || normalized.rememberApiKey !== previous.rememberApiKey;
  if (shouldMoveApiKey) {
    if (!nextApiKey) {
      await chrome.storage.session?.remove(STORAGE.apiKey).catch(() => null);
      await chrome.storage.local.remove(STORAGE.apiKey).catch(() => null);
    } else if (normalized.rememberApiKey) {
      await chrome.storage.local.set({ [STORAGE.apiKey]: nextApiKey });
      await chrome.storage.session?.remove(STORAGE.apiKey).catch(() => null);
    } else if (chrome.storage.session) {
      await chrome.storage.session.set({ [STORAGE.apiKey]: nextApiKey });
      await chrome.storage.local.remove(STORAGE.apiKey).catch(() => null);
    } else {
      await chrome.storage.local.set({ [STORAGE.apiKey]: nextApiKey });
    }
  }

  return getSettings();
}

async function getMemory() {
  const area = chrome.storage.session || chrome.storage.local;
  const result = await area.get(STORAGE.memory);
  return normalizeMemory({ ...DEFAULT_MEMORY, ...(result[STORAGE.memory] || {}) });
}

async function setMemory(memoryInput = {}) {
  const area = chrome.storage.session || chrome.storage.local;
  const memory = normalizeMemory({ ...DEFAULT_MEMORY, ...memoryInput });
  await area.set({ [STORAGE.memory]: memory });
  return memory;
}

function pruneMemory(memoryInput, settingsInput) {
  const settings = normalizeSettings(settingsInput);
  const memory = normalizeMemory(memoryInput);
  const turns = (memory.turns || []).slice(-settings.maxTurns);
  const generated = (memory.generated || []).slice(-160);
  const viewerCutoff = Date.now() - VIEWER_TTL_MS;
  const viewerEntries = Object.entries(memory.viewers || {})
    .filter(([, info]) => Number(info?.lastSeen || 0) >= viewerCutoff)
    .sort((a, b) => (b[1]?.lastSeen || 0) - (a[1]?.lastSeen || 0))
    .slice(0, settings.maxViewers);
  const viewers = Object.fromEntries(
    viewerEntries.map(([name, info]) => [
      sanitizeScalar(name, 70),
      {
        count: info.count || 0,
        lastSeen: info.lastSeen || 0,
        notes: (info.notes || []).slice(-8).map((note) => sanitizeText(note, 220))
      }
    ])
  );

  let summary = sanitizeText(memory.summary || "", 1200);
  const droppedCount = Math.max(0, (memory.turns || []).length - turns.length);
  if (droppedCount > 0) {
    summary = sanitizeText(
      `${summary} Pruned ${droppedCount} older room turns at ${new Date().toLocaleTimeString()}.`,
      1200
    );
  }

  return {
    summary,
    turns,
    viewers,
    generated,
    lastPrunedAt: Date.now()
  };
}

async function pruneAndPersistMemory() {
  const settings = await getSettings();
  return withMemoryMutation(async () => {
    const memory = await getMemory();
    const pruned = pruneMemory(memory, settings);
    await setMemory(pruned);
    return pruned;
  });
}

function summarizeMemory(memoryInput = {}) {
  const memory = normalizeMemory(memoryInput);
  const lastTurn = memory.turns?.[memory.turns.length - 1] || null;
  return {
    turnCount: memory.turns?.length || 0,
    viewerCount: Object.keys(memory.viewers || {}).length,
    generatedCount: memory.generated?.length || 0,
    summary: memory.summary || "",
    lastTurn,
    lastPrunedAt: memory.lastPrunedAt || 0
  };
}

async function getDiagnostics() {
  const result = await chrome.storage.local.get(STORAGE.diagnostics);
  return Array.isArray(result[STORAGE.diagnostics]) ? result[STORAGE.diagnostics] : [];
}

async function getFavorites() {
  const result = await chrome.storage.sync.get(STORAGE.favorites);
  const favorites = Array.isArray(result[STORAGE.favorites]) ? result[STORAGE.favorites] : [];
  return favorites.map(normalizeFavorite).filter((item) => item.text).slice(-FAVORITE_LIMIT);
}

async function setFavorites(favoritesInput = []) {
  const favorites = favoritesInput
    .map(normalizeFavorite)
    .filter((item) => item.text)
    .slice(-FAVORITE_LIMIT);
  await chrome.storage.sync.set({ [STORAGE.favorites]: favorites });
  return favorites;
}

async function toggleFavorite(favoriteInput = {}) {
  const favorite = normalizeFavorite({
    ...favoriteInput,
    id: favoriteInput.id || crypto.randomUUID(),
    ts: favoriteInput.ts || Date.now()
  });
  if (!favorite.text) return { ok: false, error: "Saved line text is empty." };

  const favorites = await getFavorites();
  const key = favorite.text.toLowerCase();
  const existingIndex = favorites.findIndex((item) => item.text.toLowerCase() === key);
  const saved = existingIndex < 0;
  if (saved) {
    favorites.push(favorite);
  } else {
    favorites.splice(existingIndex, 1);
  }
  const next = await setFavorites(favorites);
  await logDiagnostic("favorite", `${saved ? "Saved" : "Removed"} ${favorite.kind} line.`);
  return { ok: true, saved, favorites: next };
}

function normalizeFavorite(input = {}) {
  return {
    id: sanitizeScalar(input.id || "", 80),
    kind: sanitizeScalar(input.kind || "reply", 40),
    label: sanitizeText(input.label || "", 80),
    text: sanitizeText(input.text || "", 300),
    ts: Number(input.ts) || Date.now()
  };
}

async function logDiagnostic(type, message, meta = {}) {
  const settings = await getSettings({ includeSecret: false }).catch(() => DEFAULT_SETTINGS);
  if (!settings.privacy?.saveDiagnostics) return;

  const diagnostics = await getDiagnostics();
  diagnostics.push({
    id: crypto.randomUUID(),
    type,
    message: sanitizeText(message, 400),
    meta,
    ts: Date.now()
  });
  await chrome.storage.local.set({
    [STORAGE.diagnostics]: diagnostics.slice(-settings.diagnosticsLimit)
  });
}

async function ensurePruneAlarm() {
  const existing = await chrome.alarms.get(PRUNE_ALARM);
  if (!existing) {
    await chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: 1 });
  }
}

async function restrictSessionStorage() {
  try {
    await chrome.storage.session?.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // Older Chrome versions may not expose this method. Session storage still
    // remains the preferred home for live room memory when available.
  }
}

async function broadcastToTabs(message) {
  const tabs = await chrome.tabs.query({
    url: ["https://stripchat.com/*", "https://*.stripchat.com/*"]
  });
  await Promise.all(
    tabs.map((tab) => (tab.id ? chrome.tabs.sendMessage(tab.id, message).catch(() => null) : null))
  );
}

function viewerFromType(type) {
  return String(type || "viewer").replace(/_/g, " ");
}

function buildOperatorEvent(turn, memorySummary = {}, batchSize = 1) {
  return {
    type: operatorEventType(turn),
    source: "extension",
    viewerName: sanitizeScalar(turn?.viewer || "", 80),
    message: sanitizeText(turn?.text || "", 500),
    amount: tipAmountFromTurn(turn),
    goalSummary: sanitizeText(memorySummary.summary || "", 160),
    pace: paceFromMemory(memorySummary),
    batchSize,
    ts: Number(turn?.ts) || Date.now()
  };
}

function operatorEventType(turn = {}) {
  const kind = String(turn.kind || "").toLowerCase();
  if (kind.includes("tip")) return "tip_received";
  if (kind.includes("return")) return "viewer_returned";
  return "chat_turn";
}

function tipAmountFromTurn(turn = {}) {
  if (operatorEventType(turn) !== "tip_received") return 0;
  const match = String(turn.text || "").match(/(\d{1,5})/);
  return match ? Number(match[1]) : 0;
}

function paceFromMemory(memorySummary = {}) {
  const count = Number(memorySummary.turnCount || 0);
  if (count <= 5) return "slow";
  if (count >= 25) return "rising";
  return "steady";
}

async function syncOperatorEvent(event) {
  const settings = await getSettings({ includeSecret: false }).catch(() => DEFAULT_SETTINGS);
  if (!settings.operatorBridgeEnabled) return;
  postOperatorEvent(event).catch(async (error) => {
    const now = Date.now();
    if (now - lastOperatorSyncErrorAt < OPERATOR_SYNC_ERROR_COOLDOWN_MS) return;
    lastOperatorSyncErrorAt = now;
    await logDiagnostic("operator_sync_error", error.message || "Operator dashboard sync failed.");
  });
}

async function postOperatorEvent(event) {
  const operatorKey = await getBackendAuthToken();
  const response = await fetch(OPERATOR_HUB_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-operator-key": operatorKey
    },
    body: JSON.stringify(event)
  });
  if (!response.ok) {
    throw new Error(`Operator dashboard sync failed (${response.status}).`);
  }
  return response.json().catch(() => ({}));
}

function ensureOperatorCommandPolling() {
  if (operatorCommandPollTimer) return;
  pollOperatorCommand();
  operatorCommandPollTimer = setInterval(pollOperatorCommand, OPERATOR_COMMAND_POLL_MS);
}

async function refreshOperatorCommandPolling() {
  const settings = await getSettings({ includeSecret: false }).catch(() => DEFAULT_SETTINGS);
  if (settings.operatorBridgeEnabled && roomPanelPorts.size) {
    ensureOperatorCommandPolling();
  } else {
    stopOperatorCommandPolling();
  }
}

function stopOperatorCommandPolling() {
  if (!operatorCommandPollTimer) return;
  clearInterval(operatorCommandPollTimer);
  operatorCommandPollTimer = 0;
}

async function pollOperatorCommand() {
  if (operatorCommandPollInFlight || !roomPanelPorts.size) return;
  const settings = await getSettings({ includeSecret: false }).catch(() => DEFAULT_SETTINGS);
  if (!settings.operatorBridgeEnabled) {
    stopOperatorCommandPolling();
    return;
  }
  operatorCommandPollInFlight = true;
  try {
    const operatorKey = await getBackendAuthToken();
    const response = await fetch(`${OPERATOR_COMMAND_BASE_URL}/next?client=extension`, {
      headers: {
        "x-operator-key": operatorKey
      },
      cache: "no-store"
    });
    if (!response.ok) {
      throw new Error(`Operator command poll failed (${response.status}).`);
    }
    const body = await response.json().catch(() => ({}));
    if (!body.command) return;

    try {
      const result = await executeOperatorCommand(body.command);
      await acknowledgeOperatorCommand(body.command.id, {
        status: "succeeded",
        message: result.message || "Loaded in StripChat composer."
      });
    } catch (error) {
      await acknowledgeOperatorCommand(body.command.id, {
        status: "failed",
        message: error.message || "Operator command failed."
      }).catch(() => null);
    }
  } catch (error) {
    const now = Date.now();
    if (now - lastOperatorSyncErrorAt >= OPERATOR_SYNC_ERROR_COOLDOWN_MS) {
      lastOperatorSyncErrorAt = now;
      await logDiagnostic("operator_command_poll_error", error.message || "Operator command poll failed.");
    }
  } finally {
    operatorCommandPollInFlight = false;
  }
}

async function executeOperatorCommand(command = {}) {
  if (command.type !== "paste_text") {
    throw new Error(`Unsupported operator command: ${command.type || "missing"}`);
  }
  const createdAt = Number(command.createdAt || 0);
  if (!createdAt || Date.now() - createdAt > OPERATOR_COMMAND_MAX_AGE_MS) {
    throw new Error("Operator command expired before it reached StripChat.");
  }
  const text = sanitizeText(command.text || "", 500);
  if (!text) throw new Error("Operator command text is empty.");

  const tab = await findOperatorTargetTab();
  if (!tab?.id) throw new Error("No StripChat tab is open.");

  let result = await chrome.tabs
    .sendMessage(tab.id, { type: "OPERATOR_PASTE_TEXT", text, commandId: command.id })
    .catch(() => null);
  if (!result?.ok) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["page_key_guard.js"],
      world: "MAIN"
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content_script.js"]
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    result = await chrome.tabs
      .sendMessage(tab.id, { type: "OPERATOR_PASTE_TEXT", text, commandId: command.id })
      .catch(() => null);
  }
  if (!result?.ok) {
    throw new Error(result?.error || "StripChat composer was not found.");
  }
  await logDiagnostic("operator_paste", "Loaded an operator line into StripChat.", {
    commandId: command.id,
    tabId: tab.id
  });
  return result;
}

async function findOperatorTargetTab() {
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeStripChat = activeTabs.find((tab) => tab.id && isAllowedStripChatUrl(tab.url));
  if (activeStripChat) return activeStripChat;
  const stripChatTabs = await chrome.tabs.query({
    url: ["https://stripchat.com/*", "https://*.stripchat.com/*"]
  });
  return stripChatTabs.find((tab) => tab.id) || null;
}

async function acknowledgeOperatorCommand(commandId, payload) {
  const operatorKey = await getBackendAuthToken();
  const response = await fetch(`${OPERATOR_COMMAND_BASE_URL}/${encodeURIComponent(commandId)}/ack`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-operator-key": operatorKey
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Operator command acknowledgement failed (${response.status}).`);
  }
  return response.json().catch(() => ({}));
}

function withMemoryMutation(task) {
  const run = memoryMutationQueue.then(task, task);
  memoryMutationQueue = run.catch(() => null);
  return run;
}

async function enforceActionAvailability(type) {
  const featureByAction = {
    GENERATE: "replies",
    GOALS: "goals",
    ROOM_TOPIC: "tips",
    WAKE_LINE: "tools",
    TIP_REACTION: "tools",
    QUICK_CHALLENGES: "tools"
  };
  const featureId = featureByAction[type];
  if (!featureId) return null;
  const settings = await getSettings({ includeSecret: false });
  if (!settings.enabled) {
    return { ok: false, error: "Copilot is disabled in Settings." };
  }
  if (settings.features?.[featureId] === false) {
    return { ok: false, error: `The ${featureId} feature is disabled in Settings.` };
  }
  return null;
}
