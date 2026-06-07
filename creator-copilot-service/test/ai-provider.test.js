"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildOpenAiRequest,
  buildPrompt,
  buildSystem,
  createOpenAiProvider,
  normalizeGenerationInput
} = require("../src/ai-provider");
const { loadConfig } = require("../src/config");
const { OperatorHub } = require("../src/operator-hub");

function config(overrides = {}) {
  return {
    aiModel: "gpt-5-mini",
    openAiApiKey: "test-openai-key",
    openAiBaseUrl: "https://api.openai.com",
    openAiRequestTimeoutMs: 1000,
    ...overrides
  };
}

function replyInput() {
  return normalizeGenerationInput({
    task: "reply_suggestions",
    message: "that boss fight looked brutal, how did you stay so calm?",
    context: "Gaming stream; the creator just won on the final attempt.",
    tone: "playful and quick",
    persona: {
      name: "EclipseStud",
      style: "casual, warm, a little teasing",
      rules: "Do not promote private interactions."
    }
  });
}

test("OpenAI request uses the fast GPT-5 default and a message-specific reply prompt", async () => {
  let capturedUrl = "";
  let capturedRequest;
  const provider = createOpenAiProvider(config(), {
    async fetchImpl(url, request) {
      capturedUrl = url;
      capturedRequest = request;
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            suggestions: [
              "calm was generous, i was panicking quietly",
              "final attempt luck carried me hard there",
              "did i actually look calm from your side?"
            ]
          })
        }),
        {
          status: 200,
          headers: { "x-request-id": "req_openai_test" }
        }
      );
    }
  });

  const result = await provider.generate(replyInput());
  const body = JSON.parse(capturedRequest.body);
  const system = body.input[0].content;
  const prompt = body.input[1].content;

  assert.equal(capturedUrl, "https://api.openai.com/v1/responses");
  assert.equal(capturedRequest.headers.authorization, "Bearer test-openai-key");
  assert.equal(body.model, "gpt-5-mini");
  assert.equal(body.temperature, undefined);
  assert.deepEqual(body.reasoning, { effort: "minimal" });
  assert.equal(body.text.verbosity, "low");
  assert.equal(body.text.format.type, "json_schema");
  assert.match(system, /Reply to the exact viewer message/);
  assert.match(system, /avoid generic filler/);
  assert.match(system, /Do not suggest a private interaction/);
  assert.match(prompt, /that boss fight looked brutal/);
  assert.match(prompt, /Every option must clearly make sense as a direct reply/);
  assert.deepEqual(result.suggestions, [
    "calm was generous, i was panicking quietly",
    "final attempt luck carried me hard there",
    "did i actually look calm from your side?"
  ]);
  assert.equal(result.upstreamRequestId, "req_openai_test");
});

test("reply prompt contract stays short, direct, and creator-voiced", () => {
  const input = replyInput();
  const system = buildSystem(input);
  const prompt = buildPrompt(input);

  assert.match(system, /never as an AI assistant/);
  assert.match(system, /one short live-chat sentence/);
  assert.match(system, /Do not repeat or paraphrase/);
  assert.match(system, /Make the three options meaningfully different/);
  assert.match(prompt, /primary_viewer_message/);
  assert.match(prompt, /EclipseStud/);
});

test("token goal task requests exactly five concise goal lines", () => {
  const input = normalizeGenerationInput({
    task: "token_goals",
    message: "Build five goals for 750 tokens: shorts, shirt, underwear.",
    context: "Gaming room, playful tone, public chat only.",
    tone: "clear and playful",
    persona: {
      name: "EclipseStud",
      style: "short token-goal lines",
      rules: "No private promotion."
    }
  });
  const system = buildSystem(input);
  const prompt = buildPrompt(input);
  const request = buildOpenAiRequest(input, "gpt-5-mini");

  assert.equal(request.text.format.schema.properties.suggestions.minItems, 5);
  assert.equal(request.text.format.schema.properties.suggestions.maxItems, 5);
  assert.match(system, /public-room token goal lines only/);
  assert.match(system, /Do not include long descriptions/);
  assert.match(system, /private-room promotion/);
  assert.match(prompt, /Build five goals for 750 tokens/);
});

test("OpenAI timeout aborts the request and returns a clear timeout error", async () => {
  const provider = createOpenAiProvider(config({ openAiRequestTimeoutMs: 15 }), {
    fetchImpl(_url, request) {
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      });
    }
  });

  await assert.rejects(provider.generate(replyInput()), (error) => {
    assert.equal(error.statusCode, 504);
    assert.equal(error.code, "openai_timeout");
    assert.match(error.message, /timed out after 15ms/);
    return true;
  });
});

test("OpenAI upstream errors are classified and retain the upstream request id", async () => {
  const provider = createOpenAiProvider(config(), {
    async fetchImpl() {
      return new Response(
        JSON.stringify({
          error: {
            code: "model_not_found",
            message: "The project cannot access this model."
          }
        }),
        {
          status: 404,
          headers: { "x-request-id": "req_model_access" }
        }
      );
    }
  });

  await assert.rejects(provider.generate(replyInput()), (error) => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.code, "openai_model_access_error");
    assert.equal(error.requestId, "req_model_access");
    assert.match(error.message, /OpenAI model access failed/);
    return true;
  });
});

test("model tier defaults to gpt-5-mini and quality selects gpt-5", () => {
  const shared = {
    ADMIN_API_KEY: "test-admin-key",
    OPERATOR_API_KEY: "test-operator-key",
    LICENSE_HASH_SECRET: "test-license-hash-secret",
    BILLING_WEBHOOK_SECRET: "test-billing-webhook-secret"
  };
  const fast = loadConfig(shared);
  const quality = loadConfig({ ...shared, OPENAI_MODEL_TIER: "quality" });
  const explicit = loadConfig({ ...shared, OPENAI_MODEL_TIER: "quality", OPENAI_MODEL: "gpt-5" });

  assert.equal(fast.aiModel, "gpt-5-mini");
  assert.equal(fast.openAiModelTier, "fast");
  assert.equal(quality.aiModel, "gpt-5");
  assert.equal(quality.openAiModelTier, "quality");
  assert.equal(explicit.aiModel, "gpt-5");
  assert.equal("aiProvider" in fast, false);
});

test("operator OpenAI failures stay visible and never become local canned suggestions", async () => {
  const provider = {
    name: "openai",
    model: "gpt-5-mini",
    async generate() {
      const error = new Error("OpenAI request timed out after 20s");
      error.statusCode = 504;
      error.code = "openai_timeout";
      throw error;
    }
  };
  const hub = new OperatorHub({ provider, now: () => new Date("2026-06-04T12:00:00.000Z") });

  await assert.rejects(
    hub.ingestEvent({
      type: "chat_turn",
      viewerName: "nightowl88",
      message: "how are you still awake?"
    }),
    (error) => error.code === "openai_timeout"
  );

  const snapshot = hub.snapshot();
  assert.equal(snapshot.queue.length, 0);
  assert.equal(snapshot.metrics.suggestions, 0);
  assert.equal(snapshot.diagnostics[0].type, "operator_ai_error");
  assert.match(snapshot.diagnostics[0].message, /OpenAI request timed out/);
});
