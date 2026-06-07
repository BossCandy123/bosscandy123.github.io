const elements = {
  statusLine: document.getElementById("statusLine"),
  modeValue: document.getElementById("modeValue"),
  memoryValue: document.getElementById("memoryValue"),
  viewerValue: document.getElementById("viewerValue"),
  settingsBtn: document.getElementById("settingsBtn"),
  openPanelBtn: document.getElementById("openPanelBtn"),
  viewerMessage: document.getElementById("viewerMessage"),
  viewerType: document.getElementById("viewerType"),
  intent: document.getElementById("intent"),
  generateBtn: document.getElementById("generateBtn"),
  replySection: document.getElementById("replySection"),
  replies: document.getElementById("replies"),
  copyBtn: document.getElementById("copyBtn"),
  shortenBtn: document.getElementById("shortenBtn"),
  warmerBtn: document.getElementById("warmerBtn"),
  wakeBtn: document.getElementById("wakeBtn"),
  topicBtn: document.getElementById("topicBtn"),
  dashboardBtn: document.getElementById("dashboardBtn"),
  resetBtn: document.getElementById("resetBtn"),
  dashBridgeStatus: document.getElementById("dashBridgeStatus"),
  dashQueueStatus: document.getElementById("dashQueueStatus"),
  dashContext: document.getElementById("dashContext"),
  dashRoomTitle: document.getElementById("dashRoomTitle"),
  dashGoal: document.getElementById("dashGoal")
};

const state = {
  settings: null,
  memory: null,
  replies: [],
  selectedReply: 0,
  source: "local",
  dashboardToken: null,
  dashboardQueueCount: 0
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  setupPopupKeyboard();
  await refreshState();
}

function bindEvents() {
  elements.settingsBtn.addEventListener("click", () => send("OPEN_OPTIONS"));
  elements.openPanelBtn.addEventListener("click", openPanel);
  elements.generateBtn.addEventListener("click", generateReplies);
  elements.copyBtn.addEventListener("click", copySelected);
  elements.shortenBtn.addEventListener("click", () => rewriteSelected("shorter"));
  elements.warmerBtn.addEventListener("click", () => rewriteSelected("warmer"));
  elements.wakeBtn.addEventListener("click", () => quickLine("WAKE_LINE"));
  elements.topicBtn.addEventListener("click", buildRoomTopic);
  elements.dashboardBtn.addEventListener("click", connectDashboard);
  elements.resetBtn.addEventListener("click", resetMemory);
}

async function refreshState() {
  const response = await send("GET_STATE");
  if (!response.ok) {
    setStatus(response.error || "Could not load extension state.");
    return;
  }
  state.settings = response.settings;
  state.memory = response.memory;
  renderState(response.hasApiKey);
}

function renderState(hasApiKey) {
  const mode = state.settings?.aiMode || "local";
  elements.modeValue.textContent = modeLabel(mode);
  elements.memoryValue.textContent = String(state.memory?.turnCount || 0);
  elements.viewerValue.textContent = String(state.memory?.viewerCount || 0);
  renderDashBridgeStatus();
  if (mode === "direct" && !hasApiKey) {
    setStatus("Paste your OpenAI API key in Settings to use direct mode.");
  } else if (mode === "backend" && !state.settings?.backendUrl) {
    setStatus("Add your backend URL in Settings.");
  } else {
    setStatus(`Ready. Replies will use ${modeLabel(mode)}.`);
  }
}

async function openPanel() {
  elements.openPanelBtn.disabled = true;
  try {
    const response = await send("INJECT_ACTIVE_TAB");
    setStatus(response.ok ? "Room panel opened." : response.error || "Could not open room panel.");
  } catch (error) {
    setStatus(error.message || "Could not open room panel.");
  } finally {
    elements.openPanelBtn.disabled = false;
  }
}

async function generateReplies() {
  const message = elements.viewerMessage.value.trim();
  if (!message) {
    setStatus("Paste a viewer message first.");
    return;
  }

  elements.generateBtn.disabled = true;
  elements.generateBtn.textContent = "Thinking...";
  let response;
  try {
    response = await send("GENERATE", {
      request: {
        message,
        viewerType: elements.viewerType.value,
        intent: elements.intent.value,
        tone: "playful",
        source: "popup"
      }
    });
  } catch (error) {
    response = { ok: false, error: error.message };
  } finally {
    elements.generateBtn.disabled = false;
    elements.generateBtn.textContent = "Generate three replies";
  }

  if (!response.ok) {
    setStatus(response.error || "Generation failed.");
    return;
  }

  state.replies = response.replies || [];
  state.source = response.source || "local";
  state.memory = response.memory || state.memory;
  renderReplies();
  renderState(true);
  setStatus(`Generated with ${modeLabel(state.source)}.`);
}

function renderReplies() {
  elements.replySection.hidden = false;
  const hasDash = !!state.dashboardToken;
  elements.replies.innerHTML = state.replies
    .map((reply, index) => {
      const sel = index === state.selectedReply ? "selected" : "";
      const dashBtn = hasDash
        ? `<button class="dash-queue-btn" type="button" data-queue-index="${index}" title="Add this line to the web app queue">→ Dashboard</button>`
        : "";
      return `
        <div class="reply-row ${sel}" data-index="${index}">
          <button class="reply ${sel}" type="button" data-index="${index}">
            ${escapeHtml(reply)}
          </button>
          ${dashBtn}
        </div>
      `;
    })
    .join("");

  elements.replies.querySelectorAll("[data-index]").forEach((button) => {
    if (button.classList.contains("reply")) {
      button.addEventListener("click", () => {
        state.selectedReply = Number(button.dataset.index);
        renderReplies();
      });
    }
  });

  elements.replies.querySelectorAll("[data-queue-index]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.queueIndex);
      const text = state.replies[idx];
      if (text) await queueReplyToDashboard(text, btn);
    });
  });
}

async function copySelected() {
  const text = state.replies[state.selectedReply];
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus("Copied.");
}

async function rewriteSelected(mode) {
  const text = state.replies[state.selectedReply];
  if (!text) return;
  const response = await send("REWRITE_REPLY", { text, mode });
  if (response.ok) {
    state.replies[state.selectedReply] = response.text;
    renderReplies();
  }
}

async function quickLine(type, payload = {}) {
  setStatus("Asking AI...");
  const response = await send(type, {
    payload: {
      ...payload,
      viewerType: elements.viewerType.value,
      tone: "playful"
    }
  }).catch((error) => ({ ok: false, error: error.message }));
  if (!response.ok) {
    setStatus(response.error || "Quick line failed.");
    return;
  }
  const text = response.text || "";
  if (text) {
    state.replies = [text];
    state.selectedReply = 0;
    state.source = response.source || "local";
    state.memory = response.memory || state.memory;
    renderReplies();
    await navigator.clipboard.writeText(text);
    setStatus(`Quick line copied from ${modeLabel(state.source)}.`);
  }
}

async function buildRoomTopic() {
  setStatus("Building room topics...");
  const response = await send("ROOM_TOPIC", {
    payload: {
      brief: elements.viewerMessage.value.trim(),
      style: "stream_title",
      tone: "playful"
    }
  }).catch((error) => ({ ok: false, error: error.message }));
  if (!response.ok) {
    setStatus(response.error || "Room topic failed.");
    return;
  }
  state.replies = response.topics || [];
  state.selectedReply = 0;
  state.source = response.source || "local";
  state.memory = response.memory || state.memory;
  renderReplies();
  setStatus(`Topics generated with ${modeLabel(state.source)}.`);
}

async function resetMemory() {
  const response = await send("RESET_MEMORY");
  if (response.ok) {
    state.memory = response.memory;
    renderState(true);
    setStatus("Room memory reset.");
  }
}

async function connectDashboard() {
  elements.dashboardBtn.disabled = true;
  try {
    const permissionOk = await chrome.permissions.request({
      origins: ["https://127.0.0.1/*", "https://localhost/*"]
    });
    if (!permissionOk) {
      setStatus("Dashboard permission was not granted.");
      return;
    }
    const response = await send("CONNECT_DASHBOARD");
    if (response.ok) {
      setStatus("Dashboard bridge enabled.");
      state.dashboardToken = response.operatorToken || "";
      setDashBridgeLinked(true);
      await refreshDashboardQueueCount();
    } else {
      setStatus(response.error || "Dashboard connect failed.");
    }
    await refreshState();
  } catch (error) {
    setStatus(error.message || "Dashboard connect failed.");
  } finally {
    elements.dashboardBtn.disabled = false;
  }
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function setStatus(text) {
  elements.statusLine.textContent = text;
}

function modeLabel(mode) {
  const labels = {
    local: "Local",
    direct: "Direct AI",
    backend: "Backend"
  };
  return labels[mode] || mode;
}

function setDashBridgeLinked(linked) {
  try { localStorage.setItem("es_dashboard_linked", linked ? "1" : "0"); } catch {}
  renderDashBridgeStatus(linked);
}

function renderDashBridgeStatus(linked = null) {
  if (!elements.dashBridgeStatus) return;
  const isLinked = linked !== null ? linked : (localStorage.getItem("es_dashboard_linked") === "1");
  elements.dashBridgeStatus.textContent = isLinked ? "Dashboard linked" : "";
  elements.dashBridgeStatus.className = `dash-status ${isLinked ? "linked" : ""}`;
  elements.dashBridgeStatus.title = isLinked
    ? "Dashboard bridge active — you can send lines from the web app"
    : "Click Web app to link the full operator dashboard";
  if (isLinked && state.dashboardToken) {
    refreshDashboardQueueCount();
  }
  renderDashQueueStatus();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// --- Popup keyboard enhancements (part of "both" GUI work) ---

function setupPopupKeyboard() {
  // Enter in main composer textarea => Generate (Shift+Enter for newline)
  if (elements.viewerMessage) {
    elements.viewerMessage.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        generateReplies();
      }
    });
  }

  // When replies exist: Arrow keys + number keys to navigate and quick-copy
  document.addEventListener("keydown", (e) => {
    if (!state.replies || state.replies.length === 0) return;
    if (document.activeElement && document.activeElement.tagName === "TEXTAREA") return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      state.selectedReply = Math.min(state.replies.length - 1, state.selectedReply + 1);
      renderReplies();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      state.selectedReply = Math.max(0, state.selectedReply - 1);
      renderReplies();
    }
    if (["1", "2", "3"].includes(e.key) && state.replies[Number(e.key) - 1]) {
      e.preventDefault();
      state.selectedReply = Number(e.key) - 1;
      renderReplies();
      // auto-copy on number press for speed (common in live ops)
      navigator.clipboard.writeText(state.replies[state.selectedReply]).catch(() => {});
      setStatus(`Copied reply ${e.key}`);
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && state.replies[state.selectedReply]) {
      // Allow normal copy but also ensure our selected text is in clipboard on Ctrl+C in popup
      // (we already have explicit Copy button; this is belt-and-suspenders)
    }
  });

  // Persist viewer type + intent for convenience
  if (elements.viewerType) {
    elements.viewerType.addEventListener("change", () => {
      try { localStorage.setItem("es_popup_viewerType", elements.viewerType.value); } catch {}
    });
  }
  if (elements.intent) {
    elements.intent.addEventListener("change", () => {
      try { localStorage.setItem("es_popup_intent", elements.intent.value); } catch {}
    });
  }

  // Restore
  try {
    const vt = localStorage.getItem("es_popup_viewerType");
    if (vt && elements.viewerType) elements.viewerType.value = vt;
    const it = localStorage.getItem("es_popup_intent");
    if (it && elements.intent) elements.intent.value = it;
  } catch {}
}

async function queueReplyToDashboard(text, buttonEl) {
  if (!state.dashboardToken || !text) return;
  const originalText = buttonEl.textContent;
  buttonEl.disabled = true;
  buttonEl.textContent = "Queuing...";

  try {
    const res = await fetch("https://127.0.0.1:8789/v1/operator/queue", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-operator-key": state.dashboardToken
      },
      body: JSON.stringify({
        text,
        kind: "reply",
        label: "From popup",
        source: "popup"
      })
    });
    if (res.ok) {
      buttonEl.textContent = "Queued ✓";
      state.dashboardQueueCount = (state.dashboardQueueCount || 0) + 1;
      renderDashQueueStatus();
      setTimeout(() => {
        if (buttonEl && buttonEl.isConnected) {
          buttonEl.textContent = originalText;
          buttonEl.disabled = false;
        }
      }, 1200);
      setStatus("Sent to dashboard queue");
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    buttonEl.textContent = "Failed";
    setStatus("Could not reach dashboard (permission?)");
    setTimeout(() => {
      if (buttonEl && buttonEl.isConnected) {
        buttonEl.textContent = originalText;
        buttonEl.disabled = false;
      }
    }, 1400);
  }
}

async function refreshDashboardQueueCount() {
  if (!state.dashboardToken) {
    renderDashQueueStatus();
    renderDashContext(null);
    return;
  }
  try {
    const res = await fetch("https://127.0.0.1:8789/v1/operator/state", {
      headers: { "x-operator-key": state.dashboardToken },
      cache: "no-store"
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      const snap = body?.state || {};
      const q = Array.isArray(snap.queue) ? snap.queue.length : 0;
      state.dashboardQueueCount = q;

      const room = snap.room || {};
      renderDashContext({
        title: room.title || "",
        goal: room.goal || ""
      });
    }
  } catch {
    // permission or server not up — ignore silently
    renderDashContext(null);
  }
  renderDashQueueStatus();
}

function renderDashContext(room) {
  if (!elements.dashContext) return;
  if (state.dashboardToken && room && (room.title || room.goal)) {
    elements.dashRoomTitle.textContent = room.title || "Live room";
    elements.dashGoal.textContent = room.goal ? `Goal: ${room.goal}` : "";
    elements.dashContext.hidden = false;
  } else {
    elements.dashContext.hidden = true;
  }
}

function renderDashQueueStatus() {
  if (!elements.dashQueueStatus) return;
  if (state.dashboardToken && state.dashboardQueueCount > 0) {
    elements.dashQueueStatus.textContent = `${state.dashboardQueueCount} in queue`;
    elements.dashQueueStatus.style.display = "inline-flex";
  } else if (state.dashboardToken) {
    elements.dashQueueStatus.textContent = "";
    elements.dashQueueStatus.style.display = "none";
  } else {
    elements.dashQueueStatus.style.display = "none";
  }
}
