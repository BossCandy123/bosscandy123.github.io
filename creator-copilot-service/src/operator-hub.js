"use strict";

const MAX_FEED_ITEMS = 18;
const MAX_QUEUE_ITEMS = 9;
const MAX_DIAGNOSTICS = 14;
const MAX_COMMANDS = 30;
const COMMAND_LEASE_MS = 12_000;
const BRIDGE_STALE_MS = 12_000;
const COMMAND_TYPES = new Set(["paste_text"]);

class OperatorHub {
  constructor({ provider, serviceName = "Creator Copilot", now = () => new Date() }) {
    this.provider = provider;
    this.serviceName = serviceName;
    this.now = now;
    this.state = createInitialState({
      providerName: provider?.name || "offline",
      model: provider?.model || "",
      now: this.now()
    });
  }

  snapshot() {
    const snapshot = clone(this.state);
    const now = this.now().getTime();
    const lastSignalAt = Math.max(
      Number(snapshot.bridge?.lastEventAt || 0),
      Number(snapshot.bridge?.lastCommandPollAt || 0)
    );
    snapshot.bridge.connected = lastSignalAt > 0 && now - lastSignalAt <= BRIDGE_STALE_MS;
    snapshot.bridge.lastSignalAt = lastSignalAt;
    return snapshot;
  }

  async ingestEvent(input = {}) {
    const event = normalizeEvent(input, this.now());
    this.#applyEvent(event);

    let suggestions = [];
    try {
      suggestions = await this.#generateSuggestions(event);
    } catch (error) {
      this.recordDiagnostic("operator_ai_error", error.message || "Suggestion generation failed", {
        eventType: event.type
      });
      throw error;
    }

    if (suggestions.length) {
      const nextItems = suggestions.map((text, index) => ({
        id: `queue_${event.id}_${index + 1}`,
        kind: queueKindFromEvent(event.type),
        label: queueLabelFromEvent(event.type, index),
        text,
        source: this.provider?.name || "local",
        viewerName: event.viewerName,
        ts: event.ts
      }));
      this.state.queue = [...nextItems, ...(this.state.queue || [])].slice(0, MAX_QUEUE_ITEMS);
      this.state.metrics.suggestions += nextItems.length;
    }

    return {
      ok: true,
      event,
      suggestions,
      state: this.snapshot()
    };
  }

  async generateDashboard(input = {}) {
    const request = normalizeDashboardRequest(input);
    const taskInput = buildDashboardTaskInput(request, this.state);
    if (!taskInput || typeof this.provider?.generate !== "function") {
      throw operatorError(503, "ai_provider_unavailable", "OpenAI suggestion provider is unavailable");
    }

    let suggestions = [];
    try {
      const result = await this.provider.generate(taskInput);
      suggestions = Array.isArray(result?.suggestions)
        ? result.suggestions.map((item) => cleanText(item, 220)).filter(Boolean)
        : [];
    } catch (error) {
      this.recordDiagnostic("operator_ai_error", error.message || "Dashboard generation failed", {
        task: request.task
      });
      throw error;
    }

    if (!suggestions.length) {
      throw operatorError(502, "ai_provider_error", "OpenAI returned no usable suggestions");
    }

    const now = this.now().getTime();
    const queueItems = suggestions.map((text, index) => ({
      id: `queue_dashboard_${now}_${index + 1}`,
      kind: request.kind,
      label: dashboardLabelFromTask(request.task, index),
      text,
      source: this.provider?.name || "openai",
      viewerName: request.viewerName,
      ts: now
    }));
    this.state.queue = [...queueItems, ...(this.state.queue || [])].slice(0, MAX_QUEUE_ITEMS);
    this.state.metrics.suggestions += queueItems.length;
    this.state.metrics.localEvents += 1;
    this.state.feed = [
      {
        id: `feed_dashboard_${now}`,
        type: request.task,
        title: dashboardFeedTitle(request.task),
        subtitle: [request.viewerName, "dashboard"].filter(Boolean).join(" | "),
        message: request.message,
        ts: now
      },
      ...(this.state.feed || [])
    ].slice(0, MAX_FEED_ITEMS);
    this.state.strategy = nextStrategy(this.state.strategy, {
      type: dashboardEventTypeFromTask(request.task),
      viewerName: request.viewerName,
      message: request.message,
      roomTitle: request.roomTitle,
      goalSummary: request.goalSummary,
      pace: request.pace
    });

    if (request.roomTitle) this.state.room.title = request.roomTitle;
    if (request.goalSummary) this.state.room.goal = request.goalSummary;
    if (request.viewerName) this.state.room.lastViewer = request.viewerName;
    if (request.message) this.state.room.lastMessage = request.message;
    if (request.pace) this.state.room.pace = request.pace;
    this.state.room.lastEventAt = now;

    return {
      ok: true,
      suggestions,
      state: this.snapshot()
    };
  }

  enqueueCommand(input = {}) {
    const type = cleanText(input.type || "paste_text", 50).toLowerCase();
    if (!COMMAND_TYPES.has(type)) {
      throw operatorError(400, "invalid_operator_command", `Unsupported operator command: ${type}`);
    }
    const text = cleanText(input.text, 500);
    if (!text) {
      throw operatorError(400, "invalid_operator_command", "Command text is required");
    }
    const now = this.now().getTime();
    const command = {
      id: `cmd_${now}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      text,
      queueItemId: cleanText(input.queueItemId, 100),
      source: cleanText(input.source || "dashboard", 40),
      status: "pending",
      attempts: 0,
      createdAt: now,
      deliveredAt: 0,
      leaseUntil: 0,
      ackAt: 0,
      message: ""
    };
    this.state.commands = [command, ...(this.state.commands || [])].slice(0, MAX_COMMANDS);
    this.state.metrics.commandsQueued += 1;
    this.#setQueueCommandStatus(command.queueItemId, "pending", "Waiting for extension");
    return {
      ok: true,
      command: clone(command),
      state: this.snapshot()
    };
  }

  nextCommand(clientId = "extension") {
    const now = this.now().getTime();
    this.state.bridge.lastCommandPollAt = now;
    this.state.bridge.source = cleanText(clientId || "extension", 60);

    const command = (this.state.commands || [])
      .slice()
      .reverse()
      .find(
        (item) =>
          item.status === "pending" ||
          (item.status === "delivered" && Number(item.leaseUntil || 0) <= now)
      );
    if (!command) {
      return {
        ok: true,
        command: null,
        state: this.snapshot()
      };
    }

    command.status = "delivered";
    command.attempts += 1;
    command.deliveredAt = now;
    command.leaseUntil = now + COMMAND_LEASE_MS;
    this.#setQueueCommandStatus(command.queueItemId, "delivered", "Extension is loading this line");
    return {
      ok: true,
      command: clone(command),
      state: this.snapshot()
    };
  }

  acknowledgeCommand(commandId, input = {}) {
    const command = (this.state.commands || []).find((item) => item.id === commandId);
    if (!command) {
      throw operatorError(404, "operator_command_not_found", "Operator command was not found");
    }
    const status = cleanText(input.status || "failed", 30).toLowerCase();
    if (!["succeeded", "failed"].includes(status)) {
      throw operatorError(400, "invalid_operator_command_ack", "Command status must be succeeded or failed");
    }
    command.status = status;
    command.ackAt = this.now().getTime();
    command.leaseUntil = 0;
    command.message = cleanText(input.message || "", 220);
    if (status === "succeeded") {
      this.state.metrics.commandsSucceeded += 1;
      this.#setQueueCommandStatus(command.queueItemId, "succeeded", command.message || "Loaded in StripChat");
    } else {
      this.state.metrics.commandsFailed += 1;
      this.#setQueueCommandStatus(command.queueItemId, "failed", command.message || "Could not load in StripChat");
    }
    this.recordDiagnostic(
      status === "succeeded" ? "operator_command_succeeded" : "operator_command_failed",
      command.message || `${command.type} ${status}`,
      { commandId: command.id, attempts: command.attempts }
    );
    return {
      ok: true,
      command: clone(command),
      state: this.snapshot()
    };
  }

  dismissQueueItem(queueItemId) {
    const before = this.state.queue.length;
    this.state.queue = this.state.queue.filter((item) => item.id !== queueItemId);
    if (this.state.queue.length === before) {
      throw operatorError(404, "operator_queue_item_not_found", "Queue item was not found");
    }
    return {
      ok: true,
      state: this.snapshot()
    };
  }

  enqueueManual(input = {}) {
    const text = cleanText(input.text || input.message || "", 500);
    if (!text) {
      throw operatorError(400, "invalid_manual_enqueue", "Text is required");
    }
    const now = this.now().getTime();
    const item = {
      id: `queue_manual_${now}_${Math.random().toString(36).slice(2, 8)}`,
      kind: cleanText(input.kind || "reply", 30),
      label: cleanText(input.label || "Manual", 40),
      text,
      source: cleanText(input.source || "manual", 40),
      viewerName: cleanText(input.viewerName || "", 80),
      ts: now
    };
    this.state.queue = [item, ...(this.state.queue || [])].slice(0, MAX_QUEUE_ITEMS);
    this.state.metrics.localEvents = (this.state.metrics.localEvents || 0) + 1;
    this.state.feed = [
      {
        id: `feed_manual_${now}`,
        type: "manual_add",
        title: "Manual line added",
        subtitle: [item.source, item.viewerName].filter(Boolean).join(" | "),
        message: text.slice(0, 120),
        ts: now
      },
      ...(this.state.feed || [])
    ].slice(0, MAX_FEED_ITEMS);
    return {
      ok: true,
      item,
      state: this.snapshot()
    };
  }

  updateQueueItemText(queueItemId, newText) {
    const item = (this.state.queue || []).find((entry) => entry.id === queueItemId);
    if (!item) {
      throw operatorError(404, "operator_queue_item_not_found", "Queue item was not found");
    }
    item.text = cleanText(newText, 500);
    item.edited = true;
    return {
      ok: true,
      state: this.snapshot()
    };
  }

  reorderQueue(newOrderIds) {
    // newOrderIds is array of ids in desired priority order (first = highest priority)
    if (!Array.isArray(newOrderIds) || !newOrderIds.length) {
      return { ok: true, state: this.snapshot() };
    }
    const current = this.state.queue || [];
    const idToItem = new Map(current.map(item => [item.id, item]));
    const reordered = [];
    const seen = new Set();

    for (const id of newOrderIds) {
      if (idToItem.has(id) && !seen.has(id)) {
        reordered.push(idToItem.get(id));
        seen.add(id);
      }
    }
    // append any that were not in the new order (safety)
    for (const item of current) {
      if (!seen.has(item.id)) reordered.push(item);
    }
    this.state.queue = reordered.slice(0, MAX_QUEUE_ITEMS);
    return {
      ok: true,
      state: this.snapshot()
    };
  }

  recordDiagnostic(type, message, meta = {}) {
    this.state.diagnostics = [
      {
        id: `diag_${Date.now()}`,
        type: cleanText(type, 60),
        message: cleanText(message, 220),
        meta,
        ts: Date.now()
      },
      ...(this.state.diagnostics || [])
    ].slice(0, MAX_DIAGNOSTICS);
  }

  #setQueueCommandStatus(queueItemId, commandStatus, commandMessage) {
    if (!queueItemId) return;
    const item = (this.state.queue || []).find((entry) => entry.id === queueItemId);
    if (!item) return;
    item.commandStatus = commandStatus;
    item.commandMessage = cleanText(commandMessage, 180);
  }

  #applyEvent(event) {
    this.state.metrics.events += 1;
    if (event.source === "extension") {
      this.state.metrics.extensionEvents += 1;
      this.state.bridge.connected = true;
      this.state.bridge.lastEventAt = event.ts;
      this.state.bridge.source = "extension";
    } else {
      this.state.metrics.localEvents += 1;
    }

    if (event.roomTitle) this.state.room.title = event.roomTitle;
    if (event.goalSummary) this.state.room.goal = event.goalSummary;
    if (event.viewerName) this.state.room.lastViewer = event.viewerName;
    if (event.message) this.state.room.lastMessage = event.message;
    if (event.amount > 0) this.state.room.lastTipAmount = event.amount;
    if (event.pace) this.state.room.pace = event.pace;
    this.state.room.lastEventAt = event.ts;

    this.state.feed = [toFeedItem(event), ...(this.state.feed || [])].slice(0, MAX_FEED_ITEMS);
    this.state.strategy = nextStrategy(this.state.strategy, event);
  }

  async #generateSuggestions(event) {
    const taskInput = buildTaskInput(event);
    if (!taskInput || typeof this.provider?.generate !== "function") {
      throw operatorError(503, "ai_provider_unavailable", "OpenAI suggestion provider is unavailable");
    }
    const result = await this.provider.generate(taskInput);
    const suggestions = Array.isArray(result?.suggestions)
      ? result.suggestions.map((item) => cleanText(item, 220)).filter(Boolean)
      : [];
    if (!suggestions.length) {
      throw operatorError(502, "ai_provider_error", "OpenAI returned no usable suggestions");
    }
    return suggestions;
  }
}

function createInitialState({ providerName, model, now }) {
  const ts = now instanceof Date ? now.getTime() : Date.now();
  return {
    service: "operator-console",
    provider: providerName,
    model,
    mode: "assisted",
    room: {
      title: "Waiting for room signals",
      goal: "No goal captured yet",
      pace: "steady",
      lastViewer: "",
      lastMessage: "",
      lastTipAmount: 0,
      lastEventAt: ts
    },
    bridge: {
      connected: false,
      source: "dashboard",
      lastEventAt: 0,
      lastCommandPollAt: 0,
      lastSignalAt: 0
    },
    strategy: {
      focus: "momentum",
      nextMove: "Feed the room live events so the queue stays useful.",
      risk: "low"
    },
    metrics: {
      events: 0,
      extensionEvents: 0,
      localEvents: 0,
      suggestions: 0,
      commandsQueued: 0,
      commandsSucceeded: 0,
      commandsFailed: 0
    },
    queue: [],
    feed: [],
    diagnostics: [],
    commands: []
  };
}

function normalizeEvent(input = {}, now) {
  const room = input.room && typeof input.room === "object" ? input.room : {};
  const type = cleanText(input.type || "operator_ping", 50).toLowerCase();
  return {
    id: cleanText(input.id || `evt_${Date.now()}`, 80),
    type,
    source: cleanText(input.source || "dashboard", 40).toLowerCase(),
    viewerName: cleanText(input.viewerName || input.viewer || room.viewerName || "", 80),
    message: cleanText(input.message || input.text || room.message || "", 500),
    amount: numberOrZero(input.amount || room.amount),
    roomTitle: cleanText(input.roomTitle || room.title || "", 140),
    goalSummary: cleanText(input.goalSummary || room.goal || "", 160),
    pace: cleanText(input.pace || room.pace || "", 30).toLowerCase(),
    ts: numberOrZero(input.ts) || now.getTime()
  };
}

function buildTaskInput(event) {
  const sharedContext = [
    event.roomTitle ? `Room title: ${event.roomTitle}` : "",
    event.goalSummary ? `Goal: ${event.goalSummary}` : "",
    event.pace ? `Room pace: ${event.pace}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  if (event.type === "tip_received") {
    return {
      task: "reply_suggestions",
      message: `${event.viewerName || "A viewer"} tipped ${event.amount || "some"} tokens.`,
      context: `${sharedContext}\nWrite short, human live-chat responses that thank them and keep momentum.`,
      tone: "warm, playful, quick",
      persona: {
        name: "Operator",
        style: "short lines that sound typed live",
        rules: "Keep it non-graphic and conversational."
      }
    };
  }

  if (event.type === "room_slowdown") {
    return {
      task: "engagement_prompts",
      message: "The room is slowing down and needs a quick spark.",
      context: `${sharedContext}\nCreate short participation prompts that wake the room up fast.`,
      tone: "high-energy, teasing, concise",
      persona: {
        name: "Operator",
        style: "short prompts with momentum",
        rules: "Keep them brief enough to paste instantly."
      }
    };
  }

  if (event.type === "title_refresh") {
    return {
      task: "stream_titles",
      message: event.roomTitle || "Late-night chat and playful room energy",
      context: `${sharedContext}\nRefresh the title without sounding spammy.`,
      tone: "clean, clickable, natural",
      persona: {
        name: "Operator",
        style: "tight title lines",
        rules: "Avoid generic clickbait."
      }
    };
  }

  if (event.type === "viewer_returned") {
    return {
      task: "reply_suggestions",
      message: `${event.viewerName || "A regular"} came back into the room.`,
      context: `${sharedContext}\nMake it feel warm and familiar without being too long.`,
      tone: "welcoming, lightly playful",
      persona: {
        name: "Operator",
        style: "warm but not gushy",
        rules: "Keep it easy to send live."
      }
    };
  }

  return {
    task: "reply_suggestions",
    message: event.message || `${event.viewerName || "A viewer"} sent a room message.`,
    context: `${sharedContext}\nReply like a fast livestream operator helping keep chat moving.`,
    tone: "natural, quick, human",
    persona: {
      name: "Operator",
      style: "short live-chat lines",
      rules: "Keep it punchy and easy to paste."
    }
  };
}

function normalizeDashboardRequest(input = {}) {
  const task = cleanText(input.task || "reply_suggestions", 60).toLowerCase();
  const allowed = new Set(["reply_suggestions", "stream_titles", "engagement_prompts", "token_goals"]);
  if (!allowed.has(task)) {
    throw operatorError(400, "invalid_dashboard_task", `Unsupported dashboard task: ${task}`);
  }
  return {
    task,
    kind: dashboardKindFromTask(task),
    viewerName: cleanText(input.viewerName || "", 80),
    message: cleanText(input.message || "", 800),
    context: cleanText(input.context || "", 1600),
    tone: cleanText(input.tone || "natural, quick, human", 90),
    targetTokens: numberOrZero(input.targetTokens || input.target || 0),
    roomTitle: cleanText(input.roomTitle || "", 140),
    goalSummary: cleanText(input.goalSummary || "", 160),
    pace: cleanText(input.pace || "steady", 30).toLowerCase()
  };
}

function buildDashboardTaskInput(request, state = {}) {
  const room = state.room || {};
  const roomTitle = request.roomTitle || room.title || "";
  const goalSummary = request.goalSummary || room.goal || "";
  const sharedContext = [
    roomTitle ? `Room title: ${roomTitle}` : "",
    goalSummary ? `Goal: ${goalSummary}` : "",
    request.pace ? `Room pace: ${request.pace}` : "",
    request.context
  ]
    .filter(Boolean)
    .join("\n");

  if (request.task === "stream_titles") {
    return {
      task: "stream_titles",
      message: request.message || roomTitle || "Current live room needs a fresh title.",
      context: `${sharedContext}\nCreate titles for today's visible room title field.`,
      tone: request.tone || "clickable, natural, specific",
      persona: dashboardPersona("tight title lines", "No questions, no filler, no fake promises.")
    };
  }

  if (request.task === "engagement_prompts") {
    return {
      task: "engagement_prompts",
      message: request.message || "The room needs a short prompt to wake up chat.",
      context: `${sharedContext}\nCreate lines the creator can paste into public chat.`,
      tone: request.tone || "playful, concise, easy to answer",
      persona: dashboardPersona("short live-room prompts", "Keep every line quick and public-room safe.")
    };
  }

  if (request.task === "token_goals") {
    const target = request.targetTokens > 0 ? `${request.targetTokens} tokens` : "the requested total";
    return {
      task: "token_goals",
      message: request.message || `Build five public token goals for ${target}.`,
      context: `${sharedContext}\nTarget total: ${target}\nThe creator needs five goal lines only.`,
      tone: request.tone || "clear, playful, direct",
      persona: dashboardPersona(
        "short token-goal lines",
        "No descriptions. No private-room promotion. Include token amounts."
      )
    };
  }

  return {
    task: "reply_suggestions",
    message: request.message || `${request.viewerName || "A viewer"} sent a room message.`,
    context: `${sharedContext}\nReply like a fast livestream creator keeping the chat moving.`,
    tone: request.tone || "natural, quick, human",
    persona: dashboardPersona("short live-chat replies", "Reply to the exact message and keep it paste-ready.")
  };
}

function dashboardPersona(style, rules) {
  return {
    name: "EclipseStud",
    style,
    rules: `${rules} Keep suggestions respectful, consensual, non-graphic, and reviewed by the creator before sending.`
  };
}

function dashboardKindFromTask(task) {
  if (task === "stream_titles") return "title";
  if (task === "engagement_prompts") return "wake";
  if (task === "token_goals") return "goal";
  return "reply";
}

function dashboardLabelFromTask(task, index) {
  const base = {
    reply_suggestions: "Reply",
    stream_titles: "Title",
    engagement_prompts: "Room spark",
    token_goals: "Goal"
  }[task] || "Line";
  return `${base} ${index + 1}`;
}

function dashboardFeedTitle(task) {
  return {
    reply_suggestions: "Dashboard reply generation",
    stream_titles: "Dashboard title generation",
    engagement_prompts: "Dashboard room spark",
    token_goals: "Dashboard goal ladder"
  }[task] || "Dashboard generation";
}

function dashboardEventTypeFromTask(task) {
  if (task === "stream_titles") return "title_refresh";
  if (task === "engagement_prompts") return "room_slowdown";
  if (task === "token_goals") return "title_refresh";
  return "chat_turn";
}

function queueKindFromEvent(type) {
  if (type === "tip_received") return "tip";
  if (type === "room_slowdown") return "wake";
  if (type === "title_refresh") return "title";
  return "reply";
}

function queueLabelFromEvent(type, index) {
  const base = {
    tip_received: "Tip reaction",
    room_slowdown: "Wake line",
    title_refresh: "Title pass",
    viewer_returned: "Return line",
    chat_turn: "Reply"
  }[type] || "Reply";
  return `${base} ${index + 1}`;
}

function nextStrategy(current, event) {
  const strategy = { ...(current || {}) };
  strategy.risk = "low";
  strategy.focus = "momentum";
  strategy.nextMove = "Keep the feed moving and keep reply options short.";

  if (event.type === "tip_received") {
    strategy.focus = "conversion";
    strategy.nextMove = "Thank the tipper, then ask one follow-up that keeps momentum alive.";
    return strategy;
  }
  if (event.type === "room_slowdown") {
    strategy.focus = "engagement";
    strategy.nextMove = "Reset the room energy with a short prompt before the silence compounds.";
    return strategy;
  }
  if (event.type === "title_refresh") {
    strategy.focus = "positioning";
    strategy.nextMove = "Refresh the title while the room context is still current.";
    return strategy;
  }
  if (event.type === "viewer_returned") {
    strategy.focus = "retention";
    strategy.nextMove = "Use familiarity fast, then pull them into the next exchange.";
    return strategy;
  }
  if (event.message) {
    strategy.focus = "reply speed";
    strategy.nextMove = "Mirror their energy and give them a reason to answer again.";
  }
  return strategy;
}

function toFeedItem(event) {
  const amount = event.amount > 0 ? ` (${event.amount} tk)` : "";
  const message = event.message ? ` - ${event.message}` : "";
  return {
    id: event.id,
    type: event.type,
    title: `${prettyEventType(event.type)}${amount}`,
    subtitle: [event.viewerName, event.source].filter(Boolean).join(" | "),
    message,
    ts: event.ts
  };
}

function prettyEventType(type) {
  return String(type || "event")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function operatorError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

module.exports = {
  OperatorHub
};
