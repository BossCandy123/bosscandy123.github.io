/*
 * EclipseStud Copilot AI backend proxy.
 *
 * OpenAI:
 *   OPENAI_API_KEY=your_key
 *   OPENAI_MODEL=gpt-5-mini
 */

const http = require("http");

const PORT = Number(process.env.PORT || 8787);
const PROVIDER = "openai";
const GOAL_COUNT = 5;
const API_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
const AUTH_TOKEN = process.env.OPENAI_API_KEY || "";
const BACKEND_REQUEST_TOKEN = normalizeAuthToken(
  process.env.ES_COPILOT_BACKEND_TOKEN || process.env.COPILOT_BACKEND_TOKEN || ""
);
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const UPSTREAM_TIMEOUT_MS = 34_000;

const server = http.createServer(async (request, response) => {
  const browserOriginAllowed = isAllowedRequestOrigin(request);
  setCors(request, response);

  if (!browserOriginAllowed) {
    sendJson(response, 403, { ok: false, message: "Browser origin is not allowed" });
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(browserOriginAllowed ? 204 : 403);
    response.end();
    return;
  }

  if (request.method !== "POST" || request.url !== "/generate") {
    sendJson(response, 404, { ok: false, message: "Not found" });
    return;
  }

  if (!isAuthorizedBackendRequest(request)) {
    sendJson(response, 403, { ok: false, message: "Backend request token is missing or invalid" });
    return;
  }

  try {
    const body = await readJson(request);
    if (body.type === "health_check") {
      sendJson(response, AUTH_TOKEN ? 200 : 500, {
        ok: Boolean(AUTH_TOKEN),
        provider: PROVIDER,
        message: AUTH_TOKEN
          ? `Backend ready (${new URL(API_BASE_URL).hostname}, ${PROVIDER})`
          : `Backend ${PROVIDER} auth token is missing`
      });
      return;
    }

    if (!["generate_replies", "generate_goals"].includes(body.type)) {
      sendJson(response, 400, { ok: false, message: "Unknown request type" });
      return;
    }

    if (!AUTH_TOKEN) {
      sendJson(response, 500, { ok: false, message: `Backend ${PROVIDER} auth token is missing` });
      return;
    }

    const primaryModel = body.model || DEFAULT_MODEL;
    const fallbackModel = body.settings?.fallbackModel || "";
    const result = await callWithModelFallback({ body, primaryModel, fallbackModel });
    const apiResponse = result.response;

    const requestId =
      apiResponse.headers.get("request-id") || apiResponse.headers.get("x-request-id") || "";
    const apiBody = await apiResponse.json().catch(() => ({}));
    response.setHeader("request-id", requestId);

    if (!apiResponse.ok) {
      sendJson(response, apiResponse.status, {
        ok: false,
        message: apiBody?.error?.message || apiBody?.message || `${PROVIDER} request failed`,
        requestId
      });
      return;
    }

    const text = extractOpenAIText(apiBody);
    if (body.type === "generate_goals") {
      sendJson(response, 200, {
        ok: true,
        goals: parseGoals(text),
        requestId,
        model: result.model,
        fallbackUsed: result.fallbackUsed,
        usage: apiBody.usage || {}
      });
    } else {
      sendJson(response, 200, {
        ok: true,
        replies: parseReplies(text),
        requestId,
        model: result.model,
        fallbackUsed: result.fallbackUsed,
        usage: apiBody.usage || {}
      });
    }
  } catch (error) {
    sendJson(response, 500, { ok: false, message: error.message || String(error) });
  }
});

if (require.main === module) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`EclipseStud Copilot AI proxy listening on http://127.0.0.1:${PORT}/generate`);
    console.log(`Provider: ${PROVIDER}`);
    console.log(`Upstream: ${API_BASE_URL}, model: ${DEFAULT_MODEL}`);
    console.log(`Local request auth: ${BACKEND_REQUEST_TOKEN ? "enabled" : "missing token"}`);
  });
}

async function callOpenAI({ body, model }) {
  return fetchWithTimeout(buildOpenAIResponsesUrl(API_BASE_URL), {
    method: "POST",
    headers: openAiHeaders(AUTH_TOKEN),
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: buildSystem(body.settings || {}, body.type) },
        { role: "user", content: body.prompt || "" }
      ],
      max_output_tokens: body.type === "generate_goals" ? 1200 : 700,
      reasoning: { effort: "minimal" },
      text: { verbosity: "low" }
    })
  });
}

async function callWithModelFallback({ body, primaryModel, fallbackModel }) {
  const primary = String(primaryModel || DEFAULT_MODEL).trim();
  const fallback = String(fallbackModel || "").trim();
  let response = await callOpenAI({ body, model: primary });
  if (fallback && fallback !== primary && (await isModelAccessFailure(response))) {
    response = await callOpenAI({ body, model: fallback });
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

async function fetchWithTimeout(url, options, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Upstream AI request timed out after ${Math.ceil(timeoutMs / 1000)} seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function setCors(request, response) {
  const origin = String(request.headers.origin || "");
  if (isAllowedBrowserOrigin(origin)) {
    response.setHeader("access-control-allow-origin", origin);
  }
  response.setHeader("access-control-allow-methods", "POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type, x-es-copilot-backend-token");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "frame-ancestors 'none'");
  response.setHeader("content-type", "application/json; charset=utf-8");
}

function isAllowedBrowserOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (
      url.protocol === "chrome-extension:" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost"
    );
  } catch {
    return false;
  }
}

function isAllowedRequestOrigin(request) {
  const origin = String(request.headers.origin || "");
  return !origin || isAllowedBrowserOrigin(origin);
}

function isAuthorizedBackendRequest(request) {
  if (!BACKEND_REQUEST_TOKEN) return false;
  return normalizeAuthToken(request.headers["x-es-copilot-backend-token"] || "") === BACKEND_REQUEST_TOKEN;
}

function sendJson(response, status, payload) {
  response.writeHead(status);
  response.end(JSON.stringify(payload));
}

function openAiHeaders(token) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${normalizeAuthToken(token)}`
  };
}

function normalizeAuthToken(value) {
  return String(value || "")
    .trim()
    .replace(/^bearer\s+/i, "")
    .replace(/^authorization\s*:\s*bearer\s+/i, "")
    .replace(/^x-api-key\s*:\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function buildOpenAIResponsesUrl(baseUrl) {
  const clean = String(baseUrl || "https://api.openai.com").trim().replace(/\/+$/, "");
  if (/\/v1\/responses$/i.test(clean)) return clean;
  if (/\/v1$/i.test(clean)) return `${clean}/responses`;
  return `${clean}/v1/responses`;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

function buildSystem(settings, type) {
  return [
    "You are EclipseStud Copilot, a production assistant for an adult live-chat broadcaster.",
    "Write compact, natural, paste-ready chat lines that react to the exact viewer message.",
    "Sound typed live by a real person, not polished marketing copy or a generic assistant.",
    "Use casual language, light imperfect punctuation, and distinct strategies for each option.",
    "Do not restate the viewer message or use generic filler.",
    type === "generate_goals"
      ? `Return strict JSON only with a goals array containing exactly ${GOAL_COUNT} objects with name, amount, and chat_line.`
      : "Return strict JSON only with a replies array containing three objects with text.",
    "Keep replies consensual, respectful, non-graphic, and platform-safe.",
    "Do not promote private rooms, pvt, one-on-one, VIP, exclusive rooms, or pulling viewers away from public chat.",
    settings.personaStyle ? `Creator style: ${settings.personaStyle}` : "",
    settings.houseRules ? `House rules: ${settings.houseRules}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function extractOpenAIText(body) {
  if (typeof body?.output_text === "string" && body.output_text.trim()) {
    return body.output_text.trim();
  }
  const output = Array.isArray(body?.output) ? body.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") parts.push(part.text);
      if (typeof part?.output_text === "string") parts.push(part.output_text);
    }
  }
  return parts.join("\n").trim();
}

function parseReplies(text) {
  const parsed = parseJsonFromText(text);
  if (parsed !== null) {
    const replies = Array.isArray(parsed) ? parsed : parsed.replies || parsed.candidates || [];
    const clean = replies
      .map((item) => (typeof item === "string" ? item : item.text || ""))
      .filter(Boolean)
      .slice(0, 3);
    if (clean.length) return clean;
  }
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-*\d.)"]+\s*/, "").replace(/"$/, "").trim())
    .filter((line) => line.length > 10)
    .slice(0, 3);
}

function parseGoals(text) {
  const parsed = parseJsonFromText(text);
  if (parsed !== null) {
    const goals = Array.isArray(parsed) ? parsed : parsed.goals || parsed.items || Object.values(parsed);
    const clean = goals
      .map((item, index) => ({
        name: item.name || item.title || `Goal ${index + 1}`,
        amount: Number.parseInt(item.amount || item.tokens || item.target || 250 * (index + 1), 10),
        description: "",
        chat_line: item.chat_line || item.chatLine || item.promo || item.line || item.description || item.reward || item.unlock || "",
        category: item.category || item.theme || "game"
      }))
      .filter((item) => item.name && item.chat_line)
      .slice(0, GOAL_COUNT);
    if (clean.length) return clean;
  }
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-*\d.)"]+\s*/, "").replace(/"$/, "").trim())
    .filter((line) => line.length > 10)
    .slice(0, GOAL_COUNT)
    .map((line, index) => ({
      name: `Goal ${index + 1}`,
      amount: 250 * (index + 1),
      description: "",
      chat_line: line,
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
  const stack = [raw[start] === "{" ? "}" : "]"];
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

module.exports = {
  buildSystem,
  parseGoals,
  parseReplies
};
