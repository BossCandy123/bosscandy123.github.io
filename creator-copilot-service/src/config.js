"use strict";

const path = require("node:path");
const { DEFAULT_OPENAI_MODEL, QUALITY_OPENAI_MODEL } = require("./ai-provider");

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const openAiModelTier = String(env.OPENAI_MODEL_TIER || "fast").trim().toLowerCase();
  if (!["fast", "quality"].includes(openAiModelTier)) {
    throw new Error("OPENAI_MODEL_TIER must be fast or quality");
  }
  const localDataDir = path.resolve(
    env.LOCALAPPDATA || process.cwd(),
    "CreatorCopilot",
    "certs"
  );
  const config = {
    production,
    serviceName: "Creator Copilot Service",
    port: integer(env.PORT, 8788),
    httpsPort: integer(env.HTTPS_PORT, 8789),
    dataFile: path.resolve(env.DATA_FILE || path.join(process.cwd(), "data", "licenses.json")),
    httpsPfxFile: path.resolve(
      env.HTTPS_PFX_FILE || path.join(localDataDir, "creator-copilot-localhost.pfx")
    ),
    httpsPfxPassphrase: String(env.HTTPS_PFX_PASSPHRASE || "").trim(),
    httpsPfxPassphraseFile: String(env.HTTPS_PFX_PASSPHRASE_FILE || "").trim(),
    adminApiKey: String(env.ADMIN_API_KEY || "").trim(),
    operatorApiKey: String(env.OPERATOR_API_KEY || "").trim(),
    licenseHashSecret: String(env.LICENSE_HASH_SECRET || "").trim(),
    billingWebhookSecret: String(env.BILLING_WEBHOOK_SECRET || "").trim(),
    corsOrigins: String(
      env.CORS_ORIGINS ||
        [
          "http://localhost:3000",
          "http://127.0.0.1:8788",
          "http://localhost:8788",
          "https://127.0.0.1:8789",
          "https://localhost:8789",
          "chrome-extension://*"
        ].join(",")
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    maxBodyBytes: integer(env.MAX_BODY_BYTES, 1_000_000),
    aiModel: String(
      env.OPENAI_MODEL ||
        (openAiModelTier === "quality" ? QUALITY_OPENAI_MODEL : DEFAULT_OPENAI_MODEL)
    ).trim(),
    openAiModelTier,
    openAiApiKey: String(env.OPENAI_API_KEY || "").trim(),
    openAiBaseUrl: String(env.OPENAI_BASE_URL || "https://api.openai.com").trim(),
    openAiRequestTimeoutMs: integer(env.OPENAI_REQUEST_TIMEOUT_MS, 20_000)
  };

  const missing = [
    ["ADMIN_API_KEY", config.adminApiKey],
    ["OPERATOR_API_KEY", config.operatorApiKey],
    ["LICENSE_HASH_SECRET", config.licenseHashSecret],
    ["BILLING_WEBHOOK_SECRET", config.billingWebhookSecret]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) throw new Error(`Missing required secrets: ${missing.join(", ")}`);
  return config;
}

function integer(value, fallback) {
  const number = Number.parseInt(value || fallback, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

module.exports = {
  loadConfig
};
