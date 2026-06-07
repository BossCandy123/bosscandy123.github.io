(() => {
  const HOST_ID = "es-copilot-topic-fixed-shadow-host";
  const OLD_HOST_IDS = ["es-copilot-shadow-host", "es-copilot-ai-fixed-shadow-host"];
  const BOOT_FLAG = "__esCopilotTopicFixedBooted";
  const PAGE_KEY_GUARD_SOURCE = "ES_COPILOT_PAGE_KEY_GUARD";
  const PORT_NAME = "es-room-panel";
  const PANEL_FOCUS_GRACE_MS = 250;
  const TURN_BATCH_DELAY_MS = 400;
  const CHAT_SELECTORS = [
    '[data-testid*="chat" i]',
    '[class*="chat" i]',
    '[class*="message" i]',
    '[class*="messages" i]',
    '[id*="chat" i]'
  ];

  if (window[BOOT_FLAG]) {
    window.dispatchEvent(new CustomEvent("es-copilot-show"));
    return;
  }
  window[BOOT_FLAG] = true;
  window.__esCopilotBooted = true;

  const state = {
    settings: null,
    hasApiKey: false,
    memory: null,
    diagnostics: [],
    replies: [],
    goals: [],
    topics: [],
    toolLines: [],
    favorites: [],
    source: "local",
    goalSource: "",
    topicSource: "",
    toolSource: "",
    toolKind: "tip_reaction",
    activeTab: "replies",
    intent: "reply",
    tone: "playful",
    viewerType: "registered",
    viewerName: "",
    draftMessage: "",
    goalTheme: "toy",
    goalTarget: 1500,
    goalStyle: "balanced",
    goalMood: "",
    topicBrief: "",
    topicStyle: "stream_title",
    topicTone: "playful",
    tipAmount: 100,
    tipViewer: "",
    selectedReply: 0,
    watchRoom: true,
    collapsed: false,
    busy: false,
    status: "Connecting...",
    lastScan: 0,
    seenLines: new Map(),
    // AI is the main part of the extension
    copilotAnalysis: "",
    copilotSuggestions: [],
    copilotQuery: "",
    showLegacyTools: false   // default collapsed — AI is the star
  };

  let host;
  let root;
  let port;
  let observer;
  let reconnectTimer;
  let pendingIdleRender = false;
  let panelEventsIsolated = false;
  let globalPanelEventsIsolated = false;
  let activePanelField = null;
  let lastPanelFocusAt = 0;
  let flushTurnsTimer = 0;
  let queuedTurns = [];
  const pending = new Map();
  // All entries in `pending` are resolved/rejected in the port message handler or on disconnect to prevent memory leaks.

  installGlobalPanelEventShield();
  installPageKeyGuardBridge();

  if (document.body) {
    boot();
  } else {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "OPERATOR_PASTE_TEXT") {
      const result = insertTextIntoPageComposer(message.text || "");
      sendResponse(result);
      return true;
    }
    if (message?.type === "SHOW_OVERLAY") {
      state.collapsed = false;
      render();
      return;
    }
    if (message?.type === "SETTINGS_CHANGED") {
      state.settings = message.settings;
      if (typeof message.hasApiKey === "boolean") state.hasApiKey = message.hasApiKey;
      state.watchRoom = Boolean(message.settings?.enabled);
      renderWhenIdle();
      return;
    }
    if (message?.type === "MEMORY_CHANGED") {
      state.memory = message.memory;
      renderWhenIdle();
      return;
    }
    if (message?.type === "FAVORITES_CHANGED") {
      state.favorites = message.favorites || [];
      renderWhenIdle();
    }
  });

  window.addEventListener("es-copilot-show", () => {
    state.collapsed = false;
    render();
  });

  async function boot() {
    createHost();
    render();
    connectPort();
    const initial = await request("GET_STATE").catch((error) => ({ ok: false, error: error.message }));
    if (initial.ok) {
      state.settings = initial.settings;
      state.hasApiKey = initial.hasApiKey;
      state.memory = initial.memory;
      state.diagnostics = initial.diagnostics || [];
      state.favorites = initial.favorites || [];
      state.watchRoom = Boolean(initial.settings?.enabled);
      state.collapsed = !initial.settings?.overlayAutoOpen;
      state.status = state.hasApiKey || initial.settings?.aiMode !== "direct" ? "Ready" : "API key needed";
    } else {
      state.status = initial.error || "Could not load state";
    }
    startObserver();
    render();
  }

  function createHost() {
    for (const oldHostId of OLD_HOST_IDS) {
      const oldHost = document.getElementById(oldHostId);
      if (oldHost) oldHost.remove();
    }

    host = document.getElementById(HOST_ID);
    if (host && !host.shadowRoot) {
      host.remove();
      host = null;
    }
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      document.documentElement.appendChild(host);
    }
    root = host.shadowRoot || host.attachShadow({ mode: isDiagnosticsPage() ? "open" : "closed" });
    if (isDiagnosticsPage()) {
      window.__esCopilotTestRoot = root;
    }
    isolatePanelEvents();
    installGlobalPanelEventShield();
  }

  function isolatePanelEvents() {
    if (!root || panelEventsIsolated) return;
    panelEventsIsolated = true;
    const stopAtPanel = (event) => {
      event.stopPropagation();
    };
    [
      "keydown",
      "keypress",
      "keyup",
      "beforeinput",
      "input",
      "compositionstart",
      "compositionupdate",
      "compositionend",
      "paste",
      "cut",
      "drop"
    ].forEach((eventName) => {
      root.addEventListener(eventName, stopAtPanel, false);
    });

    root.addEventListener("focusin", (event) => {
      if (isPanelEditable(event.target)) {
        activePanelField = event.target;
        lastPanelFocusAt = Date.now();
      }
    });
    root.addEventListener("focusout", (event) => {
      lastPanelFocusAt = Date.now();
      if (isPanelEditable(event.relatedTarget)) return;
      setTimeout(() => {
        if (!isPanelEditable(root?.activeElement)) {
          activePanelField = null;
        }
      }, 0);
    });
  }

  function installGlobalPanelEventShield() {
    if (globalPanelEventsIsolated) return;
    globalPanelEventsIsolated = true;
    const shieldStickyKey = (event) => {
      if (!isStickySiteKeyEvent(event) || !isPanelEventContext(event)) return;
      const field = panelFieldFromEvent(event);
      const snapshot = field ? captureFieldState(field) : null;
      const pageSnapshots = capturePageEditableStates();
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      if (event.type === "keydown") {
        setTimeout(() => repairStickyKeyInput(event.key, field, snapshot, pageSnapshots), 0);
      } else {
        setTimeout(() => undoLeakedStickyKey(event.key, pageSnapshots), 0);
      }
    };

    ["keydown", "keypress", "keyup"].forEach((eventName) => {
      window.addEventListener(eventName, shieldStickyKey, true);
      document.addEventListener(eventName, shieldStickyKey, true);
    });
  }

  function installPageKeyGuardBridge() {
    window.addEventListener(
      "message",
      (event) => {
        if (event.source !== window || event.origin !== location.origin || event.data?.source !== PAGE_KEY_GUARD_SOURCE) return;
        if (event.data?.type !== "INSERT_KEY") return;
        const key = String(event.data.key || "c");
        if (key.length !== 1 || key.toLowerCase() !== "c") return;
        insertTextIntoActivePanelField(key);
      },
      true
    );
  }

  function isStickySiteKeyEvent(event) {
    return (
      ["keydown", "keypress", "keyup"].includes(event.type) &&
      String(event.key || "").toLowerCase() === "c" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    );
  }

  function isPanelEventContext(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.includes(host) || path.includes(root)) return true;
    const active = root?.activeElement;
    return Boolean(isPanelEditable(active) || (activePanelField && Date.now() - lastPanelFocusAt < PANEL_FOCUS_GRACE_MS));
  }

  function panelFieldFromEvent(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const fromPath = path.find((node) => isPanelEditable(node));
    if (fromPath) return fromPath;
    if (isPanelEditable(root?.activeElement)) return root.activeElement;
    if (isPanelEditable(activePanelField)) return activePanelField;
    return null;
  }

  function captureFieldState(field) {
    if (!field || !("value" in field)) return null;
    return {
      value: field.value,
      selectionStart: Number.isFinite(field.selectionStart) ? field.selectionStart : field.value.length,
      selectionEnd: Number.isFinite(field.selectionEnd) ? field.selectionEnd : field.value.length
    };
  }

  function repairStickyKeyInput(key, field, snapshot, pageSnapshots) {
    undoLeakedStickyKey(key, pageSnapshots);
    if (!isPanelEditable(field) || !snapshot || !("value" in field)) return;
    field.focus({ preventScroll: true });
    if (field.value !== snapshot.value) return;
    const start = Math.max(0, snapshot.selectionStart);
    const end = Math.max(start, snapshot.selectionEnd);
    field.value = `${snapshot.value.slice(0, start)}${key}${snapshot.value.slice(end)}`;
    const nextPosition = start + String(key).length;
    if (typeof field.setSelectionRange === "function") {
      field.setSelectionRange(nextPosition, nextPosition);
    }
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: key
      })
    );
  }

  function insertTextIntoActivePanelField(text) {
    undoLeakedStickyKey(text);
    const field = panelFieldFromEvent({ composedPath: () => [] });
    if (!isPanelTextEditable(field)) return;
    field.focus({ preventScroll: true });

    if ("value" in field) {
      const value = String(field.value || "");
      const start = Number.isFinite(field.selectionStart) ? field.selectionStart : value.length;
      const end = Number.isFinite(field.selectionEnd) ? field.selectionEnd : start;
      field.value = `${value.slice(0, start)}${text}${value.slice(end)}`;
      const nextPosition = start + text.length;
      if (typeof field.setSelectionRange === "function") {
        field.setSelectionRange(nextPosition, nextPosition);
      }
    } else if (isRichEditable(field)) {
      field.textContent = `${field.textContent || ""}${text}`;
      placeContentEditableCaretAtEnd(field);
    } else {
      return;
    }

    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: text
      })
    );
    setTimeout(() => undoLeakedStickyKey(text), 0);
  }

  function insertTextIntoPageComposer(textInput) {
    const text = String(textInput || "").trim();
    if (!text) return { ok: false, error: "Operator command text is empty." };
    const composer = findPageComposer();
    if (!composer) {
      state.status = "StripChat composer not found";
      renderWhenIdle();
      return { ok: false, error: "StripChat composer was not found." };
    }

    composer.focus({ preventScroll: true });
    writePageComposerValue(composer, text);
    state.status = "Operator line loaded";
    renderWhenIdle();
    return {
      ok: true,
      message: "Loaded in StripChat composer."
    };
  }

  function findPageComposer() {
    const candidates = new Set();
    const active = document.activeElement;
    if (isPageEditable(active) && active !== host) candidates.add(active);
    document
      .querySelectorAll("textarea, input, [contenteditable='true'], [contenteditable='plaintext-only'], [role='textbox']")
      .forEach((node) => {
        if (isPageEditable(node) && node !== host) candidates.add(node);
      });

    return Array.from(candidates)
      .filter((node) => !root?.contains(node) && isVisible(node) && !node.disabled && !node.readOnly)
      .map((node) => ({ node, score: scorePageComposer(node, active) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)[0]?.node;
  }

  function scorePageComposer(node, active) {
    const marker = [
      node.id,
      node.className,
      node.getAttribute?.("name"),
      node.getAttribute?.("placeholder"),
      node.getAttribute?.("aria-label"),
      node.getAttribute?.("data-testid"),
      node.getAttribute?.("role")
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (/search|filter|username|password|email/.test(marker)) return -100;

    let score = node === active ? 35 : 0;
    if (node.tagName === "TEXTAREA") score += 25;
    if (isRichEditable(node)) score += 20;
    if (node.getAttribute?.("role") === "textbox") score += 10;
    if (/chat|message|composer|send|write|say|comment/.test(marker)) score += 55;
    if (/title|topic|goal/.test(marker)) score -= 35;
    return score;
  }

  function writePageComposerValue(node, value) {
    if ("value" in node) {
      const prototype =
        node.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : node.tagName === "INPUT"
            ? HTMLInputElement.prototype
            : null;
      const setter = prototype && Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(node, value);
      else node.value = value;
      if (typeof node.setSelectionRange === "function") {
        node.setSelectionRange(value.length, value.length);
      }
    } else if (isRichEditable(node)) {
      node.textContent = value;
      placeContentEditableCaretAtEnd(node);
    } else {
      return;
    }
    node.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: value
      })
    );
    node.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  function capturePageEditableStates() {
    const nodes = new Set();
    const active = document.activeElement;
    if (isPageEditable(active)) nodes.add(active);
    document.querySelectorAll("input, textarea, [contenteditable], [role='textbox']").forEach((node) => {
      if (isPageEditable(node)) nodes.add(node);
    });
    return Array.from(nodes)
      .map((node) => ({ node, value: readEditableValue(node) }))
      .filter((entry) => entry.value !== null);
  }

  function undoLeakedStickyKey(key, pageSnapshots = []) {
    if (undoLeakedStickyKeyFromSnapshots(key, pageSnapshots)) return;
    const active = document.activeElement;
    if (!isPageEditable(active) || active === host) return;
    undoLeakedStickyKeyFromActive(key, active);
  }

  function undoLeakedStickyKeyFromSnapshots(key, pageSnapshots) {
    for (const snapshot of pageSnapshots || []) {
      const node = snapshot?.node;
      if (!isPageEditable(node) || node === host) continue;
      const value = readEditableValue(node);
      const repaired = removeSingleInsertedKey(value, snapshot.value, key);
      if (repaired === null) continue;
      writeEditableValue(node, repaired);
      return true;
    }
    return false;
  }

  function undoLeakedStickyKeyFromActive(key, active) {
    const value = readEditableValue(active);
    if (!value || value.slice(-1).toLowerCase() !== String(key).toLowerCase()) return;
    writeEditableValue(active, value.slice(0, -1));
  }

  function removeSingleInsertedKey(value, previousValue, key) {
    if (value === null || previousValue === null) return null;
    const current = String(value);
    const previous = String(previousValue);
    const inserted = String(key || "");
    if (!inserted || current.length !== previous.length + inserted.length) return null;
    for (let index = 0; index <= previous.length; index += 1) {
      const candidate = current.slice(index, index + inserted.length);
      if (
        candidate.toLowerCase() === inserted.toLowerCase() &&
        current.slice(0, index) === previous.slice(0, index) &&
        current.slice(index + inserted.length) === previous.slice(index)
      ) {
        return previous;
      }
    }
    return null;
  }

  function readEditableValue(node) {
    if (!node) return null;
    if ("value" in node) return String(node.value || "");
    if (isRichEditable(node)) return String(node.textContent || "");
    return null;
  }

  function writeEditableValue(node, value) {
    if ("value" in node) {
      node.value = value;
      if (typeof node.setSelectionRange === "function") {
        const position = String(value).length;
        node.setSelectionRange(position, position);
      }
    } else if (isRichEditable(node)) {
      node.textContent = value;
      placeContentEditableCaretAtEnd(node);
    } else {
      return;
    }
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  }

  function placeContentEditableCaretAtEnd(node) {
    const selection = window.getSelection?.();
    if (!selection || typeof document.createRange !== "function") return;
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function isPanelEditable(node) {
    return Boolean(
      node &&
        root &&
        root.contains(node) &&
        (node.matches?.("input, textarea, select, [contenteditable], [role='textbox']") || isRichEditable(node))
    );
  }

  function isPanelTextEditable(node) {
    if (!isPanelEditable(node)) return false;
    if (node.tagName === "TEXTAREA" || isRichEditable(node)) return true;
    if (node.tagName !== "INPUT") return false;
    const type = String(node.type || "text").toLowerCase();
    return ![
      "button",
      "checkbox",
      "color",
      "date",
      "datetime-local",
      "file",
      "hidden",
      "month",
      "number",
      "radio",
      "range",
      "reset",
      "submit",
      "time",
      "week"
    ].includes(type);
  }

  function isPageEditable(node) {
    return Boolean(node?.matches?.("input, textarea, [contenteditable], [role='textbox']") || isRichEditable(node));
  }

  function isRichEditable(node) {
    return Boolean(node?.isContentEditable);
  }

  function connectPort() {
    clearTimeout(reconnectTimer);
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
      port.onDisconnect.addListener(() => {
        port = null;
        rejectPendingRequests("The background worker disconnected.");
        state.status = "Reconnecting...";
        renderWhenIdle();
        reconnectTimer = setTimeout(connectPort, 1200);
      });
      port.onMessage.addListener((message) => {
        if (message?.type === "PORT_READY") {
          state.status = "Ready";
          renderWhenIdle();
          return;
        }
        if (message?.type !== "PORT_RESPONSE") return;
        const handler = pending.get(message.requestId);
        if (!handler) return;
        clearTimeout(handler.timeoutId);
        pending.delete(message.requestId);
        handler.resolve(message.response);
      });
    } catch {
      reconnectTimer = setTimeout(connectPort, 1600);
    }
  }

  function request(type, payload = {}) {
    const message = { type, requestId: crypto.randomUUID(), ...payload };
    if (port) {
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          if (!pending.has(message.requestId)) return;
          pending.delete(message.requestId);
          reject(new Error("The background worker did not answer in time."));
        }, 45000);
        pending.set(message.requestId, { resolve, reject, timeoutId });
        try {
          port.postMessage(message);
        } catch (error) {
          clearTimeout(timeoutId);
          pending.delete(message.requestId);
          reject(error);
        }
      });
    }
    return chrome.runtime.sendMessage(message);
  }

  function rejectPendingRequests(message) {
    for (const [requestId, handler] of pending.entries()) {
      clearTimeout(handler.timeoutId);
      handler.reject(new Error(message));
      pending.delete(requestId);
    }
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      if (!state.watchRoom) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          ingestNode(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(() => {
      if (state.watchRoom) scanLikelyChat();
    }, 7000);
  }

  function ingestNode(node) {
    if (!(node instanceof HTMLElement) && !(node instanceof Text)) return;
    const element = node instanceof Text ? node.parentElement : node;
    if (!element || !isLikelyChatElement(element)) return;
    const lines = extractLines(element.innerText || element.textContent || "");
    for (const line of lines) recordLine(line);
  }

  function scanLikelyChat() {
    if (Date.now() - state.lastScan < 4500) return;
    state.lastScan = Date.now();
    const candidates = CHAT_SELECTORS.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    for (const element of candidates.slice(0, 10)) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
      const lines = extractLines(element.innerText || element.textContent || "");
      for (const line of lines.slice(-8)) recordLine(line);
    }
  }

  function isLikelyChatElement(element) {
    if (!isVisible(element)) return false;
    const marker = `${element.id} ${element.className} ${element.getAttribute("data-testid") || ""}`.toLowerCase();
    return /chat|message|messages|conversation|stream/.test(marker) || hasChatAncestor(element);
  }

  function hasChatAncestor(element) {
    let current = element.parentElement;
    let depth = 0;
    while (current && depth < 5) {
      const marker = `${current.id} ${current.className} ${current.getAttribute("data-testid") || ""}`.toLowerCase();
      if (/chat|message|messages|conversation/.test(marker)) return true;
      current = current.parentElement;
      depth += 1;
    }
    return false;
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function extractLines(text) {
    return String(text || "")
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length >= 3 && line.length <= 220)
      .filter((line) => !/cookie|privacy|terms|subscribe|sign up|login/i.test(line));
  }

  function recordLine(line) {
    const key = line.toLowerCase();
    const now = Date.now();
    const seenAt = state.seenLines.get(key) || 0;
    if (now - seenAt < 2 * 60 * 1000) return;
    state.seenLines.set(key, now);
    if (state.seenLines.size > 350) {
      const cutoff = now - 2 * 60 * 1000;
      for (const [seenKey, timestamp] of state.seenLines.entries()) {
        if (timestamp < cutoff) state.seenLines.delete(seenKey);
      }
    }
    const parsed = parseChatLine(line);
    queueTurn({ ...parsed, id: stableTurnId(parsed) });
  }

  function stableTurnId(turn = {}) {
    const bucket = Math.floor(Date.now() / (2 * 60 * 1000));
    const raw = `${bucket}|${turn.viewer || "room"}|${turn.kind || "chat"}|${turn.text || ""}`.toLowerCase();
    let hash = 2166136261;
    for (let index = 0; index < raw.length; index += 1) {
      hash ^= raw.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `visible-${(hash >>> 0).toString(16)}`;
  }

  function queueTurn(turn) {
    if (!turn?.text) return;
    queuedTurns.push(turn);
    if (queuedTurns.length >= 6) {
      flushRecordedTurns();
      return;
    }
    if (!flushTurnsTimer) {
      flushTurnsTimer = setTimeout(flushRecordedTurns, TURN_BATCH_DELAY_MS);
    }

    // Proactive auto-surfacing — the dream: the AI notices important things and gives perfect options without the model having to ask.
    if (turn.kind === "tip") {
      const amount = Number(turn.amount || 0);
      if (amount >= 75) {
        // Meaningful tip — instantly give thank + smart upsell so model can keep performing
        setTimeout(() => autoProactiveCopilot("significant_tip", turn), 800);
      } else if (amount >= 30 && Math.random() < 0.6) {
        setTimeout(() => autoProactiveCopilot("tip", turn), 1200);
      }
    }

    // Extra proactive for dead air (what the model hates most): if things have been quiet, surface a low-effort wake/goal
    if (!state.lastQuietCheck) state.lastQuietCheck = Date.now();
    if (Date.now() - state.lastQuietCheck > 42000) {
      const recent = (state.memory?.turns || []).slice(-4);
      const looksQuiet = recent.length < 2 || recent.filter(t => t.text && t.text.length > 8).length < 1;
      if (looksQuiet) {
        setTimeout(() => autoProactiveCopilot("slow_room"), 500);
      }
      state.lastQuietCheck = Date.now();
    }
  }

  function flushRecordedTurns() {
    if (flushTurnsTimer) {
      clearTimeout(flushTurnsTimer);
      flushTurnsTimer = 0;
    }
    if (!queuedTurns.length) return;
    const batch = queuedTurns;
    queuedTurns = [];
    request("RECORD_TURNS", { turns: batch }).catch(() => {
      queuedTurns = [...batch, ...queuedTurns].slice(-60);
      if (!flushTurnsTimer) {
        flushTurnsTimer = setTimeout(flushRecordedTurns, 1200);
      }
    });
  }

  function parseChatLine(line) {
    const tipMatch = line.match(
      /^(?:tip\s+from\s+)?([^:]{2,40}?)(?:\s+|:\s*)(?:tipped|sent|gave)?\s*(\d{1,5})\s*(?:tk|tokens?)\b/i
    );
    if (tipMatch) {
      return {
        viewer: tipMatch[1].trim(),
        text: line,
        kind: "tip",
        source: "visible_room"
      };
    }
    const returnMatch = line.match(/^([^:]{2,40}?)\s+(?:is back|came back|returned|joined the room)\b/i);
    if (returnMatch) {
      return {
        viewer: returnMatch[1].trim(),
        text: line,
        kind: "return",
        source: "visible_room"
      };
    }
    const match = line.match(/^([^:]{2,40})[:\-]\s*(.+)$/);
    if (match) {
      return {
        viewer: match[1].trim(),
        text: match[2].trim(),
        kind: "chat",
        source: "visible_room"
      };
    }
    return {
      viewer: "room",
      text: line,
      kind: "chat",
      source: "visible_room"
    };
  }

  function render() {
    if (!root) return;
    root.innerHTML = `${styles()}${state.collapsed ? collapsedMarkup() : panelMarkup()}`;
    bindEvents();
  }

  function collapsedMarkup() {
    return `
      <button class="es-launch" type="button" title="Open EclipseStud Copilot">
        <img src="${chrome.runtime.getURL("assets/es_copilot_icon48.png")}" alt="">
        <span>EclipseStud</span>
      </button>
    `;
  }

  function panelMarkup() {
    const provider = "OpenAI";
    const mode = state.settings?.aiMode || "local";
    return `
      <section class="es-panel" aria-label="EclipseStud Copilot">
        <header class="es-header">
          <div class="brand">
            <img src="${chrome.runtime.getURL("assets/es_copilot_icon48.png")}" alt="">
            <div>
              <span class="eyebrow">EclipseStud Copilot</span>
              <strong>EclipseStud Copilot ${provider} v2.8.0</strong>
              <span>${escapeHtml(statusText())}</span>
            </div>
          </div>
          <div class="header-actions">
            <button type="button" data-action="toggle-watch" class="${state.watchRoom ? "active" : ""}" title="Watch visible room chat">${state.watchRoom ? "Watching" : "Paused"}</button>
            <button type="button" data-action="collapse" title="Collapse">-</button>
          </div>
        </header>
        <section class="status-strip" aria-label="Live assistant status">
          <div><span>AI Route</span><strong>${escapeHtml(mode)}</strong></div>
          <div><span>Memory</span><strong>${Number(state.memory?.turnCount || 0).toLocaleString()} turns</strong></div>
          <div><span>Model</span><strong>${escapeHtml(state.settings?.model || provider)}</strong></div>
        </section>

        <!-- AI IS THE EXTENSION - Ultra minimal effort mode for live performers -->
        <!-- Primary experience: one "Super Copilot" that watches everything and gives the best next move with zero thinking required. -->
        <section class="copilot-hero">
          <div class="copilot-head">
            <strong>Live Copilot</strong>
            <span class="ai-pill">GPT-5.5 High Reasoning</span>
          </div>

          ${state.copilotAnalysis ? `<div class="copilot-read">${escapeHtml(state.copilotAnalysis)}</div>` : `<div class="copilot-read muted">Room is being watched. Hit "Best move now" or type what you need.</div>`}

          <div class="copilot-grid">
            ${(state.copilotSuggestions || []).slice(0, 6).map((s, i) => `
              <div class="copilot-card" data-copilot-idx="${i}">
                <div class="card-type">${escapeHtml((s.type || 'idea').toUpperCase())}</div>
                <div class="card-text">${escapeHtml(s.text || '')}</div>
                ${s.why ? `<div class="card-why">${escapeHtml(s.why)}</div>` : ''}
                <div class="card-actions">
                  <button class="card-copy" data-copy-copilot="${i}">Copy</button>
                  <button class="card-use" data-use-copilot="${i}">Use</button>
                </div>
              </div>
            `).join('') || `<div class="copilot-empty">No suggestions yet. Use the button below for instant high-value ideas.</div>`}
          </div>

          <div class="copilot-actions">
            <button type="button" class="primary big" data-action="super-copilot" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Reasoning...' : '★ Best move right now (zero effort)'}</button>
            <div class="copilot-ask">
              <input id="copilot-free-query" placeholder="Tell me what you need (e.g. 'make it flirty', 'handle slow room', 'good reply for this tipper')" value="${escapeAttr(state.copilotQuery || '')}" />
              <button type="button" data-action="copilot-query" ${state.busy ? 'disabled' : ''}>Ask AI</button>
            </div>
          </div>

          <div style="margin-top:8px; text-align:right; font-size:9px; opacity:0.6;">
            <button type="button" class="es-mini" data-action="toggle-legacy-tools">
              ${state.showLegacyTools ? "Hide advanced tools" : "Show advanced tools (rarely needed)"}
            </button>
          </div>
        </section>
        <!-- AI IS THE EXTENSION - The Live Copilot is now the primary and default experience. 
             The old manual tools are expert overrides only, hidden by default to keep the model in flow.
             This is the "smartest way": AI observes, reasons at high depth, anticipates needs, and surfaces the best moves with almost zero input from the performer. -->
        <div class="ai-primary-mode">
          <div class="ai-mode-indicator">
            <span class="ai-pill">PURE AI MODE • GPT-5.5 EXTRA HIGH REASONING</span>
            <button type="button" data-action="toggle-legacy-tools" class="es-mini" style="font-size:9px; margin-left:8px;">
              ${state.showLegacyTools ? "Hide Expert Tools" : "Show Expert Override Tools (rarely needed)"}
            </button>
          </div>
          ${state.showLegacyTools ? `
          <nav class="tabs expert-tabs" aria-label="Expert override tools (AI is still recommended)">
            ${tabButton("replies", "Replies")}
            ${tabButton("topic", "Today's title")}
            ${tabButton("goals", "Goals")}
            ${tabButton("tools", "Live tools")}
            ${tabButton("room", "Room")}
          </nav>
          <main class="body">
            ${activeTabMarkup()}
          </main>
          ` : '<div class="pure-ai-note">The AI Copilot is running the show. It watches signals, maintains memory of what works for you, and gives the lowest-effort highest-impact moves. Talk to it naturally or hit the big button for instant high-reasoning plans. Expert tools are collapsed to reduce decision fatigue.</div>'}
        </div>
      </section>
    `;
  }

  function tabButton(id, label) {
    const featureId = id === "topic" ? "tips" : id;
    const enabled = state.settings?.features?.[featureId] !== false;
    return `<button type="button" data-tab="${id}" class="${state.activeTab === id ? "selected" : ""}" ${enabled ? "" : "disabled"}>${label}</button>`;
  }

  function activeTabMarkup() {
    if (state.activeTab === "topic") return topicMarkup();
    if (state.activeTab === "goals") return goalsMarkup();
    if (state.activeTab === "tools") return toolsMarkup();
    if (state.activeTab === "room") return roomMarkup();
    return repliesMarkup();
  }

  function repliesMarkup() {
    const replyCards = state.replies.length
      ? state.replies
          .map(
            (reply, index) => `
              <article class="reply-card ${state.selectedReply === index ? "selected" : ""}" data-reply-index="${index}">
                <span class="number-badge">${index + 1}</span>
                <div class="card-copy">
                  <p>${escapeHtml(reply)}</p>
                  <span class="pill">${escapeHtml(state.intent.replace(/_/g, " "))}</span>
                  <span class="pill">${escapeHtml(state.tone)}</span>
                </div>
                <div class="card-actions">
                  <button type="button" class="copy-btn" data-copy-reply="${index}" title="Copy reply">Copy</button>
                  ${favoriteButtonMarkup(reply, "reply", state.intent.replace(/_/g, " "), "data-favorite-reply", index)}
                </div>
              </article>
            `
          )
          .join("")
      : `<div class="empty">Paste or capture a viewer line, then generate three human-sounding options.</div>`;

    return `
      <div class="grid two">
        <label>Viewer
          <input id="es-viewer-name" value="${escapeAttr(state.viewerName)}" placeholder="name if known">
        </label>
        <label>Type
          <select id="es-viewer-type">
            ${option("grey", "Grey", state.viewerType)}
            ${option("registered", "Registered", state.viewerType)}
            ${option("casual_tip", "Casual tipper", state.viewerType)}
            ${option("big_tip", "Big tipper", state.viewerType)}
            ${option("regular", "Regular", state.viewerType)}
            ${option("fan_club", "Fan club", state.viewerType)}
            ${option("knight", "Knight", state.viewerType)}
            ${option("pushy", "Pushy", state.viewerType)}
            ${option("lurker", "Lurker", state.viewerType)}
          </select>
        </label>
      </div>
      <label>Viewer message
        <textarea id="es-message" rows="4" placeholder="Paste a chat line or use the latest captured line">${escapeHtml(state.draftMessage || latestText())}</textarea>
      </label>
      <div class="segmented" data-group="intent">
        ${chip("reply", "Reply", state.intent)}
        ${chip("keep_chat", "Keep chat", state.intent)}
        ${chip("tip_friendly", "Tip", state.intent)}
        ${chip("defuse", "Defuse", state.intent)}
        ${chip("boundary", "Boundary", state.intent)}
      </div>
      <div class="segmented" data-group="tone">
        ${chip("chill", "Chill", state.tone)}
        ${chip("playful", "Playful", state.tone)}
        ${chip("flirty", "Flirty", state.tone)}
        ${chip("dominant", "Firm", state.tone)}
        ${chip("friendly", "Friendly", state.tone)}
        ${chip("short", "Short", state.tone)}
      </div>
      <div class="actions">
        <button type="button" class="primary" data-action="generate" ${state.busy ? "disabled" : ""}>${state.busy ? "Thinking..." : "Generate"}</button>
        <button type="button" data-action="use-latest">Use latest</button>
        <button type="button" data-action="open-options">Settings</button>
      </div>
      <section class="reply-list">${replyCards}</section>
      <div class="actions subtle">
        <button type="button" data-action="rewrite-shorter">Shorter</button>
        <button type="button" data-action="rewrite-warmer">Warmer</button>
        <button type="button" data-action="rewrite-firmer">Firmer</button>
      </div>
    `;
  }

  function topicMarkup() {
    const topicCards = state.topics.length
      ? state.topics
          .map(
            (topic, index) => `
              <article class="reply-card">
                <span class="number-badge">${index + 1}</span>
                <div class="card-copy">
                  <p>${escapeHtml(topic)}</p>
                  <span class="pill">title</span>
                  <span class="pill">${escapeHtml(state.topicTone)}</span>
                </div>
                <div class="card-actions">
                  <button type="button" class="copy-btn" data-copy-topic="${index}" title="Copy topic">Copy</button>
                  ${favoriteButtonMarkup(topic, "title", state.topicStyle, "data-favorite-topic", index)}
                </div>
              </article>
            `
          )
          .join("")
      : `<div class="empty">Build today's stream title from the current vibe.</div>`;

    return `
      <div class="grid two">
        <label>Format
          <select id="es-topic-style">
            ${option("stream_title", "Stream title", state.topicStyle)}
            ${option("room_topic", "Room topic", state.topicStyle)}
            ${option("game_title", "Game title", state.topicStyle)}
            ${option("goal_title", "Goal title", state.topicStyle)}
          </select>
        </label>
        <label>Tone
          <select id="es-topic-tone">
            ${option("playful", "Playful", state.topicTone)}
            ${option("chill", "Chill", state.topicTone)}
            ${option("flirty", "Flirty", state.topicTone)}
            ${option("friendly", "Friendly", state.topicTone)}
            ${option("short", "Short", state.topicTone)}
          </select>
        </label>
      </div>
      <label>Title notes
        <textarea id="es-topic-brief" rows="4" placeholder="Example: Call of Duty chill, shy start, playful chat, interactive toy later...">${escapeHtml(state.topicBrief)}</textarea>
      </label>
      <div class="actions">
        <button type="button" class="primary" data-action="room-topic" ${state.busy ? "disabled" : ""}>${state.busy ? "Thinking..." : "Build today's title"}</button>
        <button type="button" data-action="copy-topics">Copy titles</button>
      </div>
      <div class="source-line">AI route: ${escapeHtml(state.topicSource || state.settings?.aiMode || "local")}</div>
      <div class="reply-list" id="es-topic-output">
        ${topicCards}
      </div>
    `;
  }

  function goalsMarkup() {
    const goalCards = state.goals.length
      ? state.goals
          .map(
            (goal, index) => `
              <article class="goal">
                <span class="number-badge">${index + 1}</span>
                <strong>${escapeHtml(goal.name)}</strong>
                <span>${Number(goal.amount || 0).toLocaleString()} tk</span>
                <em>${escapeHtml(goal.chat_line || "")}</em>
                <div class="card-actions">
                  <button type="button" class="copy-btn" data-copy-goal-line="${index}" title="Copy promo line">Copy line</button>
                  ${favoriteButtonMarkup(goal.chat_line || `${goal.name} ${goal.amount} tk`, "goal", goal.name, "data-favorite-goal", index)}
                </div>
              </article>
            `
          )
          .join("")
      : `<div class="empty">Build real goals with a title, token target, unlock, and paste-ready promo line.</div>`;

    return `
      <div class="grid two">
        <label>Theme
          <select id="es-goal-theme">
            ${option("toy", "Toy", state.goalTheme)}
            ${option("pose", "Pose", state.goalTheme)}
            ${option("game", "Game", state.goalTheme)}
          </select>
        </label>
        <label>Target
          <input id="es-goal-target" type="number" min="300" step="50" value="${Number(state.goalTarget) || 1500}">
        </label>
      </div>
      <label>Room mood
        <textarea id="es-goal-mood" rows="3" placeholder="Optional: quiet room, big tippers lurking, toy energy, game vibe...">${escapeHtml(state.goalMood)}</textarea>
      </label>
      <div class="segmented" data-group="goal-style">
        <button type="button" data-goal-style="balanced" class="${state.goalStyle === "balanced" ? "selected" : ""}">Balanced</button>
        <button type="button" data-goal-style="soft" class="${state.goalStyle === "soft" ? "selected" : ""}">Soft</button>
        <button type="button" data-goal-style="bold" class="${state.goalStyle === "bold" ? "selected" : ""}">Bold</button>
      </div>
      <div class="actions">
        <button type="button" class="primary" data-action="goals" ${state.busy ? "disabled" : ""}>${state.busy ? "Building..." : "Build AI goals"}</button>
        <button type="button" data-action="copy-goals">Copy goals</button>
      </div>
      <div class="source-line">Source: ${escapeHtml(state.goalSource || state.settings?.aiMode || "local")}</div>
      <div class="goal-list" id="es-goal-output">
        ${goalCards}
      </div>
    `;
  }

  function toolsMarkup() {
    const toolLabel = {
      tip_reaction: "tip reaction",
      wake_line: "wake line",
      quick_challenges: "challenge"
    }[state.toolKind] || "live tool";
    const toolCards = state.toolLines.length
      ? state.toolLines
          .map(
            (line, index) => `
              <article class="reply-card">
                <span class="number-badge">${index + 1}</span>
                <div class="card-copy">
                  <p>${escapeHtml(line)}</p>
                  <span class="pill">${escapeHtml(toolLabel)}</span>
                  <span class="pill">${escapeHtml(state.tone)}</span>
                </div>
                <div class="card-actions">
                  <button type="button" class="copy-btn" data-copy-tool="${index}" title="Copy live-tool line">Copy</button>
                  ${favoriteButtonMarkup(line, state.toolKind, toolLabel, "data-favorite-tool", index)}
                </div>
              </article>
            `
          )
          .join("")
      : `<div class="empty">React to a tip, wake a quiet room, or generate three quick public-room challenges.</div>`;

    return `
      <div class="grid two">
        <label>Tip amount
          <input id="es-tip-amount" type="number" min="1" step="1" value="${Number(state.tipAmount) || 100}">
        </label>
        <label>Viewer
          <input id="es-tip-viewer" value="${escapeAttr(state.tipViewer)}" placeholder="name if known">
        </label>
      </div>
      <div class="tool-actions">
        <button type="button" class="primary" data-action="tip-reaction" ${state.busy ? "disabled" : ""}>Tip reaction</button>
        <button type="button" data-action="wake-line" ${state.busy ? "disabled" : ""}>Wake line</button>
        <button type="button" data-action="quick-challenges" ${state.busy ? "disabled" : ""}>Challenges</button>
      </div>
      <div class="source-line">Source: ${escapeHtml(state.toolSource || state.settings?.aiMode || "local")}</div>
      <div class="reply-list" id="es-tool-output">${toolCards}</div>
    `;
  }

  function roomMarkup() {
    const last = state.memory?.lastTurn;
    const diagnostics = (state.diagnostics || [])
      .slice(-4)
      .map((item) => `<li>${escapeHtml(new Date(item.ts).toLocaleTimeString())} - ${escapeHtml(item.message)}</li>`)
      .join("");
    const favoriteCards = state.favorites.length
      ? state.favorites
          .slice()
          .reverse()
          .map(
            (favorite) => `
              <article class="favorite-row">
                <div>
                  <span class="pill">${escapeHtml(favorite.label || favorite.kind || "saved")}</span>
                  <p>${escapeHtml(favorite.text)}</p>
                </div>
                <div class="card-actions">
                  <button type="button" class="copy-btn" data-copy-favorite="${escapeAttr(favorite.id)}" title="Copy saved line">Copy</button>
                  <button type="button" class="favorite-btn saved" data-remove-favorite="${escapeAttr(favorite.id)}" title="Remove saved line" aria-label="Remove saved line">${favoriteIcon(true)}</button>
                </div>
              </article>
            `
          )
          .join("")
      : `<div class="empty">Save strong replies, titles, goals, and live-tool lines here for quick reuse.</div>`;
    return `
      <div class="stats">
        <div><strong>${state.memory?.turnCount || 0}</strong><span>turns</span></div>
        <div><strong>${state.memory?.viewerCount || 0}</strong><span>viewers</span></div>
        <div><strong>${state.memory?.generatedCount || 0}</strong><span>replies</span></div>
        <div><strong>${state.favorites.length}</strong><span>saved</span></div>
      </div>
      <section class="room-card">
        <strong>Latest captured line</strong>
        <p>${last ? `${escapeHtml(last.viewer)}: ${escapeHtml(last.text)}` : "No room line captured yet."}</p>
      </section>
      <div class="actions">
        <button type="button" data-action="use-latest">Use latest</button>
        <button type="button" data-action="prune">Prune</button>
        <button type="button" data-action="reset-memory">Reset</button>
      </div>
      <section class="room-card">
        <div class="section-title">
          <strong>Saved lines</strong>
          <button type="button" data-action="clear-favorites" ${state.favorites.length ? "" : "disabled"}>Clear</button>
        </div>
        <div class="favorite-list">${favoriteCards}</div>
      </section>
      <section class="room-card">
        <strong>Diagnostics</strong>
        <ul>${diagnostics || "<li>No diagnostics yet.</li>"}</ul>
      </section>
    `;
  }

  function bindEvents() {
    const launch = root.querySelector(".es-launch");
    if (launch) launch.addEventListener("click", () => setCollapsed(false));

    root.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        state.activeTab = button.dataset.tab;
        render();
      });
    });

    root.querySelectorAll("[data-chip]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.closest('[data-group="intent"]')) state.intent = button.dataset.chip;
        if (button.closest('[data-group="tone"]')) state.tone = button.dataset.chip;
        render();
      });
    });

    root.querySelectorAll("[data-goal-style]").forEach((button) => {
      button.addEventListener("click", () => {
        state.goalStyle = button.dataset.goalStyle || "balanced";
        render();
      });
    });

    root.querySelectorAll("[data-copy-goal-line]").forEach((button) => {
      button.addEventListener("click", async () => {
        const index = Number(button.dataset.copyGoalLine);
        const goal = state.goals[index];
        await copyText(goal?.chat_line || `${goal?.name || ""} ${goal?.amount || ""} tk`);
      });
    });

    root.querySelectorAll("[data-copy-topic]").forEach((button) => {
      button.addEventListener("click", async () => {
        const index = Number(button.dataset.copyTopic);
        await copyText(state.topics[index] || "");
      });
    });

    root.querySelectorAll("[data-reply-index]").forEach((card) => {
      card.addEventListener("click", () => {
        state.selectedReply = Number(card.dataset.replyIndex);
        render();
      });
    });

    root.querySelectorAll("[data-copy-reply]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const index = Number(button.dataset.copyReply);
        await copyText(state.replies[index] || "");
      });
    });

    root.querySelectorAll("[data-copy-tool]").forEach((button) => {
      button.addEventListener("click", async () => {
        const index = Number(button.dataset.copyTool);
        await copyText(state.toolLines[index] || "");
      });
    });

    root.querySelectorAll("[data-copy-favorite]").forEach((button) => {
      button.addEventListener("click", async () => {
        const favorite = state.favorites.find((item) => item.id === button.dataset.copyFavorite);
        await copyText(favorite?.text || "");
      });
    });

    root.querySelectorAll("[data-remove-favorite]").forEach((button) => {
      button.addEventListener("click", () => {
        const favorite = state.favorites.find((item) => item.id === button.dataset.removeFavorite);
        if (favorite) toggleFavorite(favorite);
      });
    });

    bindFavoriteButtons("[data-favorite-reply]", (button) => {
      const index = Number(button.dataset.favoriteReply);
      return { kind: "reply", label: state.intent.replace(/_/g, " "), text: state.replies[index] || "" };
    });
    bindFavoriteButtons("[data-favorite-topic]", (button) => {
      const index = Number(button.dataset.favoriteTopic);
      return { kind: "title", label: state.topicStyle, text: state.topics[index] || "" };
    });
    bindFavoriteButtons("[data-favorite-goal]", (button) => {
      const index = Number(button.dataset.favoriteGoal);
      const goal = state.goals[index];
      return { kind: "goal", label: goal?.name || "goal", text: goal?.chat_line || "" };
    });
    bindFavoriteButtons("[data-favorite-tool]", (button) => {
      const index = Number(button.dataset.favoriteTool);
      return { kind: state.toolKind, label: state.toolKind.replace(/_/g, " "), text: state.toolLines[index] || "" };
    });

    root.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => handleAction(button.dataset.action));
    });

    // Copilot hero listeners (AI is the main part)
    root.querySelectorAll("[data-copy-copilot]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.copyCopilot);
        const sug = state.copilotSuggestions[idx];
        if (sug?.text) await copyText(sug.text);
      });
    });

    // "Use" button - makes the AI actually do work for the model (copy + smart next action)
    root.querySelectorAll("[data-use-copilot]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.useCopilot);
        const sug = state.copilotSuggestions[idx];
        if (!sug?.text) return;
        await copyText(sug.text);
        // Smart follow-up based on type - zero extra thought for the performer
        if (sug.type === "reply" || sug.type === "tease" || sug.type === "boundary") {
          state.draftMessage = sug.text;
          state.activeTab = "replies";
          state.status = "Suggestion loaded into quick reply composer";
        } else if (sug.type === "goal") {
          state.activeTab = "goals";
          state.status = "Goal idea ready - use the tools or ask AI to refine";
        } else if (sug.type === "title") {
          state.activeTab = "topic";
          state.status = "Title suggestion ready";
        } else {
          state.status = "Copied + ready to use";
        }
        render();
      });
    });

    const copilotInput = root.getElementById("copilot-free-query");
    if (copilotInput) {
      copilotInput.addEventListener("input", () => (state.copilotQuery = copilotInput.value));
      copilotInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !state.busy) {
          e.preventDefault();
          handleAction("copilot-query");
        }
      });
    }

    // Keyboard power for the AI (what a model wants: minimal hands, maximum brain)
    // Number keys 1-5 on the panel = instantly copy that suggestion
    root.addEventListener("keydown", (e) => {
      if (state.collapsed || state.busy) return;
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= 5 && state.copilotSuggestions[num-1]) {
        e.preventDefault();
        const sug = state.copilotSuggestions[num-1];
        copyText(sug.text || "").then(() => {
          state.status = `Copied suggestion ${num}`;
          render();
          setTimeout(() => { if (state.status.includes("Copied")) state.status = "Watching..."; render(); }, 900);
        });
      }
      if (e.key === "/" && document.activeElement !== copilotInput) {
        e.preventDefault();
        copilotInput?.focus();
      }
    }, true);

    const viewerName = root.getElementById("es-viewer-name");
    const viewerType = root.getElementById("es-viewer-type");
    const draftMessage = root.getElementById("es-message");
    const goalTheme = root.getElementById("es-goal-theme");
    const goalTarget = root.getElementById("es-goal-target");
    const goalMood = root.getElementById("es-goal-mood");
    const topicBrief = root.getElementById("es-topic-brief");
    const topicStyle = root.getElementById("es-topic-style");
    const topicTone = root.getElementById("es-topic-tone");
    const tipAmount = root.getElementById("es-tip-amount");
    const tipViewer = root.getElementById("es-tip-viewer");
    if (viewerName) viewerName.addEventListener("input", () => (state.viewerName = viewerName.value));
    if (viewerType) viewerType.addEventListener("change", () => (state.viewerType = viewerType.value));
    if (draftMessage) draftMessage.addEventListener("input", () => (state.draftMessage = draftMessage.value));
    if (goalTheme) goalTheme.addEventListener("change", () => (state.goalTheme = goalTheme.value));
    if (goalTarget) {
      goalTarget.addEventListener("input", () => {
        state.goalTarget = Number(goalTarget.value || 1500);
      });
    }
    if (goalMood) goalMood.addEventListener("input", () => (state.goalMood = goalMood.value));
    if (topicBrief) topicBrief.addEventListener("input", () => (state.topicBrief = topicBrief.value));
    if (topicStyle) topicStyle.addEventListener("change", () => (state.topicStyle = topicStyle.value));
    if (topicTone) topicTone.addEventListener("change", () => (state.topicTone = topicTone.value));
    if (tipAmount) tipAmount.addEventListener("input", () => (state.tipAmount = Number(tipAmount.value || 100)));
    if (tipViewer) tipViewer.addEventListener("input", () => (state.tipViewer = tipViewer.value));

    root.querySelectorAll("input, textarea, select").forEach((field) => {
      field.addEventListener("blur", () => {
        setTimeout(() => {
          if (isPanelInputActive() || !pendingIdleRender) return;
          pendingIdleRender = false;
          render();
        }, 0);
      });
    });
  }

  async function handleAction(action) {
    if (action === "collapse") return setCollapsed(true);
    if (action === "toggle-watch") {
      state.watchRoom = !state.watchRoom;
      state.status = state.watchRoom ? "Watching visible room" : "Room watch paused";
      return render();
    }
    if (action === "open-options") return request("OPEN_OPTIONS");
    if (action === "use-latest") {
      state.draftMessage = latestText();
      state.activeTab = "replies";
      render();
      return;
    }
    if (action === "generate") return generateReplies();
    if (action === "room-topic") return buildRoomTopics();
    if (action === "copy-topics") return copyText(root.getElementById("es-topic-output")?.innerText || "");
    if (action === "goals") return buildGoals();
    if (action === "copy-goals") return copyText(root.getElementById("es-goal-output")?.innerText || "");
    if (action === "tip-reaction") return runLiveTool("TIP_REACTION", "tip_reaction");
    if (action === "wake-line") return runLiveTool("WAKE_LINE", "wake_line");
    if (action === "quick-challenges") return runLiveTool("QUICK_CHALLENGES", "quick_challenges");
    if (action === "clear-favorites") return clearFavorites();
    if (action === "prune") return refreshAfter("PRUNE_MEMORY");
    if (action === "reset-memory") return refreshAfter("RESET_MEMORY");
    if (action === "rewrite-shorter") return rewriteSelected("shorter");
    if (action === "rewrite-warmer") return rewriteSelected("warmer");
    if (action === "rewrite-firmer") return rewriteSelected("firmer");

    // === AI-first copilot actions (AI is the main part of the extension) ===
    if (action === "smart-copilot") return runSmartCopilot();
    if (action === "copilot-query") {
      const input = root.getElementById("copilot-free-query");
      state.copilotQuery = (input?.value || "").trim();
      return runSmartCopilotQuery();
    }
    if (action === "toggle-legacy-tools") {
      state.showLegacyTools = !state.showLegacyTools;
      return render();
    }

    // New ultra-low-effort AI actions
    if (action === "super-copilot") {
      // "Best move right now" - the one button a model actually wants during a show
      state.copilotQuery = "what is the single best low-effort high-value thing I can do or say right now to improve energy or conversion while I'm performing?";
      return runSmartCopilotQuery();
    }
  }

  async function runSmartCopilot() {
    state.busy = true;
    state.status = "Copilot analyzing room...";
    render();

    try {
      const res = await request("SMART_COPILOT", { payload: {} });
      if (res?.ok) {
        state.copilotAnalysis = res.analysis || "";
        state.copilotSuggestions = res.suggestions || [];
        state.status = "Copilot ready";
        if (res.memory) state.memory = res.memory;
      } else {
        state.status = res?.error || "Copilot failed";
      }
    } catch (e) {
      state.status = "Copilot error";
    } finally {
      state.busy = false;
      render();
    }
  }

  async function runSmartCopilotQuery() {
    const q = (state.copilotQuery || "").trim();
    if (!q) return;

    state.busy = true;
    state.status = "Asking copilot...";
    render();

    try {
      const res = await request("COPILOT_QUERY", { query: q });
      if (res?.ok) {
        state.copilotAnalysis = res.analysis || `Response to: ${q}`;
        state.copilotSuggestions = res.suggestions || [];
        if (res.memory) state.memory = res.memory;
        state.status = "Copilot answered";
      } else {
        state.status = res?.error || "Query failed";
      }
    } catch (e) {
      state.status = "Query error";
    } finally {
      state.busy = false;
      render();
    }
  }

  // Auto-proactive: the model shouldn't have to click anything when something important happens.
  async function autoProactiveCopilot(reason, turn = null) {
    if (state.busy || !state.watchRoom) return;

    // Only surface if the panel is open or we are in "always helpful" mode
    if (state.collapsed) return;

    try {
      const contextNote = reason === "significant_tip"
        ? `Big tip just landed from ${turn?.viewer || "someone"} (${turn?.amount || ""} tk). Give perfect thank + natural upsell.`
        : "Recent activity — give the model the best low-effort high-impact move right now.";

      const res = await request("SMART_COPILOT", {
        payload: { query: contextNote }
      });

      if (res?.ok && res.suggestions?.length) {
        state.copilotAnalysis = res.analysis || "Live update from room signals";
        state.copilotSuggestions = res.suggestions;
        if (res.memory) state.memory = res.memory;
        state.status = "Smart suggestion ready";
        render();
      }
    } catch (e) {
      // silent — never interrupt the show
    }
  }

  async function generateReplies() {
    const message = root.getElementById("es-message")?.value || state.draftMessage || latestText();
    state.draftMessage = message;
    state.busy = true;
    state.status = "Thinking...";
    render();
    const response = await request("GENERATE", {
      request: {
        message,
        viewerName: state.viewerName,
        viewerType: state.viewerType,
        intent: state.intent,
        tone: state.tone,
        source: "overlay"
      }
    }).catch((error) => ({ ok: false, error: error.message }));
    state.busy = false;
    if (response.ok) {
      state.replies = response.replies || [];
      state.source = response.source || "local";
      state.memory = response.memory || state.memory;
      state.status = `Ready (${state.source})`;
    } else {
      state.status = response.error || "Generation failed";
    }
    render();
  }

  async function buildRoomTopics() {
    const topicBrief = root.getElementById("es-topic-brief")?.value || state.topicBrief;
    const topicStyle = root.getElementById("es-topic-style")?.value || state.topicStyle;
    const tone = root.getElementById("es-topic-tone")?.value || state.topicTone;
    state.topicBrief = topicBrief;
    state.topicStyle = topicStyle;
    state.topicTone = tone;
    state.busy = true;
    state.status = "Building topics...";
    render();
    const response = await request("ROOM_TOPIC", {
      payload: {
        brief: topicBrief,
        style: topicStyle,
        tone,
        latestMessage: latestText()
      }
    }).catch((error) => ({ ok: false, error: error.message }));
    state.busy = false;
    if (response.ok) {
      state.topics = response.topics || [];
      state.topicSource = response.source || "local";
      state.memory = response.memory || state.memory;
      state.status = `Topics ready (${state.topicSource})`;
    } else {
      state.topics = [];
      state.topicSource = "error";
      state.status = response.error || "Topic generation failed";
    }
    render();
  }

  async function buildGoals() {
    const theme = root.getElementById("es-goal-theme")?.value || "toy";
    const targetTokens = Number(root.getElementById("es-goal-target")?.value || 1500);
    const roomMood = root.getElementById("es-goal-mood")?.value || "";
    state.goalTheme = theme;
    state.goalTarget = targetTokens;
    state.goalMood = roomMood;
    state.busy = true;
    state.status = "Building goals...";
    render();
    const response = await request("GOALS", {
      payload: {
        theme,
        targetTokens,
        style: state.goalStyle,
        roomMood,
        latestMessage: latestText()
      }
    }).catch((error) => ({ ok: false, error: error.message }));
    state.busy = false;
    if (response.ok) {
      state.goals = response.goals || [];
      state.goalSource = response.source || "local";
      state.memory = response.memory || state.memory;
      state.status = `Goals ready (${state.goalSource})`;
    } else {
      state.status = response.error || "Goal generation failed";
    }
    render();
  }

  async function runLiveTool(type, kind) {
    state.tipAmount = Number(root.getElementById("es-tip-amount")?.value || state.tipAmount || 100);
    state.tipViewer = root.getElementById("es-tip-viewer")?.value || state.tipViewer;
    state.busy = true;
    state.status = kind === "quick_challenges" ? "Building challenges..." : "Writing live line...";
    render();
    const response = await request(type, {
      payload: {
        amount: state.tipAmount,
        viewerName: state.tipViewer,
        viewerType: state.viewerType,
        tone: state.tone,
        message: latestText()
      }
    }).catch((error) => ({ ok: false, error: error.message }));
    state.busy = false;
    if (response.ok) {
      state.toolKind = kind;
      state.toolLines = response.lines?.length ? response.lines : response.text ? [response.text] : [];
      state.toolSource = response.source || "local";
      state.memory = response.memory || state.memory;
      state.status = `Live tools ready (${state.toolSource})`;
    } else {
      state.toolLines = [];
      state.toolSource = "error";
      state.status = response.error || "Live tool failed";
    }
    render();
  }

  async function toggleFavorite(favorite) {
    if (!favorite?.text) return;
    const response = await request("TOGGLE_FAVORITE", { favorite }).catch((error) => ({
      ok: false,
      error: error.message
    }));
    if (response.ok) {
      state.favorites = response.favorites || state.favorites;
      state.status = response.saved ? "Saved line" : "Removed saved line";
    } else {
      state.status = response.error || "Could not update saved lines";
    }
    render();
  }

  async function clearFavorites() {
    const response = await request("CLEAR_FAVORITES").catch((error) => ({ ok: false, error: error.message }));
    if (response.ok) {
      state.favorites = [];
      state.status = "Saved lines cleared";
    } else {
      state.status = response.error || "Could not clear saved lines";
    }
    render();
  }

  function bindFavoriteButtons(selector, resolveFavorite) {
    root.querySelectorAll(selector).forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleFavorite(resolveFavorite(button));
      });
    });
  }

  async function rewriteSelected(mode) {
    const current = state.replies[state.selectedReply];
    if (!current) return;
    const response = await request("REWRITE_REPLY", { text: current, mode });
    if (response.ok && response.text) {
      state.replies[state.selectedReply] = response.text;
      render();
    }
  }

  async function refreshAfter(type) {
    const response = await request(type);
    if (response.ok && response.memory) state.memory = response.memory;
    renderWhenIdle();
  }

  function setCollapsed(collapsed) {
    state.collapsed = collapsed;
    render();
  }

  function latestText() {
    return state.memory?.lastTurn?.text || "";
  }

  function statusText() {
    const mode = state.settings?.aiMode || "local";
    if (mode === "direct" && !state.hasApiKey) return "Direct AI needs key";
    if (state.busy) return state.status || "Thinking";
    return `${state.status} - ${mode}`;
  }

  async function copyText(text) {
    const clean = String(text || "").trim();
    if (!clean) return;
    await navigator.clipboard.writeText(clean);
    state.status = "Copied";
    renderWhenIdle();
    setTimeout(() => {
      state.status = "Ready";
      renderWhenIdle();
    }, 1000);
  }

  function renderWhenIdle() {
    if (isPanelInputActive()) {
      pendingIdleRender = true;
      return;
    }
    pendingIdleRender = false;
    render();
  }

  function isPanelInputActive() {
    const active = root?.activeElement;
    return Boolean(active?.matches?.("input, textarea, select"));
  }

  function option(value, label, selected) {
    return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }

  function chip(value, label, selected) {
    return `<button type="button" data-chip="${escapeAttr(value)}" class="${value === selected ? "selected" : ""}">${escapeHtml(label)}</button>`;
  }

  function favoriteButtonMarkup(text, kind, label, dataAttribute, index) {
    const saved = isFavorite(text);
    const title = saved ? "Remove saved line" : "Save line";
    return `<button type="button" class="favorite-btn ${saved ? "saved" : ""}" ${dataAttribute}="${index}" title="${title}" aria-label="${title}" data-favorite-kind="${escapeAttr(kind)}" data-favorite-label="${escapeAttr(label)}">${favoriteIcon(saved)}</button>`;
  }

  function isFavorite(text) {
    const key = String(text || "").trim().toLowerCase();
    return Boolean(key && state.favorites.some((item) => String(item.text || "").trim().toLowerCase() === key));
  }

  function favoriteIcon(saved) {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m12 3.7 2.5 5.1 5.6.8-4.1 4 1 5.6-5-2.7-5 2.7 1-5.6-4.1-4 5.6-.8L12 3.7Z" fill="${saved ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
      </svg>
    `;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  function isDiagnosticsPage() {
    return /^(127\.0\.0\.1|localhost)$/.test(location.hostname) && location.pathname.includes("/diagnostics/");
  }

  function styles() {
    return `
      <style>
        :host {
          all: initial;
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          width: 0;
          height: 0;
          pointer-events: none;
          color-scheme: dark;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          --bg: #070910;
          --panel: rgba(11, 13, 22, .96);
          --card: rgba(17, 21, 34, .86);
          --card-strong: rgba(24, 28, 44, .92);
          --line: rgba(169, 185, 215, .18);
          --line-hot: rgba(255, 42, 177, .72);
          --pink: #ff2ab1;
          --pink-soft: #ff6bd1;
          --violet: #9b5cff;
          --cyan: #25d9ff;
          --gold: #ffd166;
          --text: #f7f3ff;
          --muted: #aeb4c8;
          --shadow: 0 28px 90px rgba(0,0,0,.68), 0 0 42px rgba(255,42,177,.16);
        }
        :host, *, *::before, *::after { box-sizing: border-box; }
        button, input, textarea, select { font: inherit; }
        .es-launch, .es-panel { pointer-events: auto; }
        .es-launch {
          position: fixed;
          right: 18px;
          bottom: 18px;
          z-index: 2147483647;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          border: 1px solid rgba(255,42,177,.55);
          border-radius: 999px;
          padding: 9px 12px;
          background: linear-gradient(145deg, rgba(20,10,24,.96), rgba(6,11,18,.96));
          color: var(--text);
          box-shadow: 0 14px 38px rgba(0,0,0,.48), 0 0 24px rgba(255,42,177,.22);
          cursor: pointer;
        }
        .es-launch img { width: 24px; height: 24px; border-radius: 8px; box-shadow: 0 0 16px rgba(255,42,177,.5); }
        .es-panel {
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483647;
          width: min(520px, max(420px, 28vw));
          max-height: min(760px, calc(100dvh - 32px));
          display: flex;
          flex-direction: column;
          overflow: hidden;
          border: 1px solid rgba(153,169,204,.24);
          border-radius: 10px;
          background:
            radial-gradient(circle at 10% 0%, rgba(255,42,177,.18), transparent 30%),
            radial-gradient(circle at 92% 12%, rgba(37,217,255,.13), transparent 28%),
            linear-gradient(180deg, rgba(12,13,22,.98), rgba(5,7,12,.98));
          color: var(--text);
          box-shadow: var(--shadow);
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 13px;
          line-height: 1.35;
          backdrop-filter: blur(18px);
          contain: content;
          isolation: isolate;
        }
        .es-panel::before {
          content: "";
          height: 2px;
          flex: 0 0 auto;
          background: linear-gradient(90deg, transparent, var(--pink), var(--cyan), transparent);
          box-shadow: 0 0 18px rgba(255,42,177,.8);
        }
        .es-header {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          align-items: center;
          padding: 14px 14px 12px;
          border-bottom: 1px solid var(--line);
          background: linear-gradient(180deg, rgba(18,20,34,.92), rgba(8,10,18,.72));
        }
        .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .brand img {
          width: 42px;
          height: 42px;
          border-radius: 10px;
          object-fit: cover;
          border: 1px solid rgba(255,42,177,.45);
          box-shadow: 0 0 22px rgba(255,42,177,.35), 0 0 14px rgba(37,217,255,.16) inset;
        }
        .brand strong {
          display: block;
          font-size: 16px;
          color: #ffffff;
          letter-spacing: 0;
          text-shadow: 0 0 18px rgba(255,42,177,.38);
        }
        .brand span { display: block; color: var(--muted); font-size: 11px; max-width: 330px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .brand .eyebrow {
          color: var(--pink-soft);
          font-size: 10px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: .16em;
        }
        .header-actions, .actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
        button {
          min-height: 34px;
          border: 1px solid rgba(180,194,226,.2);
          border-radius: 7px;
          padding: 7px 11px;
          background: linear-gradient(180deg, rgba(28,32,48,.95), rgba(15,18,29,.95));
          color: var(--text);
          cursor: pointer;
          box-shadow: 0 8px 22px rgba(0,0,0,.18);
        }
        button:hover { border-color: rgba(255,42,177,.52); box-shadow: 0 0 0 1px rgba(255,42,177,.18) inset, 0 0 20px rgba(255,42,177,.14); }
        button:disabled { opacity: .45; cursor: not-allowed; }
        button.primary {
          min-width: 190px;
          border-color: rgba(255,42,177,.95);
          background: linear-gradient(180deg, #ff2ab1, #b51375);
          color: #fff;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: .03em;
          box-shadow: 0 0 24px rgba(255,42,177,.35), inset 0 1px 0 rgba(255,255,255,.24);
        }
        button.active, button.selected, .reply-card.selected {
          border-color: var(--line-hot);
          box-shadow: 0 0 0 1px rgba(255,42,177,.32) inset, 0 0 22px rgba(255,42,177,.16);
        }
        .status-strip {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          border-bottom: 1px solid var(--line);
          background: rgba(3,5,10,.44);
        }
        .status-strip div {
          min-width: 0;
          padding: 10px 12px;
          border-right: 1px solid rgba(169,185,215,.12);
        }
        .status-strip div:last-child { border-right: 0; }
        .status-strip span {
          display: block;
          color: var(--pink-soft);
          font-size: 9px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: .14em;
        }
        .status-strip strong {
          display: block;
          margin-top: 3px;
          color: #fff;
          font-size: 12px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .tabs {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 0;
          border-bottom: 1px solid var(--line);
          background: rgba(5,7,14,.72);
        }
        .tabs button {
          border: 0;
          border-right: 1px solid rgba(169,185,215,.1);
          border-radius: 0;
          background: transparent;
          color: #c8cbe0;
          padding: 12px 6px;
          font-size: 11px;
          box-shadow: none;
        }
        .tabs button.selected {
          color: #ffffff;
          background: linear-gradient(180deg, rgba(255,42,177,.16), rgba(255,42,177,.04));
          box-shadow: inset 0 -2px 0 var(--pink), 0 10px 32px rgba(255,42,177,.08);
        }
        .body {
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 14px;
          overflow: auto;
          scrollbar-width: thin;
          scrollbar-color: rgba(255,42,177,.75) transparent;
        }
        label { display: grid; gap: 6px; color: #cfd3e6; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
        input, textarea, select {
          width: 100%;
          min-width: 0;
          border: 1px solid rgba(169,185,215,.2);
          border-radius: 8px;
          background: rgba(7,9,16,.86);
          color: var(--text);
          padding: 10px 11px;
          outline: none;
          text-transform: none;
          letter-spacing: 0;
          box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
        }
        textarea { resize: vertical; min-height: 96px; }
        input:focus, textarea:focus, select:focus { border-color: var(--pink); box-shadow: 0 0 0 2px rgba(255,42,177,.18), 0 0 22px rgba(255,42,177,.14); }
        .grid.two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 11px; }
        .segmented { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
        .segmented button { min-width: 0; }
        .tool-actions { display: grid; grid-template-columns: 1.2fr 1fr 1fr; gap: 8px; }
        .tool-actions .primary { min-width: 0; }
        .reply-list, .goal-list { display: grid; gap: 10px; }
        .reply-card, .goal, .room-card, .output, .empty {
          border: 1px solid var(--line);
          border-radius: 9px;
          background: linear-gradient(180deg, var(--card), rgba(9,12,21,.9));
          padding: 12px;
          box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
        }
        .reply-card {
          display: grid;
          grid-template-columns: 40px minmax(0, 1fr) auto;
          gap: 11px;
          align-items: start;
          cursor: pointer;
        }
        .number-badge {
          width: 34px;
          height: 34px;
          display: inline-grid;
          place-items: center;
          border-radius: 999px;
          background: radial-gradient(circle at 32% 22%, #ff78d8, #d71891 62%, #7e1457);
          color: #fff;
          font-weight: 900;
          box-shadow: 0 0 22px rgba(255,42,177,.48);
        }
        .card-copy { min-width: 0; }
        .card-actions { display: flex; flex-direction: column; align-items: stretch; gap: 7px; }
        .reply-card p, .goal p, .room-card p { margin: 0; color: var(--text); }
        .reply-card p { font-size: 14px; line-height: 1.45; }
        .pill {
          display: inline-flex;
          align-items: center;
          min-height: 20px;
          margin: 9px 6px 0 0;
          border: 1px solid rgba(255,42,177,.24);
          border-radius: 5px;
          padding: 2px 7px;
          background: rgba(255,42,177,.14);
          color: #ff9fe1;
          font-size: 10px;
          font-weight: 800;
          text-transform: uppercase;
        }
        .copy-btn {
          min-width: 76px;
          border-color: rgba(255,42,177,.72);
          background: linear-gradient(180deg, rgba(255,42,177,.72), rgba(133,20,91,.9));
          font-weight: 800;
          text-transform: uppercase;
        }
        .favorite-btn {
          min-width: 0;
          width: 100%;
          min-height: 30px;
          display: grid;
          place-items: center;
          padding: 5px;
          color: var(--muted);
          background: rgba(14,17,28,.86);
        }
        .favorite-btn.saved {
          border-color: rgba(255,209,102,.56);
          color: var(--gold);
          box-shadow: 0 0 18px rgba(255,209,102,.12);
        }
        .favorite-btn svg { width: 17px; height: 17px; display: block; }
        .goal { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; gap: 7px 10px; }
        .goal strong { align-self: center; font-size: 14px; color: #fff; }
        .goal span:not(.number-badge) { align-self: center; color: var(--gold); font-weight: 800; }
        .goal p { grid-column: 2 / -1; color: #d5d8e8; }
        .goal em {
          grid-column: 2 / -1;
          color: var(--text);
          font-style: normal;
          border-left: 2px solid var(--pink);
          padding-left: 8px;
        }
        .goal > .card-actions { grid-column: 2 / -1; flex-direction: row; justify-self: start; }
        .goal > .card-actions .favorite-btn { width: 38px; }
        .source-line { color: var(--muted); font-size: 11px; }
        .output, .empty { color: #cfd3e6; min-height: 54px; }
        .subtle button { background: rgba(14,17,28,.86); color: #d5d8e8; }
        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
        .stats div {
          border: 1px solid var(--line);
          border-radius: 9px;
          background: linear-gradient(180deg, rgba(20,25,41,.9), rgba(7,9,16,.92));
          padding: 12px;
        }
        .stats strong { display: block; font-size: 20px; color: var(--cyan); text-shadow: 0 0 16px rgba(37,217,255,.35); }
        .stats span { color: var(--muted); font-size: 11px; }
        .section-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .favorite-list { display: grid; gap: 8px; margin-top: 10px; }
        .favorite-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 10px;
          align-items: start;
          border-top: 1px solid rgba(169,185,215,.12);
          padding-top: 9px;
        }
        .favorite-row:first-child { border-top: 0; padding-top: 0; }
        .favorite-row p { margin: 6px 0 0; color: var(--text); line-height: 1.4; }
        ul { margin: 6px 0 0; padding-left: 18px; color: #d5d8e8; }
        @media (max-width: 520px) {
          .es-panel { right: 8px; bottom: 8px; width: calc(100vw - 16px); }
          .grid.two { grid-template-columns: 1fr; }
          .segmented { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .tool-actions { grid-template-columns: 1fr; }
          .reply-card, .goal { grid-template-columns: 34px minmax(0, 1fr); }
          .reply-card > .card-actions { grid-column: 2; flex-direction: row; justify-self: start; }
          .reply-card > .card-actions .favorite-btn { width: 38px; }
          .brand span { max-width: 190px; }
          .status-strip { grid-template-columns: 1fr; }
          .status-strip div { border-right: 0; border-bottom: 1px solid rgba(169,185,215,.1); }
          .stats { grid-template-columns: repeat(2, 1fr); }
        }

        /* === AI IS THE EXTENSION - Copilot Hero Styles (primary experience) === */
        .copilot-hero {
          margin: 12px 14px 8px;
          padding: 14px;
          border-radius: 12px;
          background: linear-gradient(180deg, rgba(255,42,177,.08), rgba(10,12,20,.92));
          border: 1px solid rgba(255,42,177,.25);
          box-shadow: 0 10px 30px rgba(0,0,0,.3);
        }
        .copilot-head {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 8px;
        }
        .copilot-head strong { font-size: 15px; color: #fff; }
        .ai-pill {
          font-size: 10px; padding: 1px 8px; border-radius: 999px;
          background: rgba(37,216,255,.18); color: #25d8ff; border: 1px solid rgba(37,216,255,.35);
          font-weight: 800; letter-spacing: .5px;
        }
        .copilot-read { font-size: 12.5px; color: #c8d0e6; margin-bottom: 10px; line-height: 1.35; }
        .copilot-read.muted { color: #7f8aa8; font-style: italic; }
        .copilot-grid { display: grid; gap: 8px; margin-bottom: 10px; }
        .copilot-card {
          background: rgba(8,10,18,.9); border: 1px solid rgba(169,185,215,.15);
          border-radius: 9px; padding: 9px 11px; font-size: 13px;
        }
        .card-type { font-size: 9px; font-weight: 900; color: #ff9fe1; text-transform: uppercase; letter-spacing: .6px; margin-bottom: 2px; }
        .card-text { color: #f0f4ff; line-height: 1.35; margin-bottom: 4px; }
        .card-why { font-size: 10px; color: #7f8aa8; }
        .card-copy { margin-top: 6px; font-size: 10px; padding: 3px 8px; min-height: 24px; }
        .copilot-empty { font-size: 12px; color: #7f8aa8; font-style: italic; padding: 4px 0; }
        .copilot-actions { display: grid; gap: 8px; }
        .copilot-ask { display: grid; grid-template-columns: 1fr auto; gap: 6px; }
        .copilot-ask input { font-size: 12px; }
      </style>
    `;
  }
})();
