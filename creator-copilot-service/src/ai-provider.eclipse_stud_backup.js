"use strict";

const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
const QUALITY_OPENAI_MODEL = "gpt-5";
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

const TASKS = Object.freeze({
  reply_suggestions: {
    count: 3,
    maxLength: 180,
    instruction: "Write three distinct replies to the viewer's exact message."
  },
  stream_titles: {
    count: 3,
    maxLength: 140,
    instruction: "Write three concise livestream title suggestions."
  },
  engagement_prompts: {
    count: 5,
    maxLength: 180,
    instruction: "Write five concise prompts that invite healthy audience participation."
  },
  token_goals: {
    count: 5,
    maxLength: 160,
    instruction: "Write five concise token goal lines for a livestream room."
  }
});

function createAiProvider(config, dependencies) {
  return createOpenAiProvider(config, dependencies);
}

function createOpenAiProvider(config, { fetchImpl = globalThis.fetch } = {}) {
  if (!config.openAiApiKey) {
    throw providerError(
      "OPENAI_API_KEY is missing. Set it before starting Creator Copilot Service.",
      500,
      "",
      "openai_configuration_error"
    );
  }
  if (typeof fetchImpl !== "function") {
    throw providerError("OpenAI transport is unavailable", 500, "", "openai_configuration_error");
  }

  const model = compact(config.aiModel || DEFAULT_OPENAI_MODEL, 100);
  const timeoutMs = positiveInteger(config.openAiRequestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);

  return {
    name: "openai",
    model,
    async generate(input) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(buildOpenAiUrl(config.openAiBaseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.openAiApiKey}`
          },
          signal: controller.signal,
          body: JSON.stringify(buildOpenAiRequest(input, model))
        });
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError") {
          throw providerError(
            `OpenAI request timed out after ${timeoutMs}ms`,
            504,
            "",
            "openai_timeout"
          );
        }
        throw providerError(
          `Could not reach OpenAI: ${compact(error?.message || "network request failed", 180)}`,
          502,
          "",
          "openai_connection_error"
        );
      } finally {
        clearTimeout(timeout);
      }

      return parseOpenAiResponse(response, input, model);
    }
  };
}

function buildOpenAiRequest(input, model) {
  const count = TASKS[input.task].count;
  return {
    model,
    max_output_tokens: 700,
    reasoning: { effort: "minimal" },
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "creator_copilot_suggestions",
        strict: true,
        schema: {
          type: "object",
          properties: {
            suggestions: {
              type: "array",
              minItems: count,
              maxItems: count,
              items: { type: "string" }
            }
          },
          required: ["suggestions"],
          additionalProperties: false
        }
      }
    },
    input: [
      { role: "system", content: buildSystem(input) },
      { role: "user", content: buildPrompt(input) }
    ]
  };
}

async function parseOpenAiResponse(response, input, model) {
  const upstreamRequestId =
    response?.headers?.get?.("x-request-id") || response?.headers?.get?.("request-id") || "";
  let body;
  try {
    body = await response.json();
  } catch {
    throw providerError(
      "OpenAI returned a response that was not valid JSON",
      502,
      upstreamRequestId,
      "openai_invalid_response"
    );
  }

  if (!response.ok) throw classifyOpenAiError(response.status, body, upstreamRequestId);

  const suggestions = parseSuggestions(extractOpenAiText(body))
    .map((suggestion) => compact(suggestion, TASKS[input.task].maxLength))
    .filter(Boolean)
    .slice(0, TASKS[input.task].count);
  if (suggestions.length !== TASKS[input.task].count) {
    throw providerError(
      `OpenAI returned ${suggestions.length} usable suggestions; expected ${TASKS[input.task].count}`,
      502,
      upstreamRequestId,
      "openai_invalid_response"
    );
  }
  return {
    suggestions,
    provider: "openai",
    model,
    upstreamRequestId
  };
}

function classifyOpenAiError(status, body, requestId) {
  const upstreamMessage = compact(
    body?.error?.message || body?.message || `OpenAI request failed with status ${status}`,
    260
  );
  const upstreamCode = compact(body?.error?.code || body?.code || "", 80).toLowerCase();
  const detail = `${upstreamCode} ${upstreamMessage}`.toLowerCase();

  if (status === 401) {
    return providerError(
      `OpenAI authentication failed: ${upstreamMessage}`,
      502,
      requestId,
      "openai_auth_error"
    );
  }
  if (status === 403 || status === 404 || detail.includes("model_not_found")) {
    return providerError(
      `OpenAI model access failed: ${upstreamMessage}`,
      502,
      requestId,
      "openai_model_access_error"
    );
  }
  if (status === 429 && /quota|billing|credit|balance|spend/.test(detail)) {
    return providerError(
      `OpenAI quota is unavailable: ${upstreamMessage}`,
      503,
      requestId,
      "openai_quota_exhausted"
    );
  }
  if (status === 429) {
    return providerError(
      `OpenAI rate limit reached: ${upstreamMessage}`,
      503,
      requestId,
      "openai_rate_limited"
    );
  }
  return providerError(
    `OpenAI request failed: ${upstreamMessage}`,
    502,
    requestId,
    "openai_upstream_error"
  );
}

function normalizeGenerationInput(input = {}) {
  const task = compact(input.task || "reply_suggestions", 60).toLowerCase();
  if (!TASKS[task]) throw providerError(`Unsupported task: ${task}`, 400);
  const message = compact(input.message, 2000);
  const context = compact(input.context, 3000);
  if (!message && !context) throw providerError("message or context is required", 400);
  return {
    task,
    message,
    context,
    tone: compact(input.tone || "friendly", 80),
    persona: {
      name: compact(input.persona?.name || "Creator", 100),
      style: compact(input.persona?.style || "warm, natural, concise", 600),
      rules: compact(input.persona?.rules || "", 1000)
    }
  };
}

function buildSystem(input) {
  const common = [
    "You are EclipseStud Copilot: write short, paste-ready live chat lines a creator would actually type while streaming. never as an AI assistant.",
    "Voice: confident, warm, witty, teasing but safe; typed live, not polished marketing copy. Keep phrasing to one short live-chat sentence.",
    "Do not repeat or paraphrase the viewer's message; instead react to its words, energy, or timing.",
    "Avoid generic filler. Do not suggest a private interaction, private rooms, VIP, one-on-one, or pulling viewers out of public chat.",
    "Keep lines short (most good ones are 4-14 words). Prioritize things the performer can use while physically performing.",
    `Return exactly ${TASKS[input.task].count} distinct items in the exact JSON schema. Make the ${TASKS[input.task].count} options meaningfully different and high-value for the current room signals.`
  ];

  if (input.task === "reply_suggestions") {
    common.push(
      "Reply to the exact viewer message — reference their words, energy, or timing.",
      "Make the three options meaningfully different: direct, playful/teasing, and one that invites a tiny next step.",
      "Sound typed live; avoid generic filler."
    );
  } else if (input.task === "stream_titles") {
    common.push("Specific to the current room vibe and context. No generic clickbait or fake promises.");
  } else if (input.task === "token_goals") {
    common.push(
      "public-room token goal lines only. Short name + token amount + one lively paste-ready chat line per goal.",
      "Do not include long descriptions or long explanations.",
      "No private-room promotion."
    );
  } else {
    common.push("Short, natural prompts that real people in a live room would actually answer.");
  }
  return common.join("\n");
}

function buildPrompt(input) {
  return JSON.stringify(
    {
      task: input.task,
      instruction: TASKS[input.task].instruction,
      primary_viewer_message: input.message,
      room_context: input.context,
      requested_tone: input.tone,
      creator_persona: input.persona,
      final_check:
        input.task === "reply_suggestions"
          ? "Every option must clearly make sense as a direct reply to the primary viewer message."
          : "Every option must be specific to the supplied context."
    },
    null,
    2
  );
}

function parseSuggestions(text) {
  const raw = String(text || "").trim();
  const candidates = [raw, raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const suggestions = Array.isArray(parsed) ? parsed : parsed.suggestions;
      if (Array.isArray(suggestions)) return suggestions.map(cleanSuggestion).filter(Boolean);
    } catch {
      // Try the next format.
    }
  }
  return raw
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-*\d.)"]+\s*/, "").replace(/"$/, ""))
    .map(cleanSuggestion)
    .filter(Boolean);
}

function extractOpenAiText(body) {
  if (typeof body?.output_text === "string") return body.output_text;
  return (body?.output || [])
    .flatMap((item) => item?.content || [])
    .map((part) => part?.text || part?.output_text || "")
    .join("\n");
}

function buildOpenAiUrl(baseUrl) {
  const clean = String(baseUrl || "https://api.openai.com").replace(/\/+$/, "");
  if (/\/v1\/responses$/i.test(clean)) return clean;
  if (/\/v1$/i.test(clean)) return `${clean}/responses`;
  return `${clean}/v1/responses`;
}

function cleanSuggestion(value) {
  return compact(typeof value === "string" ? value : value?.text, 500);
}

function compact(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function providerError(message, statusCode = 500, requestId = "", code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code || (statusCode === 400 ? "invalid_generation_request" : "ai_provider_error");
  error.requestId = requestId;
  return error;
}

module.exports = {
  DEFAULT_OPENAI_MODEL,
  QUALITY_OPENAI_MODEL,
  TASKS,
  buildOpenAiRequest,
  buildPrompt,
  buildSystem,
  createAiProvider,
  createOpenAiProvider,
  normalizeGenerationInput,
  parseSuggestions
};
