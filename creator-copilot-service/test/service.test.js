"use strict";

const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createApp } = require("../src/app");
const { LicenseStore } = require("../src/license-store");

const TEST_PLANS = {
  trial: { id: "trial", name: "Trial", monthlyRequests: 1, maxSeats: 1 },
  creator: { id: "creator", name: "Creator", monthlyRequests: 2, maxSeats: 1 },
  agency: { id: "agency", name: "Agency", monthlyRequests: 10, maxSeats: 5 }
};
const OPERATOR_ORIGIN = "http://localhost:3000";
const OPERATOR_KEY = "test-operator-key";

async function setup(providerOverride) {
  const directory = await mkdtemp(path.join(tmpdir(), "creator-copilot-"));
  const filePath = path.join(directory, "licenses.json");
  const config = {
    serviceName: "Creator Copilot Test",
    adminApiKey: "test-admin-key",
    operatorApiKey: OPERATOR_KEY,
    billingWebhookSecret: "test-webhook-secret",
    corsOrigins: ["http://localhost:3000"],
    maxBodyBytes: 100_000
  };
  const store = new LicenseStore({
    filePath,
    hashSecret: "test-license-hash-secret",
    plans: TEST_PLANS,
    now: () => new Date("2026-06-04T12:00:00.000Z")
  });
  const provider =
    providerOverride ||
    {
      name: "test",
      async generate(input) {
        const count = ["engagement_prompts", "token_goals"].includes(input.task) ? 5 : 3;
        return {
          suggestions: Array.from({ length: count }, (_, index) => `Suggestion ${index + 1}`),
          provider: "test",
          model: "test-model",
          upstreamRequestId: "upstream-test"
        };
      }
    };
  const server = createApp({ config, store, provider });
  await store.initialize();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    config,
    directory,
    filePath,
    server,
    store,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  };
}

async function json(response) {
  return { status: response.status, body: await response.json() };
}

test("license flow enforces limits without storing the plaintext key", async () => {
  const app = await setup();
  try {
    const health = await json(await fetch(`${app.baseUrl}/health`));
    assert.equal(health.status, 200);
    assert.equal(health.body.provider, "test");

    const unauthorized = await json(
      await fetch(`${app.baseUrl}/v1/admin/licenses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "creator@example.com", plan: "creator" })
      })
    );
    assert.equal(unauthorized.status, 401);

    const created = await json(
      await fetch(`${app.baseUrl}/v1/admin/licenses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-key": app.config.adminApiKey
        },
        body: JSON.stringify({ email: "creator@example.com", plan: "creator" })
      })
    );
    assert.equal(created.status, 201);
    assert.match(created.body.licenseKey, /^cc_live_/);
    assert.equal(created.body.license.usage.limit, 2);

    const persisted = await readFile(app.filePath, "utf8");
    assert.equal(persisted.includes(created.body.licenseKey), false);

    const headers = {
      authorization: `Bearer ${created.body.licenseKey}`,
      "content-type": "application/json"
    };
    for (let index = 0; index < 2; index += 1) {
      const generated = await json(
        await fetch(`${app.baseUrl}/v1/generate`, {
          method: "POST",
          headers,
          body: JSON.stringify({ task: "reply_suggestions", message: "How is your day?" })
        })
      );
      assert.equal(generated.status, 200);
      assert.equal(generated.body.suggestions.length, 3);
      assert.equal(generated.body.usage.used, index + 1);
    }

    const limited = await json(
      await fetch(`${app.baseUrl}/v1/generate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ task: "reply_suggestions", message: "One more" })
      })
    );
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, "monthly_limit_reached");

    const account = await json(await fetch(`${app.baseUrl}/v1/account`, { headers }));
    assert.equal(account.body.account.usage.remaining, 0);

    const revoked = await json(
      await fetch(`${app.baseUrl}/v1/admin/licenses/${created.body.license.id}/revoke`, {
        method: "POST",
        headers: { "x-admin-key": app.config.adminApiKey }
      })
    );
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.license.status, "revoked");
    assert.equal((await fetch(`${app.baseUrl}/v1/account`, { headers })).status, 403);
  } finally {
    await app.close();
  }
});

test("failed AI calls release reserved usage", async () => {
  const app = await setup({
    name: "failing",
    async generate() {
      const error = new Error("Temporary upstream failure");
      error.statusCode = 502;
      error.code = "ai_provider_error";
      throw error;
    }
  });
  try {
    const created = await app.store.createLicense({ email: "creator@example.com", plan: "creator" });
    const headers = {
      authorization: `Bearer ${created.licenseKey}`,
      "content-type": "application/json"
    };
    const failed = await json(
      await fetch(`${app.baseUrl}/v1/generate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ message: "hello" })
      })
    );
    assert.equal(failed.status, 502);
    const account = await app.store.getAccount(created.licenseKey);
    assert.equal(account.usage.used, 0);
  } finally {
    await app.close();
  }
});

test("signed subscription events provision once and update the license", async () => {
  const app = await setup();
  try {
    const event = {
      eventId: "evt_001",
      type: "subscription.activated",
      customer: { id: "cus_001", email: "agency@example.com" },
      subscription: { id: "sub_001", plan: "agency", status: "active", seats: 3 }
    };
    const raw = JSON.stringify(event);
    const signature = createHmac("sha256", app.config.billingWebhookSecret).update(raw).digest("hex");
    const first = await json(
      await fetch(`${app.baseUrl}/v1/billing/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-creator-copilot-signature": `sha256=${signature}`
        },
        body: raw
      })
    );
    assert.equal(first.status, 200);
    assert.equal(first.body.duplicate, false);
    assert.match(first.body.licenseKey, /^cc_live_/);
    assert.equal(first.body.license.seats, 3);

    const duplicate = await json(
      await fetch(`${app.baseUrl}/v1/billing/webhook`, {
        method: "POST",
        headers: { "x-creator-copilot-signature": signature },
        body: raw
      })
    );
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.licenseKey, "");

    const invalid = await fetch(`${app.baseUrl}/v1/billing/webhook`, {
      method: "POST",
      headers: { "x-creator-copilot-signature": "bad" },
      body: raw
    });
    assert.equal(invalid.status, 401);
  } finally {
    await app.close();
  }
});

test("operator dashboard serves and builds queue state from local events", async () => {
  const app = await setup();
  try {
    const dashboard = await fetch(`${app.baseUrl}/dashboard`);
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.headers.get("x-frame-options"), "DENY");
    assert.equal(dashboard.headers.get("x-content-type-options"), "nosniff");
    assert.equal(dashboard.headers.get("referrer-policy"), "no-referrer");
    assert.equal(dashboard.headers.get("cache-control"), "no-store");
    assert.equal(dashboard.headers.get("content-security-policy"), "frame-ancestors 'none'");
    const dashboardHtml = await dashboard.text();
    assert.match(dashboardHtml, /EclipseStud Copilot Web App/);
    assert.match(dashboardHtml, /Generate and queue/);

    const dashboardCors = await fetch(`${app.baseUrl}/dashboard`, {
      headers: { Origin: OPERATOR_ORIGIN }
    });
    assert.equal(dashboardCors.status, 200);
    assert.equal(dashboardCors.headers.get("access-control-allow-origin"), null);

    const dashboardCss = await fetch(`${app.baseUrl}/dashboard/operator.css`);
    assert.equal(dashboardCss.status, 200);
    const css = await dashboardCss.text();
    assert.ok(css.length > 5000);
    assert.match(css, /\.app-shell/);
    assert.match(css, /@media \(max-width: 640px\)/);

    const missingOrigin = await fetch(`${app.baseUrl}/v1/operator/state`);
    assert.equal(missingOrigin.status, 401);

    const sameOriginOperator = await json(
      await fetch(`${app.baseUrl}/v1/operator/state`, {
        headers: {
          "x-operator-key": OPERATOR_KEY
        }
      })
    );
    assert.equal(sameOriginOperator.status, 200);

    const missingOperatorKey = await fetch(`${app.baseUrl}/v1/operator/state`, {
      headers: { Origin: OPERATOR_ORIGIN }
    });
    assert.equal(missingOperatorKey.status, 401);

    const preflight = await fetch(`${app.baseUrl}/v1/operator/events`, {
      method: "OPTIONS",
      headers: {
        Origin: OPERATOR_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-operator-key"
      }
    });
    assert.equal(preflight.status, 204);
    assert.match(
      preflight.headers.get("access-control-allow-headers") || "",
      /x-operator-key/i
    );

    const before = await json(
      await fetch(`${app.baseUrl}/v1/operator/state`, {
        headers: {
          Origin: OPERATOR_ORIGIN,
          "x-operator-key": OPERATOR_KEY
        }
      })
    );
    assert.equal(before.status, 200);
    assert.equal(before.body.state.queue.length, 0);

    const generatedGoals = await json(
      await fetch(`${app.baseUrl}/v1/operator/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: OPERATOR_ORIGIN,
          "x-operator-key": OPERATOR_KEY
        },
        body: JSON.stringify({
          task: "token_goals",
          message: "shorts, shirt, underwear",
          targetTokens: 750,
          roomTitle: "Call of Duty chill",
          goalSummary: "750 tk five-goal ladder"
        })
      })
    );
    assert.equal(generatedGoals.status, 200);
    assert.equal(generatedGoals.body.suggestions.length, 5);
    assert.equal(generatedGoals.body.state.queue.length, 5);
    assert.equal(generatedGoals.body.state.queue[0].kind, "goal");
    assert.equal(generatedGoals.body.state.queue[0].label, "Goal 1");

    const tipEvent = await json(
      await fetch(`${app.baseUrl}/v1/operator/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: OPERATOR_ORIGIN,
          "x-operator-key": OPERATOR_KEY
        },
        body: JSON.stringify({
          type: "tip_received",
          source: "extension",
          viewerName: "nightowl88",
          amount: 75,
          roomTitle: "late-night teasing and real chat",
          goalSummary: "450 tk goal"
        })
      })
    );
    assert.equal(tipEvent.status, 200);
    assert.equal(tipEvent.body.suggestions.length, 3);
    assert.equal(tipEvent.body.state.bridge.connected, true);
    assert.equal(tipEvent.body.state.queue.length, 8);

    const after = await json(
      await fetch(`${app.baseUrl}/v1/operator/state`, {
        headers: {
          Origin: OPERATOR_ORIGIN,
          "x-operator-key": OPERATOR_KEY
        }
      })
    );
    assert.equal(after.status, 200);
    assert.equal(after.body.state.metrics.extensionEvents, 1);
    assert.equal(after.body.state.room.lastViewer, "nightowl88");
    assert.equal(after.body.state.queue[0].kind, "tip");

    const queueItem = after.body.state.queue[0];
    const queuedCommand = await json(
      await fetch(`${app.baseUrl}/v1/operator/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: OPERATOR_ORIGIN,
          "x-operator-key": OPERATOR_KEY
        },
        body: JSON.stringify({
          type: "paste_text",
          text: queueItem.text,
          queueItemId: queueItem.id,
          source: "dashboard"
        })
      })
    );
    assert.equal(queuedCommand.status, 201);
    assert.equal(queuedCommand.body.command.status, "pending");

    const nextCommand = await json(
      await fetch(`${app.baseUrl}/v1/operator/commands/next?client=extension`, {
        headers: {
          Origin: OPERATOR_ORIGIN,
          "x-operator-key": OPERATOR_KEY
        }
      })
    );
    assert.equal(nextCommand.status, 200);
    assert.equal(nextCommand.body.command.type, "paste_text");
    assert.equal(nextCommand.body.command.status, "delivered");
    assert.equal(nextCommand.body.state.bridge.connected, true);

    const acknowledged = await json(
      await fetch(`${app.baseUrl}/v1/operator/commands/${nextCommand.body.command.id}/ack`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: OPERATOR_ORIGIN,
          "x-operator-key": OPERATOR_KEY
        },
        body: JSON.stringify({
          status: "succeeded",
          message: "Loaded in StripChat composer."
        })
      })
    );
    assert.equal(acknowledged.status, 200);
    assert.equal(acknowledged.body.command.status, "succeeded");
    assert.equal(acknowledged.body.state.queue[0].commandStatus, "succeeded");
    assert.equal(acknowledged.body.state.metrics.commandsSucceeded, 1);

    const dismissed = await json(
      await fetch(`${app.baseUrl}/v1/operator/queue/${queueItem.id}/dismiss`, {
        method: "POST",
        headers: {
          Origin: OPERATOR_ORIGIN,
          "x-operator-key": OPERATOR_KEY
        }
      })
    );
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.body.state.queue.some((item) => item.id === queueItem.id), false);
  } finally {
    await app.close();
  }
});
