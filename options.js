import {
  DEFAULT_SETTINGS,
  normalizeApiKey,
  normalizeSettings
} from "./ai_service.js";

const fields = {
  statusLine: document.getElementById("statusLine"),
  saveBtn: document.getElementById("saveBtn"),
  testBtn: document.getElementById("testBtn"),
  clearKeyBtn: document.getElementById("clearKeyBtn"),
  fastPresetBtn: document.getElementById("fastPresetBtn"),
  qualityPresetBtn: document.getElementById("qualityPresetBtn"),
  resetMemoryBtn: document.getElementById("resetMemoryBtn"),
  pruneMemoryBtn: document.getElementById("pruneMemoryBtn"),
  aiMode: document.getElementById("aiMode"),
  model: document.getElementById("model"),
  fallbackModel: document.getElementById("fallbackModel"),
  backendUrl: document.getElementById("backendUrl"),
  apiKey: document.getElementById("apiKey"),
  rememberApiKey: document.getElementById("rememberApiKey"),
  personaName: document.getElementById("personaName"),
  personaStyle: document.getElementById("personaStyle"),
  houseRules: document.getElementById("houseRules"),
  enabled: document.getElementById("enabled"),
  overlayAutoOpen: document.getElementById("overlayAutoOpen"),
  featureReplies: document.getElementById("featureReplies"),
  featureTips: document.getElementById("featureTips"),
  featureGoals: document.getElementById("featureGoals"),
  featureTools: document.getElementById("featureTools"),
  featureRoom: document.getElementById("featureRoom"),
  operatorBridgeEnabled: document.getElementById("operatorBridgeEnabled"),
  maxTurns: document.getElementById("maxTurns"),
  maxViewers: document.getElementById("maxViewers"),
  maxPromptTokens: document.getElementById("maxPromptTokens"),
  diagnosticsLimit: document.getElementById("diagnosticsLimit"),
  sendRoomContext: document.getElementById("sendRoomContext"),
  saveDiagnostics: document.getElementById("saveDiagnostics")
};

let currentSettings = normalizeSettings(DEFAULT_SETTINGS);

document.addEventListener("DOMContentLoaded", init);

async function init() {
  fields.saveBtn.addEventListener("click", saveSettings);
  fields.testBtn.addEventListener("click", testConnection);
  fields.clearKeyBtn.addEventListener("click", clearKey);
  fields.fastPresetBtn.addEventListener("click", applyFastPreset);
  fields.qualityPresetBtn.addEventListener("click", applyQualityPreset);
  fields.resetMemoryBtn.addEventListener("click", () => runMemoryAction("RESET_MEMORY", "Live memory reset."));
  fields.pruneMemoryBtn.addEventListener("click", () => runMemoryAction("PRUNE_MEMORY", "Live memory pruned."));

  fields.aiMode.addEventListener("change", updateModeHint);
  await loadState();
}

async function loadState() {
  const response = await send("GET_STATE");
  if (!response.ok) {
    setStatus(response.error || "Could not load settings.");
    return;
  }
  currentSettings = normalizeSettings(response.settings || DEFAULT_SETTINGS);
  fillForm(currentSettings);
  setStatus(response.hasApiKey ? "Saved key found. Settings loaded." : "Settings loaded.");
}

function fillForm(settings) {
  fields.aiMode.value = settings.aiMode;
  fields.model.value = settings.model;
  fields.fallbackModel.value = settings.fallbackModel;
  fields.backendUrl.value = settings.backendUrl;
  fields.apiKey.value = "";
  fields.rememberApiKey.checked = Boolean(settings.rememberApiKey);
  fields.personaName.value = settings.personaName;
  fields.personaStyle.value = settings.personaStyle;
  fields.houseRules.value = settings.houseRules;
  fields.enabled.checked = Boolean(settings.enabled);
  fields.overlayAutoOpen.checked = Boolean(settings.overlayAutoOpen);
  fields.featureReplies.checked = settings.features.replies !== false;
  fields.featureTips.checked = settings.features.tips !== false;
  fields.featureGoals.checked = settings.features.goals !== false;
  fields.featureTools.checked = settings.features.tools !== false;
  fields.featureRoom.checked = settings.features.room !== false;
  fields.operatorBridgeEnabled.checked = Boolean(settings.operatorBridgeEnabled);
  fields.maxTurns.value = settings.maxTurns;
  fields.maxViewers.value = settings.maxViewers;
  fields.maxPromptTokens.value = settings.maxPromptTokens;
  fields.diagnosticsLimit.value = settings.diagnosticsLimit;
  fields.sendRoomContext.checked = settings.privacy.sendRoomContext !== false;
  fields.saveDiagnostics.checked = settings.privacy.saveDiagnostics !== false;
  updateModeHint();
}

function collectForm() {
  return normalizeSettings({
    ...currentSettings,
    aiProvider: "openai",
    aiMode: fields.aiMode.value,
    apiBaseUrl: "https://api.openai.com",
    model: fields.model.value,
    fallbackModel: fields.fallbackModel.value,
    backendUrl: fields.backendUrl.value,
    rememberApiKey: fields.rememberApiKey.checked,
    personaName: fields.personaName.value,
    personaStyle: fields.personaStyle.value,
    houseRules: fields.houseRules.value,
    enabled: fields.enabled.checked,
    overlayAutoOpen: fields.overlayAutoOpen.checked,
    operatorBridgeEnabled: fields.operatorBridgeEnabled.checked,
    features: {
      replies: fields.featureReplies.checked,
      tips: fields.featureTips.checked,
      goals: fields.featureGoals.checked,
      tools: fields.featureTools.checked,
      room: fields.featureRoom.checked
    },
    maxTurns: fields.maxTurns.value,
    maxViewers: fields.maxViewers.value,
    maxPromptTokens: fields.maxPromptTokens.value,
    diagnosticsLimit: fields.diagnosticsLimit.value,
    privacy: {
      sendRoomContext: fields.sendRoomContext.checked,
      saveDiagnostics: fields.saveDiagnostics.checked
    }
  });
}

async function saveSettings() {
  fields.saveBtn.disabled = true;
  fields.saveBtn.textContent = "Saving...";
  const settings = collectForm();
  const permissionOk = await requestApiPermission(settings);
  const operatorPermissionOk = permissionOk && (await requestOperatorPermission(settings));
  if (!permissionOk || !operatorPermissionOk) {
    fields.saveBtn.disabled = false;
    fields.saveBtn.textContent = "Save settings";
    const label = !permissionOk
      ? settings.aiMode === "backend" ? "Backend" : "Direct API"
      : "Dashboard bridge";
    setStatus(`${label} permission was not granted. Settings were not saved.`);
    return { ok: false, aborted: true };
  }
  const payload = { settings };
  const pastedKey = normalizeApiKey(fields.apiKey.value);
  if (pastedKey) {
    payload.apiKey = pastedKey;
  }

  const response = await send("SAVE_SETTINGS", payload).catch((error) => ({
    ok: false,
    error: error.message
  }));
  fields.saveBtn.disabled = false;
  fields.saveBtn.textContent = "Save settings";

  if (!response.ok) {
    setStatus(response.error || "Could not save settings.");
    return response;
  }

  currentSettings = normalizeSettings(response.settings);
  fields.apiKey.value = "";
  setStatus(response.hasApiKey ? "Saved. AI key/token is available." : "Saved.");
  return response;
}

async function testConnection() {
  const saved = await saveSettings();
  if (!saved?.ok) return;
  fields.testBtn.disabled = true;
  fields.testBtn.textContent = "Testing...";
  const response = await send("TEST_CONNECTION").catch((error) => ({
    ok: false,
    error: error.message
  }));
  fields.testBtn.disabled = false;
  fields.testBtn.textContent = "Test connection";
  setStatus(response.ok ? response.message : response.message || response.error || "Connection failed.");
}

async function clearKey() {
  fields.apiKey.value = "";
  const settings = collectForm();
  const response = await send("SAVE_SETTINGS", { settings, apiKey: "" });
  setStatus(response.ok ? "Saved API key cleared." : response.error || "Could not clear key.");
}

async function runMemoryAction(type, successMessage) {
  const response = await send(type);
  setStatus(response.ok ? successMessage : response.error || "Memory action failed.");
}

function updateModeHint() {
  const mode = fields.aiMode.value;
  if (mode === "direct") {
    setStatus("Direct mode calls OpenAI from the browser with your saved key.");
  } else {
    setStatus("Backend mode sends requests to your local OpenAI backend.");
  }
}

function applyFastPreset() {
  fields.aiMode.value = "direct";
  fields.model.value = "gpt-5-mini";
  fields.fallbackModel.value = "gpt-5-nano";
  fields.backendUrl.value = "http://127.0.0.1:8787/generate";
  setStatus("Fast GPT-5 preset applied. Paste your OpenAI key, then save and test.");
}

function applyQualityPreset() {
  fields.aiMode.value = "direct";
  fields.model.value = "gpt-5";
  fields.fallbackModel.value = "gpt-5-mini";
  fields.backendUrl.value = "http://127.0.0.1:8787/generate";
  setStatus("Quality GPT-5 preset applied. Paste your OpenAI key, then save and test.");
}

function setStatus(text) {
  fields.statusLine.textContent = text;
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

async function requestApiPermission(settings) {
  const urlToRequest = settings.aiMode === "backend" ? settings.backendUrl : settings.apiBaseUrl;
  if (!["backend", "direct"].includes(settings.aiMode) || !urlToRequest) return true;
  let originPattern = "";
  try {
    const url = new URL(urlToRequest);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      setStatus("API URL must use HTTPS unless it is localhost.");
      return false;
    }
    originPattern = `${url.protocol}//${url.hostname}/*`;
  } catch {
    setStatus("API URL is not valid.");
    return false;
  }

  const alreadyGranted = await chrome.permissions.contains({ origins: [originPattern] });
  if (alreadyGranted) return true;
  return chrome.permissions.request({ origins: [originPattern] });
}

async function requestOperatorPermission(settings) {
  if (!settings.operatorBridgeEnabled) return true;
  const origins = ["https://127.0.0.1/*", "https://localhost/*"];
  const alreadyGranted = await chrome.permissions.contains({ origins });
  if (alreadyGranted) return true;
  return chrome.permissions.request({ origins });
}
