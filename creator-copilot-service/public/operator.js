const OPERATOR_API_KEY = String(window.__OPERATOR_API_KEY__ || "");

const state = {
  snapshot: null,
  activeTask: "reply_suggestions",
  busy: false,
  selectedQueueIds: new Set()
};

const elements = {
  bridgeStatus: document.getElementById("bridgeStatus"),
  providerStatus: document.getElementById("providerStatus"),
  modelStatus: document.getElementById("modelStatus"),
  commandStatus: document.getElementById("commandStatus"),
  roomTitle: document.getElementById("roomTitle"),
  goalSummary: document.getElementById("goalSummary"),
  roomPace: document.getElementById("roomPace"),
  lastViewer: document.getElementById("lastViewer"),
  sourceChip: document.getElementById("sourceChip"),
  queueCount: document.getElementById("queueCount"),
  queueList: document.getElementById("queueList"),
  eventCount: document.getElementById("eventCount"),
  feedList: document.getElementById("feedList"),
  diagnosticList: document.getElementById("diagnosticList"),
  setupList: document.getElementById("setupList"),
  generateForm: document.getElementById("generateForm"),
  generateBtn: document.getElementById("generateBtn"),
  viewerName: document.getElementById("viewerName"),
  tone: document.getElementById("tone"),
  targetTokens: document.getElementById("targetTokens"),
  messageLabel: document.getElementById("messageLabel"),
  message: document.getElementById("message"),
  context: document.getElementById("context"),
  useRoomBtn: document.getElementById("useRoomBtn"),
  clearFormBtn: document.getElementById("clearFormBtn"),
  openStripChatBtn: document.getElementById("openStripChatBtn"),
  openBroadcastBtn: document.getElementById("openBroadcastBtn"),
  manualEnqueueText: document.getElementById("manualEnqueueText"),
  manualEnqueueBtn: document.getElementById("manualEnqueueBtn"),
  aiPlanBtn: document.getElementById("aiPlanBtn"),
  manualEventForm: document.getElementById("manualEventForm"),
  manualMessage: document.getElementById("manualMessage"),
  queueItemTemplate: document.getElementById("queueItemTemplate"),
  feedItemTemplate: document.getElementById("feedItemTemplate"),
  diagnosticItemTemplate: document.getElementById("diagnosticItemTemplate"),
  queueNavLink: document.getElementById("queueNavLink"),
  queueNavBadge: document.getElementById("queueNavBadge"),
  sendAllBtn: document.getElementById("sendAllBtn"),
  sendSelectedBtn: document.getElementById("sendSelectedBtn"),
  dismissSelectedBtn: document.getElementById("dismissSelectedBtn"),
  selectAllBtn: document.getElementById("selectAllBtn")
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  setupKeyboard();
  restorePersistedForm();
  setCommandStatus("Checking local service...", "pending");
  await refreshState();
  window.setInterval(refreshState, 2500);
}

function bindEvents() {
  document.querySelectorAll(".task-tab").forEach((button) => {
    button.addEventListener("click", () => setActiveTask(button.dataset.task || "reply_suggestions"));
  });

  document.querySelectorAll("[data-demo]").forEach((button) => {
    button.addEventListener("click", async () => {
      await postEvent(buildDemoEvent(button.getAttribute("data-demo")));
    });
  });

  elements.generateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await generateDashboardItems();
  });

  elements.manualEventForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = elements.manualMessage.value.trim();
    if (!message) return;
    await postEvent({
      type: "chat_turn",
      source: "dashboard",
      message,
      viewerName: elements.viewerName.value.trim(),
      roomTitle: currentRoom().title,
      goalSummary: currentRoom().goal,
      pace: currentRoom().pace
    });
    elements.manualMessage.value = "";
  });

  elements.useRoomBtn.addEventListener("click", () => {
    const room = currentRoom();
    elements.context.value = [
      room.title ? `Room title: ${room.title}` : "",
      room.goal ? `Goal: ${room.goal}` : "",
      room.pace ? `Pace: ${room.pace}` : "",
      room.lastViewer ? `Last viewer: ${room.lastViewer}` : "",
      room.lastMessage ? `Last message: ${room.lastMessage}` : ""
    ]
      .filter(Boolean)
      .join("\n");
    setCommandStatus("Live room context loaded", "muted");
  });

  elements.clearFormBtn.addEventListener("click", () => {
    elements.viewerName.value = "";
    elements.message.value = "";
    elements.context.value = "";
    setCommandStatus("Workspace cleared", "muted");
  });

  elements.openStripChatBtn.addEventListener("click", () => {
    window.open("https://stripchat.com/EclipseStud", "_blank", "noopener");
  });

  elements.openBroadcastBtn.addEventListener("click", () => {
    window.open("https://stripchat.com/start-broadcasting", "_blank", "noopener");
  });

  const clearBtn = document.getElementById("clearQueueBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      const queue = Array.isArray(state.snapshot?.queue) ? [...state.snapshot.queue] : [];
      if (!queue.length) return;
      setCommandStatus("Clearing queue...", "pending");
      for (const item of queue) {
        try {
          await fetchJson(`/v1/operator/queue/${encodeURIComponent(item.id)}/dismiss`, { method: "POST" });
        } catch {}
      }
      await refreshState();
      setCommandStatus("Queue cleared", "muted");
    });
  }

  if (elements.manualEnqueueBtn && elements.manualEnqueueText) {
    const doEnqueue = async () => {
      const text = elements.manualEnqueueText.value.trim();
      if (!text) return;
      setCommandStatus("Adding to queue...", "pending");
      elements.manualEnqueueBtn.disabled = true;
      const response = await fetchJson("/v1/operator/queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, source: "dashboard-manual", label: "Manual" })
      });
      elements.manualEnqueueBtn.disabled = false;
      elements.manualEnqueueText.value = "";
      if (response.ok) {
        state.snapshot = response.state;
        setCommandStatus("Added to queue", "connected");
        render();
      } else {
        setCommandStatus(response.error || "Failed to add", "failed");
      }
    };
    elements.manualEnqueueBtn.addEventListener("click", doEnqueue);
    elements.manualEnqueueText.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doEnqueue();
      }
    });
  }

  // Bulk queue actions (Send all ready, Send selected, Dismiss selected)
  if (elements.sendAllBtn) {
    elements.sendAllBtn.addEventListener("click", async () => {
      const queue = Array.isArray(state.snapshot?.queue) ? state.snapshot.queue : [];
      const ready = queue.filter((it) => !["pending", "delivered", "succeeded"].includes(it.commandStatus));
      if (!ready.length) return;
      setCommandStatus(`Sending ${ready.length} items...`, "pending");
      for (const item of ready) {
        try {
          await queuePasteCommand(item);
        } catch {}
      }
      await refreshState();
    });
  }

  if (elements.sendSelectedBtn) {
    elements.sendSelectedBtn.addEventListener("click", async () => {
      await sendSelectedItems();
    });
  }

  if (elements.dismissSelectedBtn) {
    elements.dismissSelectedBtn.addEventListener("click", async () => {
      await dismissSelectedItems();
    });
  }

  if (elements.selectAllBtn) {
    elements.selectAllBtn.addEventListener("click", () => {
      const queue = Array.isArray(state.snapshot?.queue) ? state.snapshot.queue : [];
      const allSelected = queue.length > 0 && queue.every((it) => state.selectedQueueIds.has(it.id));
      state.selectedQueueIds.clear();
      if (!allSelected) {
        queue.forEach((it) => state.selectedQueueIds.add(it.id));
      }
      renderQueue(queue); // re-render to update checkboxes
    });
  }

  if (elements.aiPlanBtn) {
    elements.aiPlanBtn.addEventListener("click", async () => {
      await getHighReasoningAIPlan();
    });
  }
}

function setActiveTask(task) {
  state.activeTask = task;
  document.querySelectorAll(".task-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.task === task);
  });

  const labels = {
    reply_suggestions: "Viewer message",
    stream_titles: "Title notes",
    token_goals: "Goal notes",
    engagement_prompts: "Room mood"
  };
  const placeholders = {
    reply_suggestions: "Paste the exact viewer line you want to answer...",
    stream_titles: "Game, vibe, mood, or what today's room should be about...",
    token_goals: "Example: shorts, shirt, underwear, total 750 tokens...",
    engagement_prompts: "What is happening in the room right now?"
  };
  elements.messageLabel.textContent = labels[task] || "Message";
  elements.message.placeholder = placeholders[task] || "Enter context...";
  elements.targetTokens.disabled = task !== "token_goals";
}

async function refreshState() {
  const response = await fetchJson("/v1/operator/state");
  if (!response.ok) {
    setCommandStatus(response.error?.message || response.error || "Operator service unavailable", "failed");
    renderSetup(null);
    return;
  }
  state.snapshot = response.state;
  render();
}

async function generateDashboardItems() {
  const message = elements.message.value.trim();
  const context = elements.context.value.trim();
  if (!message && !context) {
    setCommandStatus("Add a message or room context first", "warning");
    return;
  }

  setBusy(true, "Generating...");
  setCommandStatus("Generating OpenAI queue items...", "pending");
  const response = await fetchJson("/v1/operator/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task: state.activeTask,
      viewerName: elements.viewerName.value.trim(),
      message,
      context,
      tone: elements.tone.value,
      targetTokens: Number(elements.targetTokens.value || 0),
      roomTitle: currentRoom().title,
      goalSummary: currentRoom().goal,
      pace: currentRoom().pace
    })
  });
  setBusy(false);

  if (!response.ok) {
    setCommandStatus(response.error?.message || response.error || "Generation failed", "failed");
    return;
  }

  state.snapshot = response.state;
  setCommandStatus("Generated and queued", "connected");
  render();
}

async function postEvent(payload) {
  setBusy(true, "Generating...");
  setCommandStatus("Sending room event to OpenAI...", "pending");
  const response = await fetchJson("/v1/operator/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  setBusy(false);

  if (!response.ok) {
    setCommandStatus(response.error?.message || response.error || "Room event failed", "failed");
    return;
  }
  state.snapshot = response.state;
  setCommandStatus("Room event queued", "connected");
  render();
}

async function queuePasteCommand(item) {
  setCommandStatus("Sending line to extension...", "pending");
  const response = await fetchJson("/v1/operator/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "paste_text",
      text: item.text,
      queueItemId: item.id,
      source: "dashboard"
    })
  });

  if (!response.ok) {
    setCommandStatus(response.error?.message || response.error || "Command queue failed", "failed");
    return;
  }
  state.snapshot = response.state;
  setCommandStatus("Waiting for extension bridge", "pending");
  render();
}

async function dismissQueueItem(item) {
  const response = await fetchJson(`/v1/operator/queue/${encodeURIComponent(item.id)}/dismiss`, {
    method: "POST"
  });
  if (!response.ok) {
    setCommandStatus(response.error?.message || response.error || "Could not dismiss item", "failed");
    return;
  }
  state.snapshot = response.state;
  setCommandStatus("Queue item dismissed", "muted");
  render();
}

function render() {
  const snapshot = state.snapshot;
  if (!snapshot) return;

  const bridgeConnected = Boolean(snapshot.bridge?.connected);
  elements.bridgeStatus.textContent = bridgeConnected ? "Extension bridge live" : "Open extension panel";
  elements.bridgeStatus.className = `status-pill ${bridgeConnected ? "connected" : "warning"}`;
  elements.providerStatus.textContent =
    snapshot.provider === "openai" ? "OpenAI connected" : "OpenAI unavailable";
  elements.providerStatus.className = `status-pill ${snapshot.provider === "openai" ? "connected" : "failed"}`;
  elements.modelStatus.textContent = `Model: ${snapshot.model || "--"}`;
  elements.sourceChip.textContent = `Source: ${snapshot.provider || "unknown"}`;

  const latestCommand = Array.isArray(snapshot.commands) ? snapshot.commands[0] : null;
  if (latestCommand?.status === "succeeded") {
    setCommandStatus(latestCommand.message || "Loaded in StripChat", "connected");
  } else if (latestCommand?.status === "failed") {
    setCommandStatus(latestCommand.message || "Paste command failed", "failed");
  } else if (latestCommand?.status === "delivered") {
    setCommandStatus("Extension is loading the line...", "pending");
  } else if (latestCommand?.status === "pending") {
    setCommandStatus("Waiting for extension bridge", "pending");
  } else if (!state.busy) {
    setCommandStatus("Commands idle", "muted");
  }

  const room = currentRoom();
  elements.roomTitle.textContent = room.title || "Waiting for room signals";
  elements.goalSummary.textContent = room.goal || "No goal captured yet";
  elements.roomPace.textContent = room.pace || "steady";
  elements.lastViewer.textContent = room.lastViewer || "--";

  const queue = Array.isArray(snapshot.queue) ? snapshot.queue : [];
  const feed = Array.isArray(snapshot.feed) ? snapshot.feed : [];
  const diagnostics = Array.isArray(snapshot.diagnostics) ? snapshot.diagnostics : [];

  elements.queueCount.textContent = `${queue.length} queued`;
  elements.eventCount.textContent = `${snapshot.metrics?.events || feed.length} events`;

  // Update nav badge for quick visual queue size (both GUIs benefit from obvious queue awareness)
  if (elements.queueNavBadge) {
    if (queue.length > 0) {
      elements.queueNavBadge.textContent = String(queue.length);
      elements.queueNavBadge.hidden = false;
    } else {
      elements.queueNavBadge.hidden = true;
    }
  }

  renderQueue(queue);
  renderFeed(feed);
  renderDiagnostics(diagnostics);
  renderSetup(snapshot);

  // Auto-refresh AI tip in setup on every render (webapp now feels alive with the AI core)
  // This keeps the #setup section useful and tied to the high-reasoning experience
  if (document.getElementById("aiSetupTipText")) {
    // re-renderSetup already handles dynamic text
  }
}

function renderQueue(queue) {
  elements.queueList.innerHTML = "";
  if (!queue.length) {
    elements.queueList.appendChild(emptyState("Generated lines, titles, and goals will appear here."));
    updateBulkButtonStates();
    return;
  }

  queue.forEach((item, index) => {
    const fragment = elements.queueItemTemplate.content.cloneNode(true);
    const node = fragment.querySelector(".queue-item");
    node.dataset.queueId = item.id;

    // Enable drag for priority reordering
    node.draggable = true;

    node.querySelector(".queue-kind").textContent = capitalize(item.kind || "reply");
    node.querySelector(".queue-label").textContent = item.label || "Ready";

    // Show priority rank (drag to change — this order is what gets sent first when you batch)
    const rank = document.createElement("span");
    rank.className = "queue-rank";
    rank.textContent = `#${index + 1}`;
    node.querySelector(".queue-meta").prepend(rank);

    const textEl = node.querySelector(".queue-text");
    textEl.textContent = item.text || "";
    if (item.edited) textEl.classList.add("edited");

    const sourceEl = node.querySelector(".queue-source");
    const src = (item.source || "openai").toString();
    sourceEl.textContent = `Source: ${src}${item.edited ? " (edited)" : ""}`;

    const commandStatus = node.querySelector(".queue-command-status");
    commandStatus.textContent = queueCommandText(item);
    commandStatus.className = `queue-command-status ${item.commandStatus || "ready"}`;

    const sendButton = node.querySelector(".send-btn");
    sendButton.disabled = ["pending", "delivered"].includes(item.commandStatus);
    sendButton.textContent =
      item.commandStatus === "succeeded"
        ? "Send again"
        : item.commandStatus === "failed"
          ? "Retry send"
          : "Send to extension";
    sendButton.addEventListener("click", () => queuePasteCommandWithText(item, textEl.textContent));

    node.querySelector(".copy-btn").addEventListener("click", async () => {
      await navigator.clipboard.writeText(textEl.textContent || item.text || "").catch(() => undefined);
      setCommandStatus("Copied", "muted");
    });

    // Checkbox for bulk actions
    const checkbox = node.querySelector(".queue-checkbox");
    checkbox.checked = state.selectedQueueIds.has(item.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.selectedQueueIds.add(item.id);
      } else {
        state.selectedQueueIds.delete(item.id);
      }
      updateBulkButtonStates();
    });

    // Edit support
    const editBtn = document.createElement("button");
    editBtn.className = "ghost-btn";
    editBtn.style.minHeight = "28px";
    editBtn.style.padding = "2px 8px";
    editBtn.style.fontSize = "0.7rem";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => startInlineEdit(item, textEl, node, editBtn));

    const actions = node.querySelector(".queue-action-buttons");
    actions.insertBefore(editBtn, actions.firstChild);

    node.querySelector(".dismiss-btn").addEventListener("click", () => {
      state.selectedQueueIds.delete(item.id);
      dismissQueueItem(item);
    });

    // Drag and drop for reordering / priority
    node.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", item.id);
      node.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });

    node.addEventListener("dragend", () => {
      node.classList.remove("dragging");
      // Clear any drag-over states
      document.querySelectorAll(".queue-item").forEach(n => n.classList.remove("drag-over"));
    });

    node.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      node.classList.add("drag-over");
    });

    node.addEventListener("dragleave", () => {
      node.classList.remove("drag-over");
    });

    node.addEventListener("drop", (e) => {
      e.preventDefault();
      node.classList.remove("drag-over");
      const draggedId = e.dataTransfer.getData("text/plain");
      if (!draggedId || draggedId === item.id) return;

      reorderQueueByDrag(draggedId, item.id);
    });

    elements.queueList.appendChild(fragment);
  });

  // Also allow dropping on the list container for end-of-list
  elements.queueList.ondragover = (e) => { e.preventDefault(); };
  elements.queueList.ondrop = (e) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData("text/plain");
    if (!draggedId) return;
    // Drop at end
    reorderQueueByDrag(draggedId, null);
  };

  updateBulkButtonStates();
}

function reorderQueueByDrag(draggedId, targetId) {
  const queue = Array.isArray(state.snapshot?.queue) ? [...state.snapshot.queue] : [];
  const draggedIndex = queue.findIndex(it => it.id === draggedId);
  if (draggedIndex === -1) return;

  const draggedItem = queue.splice(draggedIndex, 1)[0];

  if (!targetId) {
    queue.push(draggedItem);
  } else {
    const targetIndex = queue.findIndex(it => it.id === targetId);
    if (targetIndex === -1) {
      queue.push(draggedItem);
    } else {
      queue.splice(targetIndex, 0, draggedItem);
    }
  }

  state.snapshot.queue = queue;

  // Persist order to server so priority survives refresh / dashboard restart (true "set it and forget it")
  const newOrder = queue.map(it => it.id);
  fetchJson("/v1/operator/queue/reorder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order: newOrder })
  }).catch(() => {}); // best effort

  renderQueue(queue);
}

function startInlineEdit(item, textEl, node, editBtn) {
  const original = textEl.textContent;
  const ta = document.createElement("textarea");
  ta.value = original;
  ta.style.width = "100%";
  ta.style.minHeight = "70px";
  ta.style.fontSize = "0.95rem";
  textEl.replaceWith(ta);

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.className = "send-btn";
  saveBtn.style.minHeight = "28px";

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.className = "ghost-btn";
  cancelBtn.style.minHeight = "28px";

  const btnWrap = document.createElement("div");
  btnWrap.style.display = "flex";
  btnWrap.style.gap = "6px";
  btnWrap.style.marginTop = "6px";
  btnWrap.appendChild(saveBtn);
  btnWrap.appendChild(cancelBtn);

  const actions = node.querySelector(".queue-action-buttons");
  actions.style.display = "none";
  node.appendChild(btnWrap);

  const finish = async (save) => {
    const newText = save ? ta.value.trim() : original;
    btnWrap.remove();
    actions.style.display = "";
    const finalEl = document.createElement("p");
    finalEl.className = "queue-text" + (save && newText !== original ? " edited" : "");
    finalEl.textContent = newText || original;
    ta.replaceWith(finalEl);

    if (save && newText && newText !== original) {
      // Try to persist the edit to server
      try {
        await fetchJson(`/v1/operator/queue/${encodeURIComponent(item.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: newText })
        });
      } catch {}
      // Update local snapshot text for future sends
      item.text = newText;
      item.edited = true;
    }
    editBtn.disabled = false;
  };

  saveBtn.addEventListener("click", () => finish(true));
  cancelBtn.addEventListener("click", () => finish(false));
  editBtn.disabled = true;
}

// Wrapper so Send uses the (possibly edited) text from the DOM element
async function queuePasteCommandWithText(item, currentText) {
  const textToSend = (currentText || item.text || "").trim();
  if (!textToSend) return;
  // Temporarily override for the command
  const originalText = item.text;
  item.text = textToSend;
  await queuePasteCommand(item);
  item.text = originalText; // keep snapshot stable
}

function renderFeed(feed) {
  elements.feedList.innerHTML = "";
  if (!feed.length) {
    elements.feedList.appendChild(emptyState("Room events from the extension and dashboard will land here."));
    return;
  }

  feed.forEach((item) => {
    const fragment = elements.feedItemTemplate.content.cloneNode(true);
    fragment.querySelector(".feed-title").textContent = item.title || "Event";
    fragment.querySelector(".feed-time").textContent = relativeTime(item.ts);
    fragment.querySelector(".feed-subtitle").textContent = item.subtitle || "";
    fragment.querySelector(".feed-message").textContent = cleanFeedMessage(item.message || "");
    elements.feedList.appendChild(fragment);
  });
}

function renderDiagnostics(diagnostics) {
  elements.diagnosticList.innerHTML = "";
  if (!diagnostics.length) {
    elements.diagnosticList.appendChild(emptyState("No bridge or AI diagnostics yet."));
    return;
  }

  diagnostics.forEach((item) => {
    const fragment = elements.diagnosticItemTemplate.content.cloneNode(true);
    fragment.querySelector(".diagnostic-type").textContent = item.type || "diagnostic";
    fragment.querySelector(".feed-time").textContent = relativeTime(item.ts);
    fragment.querySelector(".diagnostic-message").textContent = item.message || "";
    elements.diagnosticList.appendChild(fragment);
  });
}

function renderSetup(snapshot) {
  const bridgeConnected = Boolean(snapshot?.bridge?.connected);
  const providerReady = snapshot?.provider === "openai";
  const queueReady = Array.isArray(snapshot?.queue) && snapshot.queue.length > 0;
  const checks = [
    { text: "Local web app is running", status: snapshot ? "done" : "warn" },
    { text: providerReady ? `OpenAI ready on ${snapshot.model} (Extra High Reasoning)` : "OpenAI provider needs a valid key", status: providerReady ? "done" : "warn" },
    { text: bridgeConnected ? "Extension bridge is connected (Live Copilot active)" : "Open the extension panel on StripChat", status: bridgeConnected ? "done" : "warn" },
    { text: queueReady ? "Queue has lines ready for StripChat" : "AI is ready to generate autonomous plans", status: queueReady ? "done" : "warn" }
  ];
  elements.setupList.innerHTML = "";
  checks.forEach((check) => {
    const item = document.createElement("li");
    item.className = check.status;
    item.textContent = check.text;
    elements.setupList.appendChild(item);
  });

  // Dynamic AI tip in #setup for the webapp - now more agentic
  const tipEl = document.getElementById("aiSetupTipText");
  if (tipEl) {
    if (!bridgeConnected) {
      tipEl.textContent = "The AI is waiting for the in-room Live Copilot (press c in room). Enable bridge from popup so the AI can execute plans autonomously.";
    } else if (!queueReady) {
      tipEl.textContent = "Click 'Let AI Autonomously Run the Next 15 mins' or '★ Run Full AI Session Plan'. The high-reasoning AI will observe, plan, and queue everything with minimal input from you.";
    } else {
      tipEl.textContent = "AI is in control. Drag to adjust priority if you want to steer. The brain will keep suggesting and executing based on live signals.";
    }
  }
}

function buildDemoEvent(type) {
  const roomTitle = currentRoom().title || "Call of Duty chill and quick chat";
  const goalSummary = currentRoom().goal || "750 tk five-goal ladder";
  if (type === "tip_received") {
    return {
      type,
      source: "dashboard",
      viewerName: "nightowl88",
      amount: 75,
      roomTitle,
      goalSummary,
      pace: "rising"
    };
  }
  if (type === "viewer_returned") {
    return {
      type,
      source: "dashboard",
      viewerName: "cashmerefox",
      roomTitle,
      goalSummary,
      pace: "steady"
    };
  }
  if (type === "room_slowdown") {
    return {
      type,
      source: "dashboard",
      roomTitle,
      goalSummary,
      pace: "slow"
    };
  }
  if (type === "title_refresh") {
    return {
      type,
      source: "dashboard",
      roomTitle: "Call of Duty chill and confident room energy",
      goalSummary,
      pace: "steady"
    };
  }
  return {
    type: "chat_turn",
    source: "dashboard",
    viewerName: "velvetstorm",
    message: "what are you in the mood for tonight?",
    roomTitle,
    goalSummary,
    pace: "steady"
  };
}

function currentRoom() {
  const room = state.snapshot?.room || {};
  return {
    title: room.title || "",
    goal: room.goal || "",
    pace: room.pace || "steady",
    lastViewer: room.lastViewer || "",
    lastMessage: room.lastMessage || ""
  };
}

function emptyState(text) {
  const node = document.createElement("div");
  node.className = "empty-state";
  node.textContent = text;
  return node;
}

function queueCommandText(item) {
  if (item.commandMessage) return item.commandMessage;
  if (item.commandStatus === "pending") return "Waiting for extension";
  if (item.commandStatus === "delivered") return "Loading in StripChat";
  if (item.commandStatus === "succeeded") return "Loaded in StripChat";
  if (item.commandStatus === "failed") return "Send failed";
  return "Ready";
}

function setBusy(isBusy, label = "") {
  state.busy = isBusy;
  elements.generateBtn.disabled = isBusy;
  document.querySelectorAll("[data-demo]").forEach((button) => {
    button.disabled = isBusy;
  });
  elements.generateBtn.textContent = isBusy ? label || "Working..." : "Generate and queue";
}

function setCommandStatus(message, status = "muted") {
  elements.commandStatus.textContent = message;
  elements.commandStatus.className = `status-pill ${status}`;
}

function cleanFeedMessage(value) {
  return String(value || "").replace(/^\s*-\s*/, "");
}

function capitalize(value) {
  const text = String(value || "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1).replace(/_/g, " ") : "";
}

function relativeTime(ts) {
  const timestamp = Number(ts || 0);
  if (!timestamp) return "--";
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 5) return "just now";
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  return `${deltaHours}h ago`;
}

async function fetchJson(url, options) {
  try {
    const headers = { ...(options?.headers || {}) };
    if (url.startsWith("/v1/operator/") && OPERATOR_API_KEY) {
      headers["x-operator-key"] = OPERATOR_API_KEY;
    }
    const response = await fetch(url, {
      ...options,
      headers
    });
    const body = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      status: response.status,
      ...body
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

// New: High Reasoning AI Plan for the webapp dashboard
// This makes the webapp a true AI command center, using extra context and multiple smart generations
// to give the model a "session plan" with minimal effort. Ties into the GPT-5.5 high reasoning theme.
async function getHighReasoningAIPlan() {
  setCommandStatus("Running High Reasoning AI Plan...", "pending");
  elements.aiPlanBtn.disabled = true;
  elements.aiPlanBtn.textContent = "Reasoning...";

  const room = currentRoom();
  const baseContext = {
    roomTitle: room.title,
    goalSummary: room.goal,
    pace: room.pace,
    lastViewer: room.lastViewer,
    context: `Current room state: ${room.title || 'unknown title'}. Goal: ${room.goal || 'none'}. Pace: ${room.pace}. Last viewer: ${room.lastViewer || 'none'}. Use extra high reasoning to suggest the most valuable low-effort actions for the performer right now.`
  };

  try {
    // Generate multiple smart recommendations using different high-value tasks
    const tasks = ["reply_suggestions", "engagement_prompts", "stream_titles"];
    const allSuggestions = [];

    for (const task of tasks) {
      const resp = await fetchJson("/v1/operator/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task: task,
          message: baseContext.context,
          context: baseContext.context,
          tone: "natural, quick, high-value for live performer",
          targetTokens: 750,
          ...baseContext
        })
      });

      if (resp.ok && resp.suggestions) {
        resp.suggestions.forEach(s => {
          allSuggestions.push({
            text: s,
            kind: task === "reply_suggestions" ? "reply" : task === "engagement_prompts" ? "wake" : "title",
            label: task === "reply_suggestions" ? "AI Rec" : task === "engagement_prompts" ? "AI Spark" : "AI Title",
            source: "ai-high-reasoning-plan"
          });
        });
      }
    }

    if (allSuggestions.length) {
      // Enqueue them all via the manual queue endpoint for consistency with new features
      for (const sug of allSuggestions.slice(0, 6)) {  // Limit to avoid spam
        await fetchJson("/v1/operator/queue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: sug.text,
            kind: sug.kind,
            label: sug.label,
            source: sug.source
          })
        });
      }

      setCommandStatus("High Reasoning AI Plan added to queue (6 smart moves)", "connected");
      await refreshState();
    } else {
      setCommandStatus("AI Plan generated but no new suggestions (try again with more room data)", "warning");
    }
  } catch (e) {
    setCommandStatus("High Reasoning AI Plan failed - check OpenAI/bridge", "failed");
  } finally {
    elements.aiPlanBtn.disabled = false;
    elements.aiPlanBtn.textContent = "★ High Reasoning AI Plan";
  }
}

// --- Keyboard shortcuts + persistence (GUI power-user improvements for dashboard) ---

function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    // Ignore when focused on inputs that need normal typing (except for global submit)
    const active = document.activeElement;
    const isTyping = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT");

    // Task tabs: 1=Replies, 2=Title, 3=Goals, 4=Wake (or letter shortcuts)
    if (!isTyping && ["1", "2", "3", "4"].includes(e.key)) {
      e.preventDefault();
      const map = { "1": "reply_suggestions", "2": "stream_titles", "3": "token_goals", "4": "engagement_prompts" };
      setActiveTask(map[e.key]);
      return;
    }
    if (!isTyping && e.key.toLowerCase() === "r") { e.preventDefault(); setActiveTask("reply_suggestions"); return; }
    if (!isTyping && e.key.toLowerCase() === "t") { e.preventDefault(); setActiveTask("stream_titles"); return; }
    if (!isTyping && e.key.toLowerCase() === "g") { e.preventDefault(); setActiveTask("token_goals"); return; }
    if (!isTyping && e.key.toLowerCase() === "w") { e.preventDefault(); setActiveTask("engagement_prompts"); return; }

    // Focus main input
    if (!isTyping && (e.key === "/" || (e.key.toLowerCase() === "i" && !e.ctrlKey))) {
      e.preventDefault();
      elements.message.focus();
      elements.message.select();
      return;
    }

    // Submit generate with Ctrl/Cmd+Enter even while typing in form fields
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      if (active && (active.id === "message" || active.id === "context" || active.closest("#generateForm"))) {
        e.preventDefault();
        elements.generateForm.dispatchEvent(new Event("submit", { cancelable: true }));
        return;
      }
    }

    // Clear form
    if (e.key === "Escape" && !e.target.closest(".queue-item")) {
      if (isTyping || active?.closest("#generateForm")) {
        elements.clearFormBtn.click();
        e.preventDefault();
      }
    }

    // Quick jump to queue list
    if (!isTyping && e.key.toLowerCase() === "q") {
      e.preventDefault();
      const q = document.getElementById("queue");
      if (q) q.scrollIntoView({ behavior: "smooth", block: "start" });
      if (elements.queueList) elements.queueList.focus?.();
    }
  });

  // Save form values when they change (persistence across reloads)
  ["tone", "viewerName", "targetTokens"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", persistForm);
  });
  if (elements.message) elements.message.addEventListener("input", debounce(persistForm, 400));
  if (elements.context) elements.context.addEventListener("input", debounce(persistForm, 400));
}

function persistForm() {
  try {
    const data = {
      activeTask: state.activeTask,
      tone: elements.tone?.value,
      viewerName: elements.viewerName?.value,
      targetTokens: elements.targetTokens?.value,
      message: elements.message?.value,
      context: elements.context?.value,
      ts: Date.now()
    };
    localStorage.setItem("es_dashboard_form", JSON.stringify(data));
  } catch {}
}

function restorePersistedForm() {
  try {
    const raw = localStorage.getItem("es_dashboard_form");
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || Date.now() - (data.ts || 0) > 1000 * 60 * 60 * 6) return; // 6h freshness

    if (data.activeTask) setActiveTask(data.activeTask);
    if (elements.tone && data.tone) elements.tone.value = data.tone;
    if (elements.viewerName && data.viewerName != null) elements.viewerName.value = data.viewerName;
    if (elements.targetTokens && data.targetTokens != null) elements.targetTokens.value = data.targetTokens;
    if (elements.message && data.message != null) elements.message.value = data.message;
    if (elements.context && data.context != null) elements.context.value = data.context;
  } catch {}
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function updateBulkButtonStates() {
  const queue = Array.isArray(state.snapshot?.queue) ? state.snapshot.queue : [];
  const selectedCount = state.selectedQueueIds.size;
  const readyCount = queue.filter((it) => !["pending", "delivered", "succeeded"].includes(it.commandStatus)).length;

  if (elements.sendAllBtn) {
    elements.sendAllBtn.disabled = readyCount === 0 || state.busy;
    elements.sendAllBtn.textContent = readyCount > 0 ? `Send all ready (${readyCount})` : "Send all ready";
  }
  if (elements.sendSelectedBtn) {
    elements.sendSelectedBtn.disabled = selectedCount === 0 || state.busy;
    elements.sendSelectedBtn.textContent = selectedCount > 0 ? `Send selected (${selectedCount})` : "Send selected";
  }
  if (elements.dismissSelectedBtn) {
    elements.dismissSelectedBtn.disabled = selectedCount === 0;
  }
  if (elements.selectAllBtn) {
    const allSelected = queue.length > 0 && queue.every((it) => state.selectedQueueIds.has(it.id));
    elements.selectAllBtn.textContent = allSelected ? "Clear selection" : "Select all";
  }
}

async function sendSelectedItems() {
  const queue = Array.isArray(state.snapshot?.queue) ? state.snapshot.queue : [];
  const toSend = queue.filter((it) => state.selectedQueueIds.has(it.id) && !["pending", "delivered", "succeeded"].includes(it.commandStatus));
  if (!toSend.length) return;

  setCommandStatus(`Sending ${toSend.length} selected...`, "pending");
  for (const item of toSend) {
    try {
      await queuePasteCommand(item);
    } catch {}
  }
  state.selectedQueueIds.clear();
  await refreshState();
}

async function dismissSelectedItems() {
  const queue = Array.isArray(state.snapshot?.queue) ? state.snapshot.queue : [];
  const toDismiss = queue.filter((it) => state.selectedQueueIds.has(it.id));
  if (!toDismiss.length) return;

  setCommandStatus(`Dismissing ${toDismiss.length}...`, "pending");
  for (const item of toDismiss) {
    try {
      await fetchJson(`/v1/operator/queue/${encodeURIComponent(item.id)}/dismiss`, { method: "POST" });
    } catch {}
  }
  state.selectedQueueIds.clear();
  await refreshState();
  setCommandStatus("Selected items dismissed", "muted");
}
