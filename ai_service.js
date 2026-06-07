/*
 * Shared generation and prompt utilities for EclipseStud Copilot.
 *
 * The service worker owns extension state and imports this module. Popup and
 * options pages can also import constants from here without touching Chrome APIs.
 */

export const VIEWER_TYPES = [
  { value: "grey", label: "Grey" },
  { value: "registered", label: "Registered" },
  { value: "casual_tip", label: "Casual tipper" },
  { value: "big_tip", label: "Big tipper" },
  { value: "regular", label: "Regular" },
  { value: "fan_club", label: "Fan club" },
  { value: "knight", label: "Knight" },
  { value: "pushy", label: "Pushy" },
  { value: "lurker", label: "Lurker" }
];

export const INTENTS = [
  { value: "reply", label: "Reply" },
  { value: "keep_chat", label: "Keep chat" },
  { value: "tip_friendly", label: "Tip friendly" },
  { value: "defuse", label: "Defuse" },
  { value: "boundary", label: "Boundary" },
  { value: "thank_tipper", label: "Thank" },
  { value: "wake_chat", label: "Wake chat" }
];

export const TONES = [
  { value: "chill", label: "Chill" },
  { value: "playful", label: "Playful" },
  { value: "flirty", label: "Flirty" },
  { value: "dominant", label: "Firm" },
  { value: "friendly", label: "Friendly" },
  { value: "short", label: "Short" }
];

const GOAL_COUNT = 5;

export const OPENAI_MODELS = [
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5"
];

export const DEFAULT_SETTINGS = {
  enabled: true,
  aiMode: "direct",
  aiProvider: "openai",
  apiBaseUrl: "https://api.openai.com",
  model: "gpt-5-mini",
  fallbackModel: "gpt-5-nano",
  backendUrl: "http://127.0.0.1:8787/generate",
  backendAuthToken: "",
  operatorBridgeEnabled: false,
  rememberApiKey: false,
  overlayAutoOpen: true,
  theme: "studio",
  personaName: "EclipseStud",
  personaStyle:
    "confident, warm, witty, adult-only, teasing without being graphic, and quick to protect boundaries",
  houseRules:
    "Only engage with adults. Keep replies consensual, respectful, non-graphic, and platform-safe. Never encourage harassment, coercion, minors, intoxication, unsafe acts, or doxxing.",
  maxTurns: 80,
  maxViewers: 60,
  maxPromptTokens: 4800,
  diagnosticsLimit: 80,
  features: {
    replies: true,
    tips: true,
    goals: true,
    tools: true,
    room: true
  },
  privacy: {
    sendRoomContext: true,
    saveDiagnostics: true
  }
};

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const NON_RETRY_STATUSES = new Set([400, 401, 403]);
const REQUEST_TIMEOUT_MS = 34_000;
const ATTEMPT_TIMEOUT_MS = 15_000;

export function normalizeSettings(input = {}) {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...input,
    features: { ...DEFAULT_SETTINGS.features, ...(input.features || {}) },
    privacy: { ...DEFAULT_SETTINGS.privacy, ...(input.privacy || {}) }
  };

  merged.maxTurns = clampInt(merged.maxTurns, 10, 200, DEFAULT_SETTINGS.maxTurns);
  merged.maxViewers = clampInt(merged.maxViewers, 10, 250, DEFAULT_SETTINGS.maxViewers);
  merged.maxPromptTokens = clampInt(
    merged.maxPromptTokens,
    1000,
    18000,
    DEFAULT_SETTINGS.maxPromptTokens
  );
  merged.diagnosticsLimit = clampInt(
    merged.diagnosticsLimit,
    10,
    300,
    DEFAULT_SETTINGS.diagnosticsLimit
  );
  merged.aiMode = ["direct", "backend"].includes(merged.aiMode)
    ? merged.aiMode
    : DEFAULT_SETTINGS.aiMode;
  merged.aiProvider = "openai";
  merged.apiBaseUrl = DEFAULT_SETTINGS.apiBaseUrl;
  delete merged.authHeaderMode;
  merged.model = sanitizeScalar(merged.model || DEFAULT_SETTINGS.model, 100);
  if (!/^gpt-/i.test(merged.model)) merged.model = DEFAULT_SETTINGS.model;
  merged.fallbackModel = sanitizeScalar(
    merged.fallbackModel || DEFAULT_SETTINGS.fallbackModel,
    100
  );
  if (!/^gpt-/i.test(merged.fallbackModel)) merged.fallbackModel = DEFAULT_SETTINGS.fallbackModel;
  merged.operatorBridgeEnabled = Boolean(merged.operatorBridgeEnabled);
  merged.backendUrl = sanitizeScalar(merged.backendUrl || "", 300);
  merged.personaName = sanitizeScalar(merged.personaName || "EclipseStud", 80);
  merged.personaStyle = sanitizeText(merged.personaStyle || DEFAULT_SETTINGS.personaStyle, 900);
  merged.houseRules = sanitizeText(merged.houseRules || DEFAULT_SETTINGS.houseRules, 1200);
  return merged;
}

export function stripSecretSettings(settings = {}) {
  const clean = { ...settings };
  delete clean.apiKey;
  delete clean.transientApiKey;
  delete clean.backendAuthToken;
  return clean;
}

export function normalizeApiKey(value = "") {
  return String(value || "")
    .trim()
    .replace(/^bearer\s+/i, "")
    .replace(/^authorization\s*:\s*bearer\s+/i, "")
    .replace(/^x-api-key\s*:\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

export function isLikelyOpenAiKey(value = "") {
  const key = normalizeApiKey(value);
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(key);
}

export async function generateCopilotReply(request, context = {}) {
  const settings = normalizeSettings(context.settings || {});
  const cleanRequest = normalizeRequest(request);
  const memory = normalizeMemory(context.memory || {});

  if (settings.aiMode === "backend") {
    if (!settings.backendUrl) {
      throw new AiRequestError("Backend URL is empty. Add http://127.0.0.1:8787/generate or choose Direct API.", 500);
    }
    return await callBackend(cleanRequest, { settings, memory });
  }

  if (settings.aiMode === "direct") {
    if (!settings.apiKey) {
      throw new AiRequestError("OpenAI API key is missing. Save it in Settings or use the OpenAI backend starter.", 401);
    }
    return await callOpenAI(cleanRequest, { settings, memory });
  }

  return {
    ok: true,
    source: "local",
    replies: generateLocalReplies(cleanRequest, { settings, memory }),
    diagnostics: {
      promptTokens: estimateTokens(buildPrompt(cleanRequest, { settings, memory })),
      fallbackReason: settings.aiMode === "local" ? "" : "Missing AI connection details"
    }
  };
}

export async function generateCopilotGoals(request, context = {}) {
  const settings = normalizeSettings(context.settings || {});
  const cleanRequest = normalizeGoalRequest(request);
  const memory = normalizeMemory(context.memory || {});

  if (settings.aiMode === "backend") {
    if (!settings.backendUrl) {
      throw new AiRequestError("Backend URL is empty. Add http://127.0.0.1:8787/generate or choose Direct API.", 500);
    }
    return await callBackendGoals(cleanRequest, { settings, memory });
  }

  if (settings.aiMode === "direct") {
    if (!settings.apiKey) {
      throw new AiRequestError("OpenAI API key is missing. Save it in Settings or use the OpenAI backend starter.", 401);
    }
    return await callOpenAIGoals(cleanRequest, { settings, memory });
  }

  return {
    ok: true,
    source: "local",
    goals: generateGoals(cleanRequest, { settings, memory }),
    diagnostics: {
      promptTokens: estimateTokens(buildGoalsPrompt(cleanRequest, { settings, memory })),
      fallbackReason: settings.aiMode === "local" ? "" : "Missing AI connection details"
    }
  };
}

export async function testAiConnection(settingsInput = {}) {
  const settings = normalizeSettings(settingsInput);

  if (settings.aiMode === "local") {
    return { ok: true, source: "local", message: "Local generator is ready." };
  }

  if (settings.aiMode === "backend") {
    if (!settings.backendUrl) {
      return { ok: false, source: "backend", message: "Backend URL is empty." };
    }
    const url = normalizeBackendUrl(settings.backendUrl);
    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: backendHeaders(settings),
        body: JSON.stringify({
          type: "health_check",
          timestamp: Date.now()
        })
      },
      { maxAttempts: 2 }
    );
    return {
      ok: response.ok,
      source: "backend",
      message: response.ok ? "Backend responded." : `Backend returned ${response.status}.`,
      requestId: response.headers.get("request-id") || ""
    };
  }

  if (!settings.apiKey) {
    return { ok: false, source: "direct", message: "API key/token is empty." };
  }

  const response = await fetchWithRetry(
    buildOpenAIResponsesUrl(settings.apiBaseUrl),
    {
      method: "POST",
      headers: openAiHeaders(settings.apiKey),
      body: JSON.stringify({
        model: settings.model,
        input: [
          { role: "system", content: "Reply with compact JSON only." },
          { role: "user", content: "Return {\"ok\":true}" }
        ],
        reasoning: { effort: "minimal" },
        text: { verbosity: "low" },
        max_output_tokens: 32
      })
    },
    { maxAttempts: 2 }
  );

  const requestId = response.headers.get("request-id") || "";
  if (!response.ok) {
    return {
      ok: false,
      source: "direct",
      message: await responseErrorText(response),
      requestId
    };
  }
  return {
    ok: true,
    source: "direct",
    message: "OpenAI responded.",
    requestId
  };
}

async function callBackend(request, { settings, memory }) {
  const prompt = buildPrompt(request, { settings, memory });
  const response = await fetchWithRetry(
    normalizeBackendUrl(settings.backendUrl),
    {
      method: "POST",
      headers: backendHeaders(settings),
      body: JSON.stringify({
        type: "generate_replies",
        model: settings.model,
        request,
        settings: stripSecretSettings(settings),
        memory: compactMemoryForPrompt(memory, settings),
        prompt
      })
    },
    { maxAttempts: 3 }
  );

  const requestId = response.headers.get("request-id") || "";
  if (!response.ok) {
    throw new AiRequestError(await responseErrorText(response), response.status, requestId);
  }

  const body = await response.json();
  const replies = cleanRepliesForRequest(
    coerceReplies(body.replies || body.candidates || body),
    request,
    { settings, memory }
  );
  if (!replies.length) {
    throw new AiRequestError("Backend response did not contain replies.", 502, requestId);
  }
  return {
    ok: true,
    source: "backend",
    replies,
    diagnostics: {
      promptTokens: estimateTokens(prompt),
      requestId
    }
  };
}

async function callBackendGoals(request, { settings, memory }) {
  const prompt = buildGoalsPrompt(request, { settings, memory });
  const response = await fetchWithRetry(
    normalizeBackendUrl(settings.backendUrl),
    {
      method: "POST",
      headers: backendHeaders(settings),
      body: JSON.stringify({
        type: "generate_goals",
        model: settings.model,
        request,
        settings: stripSecretSettings(settings),
        memory: compactMemoryForPrompt(memory, settings),
        prompt
      })
    },
    { maxAttempts: 3 }
  );

  const requestId = response.headers.get("request-id") || "";
  if (!response.ok) {
    throw new AiRequestError(await responseErrorText(response), response.status, requestId);
  }

  const body = await response.json();
  const goals = cleanGoalsForRequest(
    coerceGoals(body.goals || body.items || body),
    request
  );
  if (!goals.length) {
    throw new AiRequestError("Backend response did not contain goals.", 502, requestId);
  }
  return {
    ok: true,
    source: "backend",
    goals,
    diagnostics: {
      promptTokens: estimateTokens(prompt),
      requestId
    }
  };
}

async function callOpenAI(request, { settings, memory }) {
  const prompt = buildPrompt(request, { settings, memory });
  const requestResult = await fetchWithModelFallback(
    buildOpenAIResponsesUrl(settings.apiBaseUrl),
    (model) => ({
        method: "POST",
        headers: openAiHeaders(settings.apiKey),
      body: JSON.stringify({
        model,
        max_output_tokens: 700,
        reasoning: { effort: "minimal" },
        text: { verbosity: "low" },
        input: [
          {
            role: "system",
            content: buildSystemPrompt(settings)
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    }),
    settings.model,
    settings.fallbackModel
  );
  const response = requestResult.response;

  const requestId = response.headers.get("request-id") || "";
  if (!response.ok) {
    throw new AiRequestError(await responseErrorText(response), response.status, requestId);
  }

  const body = await response.json();
  const text = extractOpenAIText(body);
  const replies = cleanRepliesForRequest(parseStructuredReplies(text), request, { settings, memory });
  if (!replies.length) {
    throw new AiRequestError("OpenAI response did not contain usable replies.", 502, requestId);
  }

  return {
    ok: true,
    source: "direct",
    replies,
    diagnostics: {
      requestId,
      model: requestResult.model,
      fallbackUsed: requestResult.fallbackUsed,
      promptTokens: estimateTokens(prompt),
      outputTokens: body.usage?.output_tokens || 0,
      inputTokens: body.usage?.input_tokens || 0
    }
  };
}

async function callOpenAIGoals(request, { settings, memory }) {
  const prompt = buildGoalsPrompt(request, { settings, memory });
  const requestResult = await fetchWithModelFallback(
    buildOpenAIResponsesUrl(settings.apiBaseUrl),
    (model) => ({
      method: "POST",
      headers: openAiHeaders(settings.apiKey),
      body: JSON.stringify({
        model,
        max_output_tokens: 1200,
        reasoning: { effort: "minimal" },
        text: { verbosity: "low" },
        input: [
          {
            role: "system",
            content: buildSystemPrompt(settings)
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    }),
    settings.model,
    settings.fallbackModel
  );
  const response = requestResult.response;

  const requestId = response.headers.get("request-id") || "";
  if (!response.ok) {
    throw new AiRequestError(await responseErrorText(response), response.status, requestId);
  }

  const body = await response.json();
  const text = extractOpenAIText(body);
  const goals = cleanGoalsForRequest(parseStructuredGoals(text), request);
  if (!goals.length) {
    throw new AiRequestError("OpenAI response did not contain usable goals.", 502, requestId);
  }

  return {
    ok: true,
    source: "direct",
    goals,
    diagnostics: {
      requestId,
      model: requestResult.model,
      fallbackUsed: requestResult.fallbackUsed,
      promptTokens: estimateTokens(prompt),
      outputTokens: body.usage?.output_tokens || 0,
      inputTokens: body.usage?.input_tokens || 0
    }
  };
}

export function buildPrompt(request, { settings, memory }) {
  const compactMemory = compactMemoryForPrompt(memory, settings);
  const isRoomTopic = request.source === "room_topic";
  const recentReplies = (memory.generated || [])
    .filter((item) => item.kind !== "goal" && item.type !== "goal")
    .slice(-16)
    .map((item) => item.text || "")
    .filter(Boolean);

  const taskDesc = isRoomTopic
    ? "Write exactly 3 distinct, paste-ready live stream title options that feel fresh and on-brand for right now."
    : "Write exactly 3 short, distinct, paste-ready public chat replies that sound like the creator just typed them while live.";

  return [
    taskDesc,
    "Think like the creator who is currently streaming: fast, specific, personality-forward, slightly imperfect.",
    "Return ONLY a compact JSON array of strings (the lines themselves). No explanations, no objects, no markdown.",
    "",
    `Creator: ${settings.personaName}`,
    `Voice: ${settings.personaStyle}`,
    "",
    "Viewer just said:",
    request.message || "(no specific message - use room energy)",
    request.viewerName ? `Viewer name/handle: ${request.viewerName}` : "",
    request.viewerType ? `Viewer type: ${request.viewerType}` : "",
    request.intent ? `Desired intent: ${request.intent}` : "",
    request.tone ? `Tone direction: ${request.tone}` : "",
    "",
    "Live room context right now (recent turns, known viewers, current energy, recent tips):",
    JSON.stringify(compactMemory, null, 2),
    "",
    "Recent lines you already used (avoid repeating these or very similar phrasing):",
    JSON.stringify(recentReplies.slice(-10), null, 2),
    "",
    "Reasoning (internal only, do before generating):",
    "1. In one sentence, analyze the viewer's exact message + recent activity (especially any recent tips) + overall room energy and what the creator probably needs right now.",
    "2. Choose the best angle and tone for a live streamer who is in the moment.",
    "3. Produce three short, distinct, high-personality lines the creator would actually type and paste immediately.",
    "",
    "Critical quality rules (internal only):",
    "- Every line must directly address something specific the viewer said or the current room moment.",
    "- Extremely short and natural. Most good lines are 4-12 words.",
    "- Vary the three options: one more direct, one more playful/teasing, one that opens a tiny bit of conversation or invites action.",
    "- Never generic. No 'tell me more', 'thanks babe', 'what are you in the mood for' as default.",
    "- Never suggest private rooms or pulling the viewer out of public chat.",
    "- If the energy feels off or pushy, one of the options should set a light boundary while staying warm.",
    "- Sound typed live, not written by a team or an AI."
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildGoalsPrompt(request, { settings, memory }) {
  const compactMemory = compactMemoryForPrompt(memory, settings);
  const recentGoalText = (memory.generated || [])
    .filter((item) => item.kind === "goal" || item.type === "goal")
    .slice(-14)
    .map((item) => item.text || item.name || "")
    .filter(Boolean);

  return [
    `Create exactly ${GOAL_COUNT} real, achievable public-room token goals that feel current for this stream.`,
    "Return ONLY valid JSON: { \"goals\": [ { \"name\": string, \"amount\": number, \"chat_line\": string }, ... ] }",
    "No markdown, no extra text, no explanations outside the JSON.",
    "",
    `Creator voice: ${settings.personaStyle}`,
    "",
    "Goal brief:",
    `Theme / focus: ${request.theme || "mixed"}`,
    `Target total around: ${request.targetTokens || 1000} tokens`,
    `Room mood / notes: ${request.roomMood || "normal energy"}`,
    request.latestMessage ? `Latest chat energy: ${request.latestMessage}` : "",
    "",
    "Current room memory (recent activity):",
    JSON.stringify(compactMemory, null, 2),
    "",
    "Recently used goal language (avoid close repeats):",
    JSON.stringify(recentGoalText.slice(-8), null, 2),
    "",
    "High quality bar for these goals (the creator should be able to just copy-paste and keep performing):",
    "- Name: short, sexy, current, room-facing (examples that feel alive: 'Oil on skin', 'Skirt disappears', 'Vibe toy low for 2 mins').",
    "- Amount: believable progressive steps that add up toward the target.",
    "- chat_line: one single, flirty/confident, personality-heavy sentence they can say out loud while doing the goal. It should make viewers want to tip right then.",
    "- All 5 lines must feel different — different energy, different promise, different tease level.",
    "- 100% public room only. Zero private room language.",
    "- Make the whole ladder feel like it was invented for this exact second in this exact show."
  ].join("\n");
}

export function buildSystemPrompt(settingsInput = {}) {
  const settings = normalizeSettings(settingsInput);
  return [
    "You are the creator, live on stream right now, quickly typing replies in public chat.",
    "Your voice is confident, warm, witty, teasing but never graphic, and very quick to protect your own boundaries.",
    "Every line must feel like something you would actually type and send in the moment — short, specific, reactive to the exact thing the viewer just said.",
    "Sound like a real person who is busy entertaining a room: casual casing, light punctuation, personality first, never corporate or overly polished.",
    "React to concrete details in the viewer's message. Reference their words, energy, or timing when it makes sense.",
    "Keep almost everything 1-2 short sentences. 3-14 words is ideal for most replies.",
    "Never sound like an AI assistant, customer support, or a marketing script. No 'thanks for asking', 'tell me more', or generic engagement bait.",
    "Strongly prefer public chat energy. Never suggest or hint at private rooms, pvt, one-on-one, VIP, exclusive, or pulling anyone away from the public room.",
    "You are protective: if someone is pushy, rude, or testing boundaries, you set a warm but firm limit without escalating.",
    "Current creator style: " + settings.personaStyle,
    "Non-negotiable house rules: " + settings.houseRules,
    "Only output the requested number of distinct paste-ready lines. No explanations, no numbering in the final lines themselves."
  ].join("\n");
}

export function compactMemoryForPrompt(memoryInput = {}, settingsInput = {}) {
  const settings = normalizeSettings(settingsInput);
  const memory = normalizeMemory(memoryInput);
  if (!settings.privacy.sendRoomContext) {
    return { turns: [], viewers: {}, recentTips: [], summary: "Room context disabled." };
  }

  const turnBudget = Math.min(settings.maxTurns, 25);
  const turns = (memory.turns || []).slice(-turnBudget).map((turn) => ({
    viewer: sanitizeScalar(turn.viewer || "viewer", 50),
    text: sanitizeText(turn.text || "", 220),
    kind: sanitizeScalar(turn.kind || "chat", 40),
    at: turn.ts || turn.createdAt || 0
  }));

  // Extract recent tips for deeper context
  const recentTips = (memory.turns || [])
    .filter(t => t.kind === "tip" || /tip/i.test(t.text || ""))
    .slice(-8)
    .map(t => ({
      viewer: sanitizeScalar(t.viewer || "", 40),
      amount: t.amount || null,
      text: sanitizeText(t.text || "", 120)
    }));

  const viewers = {};
  const entries = Object.entries(memory.viewers || {}).slice(-Math.min(settings.maxViewers, 20));
  for (const [name, info] of entries) {
    viewers[sanitizeScalar(name, 50)] = {
      count: info.count || 0,
      lastSeen: info.lastSeen || 0,
      notes: sanitizeText((info.notes || []).slice(-3).join(" | "), 300)
    };
  }

  return {
    summary: sanitizeText(memory.summary || "", 600),
    turns,
    recentTips,
    viewers,
    generatedCount: (memory.generated || []).length
  };
}

export function generateLocalReplies(requestInput = {}, context = {}) {
  const request = normalizeRequest(requestInput);
  const settings = normalizeSettings(context.settings || {});
  const memory = normalizeMemory(context.memory || {});
  const intent = request.intent;
  const tone = request.tone;
  const viewer = request.viewerName || "";
  const text = request.message;
  const classification = classifyMessage(text);
  const recent = new Set((memory.generated || []).slice(-25).map((item) => item.text || item));

  const candidates = [
    buildIntentReply({ intent, tone, viewer, text, classification, settings, index: 0 }),
    buildIntentReply({ intent, tone, viewer, text, classification, settings, index: 1 }),
    buildIntentReply({ intent, tone, viewer, text, classification, settings, index: 2 })
  ]
    .map((line) => polishLine(line, tone))
    .filter(Boolean);

  const unique = [];
  for (const candidate of candidates) {
    if (!recent.has(candidate) && !unique.includes(candidate)) {
      unique.push(candidate);
    }
  }

  while (unique.length < 3) {
    unique.push(
      polishLine(
        fallbackLine(unique.length, { intent, tone, viewer, classification, settings }),
        tone
      )
    );
  }

  return cleanRepliesForRequest(unique.slice(0, 3), request, { settings, memory });
}

/**
 * Smart Copilot - the heart of making AI the main part of the extension.
 * This powers the new primary "AI-first" experience in the in-room panel.
 * Deeper memory (recent tips, viewer history), explicit reasoning step,
 * and proactive + query-driven suggestions.
 *
 * === Specific prompt test cases the AI should handle well (what a model wishes they didn't have to think about) ===
 * 1. Viewer says something cheap / low effort after a goal → firm but warm boundary + re-engage public energy with almost zero typing.
 * 2. Big tip from a regular → warm personal thank + light, natural upsell to next public goal without sounding salesy.
 * 3. Room goes quiet after a long silence → high-energy but not desperate wake line that feels like something the model would actually say.
 * 4. Pushy viewer asking for private → clear, classy boundary while keeping the door open for public fun (protects the model without killing vibe).
 * 5. Slow room + recent small tips → instantly suggest a small exciting goal ladder + one strong chat line the model can say while moving.
 * 6. Creator is performing hard and just wants "something good for right now" → proactive mixed suggestions (reply + strategic move) with why.
 * 7. Freeform "make this slow room fun again" or "title for this toy energy" → perfect lines that require the model to do nothing but paste or say.
 * 8. After a big tip + someone being weird in chat → thank the tipper beautifully + shut down the weird energy in one clean move.
 */
export async function generateSmartCopilot(payload = {}, context = {}) {
  const settings = normalizeSettings(context.settings || {});
  const memory = normalizeMemory(context.memory || {});

  const query = sanitizeText(payload.query || payload.message || "", 600);
  const compactMemory = compactMemoryForPrompt(memory, settings);

  const system = [
    "You are an elite, hyper-observant live streaming co-pilot (GPT-5.5 level extra high reasoning) for an adult content creator who is actively performing.",
    "You watch the room in real time through memory (recent chat, tips with amounts, viewers, energy, momentum). The creator is busy on camera and wants ZERO unnecessary thinking or typing.",
    "Your job: be the smartest, most helpful person in the room. Anticipate needs and give perfect, low-effort, high-value moves (short lines they can say while moving, perfect timing for goals/titles, boundaries that protect without killing vibe).",
    "Use extra high-reasoning chain-of-thought internally: deeply analyze context, performer state, what has worked recently, what the room needs in the next 30-90 seconds.",
    "Output must feel like it came from the creator's own brain mid-show: natural, specific, personality-forward, immediately usable.",
    "Never generic, never long, never salesy. Always reference real recent signals when possible. 100% public-room safe.",
    "Strongly protect the creator's energy, boundaries, and public chat focus."
  ].join("\n");

  const user = [
    "Current deep room memory (includes recent tips with amounts, viewer history, chat momentum, recent activity):",
    JSON.stringify(compactMemory, null, 2),
    "",
    query ? `Creator's request (they are performing - keep it minimal effort): "${query}"` : "No specific request. Be extremely proactive: read the room signals and give the creator the absolute best low-effort moves to improve things right now.",
    "",
    "You are the ultimate high-reasoning co-pilot (Codex/GPT-5.5 extra thinking mode) for a performer who wants to focus 95% on the show and 5% on chat/goals. Anticipate. Minimize their work.",
    "",
    "=== EXTRA HIGH REASONING PROCESS (think like a top 1% operator before any output) ===",
    "1. Synthesize live signals: energy from tips + chat, time since last big action, what the performer is physically doing, conversion opportunities, dead-air risk, boundary needs.",
    "2. Pick the highest-ROI, lowest-cognitive-load intervention (short line they can say while moving, perfect goal to launch, title that matches current vibe, etc.).",
    "3. Generate options in the exact voice of this creator - short, natural, specific, flirty/confident where appropriate, zero AI or corporate feel.",
    "4. For each suggestion, give a tiny 'why now' and the easiest action for the UI.",
    "",
    "Return ONLY this JSON (no other text whatsoever):",
    "{",
    '  "analysis": "one tight sentence on the room right now + the #1 thing the creator should do",',
    '  "suggestions": [',
    '    {"type": "reply|title|goal|wake|boundary|tease|action", "text": "paste-ready or speakable text", "why": "short reason it wins right now", "actionHint": "paste|set_title|queue_goal|copy"}',
    "  ]",
    "}",
    "Aim for 6-9 suggestions. Heavily favor things the creator can use with almost no extra thought or typing while on camera. Include strategic moves (goals/titles) when they will pay off. Make it feel like magic assistance."
  ].join("\n");

  if (settings.aiMode === "direct" && settings.apiKey) {
    try {
      const response = await fetchWithModelFallback(
        buildOpenAIResponsesUrl(settings.apiBaseUrl),
        (model) => ({
          method: "POST",
          headers: openAiHeaders(settings.apiKey),
          body: JSON.stringify({
            model,
            max_output_tokens: 900,
            reasoning: { effort: "minimal" },
            text: { verbosity: "low" },
            input: [
              { role: "system", content: system },
              { role: "user", content: user }
            ]
          })
        }),
        settings.model,
        settings.fallbackModel
      );

      const body = await response.response.json().catch(() => ({}));
      const text = extractOpenAIText(body);
      const parsed = parseSmartCopilotOutput(text);

      return {
        ok: true,
        source: "direct",
        analysis: parsed.analysis,
        suggestions: parsed.suggestions || [],
        diagnostics: { model: response.model || settings.model }
      };
    } catch (e) {
      // fall to local
    }
  }

  return generateLocalSmartCopilot({ query, memory: compactMemory, settings });
}

function parseSmartCopilotOutput(text) {
  try {
    const cleaned = String(text || "").replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      analysis: sanitizeText(parsed.analysis || "", 300),
      suggestions: (Array.isArray(parsed.suggestions) ? parsed.suggestions : []).slice(0, 7).map(s => ({
        type: sanitizeScalar(s.type || "reply", 30),
        text: sanitizeText(s.text || "", 280),
        why: sanitizeText(s.why || "", 160)
      }))
    };
  } catch {
    return { analysis: "Room is active.", suggestions: [] };
  }
}

function generateLocalSmartCopilot({ query, memory, settings }) {
  const suggestions = [];
  const recentTip = (memory.recentTips || [])[0];
  const lastTurn = (memory.turns || []).slice(-1)[0];

  if (recentTip) {
    suggestions.push({
      type: "reply",
      text: `Thanks for that, ${recentTip.viewer || "you"}. That hit different.`,
      why: "Acknowledge the recent tip warmly and personally"
    });
  }

  if (lastTurn && /slow|quiet|bored/i.test(lastTurn.text || "")) {
    suggestions.push({
      type: "wake",
      text: "Okay who is going to be brave and start the next goal with me?",
      why: "Room feels slow — direct, high-energy call to action"
    });
  }

  suggestions.push({
    type: "advice",
    text: "Quick 30-second tease then open a small, exciting goal ladder.",
    why: "Good general momentum and conversion move for most rooms right now"
  });

  if (query) {
    suggestions.push({
      type: "advice",
      text: "Based on what you asked, focus on direct engagement and one clear next goal.",
      why: "Tailored to your specific request"
    });
  }

  return {
    ok: true,
    source: "local-smart",
    analysis: query ? "Responding to your request using current room signals." : "Reading the room from recent activity and tips.",
    suggestions: suggestions.slice(0, 5)
  };
}

function buildIntentReply({ intent, tone, viewer, text, classification, settings, index }) {
  const mention = viewer && viewer !== "viewer" ? `${viewer}, ` : "";
  const safeText = sanitizeText(text, 140);

  // Much tighter, less robotic local fallbacks
  if (classification === "unsafe" || intent === "boundary") {
    return `${mention}keep the energy respectful and we stay having fun.`;
  }
  if (intent === "defuse") {
    return `${mention}let's reset and keep it sweet. Menu is there if you want to steer.`;
  }
  if (intent === "thank_tipper") {
    return `${mention}that felt good, thank you. You have my attention for the next one.`;
  }
  if (intent === "tip_friendly" || classification === "tip") {
    const lines = [
      `${mention}tokens make me focus harder. What's the move?`,
      `${mention}a little love on the menu gets you exactly what you want.`,
      `${mention}show me how much you want it and I'll match you.`
    ];
    return lines[index % lines.length];
  }
  if (intent === "wake_chat" || classification === "idle") {
    return `${mention}room's quiet... someone brave enough to start the next goal with me?`;
  }
  if (classification === "hello") {
    return `${mention}hey. What kind of trouble are you bringing in tonight?`;
  }
  if (tone === "dominant") {
    return `${mention}I see you. Behave, pick from the menu, and make it worth my time.`;
  }
  if (safeText) {
    const reactions = [
      `${mention}that ${safeText.toLowerCase().slice(0, 60)} got me. Say more.`,
      `${mention}oh? ${safeText.toLowerCase().slice(0, 50)}... keep going.`,
      `${mention}you said "${safeText.toLowerCase().slice(0, 45)}" and now I'm interested.`
    ];
    return reactions[index % reactions.length];
  }
  return fallbackLine(index, { intent, tone, viewer, classification, settings });
}

function fallbackLine(index, { intent, tone, viewer }) {
  const mention = viewer && viewer !== "viewer" ? `${viewer}, ` : "";
  const lines = [
    `${mention}say something worth my attention or hit the menu.`,
    `${mention}make a move and I'll match the energy.`,
    `${mention}someone start the next goal before the room goes flat.`
  ];

  if (intent === "keep_chat") {
    return [
      `${mention}what's the vibe in here right now?`,
      `${mention}give me a word for the energy and I'll run with it.`,
      `${mention}room's waiting — somebody talk to me.`
    ][index % 3];
  }

  if (tone === "short") {
    return [
      `${mention}make it count.`,
      `${mention}menu or nothing.`,
      `${mention}I see you. Go.`
    ][index % 3];
  }

  return lines[index % lines.length];
}

const PRIVATE_PROMO_PATTERN =
  /\b(private|pvt|one[-\s]?on[-\s]?one|1[-\s]?on[-\s]?1|vip|exclusive|take me private|pull me away|disappear private)\b/i;

function cleanRepliesForRequest(replies, request, { settings } = {}) {
  const cleanRequest = normalizeRequest(request);
  const cleanSettings = normalizeSettings(settings || {});
  const cleaned = [];

  for (const [index, reply] of (replies || []).entries()) {
    let candidate = polishLine(reply, cleanRequest.tone);
    if (!candidate) continue;
    if (hasPrivatePromotion(candidate)) {
      candidate = publicRoomFallbackLine(index, {
        intent: cleanRequest.intent,
        tone: cleanRequest.tone,
        viewer: cleanRequest.viewerName,
        settings: cleanSettings
      });
    }
    if (candidate && !cleaned.includes(candidate)) cleaned.push(candidate);
  }

  while (cleaned.length < 3) {
    const fallback = publicRoomFallbackLine(cleaned.length, {
      intent: cleanRequest.intent,
      tone: cleanRequest.tone,
      viewer: cleanRequest.viewerName,
      settings: cleanSettings
    });
    if (!cleaned.includes(fallback)) cleaned.push(fallback);
    else cleaned.push(fallbackLine(cleaned.length, cleanRequest));
  }

  return cleaned.slice(0, 3);
}

function publicRoomFallbackLine(index, { intent, tone, viewer }) {
  const mention = viewer && viewer !== "viewer" ? `${viewer}, ` : "";
  if (intent === "tip_friendly") {
    return [
      `${mention}thanks for the love. stick around and help me wake this room up.`,
      `${mention}that got my attention. keep steering the room from the menu.`,
      `${mention}appreciate you. the room gets better when you keep the energy moving.`
    ][index % 3];
  }
  if (intent === "keep_chat" || intent === "wake_chat") {
    return [
      `${mention}stay and talk to me a little. i get more fun when the room warms up.`,
      `${mention}give me one word for the vibe and i will pick the next tease.`,
      `${mention}i want the room talking before the next goal moves.`
    ][index % 3];
  }
  if (tone === "short") {
    return [
      `${mention}stay close and say it sweeter.`,
      `${mention}i see you. keep going.`,
      `${mention}menu first, attention next.`
    ][index % 3];
  }
  return [
    `${mention}thanks babe. stay close, i like when the room actually talks to me.`,
    `${mention}that was sweet. keep the vibe going and i will match it.`,
    `${mention}you got my attention for a second. make the next line count.`
  ][index % 3];
}

function hasPrivatePromotion(value) {
  return PRIVATE_PROMO_PATTERN.test(String(value || ""));
}

function cleanGoalsForRequest(goals, request) {
  const cleanRequest = normalizeGoalRequest(request);
  const cleaned = [];

  for (const [index, goal] of (goals || []).entries()) {
    const description = sanitizeText(goal?.description || goal?.reward || goal?.unlock || "", 180);
    const chatLine = sanitizeText(goal?.chat_line || goal?.chatLine || goal?.promo || goal?.line || description, 220);
    const candidate = {
      name: sanitizeText(goal?.name || `Goal ${index + 1}`, 42),
      amount: clampInt(goal?.amount, 50, 100000, 250 * (index + 1)),
      description: "",
      chat_line: chatLine,
      category: sanitizeScalar(goal?.category || cleanRequest.theme || "game", 50)
    };
    const combined = `${candidate.name} ${description} ${candidate.chat_line}`;
    if (hasPrivatePromotion(combined) || looksLikeRawJsonText(combined)) {
      cleaned.push(publicGoalFallback(index, cleanRequest));
    } else if (candidate.name && candidate.chat_line) {
      cleaned.push({
        ...candidate
      });
    }
  }

  while (cleaned.length < GOAL_COUNT) {
    cleaned.push(publicGoalFallback(cleaned.length, cleanRequest));
  }

  return cleaned.slice(0, GOAL_COUNT);
}

function looksLikeRawJsonText(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return (
    /[{[]\s*"?goals"?\s*:/.test(text) ||
    /"\s*(name|amount|description|chat_line|chatLine|category)"\s*:/.test(text) ||
    /\\?"goals\\?"\s*:/.test(text)
  );
}

function publicGoalFallback(index, request) {
  const total = clampInt(request.targetTokens, 300, 100000, 1500);
  const amounts = goalAmountsForTarget(total);
  const templates = [
    {
      name: "Room Warmup",
      description: "Unlock a small public-room action that gets chat moving.",
      line: (amount) => `${amount} tk starts Room Warmup. Help me wake the chat up.`
    },
    {
      name: "Tip Vote",
      description: "Unlock a room vote from creator-approved options.",
      line: (amount) => `${amount} tk opens Tip Vote. Tip your choice and make it count.`
    },
    {
      name: "Top Helper Moment",
      description: "Unlock a top-helper choice for the next public room moment.",
      line: (amount) => `${amount} tk unlocks Top Helper Moment. Whoever carries it gets to steer the next room move.`
    },
    {
      name: "Vibe Check",
      description: "Unlock a quick room reset with a clear chat prompt.",
      line: (amount) => `${amount} tk hits Vibe Check. Tell me the mood and keep the room moving.`
    },
    {
      name: "Final Push",
      description: "Unlock the final public-room goal moment.",
      line: (amount) => `${amount} tk closes Final Push. Carry the room over the line and make it count.`
    }
  ];
  const template = templates[index % templates.length];
  return {
    name: template.name,
    amount: amounts[index % amounts.length],
    description: "",
    chat_line: template.line(amounts[index % amounts.length]),
    category: ["toy", "pose", "game"].includes(request.theme) ? request.theme : "game"
  };
}

function polishLine(line, tone) {
  let out = sanitizeText(line, 260).replace(/\s+/g, " ").trim();
  out = out.replace(/\s+([,.!?])/g, "$1");
  if (!out) return "";
  if (tone === "short" && out.length > 145) {
    const first = out.split(/(?<=[.!?])\s+/)[0] || out;
    out = first.length <= 145 ? first : `${first.slice(0, 142).trim()}...`;
  }
  return out;
}

export function generateTipReaction({ amount = 0, viewerType = "registered", tone = "playful" } = {}) {
  const tokens = clampInt(amount, 0, 100000, 0);
  const viewer = viewerLabel(viewerType);
  if (tokens >= 1000) {
    return `That was a serious tip, ${viewer}. You just took over the room for a second. Tell me the next move.`;
  }
  if (tokens >= 200) {
    return `Mmm, thank you ${viewer}. That got my attention. Check the next goal if you want to keep steering me.`;
  }
  if (tokens > 0) {
    return `Thank you ${viewer}. I see you helping the room wake up.`;
  }
  return tone === "short"
    ? "First tip gets my attention."
    : "First tip starts the momentum. Who wants to wake the room up?";
}

export function generateGoals(input = {}, context = {}) {
  // This local version is now intentionally simple and non-"automation" feeling.
  // The real intelligence for goals is in the Smart Copilot (high-reasoning AI path above).
  // Local fallback only exists for offline/no-key situations and produces clean, progressive, speakable goals.
  const request = normalizeGoalRequest(input);
  const memory = normalizeMemory(context.memory || {});
  const total = clampInt(request.targetTokens, 300, 100000, 1500);
  const amounts = goalAmountsForTarget(total);

  const base = ["Warm Up", "Getting Hot", "Vibe Control", "Push It", "Finish Strong"];
  const adj = request.style === "bold" ? "Hard" : request.style === "soft" ? "Slow" : "";

  const goals = amounts.map((amt, i) => {
    const name = sanitizeText(`${base[i] || "Step"} ${adj}`.trim(), 42);
    const line = sanitizeText(
      `${name} — ${amt} tk. ${i === 0 ? "Let's start slow and build." : i > 2 ? "Who is finishing this with me?" : "Keep me going, the room decides."}`,
      220
    );
    return { name, amount: amt, chat_line: line, category: request.theme };
  });

  return cleanGoalsForRequest(goals, request);
}

function goalTemplatePacks() {
  return {
    toy: [
      [
        goalTemplate(
          "First Buzz Check",
          "Unlock a short toy buzz plus a named thank-you in chat.",
          (amount) => `Goal 1: First Buzz Check is ${amount} tk. Start the toy and I will call out who woke me up.`
        ),
        goalTemplate(
          "Room Controls the Vibe",
          "Unlock a longer toy buzz while the room votes soft, playful, or firm.",
          (amount) => `At ${amount} tk, the room gets to pick the vibe while the toy runs. Vote with your tips.`
        ),
        goalTemplate(
          "Control Finale",
          "Unlock the strongest toy round and a top-helper room choice.",
          (amount) => `Final goal is ${amount} tk: strongest toy round, top helper gets my full attention next.`
        )
      ],
      [
        goalTemplate(
          "Tap to Wake Me",
          "Unlock a quick buzz and a playful reset for the whole room.",
          (amount) => `${amount} tk wakes me up. Small tips count, brave ones get noticed.`
        ),
        goalTemplate(
          "No Hands Minute",
          "Unlock a one-minute hands-off tease while the room keeps the buzz going.",
          (amount) => `${amount} tk unlocks the no-hands minute. Keep the buzz alive and I will try not to break.`
        ),
        goalTemplate(
          "Top Tipper Takes Control",
          "Unlock a focused control round led by the top contributor.",
          (amount) => `${amount} tk and the top tipper gets to steer the final control round from the menu.`
        )
      ],
      [
        goalTemplate(
          "Warmup Buzz",
          "Unlock a gentle buzz and a flirty room check-in.",
          (amount) => `Warmup Buzz is ${amount} tk. Help me start sweet before the room gets louder.`
        ),
        goalTemplate(
          "Buzz Vote",
          "Unlock a room vote for the next toy mood.",
          (amount) => `${amount} tk opens Buzz Vote. Tip with your mood: sweet, bold, or bossy.`
        ),
        goalTemplate(
          "Buzz Boss Finale",
          "Unlock a final toy round and top-tipper shoutout.",
          (amount) => `${amount} tk closes Buzz Boss Finale. Whoever carries it gets the loudest thank-you.`
        )
      ]
    ],
    pose: [
      [
        goalTemplate(
          "Pose Vote Opens",
          "Unlock a room vote for the next pose.",
          (amount) => `${amount} tk opens Pose Vote. Tip your choice and I will move with the room.`
        ),
        goalTemplate(
          "Slow Turn Reset",
          "Unlock a slow pose change and a fresh room angle.",
          (amount) => `${amount} tk gets a slow turn reset. Make the room earn the view.`
        ),
        goalTemplate(
          "Favorite Angle Finale",
          "Unlock the creator's favorite pose and a top-helper callout.",
          (amount) => `${amount} tk unlocks my favorite angle. Top helper gets the credit in chat.`
        )
      ],
      [
        goalTemplate(
          "Choose My Side",
          "Unlock a left, right, or front pose vote.",
          (amount) => `${amount} tk and the room chooses the side. Vote with tokens, not whispers.`
        ),
        goalTemplate(
          "Hold That Pose",
          "Unlock a timed pose hold while chat keeps the energy moving.",
          (amount) => `${amount} tk makes me hold the pose. Keep talking so I know who is watching.`
        ),
        goalTemplate(
          "Photo-Finish Pose",
          "Unlock a polished finale pose with a room countdown.",
          (amount) => `${amount} tk for the photo-finish pose. Countdown in chat when we get close.`
        )
      ]
    ],
    game: [
      [
        goalTemplate(
          "Truth Token",
          "Unlock one playful truth answer chosen from safe room prompts.",
          (amount) => `${amount} tk unlocks Truth Token. Ask it cute, keep it respectful, and I will answer.`
        ),
        goalTemplate(
          "Room Vote Dare",
          "Unlock a safe room-vote dare from two creator-approved options.",
          (amount) => `${amount} tk opens Room Vote Dare. I give two choices, you vote with tips.`
        ),
        goalTemplate(
          "Winner Picks Prompt",
          "Unlock a top-tipper prompt that guides the next room moment.",
          (amount) => `${amount} tk and the top helper picks the next prompt from my safe list.`
        )
      ],
      [
        goalTemplate(
          "Emoji Mood Vote",
          "Unlock a room mood vote using chat emojis.",
          (amount) => `${amount} tk starts Emoji Mood Vote. Drop the mood and tip to make it count.`
        ),
        goalTemplate(
          "Spin the Menu",
          "Unlock a random menu-friendly action chosen by the creator.",
          (amount) => `${amount} tk spins the menu. I pick the safe surprise, you make it happen.`
        ),
        goalTemplate(
          "Top Helper Rule",
          "Unlock a temporary room rule chosen by the top contributor.",
          (amount) => `${amount} tk gives top helper a room rule, as long as it stays cute and respectful.`
        )
      ]
    ]
  };
}

function goalTemplate(name, description, chatLine) {
  return {
    name,
    description: () => description,
    chatLine
  };
}

function goalAmountsForTarget(total) {
  const ratios = [0.16, 0.32, 0.52, 0.74, 1];
  const amounts = ratios.map((ratio, index) => Math.max(100 + index * 50, Math.round(total * ratio)));
  for (let index = 1; index < amounts.length; index += 1) {
    if (amounts[index] <= amounts[index - 1]) amounts[index] = amounts[index - 1] + 75;
  }
  return amounts;
}

function chooseGoalTemplates(packs, recentText, style) {
  const primary = chooseFreshGoalPack(packs, recentText, style);
  const used = new Set(primary.map((item) => item.name));
  const extras = packs
    .flat()
    .filter((item) => !used.has(item.name));
  return [...primary, ...extras].slice(0, GOAL_COUNT);
}

function chooseFreshGoalPack(packs, recentText, style) {
  const offset = Math.floor(Date.now() / 60000) % Math.max(1, packs.length);
  const scored = packs.map((pack, index) => {
    const phrase = pack.map((item) => `${item.name} ${item.description(style)}`).join(" ").toLowerCase();
    const words = phrase.split(/\W+/).filter((word) => word.length > 4);
    const repeatScore = words.reduce((score, word) => score + (recentText.includes(word) ? 1 : 0), 0);
    return { pack, score: repeatScore, index };
  });
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      ((a.index - offset + packs.length) % packs.length) -
        ((b.index - offset + packs.length) % packs.length)
  );
  return scored[0]?.pack || packs[0];
}

export function generateWakeLine({ tone = "playful" } = {}) {
  const lines = {
    chill: [
      "Quiet room check. Who is hanging out with me tonight?",
      "I see the room watching. Come say hi before the next goal starts.",
      "Soft reset. Give me one word for the vibe tonight."
    ],
    playful: [
      "I see all these quiet names. Who is brave enough to start the room?",
      "First good line gets my attention. First tip gets the room moving.",
      "The room is too quiet for how many of you are watching."
    ],
    flirty: [
      "I like a quiet room, but I like a brave viewer more.",
      "Someone come make this room feel less innocent.",
      "Say hi nicely and I might keep my eyes on you."
    ],
    dominant: [
      "Room, wake up. Good manners first, menu second.",
      "If you are watching, participate. I like useful attention.",
      "Someone make a smart move and start the next goal."
    ]
  };
  const group = lines[tone] || lines.playful;
  return group[Math.floor(Math.random() * group.length)];
}

export function rewriteReply(text = "", mode = "shorter") {
  const clean = sanitizeText(text, 500);
  if (!clean) return "";
  if (mode === "shorter") {
    const firstSentence = clean.split(/(?<=[.!?])\s+/)[0] || clean;
    return firstSentence.length <= 130 ? firstSentence : `${firstSentence.slice(0, 127).trim()}...`;
  }
  if (mode === "warmer") {
    return clean.includes("babe") ? clean : `${clean} I see you, babe.`;
  }
  if (mode === "firmer") {
    return `Keep it respectful and menu-based. ${clean}`;
  }
  return clean;
}

export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  return Math.ceil(text.length / 4);
}

export function sanitizeText(value, maxLength = 500) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function sanitizeScalar(value, maxLength = 120) {
  return sanitizeText(value, maxLength).replace(/[<>{}[\]\\]/g, "");
}

export function normalizeRequest(input = {}) {
  return {
    message: sanitizeText(input.message || input.viewerMessage || "", 700),
    viewerName: sanitizeScalar(input.viewerName || input.viewer || "", 60),
    viewerType: normalizeEnum(input.viewerType, VIEWER_TYPES, "registered"),
    intent: normalizeEnum(input.intent, INTENTS, "reply"),
    tone: normalizeEnum(input.tone, TONES, "playful"),
    amount: Number.isFinite(Number(input.amount)) ? Number(input.amount) : 0,
    instruction: sanitizeText(input.instruction || "", 700),
    source: sanitizeScalar(input.source || "manual", 40)
  };
}

export function normalizeGoalRequest(input = {}) {
  const theme = sanitizeScalar(input.theme || "toy", 50).toLowerCase();
  const style = sanitizeScalar(input.style || "balanced", 50).toLowerCase();
  return {
    theme: ["toy", "pose", "game"].includes(theme) ? theme : "game",
    targetTokens: clampInt(input.targetTokens || input.target || input.amount, 300, 100000, 1500),
    style: ["balanced", "soft", "bold"].includes(style) ? style : "balanced",
    roomMood: sanitizeText(input.roomMood || "", 240),
    latestMessage: sanitizeText(input.latestMessage || input.message || "", 300)
  };
}

export function normalizeMemory(input = {}) {
  return {
    summary: sanitizeText(input.summary || "", 1200),
    turns: Array.isArray(input.turns) ? input.turns : [],
    viewers: input.viewers && typeof input.viewers === "object" ? input.viewers : {},
    generated: Array.isArray(input.generated) ? input.generated : [],
    lastPrunedAt: Number(input.lastPrunedAt) || 0
  };
}

function normalizeEnum(value, list, fallback) {
  const clean = sanitizeScalar(value || "", 80);
  return list.some((item) => item.value === clean) ? clean : fallback;
}

function viewerLabel(viewerType) {
  const match = VIEWER_TYPES.find((item) => item.value === viewerType);
  return match ? match.label.toLowerCase() : "viewer";
}

function classifyMessage(text) {
  const clean = sanitizeText(text, 300).toLowerCase();
  if (!clean) return "idle";
  if (/\b(underage|minor|child|kid|teen|dox|address|blackmail|drugged|asleep)\b/.test(clean)) {
    return "unsafe";
  }
  if (/\b(tip|token|tk|menu|goal|buzz)\b/.test(clean)) return "tip";
  if (/\b(hi|hello|hey|sup|good evening|good morning)\b/.test(clean)) return "hello";
  if (/\b(free|show me|do it now|shut up|stupid|bitch|prove)\b/.test(clean)) return "pushy";
  return "normal";
}

function parseStructuredReplies(text) {
  const parsed = parseJsonFromText(text);
  if (parsed !== null) {
    const replies = coerceReplies(parsed.replies || parsed.candidates || parsed);
    if (replies.length) return replies;
  }
  return coerceReplies(text);
}

function parseStructuredGoals(text) {
  const parsed = parseJsonFromText(text);
  if (parsed !== null) {
    const goals = coerceGoals(parsed.goals || parsed.items || parsed);
    if (goals.length) return goals;
  }
  return coerceGoals(text);
}

function coerceReplies(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : item?.text || item?.reply || ""))
      .map((item) => sanitizeText(item, 280))
      .filter(Boolean)
      .slice(0, 3);
  }
  if (value && typeof value === "object") {
    return coerceReplies(value.replies || value.items || Object.values(value));
  }
  return String(value || "")
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-*\d.)"]+\s*/, "").replace(/"$/, ""))
    .map((line) => sanitizeText(line, 280))
    .filter((line) => line.length > 10)
    .slice(0, 3);
}

function coerceGoals(value) {
  const parsedString = typeof value === "string" ? parseJsonFromText(value) : null;
  if (parsedString !== null) {
    return coerceGoals(parsedString.goals || parsedString.items || parsedString);
  }
  if (Array.isArray(value)) {
    return value
      .flatMap((item, index) => {
        const parsedItem = typeof item === "string" ? parseJsonFromText(item) : null;
        if (parsedItem !== null) {
          return coerceGoals(parsedItem.goals || parsedItem.items || parsedItem);
        }
        if (typeof item === "string") {
          return [{
            name: `Goal ${index + 1}`,
            amount: 250 * (index + 1),
            description: "",
            chat_line: item,
            category: "game"
          }];
        }
        const description = sanitizeText(item?.description || item?.reward || item?.unlock || "", 180);
        const chatLine = sanitizeText(item?.chat_line || item?.chatLine || item?.promo || item?.line || description, 220);
        return [{
          name: sanitizeText(item?.name || item?.title || `Goal ${index + 1}`, 42),
          amount: clampInt(item?.amount || item?.tokens || item?.target, 50, 100000, 250 * (index + 1)),
          description: "",
          chat_line: chatLine,
          category: sanitizeScalar(item?.category || item?.theme || "game", 50)
        }];
      })
      .filter((goal) => goal.name && goal.chat_line)
      .map((goal) => ({
        ...goal,
        chat_line: goal.chat_line || `${goal.name} is ${goal.amount} tk.`
      }))
      .slice(0, GOAL_COUNT);
  }
  if (value && typeof value === "object") {
    return coerceGoals(value.goals || value.items || Object.values(value));
  }
  return String(value || "")
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-*\d.)"]+\s*/, "").replace(/"$/, "").trim())
    .filter((line) => line.length > 10)
    .slice(0, GOAL_COUNT)
    .map((line, index) => ({
      name: `Goal ${index + 1}`,
      amount: 250 * (index + 1),
      description: "",
      chat_line: sanitizeText(line, 220),
      category: "game"
    }));
}

function parseJsonFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const direct = tryParseJson(raw);
  if (direct !== null) return direct;

  const fenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const fencedParsed = tryParseJson(fenced);
  if (fencedParsed !== null) return fencedParsed;

  const extracted = extractFirstJsonValue(fenced);
  return extracted ? tryParseJson(extracted) : null;
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractFirstJsonValue(text) {
  const raw = String(text || "");
  const start = raw.search(/[\[{]/);
  if (start < 0) return "";

  const opener = raw[start];
  const stack = [opener === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < raw.length; index += 1) {
    const char = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (char !== stack[stack.length - 1]) return "";
      stack.pop();
      if (!stack.length) return raw.slice(start, index + 1);
    }
  }

  return "";
}

function extractOpenAIText(body) {
  if (typeof body?.output_text === "string" && body.output_text.trim()) {
    return body.output_text.trim();
  }
  const messages = Array.isArray(body?.output) ? body.output : [];
  const parts = [];
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") parts.push(part.text);
      if (typeof part?.output_text === "string") parts.push(part.output_text);
    }
  }
  return parts.join("\n").trim();
}

function openAiHeaders(apiKey) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${normalizeApiKey(apiKey)}`
  };
  return headers;
}

function backendHeaders(settings = {}) {
  const headers = { "content-type": "application/json" };
  if (settings.backendAuthToken) {
    headers["x-es-copilot-backend-token"] = normalizeApiKey(settings.backendAuthToken);
  }
  return headers;
}

async function fetchWithModelFallback(url, buildOptions, primaryModel, fallbackModel) {
  const primary = sanitizeScalar(primaryModel, 100);
  const fallback = sanitizeScalar(fallbackModel, 100);
  let response = await fetchWithRetry(url, buildOptions(primary), { maxAttempts: 3 });
  if (fallback && fallback !== primary && (await isModelAccessFailure(response))) {
    response = await fetchWithRetry(url, buildOptions(fallback), { maxAttempts: 2 });
    return { response, model: fallback, fallbackUsed: true };
  }
  return { response, model: primary, fallbackUsed: false };
}

async function isModelAccessFailure(response) {
  if (response.ok || ![400, 403, 404].includes(response.status)) return false;
  const text = await response
    .clone()
    .text()
    .catch(() => "");
  return /\b(model|access|available|permission|entitled|not found)\b/i.test(text);
}

async function fetchWithRetry(
  url,
  options,
  { maxAttempts = 3, timeoutMs = REQUEST_TIMEOUT_MS, attemptTimeoutMs = ATTEMPT_TIMEOUT_MS } = {}
) {
  let lastResponse = null;
  let lastError = null;
  const startedAt = Date.now();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.min(attemptTimeoutMs, remainingMs));
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      lastResponse = response;
      if (response.ok || NON_RETRY_STATUSES.has(response.status) || !RETRY_STATUSES.has(response.status)) {
        return response;
      }
    } catch (error) {
      lastError =
        error?.name === "AbortError"
          ? new Error(`AI request timed out after ${Math.ceil(Math.min(attemptTimeoutMs, remainingMs) / 1000)} seconds.`)
          : error;
    } finally {
      clearTimeout(timeoutId);
    }
    if (attempt < maxAttempts - 1) {
      const delay = Math.min(backoffMs(attempt), Math.max(0, timeoutMs - (Date.now() - startedAt)));
      if (delay > 0) await sleep(delay);
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError || new Error(`AI request timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`);
}

function backoffMs(attempt) {
  const base = 350 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 180);
  return base + jitter;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function responseErrorText(response) {
  const requestId = response.headers.get("request-id") || "";
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json();
    message = body?.error?.message || body?.message || message;
  } catch {
    try {
      const text = await response.text();
      if (text) message = text.slice(0, 300);
    } catch {
      // Keep default message.
    }
  }
  return requestId ? `${message} (request-id: ${requestId})` : message;
}

function normalizeBackendUrl(url) {
  const clean = sanitizeScalar(url, 300).replace(/\/+$/, "");
  if (!clean) return "";
  if (/\/generate$/i.test(clean)) return clean;
  return `${clean}/generate`;
}

function buildOpenAIResponsesUrl(baseUrl = DEFAULT_SETTINGS.apiBaseUrl) {
  const clean = sanitizeScalar(baseUrl || DEFAULT_SETTINGS.apiBaseUrl, 300).replace(/\/+$/, "");
  if (/\/v1\/responses$/i.test(clean)) return clean;
  if (/\/v1$/i.test(clean)) return `${clean}/responses`;
  return `${clean}/v1/responses`;
}

function readableError(error) {
  if (!error) return "Unknown error";
  if (error instanceof AiRequestError) {
    return `${error.status || "request"}: ${error.message}`;
  }
  return error.message || String(error);
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

class AiRequestError extends Error {
  constructor(message, status, requestId = "") {
    super(message);
    this.name = "AiRequestError";
    this.status = status;
    this.requestId = requestId;
  }
}

export const __testing = Object.freeze({
  fetchWithRetry,
  isModelAccessFailure
});
