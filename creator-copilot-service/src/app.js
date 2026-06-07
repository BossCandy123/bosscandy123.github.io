"use strict";

const { createHmac, randomUUID, timingSafeEqual } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const path = require("node:path");
const { normalizeGenerationInput } = require("./ai-provider");
const { OperatorHub } = require("./operator-hub");

function createApp({ config, store, provider }) {
  return createServer(createRequestHandler({ config, store, provider }));
}

function createRequestHandler({ config, store, provider }) {
  const operatorHub = new OperatorHub({ provider, serviceName: config.serviceName });
  const publicDir = path.resolve(__dirname, "..", "public");

  return async (request, response) => {
    const requestId = request.headers["x-request-id"] || randomUUID();
    response.setHeader("x-request-id", requestId);

    try {
      const url = new URL(request.url || "/", "http://localhost");
      setSecurityHeaders(response);
      setCorsHeaders(request, response, config, url);
      if (!isRequestOriginAllowed(request, url, config.corsOrigins)) {
        throw httpError(403, "origin_not_allowed", "Browser origin is not allowed");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
        return serveDashboard(response, path.join(publicDir, "dashboard.html"), config.operatorApiKey);
      }

      if (request.method === "GET" && url.pathname === "/dashboard/operator.css") {
        return serveFile(response, path.join(publicDir, "operator.css"), "text/css; charset=utf-8");
      }

      if (request.method === "GET" && url.pathname === "/dashboard/operator.js") {
        return serveFile(response, path.join(publicDir, "operator.js"), "text/javascript; charset=utf-8");
      }

      if (request.method === "GET" && url.pathname === "/dashboard/icon.png") {
        return serveBinaryFile(
          response,
          path.join(publicDir, "icon.png"),
          "image/png"
        );
      }

      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          service: config.serviceName,
          provider: provider.name,
          model: provider.model
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/operator/state") {
        requireOperator(request, config);
        sendJson(response, 200, {
          ok: true,
          service: config.serviceName,
          provider: provider.name,
          state: operatorHub.snapshot()
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/operator/events") {
        requireOperator(request, config);
        const body = await readJson(request, config.maxBodyBytes);
        const result = await operatorHub.ingestEvent(body);
        sendJson(response, 200, {
          ok: true,
          service: config.serviceName,
          provider: provider.name,
          ...result
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/operator/generate") {
        requireOperator(request, config);
        const result = await operatorHub.generateDashboard(await readJson(request, config.maxBodyBytes));
        sendJson(response, 200, {
          ok: true,
          service: config.serviceName,
          provider: provider.name,
          ...result
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/operator/queue") {
        requireOperator(request, config);
        const result = operatorHub.enqueueManual(await readJson(request, config.maxBodyBytes));
        sendJson(response, 201, {
          ok: true,
          service: config.serviceName,
          provider: provider.name,
          ...result
        });
        return;
      }

      const queueUpdateMatch = url.pathname.match(/^\/v1\/operator\/queue\/([^/]+)$/);
      if (request.method === "PATCH" && queueUpdateMatch) {
        requireOperator(request, config);
        const body = await readJson(request, config.maxBodyBytes);
        const result = operatorHub.updateQueueItemText(decodeURIComponent(queueUpdateMatch[1]), body.text || body.message);
        sendJson(response, 200, {
          ok: true,
          service: config.serviceName,
          ...result
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/operator/queue/reorder") {
        requireOperator(request, config);
        const body = await readJson(request, config.maxBodyBytes);
        const result = operatorHub.reorderQueue(body.order || body.ids || []);
        sendJson(response, 200, {
          ok: true,
          service: config.serviceName,
          ...result
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/operator/commands") {
        requireOperator(request, config);
        const result = operatorHub.enqueueCommand(await readJson(request, config.maxBodyBytes));
        sendJson(response, 201, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/operator/commands/next") {
        requireOperator(request, config);
        const result = operatorHub.nextCommand(url.searchParams.get("client") || "extension");
        sendJson(response, 200, result);
        return;
      }

      const commandAckMatch = url.pathname.match(/^\/v1\/operator\/commands\/([^/]+)\/ack$/);
      if (request.method === "POST" && commandAckMatch) {
        requireOperator(request, config);
        const result = operatorHub.acknowledgeCommand(
          decodeURIComponent(commandAckMatch[1]),
          await readJson(request, config.maxBodyBytes)
        );
        sendJson(response, 200, result);
        return;
      }

      const queueDismissMatch = url.pathname.match(/^\/v1\/operator\/queue\/([^/]+)\/dismiss$/);
      if (request.method === "POST" && queueDismissMatch) {
        requireOperator(request, config);
        const result = operatorHub.dismissQueueItem(decodeURIComponent(queueDismissMatch[1]));
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/account") {
        const account = await store.getAccount(readBearerToken(request));
        sendJson(response, 200, { ok: true, account });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/generate") {
        const body = await readJson(request, config.maxBodyBytes);
        const input = normalizeGenerationInput(body);
        const reservation = await store.reserveRequest(readBearerToken(request));
        try {
          const result = await provider.generate(input);
          sendJson(response, 200, {
            ok: true,
            requestId,
            task: input.task,
            suggestions: result.suggestions,
            provider: result.provider,
            model: result.model,
            upstreamRequestId: result.upstreamRequestId,
            usage: reservation.usage
          });
        } catch (error) {
          await store.releaseRequest(reservation.licenseId, reservation.period).catch(() => undefined);
          throw error;
        }
        return;
      }

      if (url.pathname === "/v1/admin/licenses") {
        requireAdmin(request, config);
        if (request.method === "GET") {
          sendJson(response, 200, { ok: true, licenses: await store.listLicenses() });
          return;
        }
        if (request.method === "POST") {
          const result = await store.createLicense(await readJson(request, config.maxBodyBytes));
          sendJson(response, 201, { ok: true, ...result });
          return;
        }
      }

      const revokeMatch = url.pathname.match(/^\/v1\/admin\/licenses\/([^/]+)\/revoke$/);
      if (request.method === "POST" && revokeMatch) {
        requireAdmin(request, config);
        const license = await store.revokeLicense(decodeURIComponent(revokeMatch[1]));
        sendJson(response, 200, { ok: true, license });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/billing/webhook") {
        const rawBody = await readBody(request, config.maxBodyBytes);
        requireWebhookSignature(request, rawBody, config.billingWebhookSecret);
        let event;
        try {
          event = JSON.parse(rawBody.toString("utf8"));
        } catch {
          throw httpError(400, "invalid_json", "Request body must be valid JSON");
        }
        const result = await store.applySubscriptionEvent(event);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }

      throw httpError(404, "not_found", "Not found");
    } catch (error) {
      sendError(response, error, requestId);
    }
  };
}

function setCorsHeaders(request, response, config, url) {
  if (!shouldEmitCors(url)) return;
  const origin = String(request.headers.origin || "");
  if (origin && isOriginAllowed(origin, config.corsOrigins)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
  }
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "authorization, content-type, x-admin-key, x-creator-copilot-signature, x-operator-key, x-request-id"
  );
}

function setSecurityHeaders(response) {
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "frame-ancestors 'none'");
}

function shouldEmitCors(url) {
  const pathname = String(url?.pathname || "");
  return pathname === "/health" || pathname.startsWith("/v1/");
}

function isOriginAllowed(origin, allowedOrigins = []) {
  if (!origin) return false;
  return allowedOrigins.some((allowed) => {
    if (allowed === "*") return true;
    if (allowed.endsWith("*")) return origin.startsWith(allowed.slice(0, -1));
    return origin === allowed;
  });
}

function isRequestOriginAllowed(request, url, allowedOrigins = []) {
  const origin = String(request.headers.origin || "");
  if (!origin) {
    return !requiresBrowserOrigin(request, url);
  }
  return isOriginAllowed(origin, allowedOrigins);
}

function requiresBrowserOrigin(request, url) {
  if (request.method === "OPTIONS") return true;
  return false;
}

function requireAdmin(request, config) {
  const key = String(request.headers["x-admin-key"] || readBearerToken(request, false) || "");
  if (!secureEqual(key, config.adminApiKey)) {
    throw httpError(401, "invalid_admin_key", "Admin key is invalid");
  }
}

function requireOperator(request, config) {
  const key = String(request.headers["x-operator-key"] || "");
  if (!secureEqual(key, config.operatorApiKey)) {
    throw httpError(401, "invalid_operator_key", "Operator key is invalid");
  }
}

function requireWebhookSignature(request, rawBody, secret) {
  const supplied = String(request.headers["x-creator-copilot-signature"] || "").replace(/^sha256=/i, "");
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (!secureEqual(supplied, expected)) {
    throw httpError(401, "invalid_webhook_signature", "Webhook signature is invalid");
  }
}

function readBearerToken(request, required = true) {
  const match = String(request.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  if (required) throw httpError(401, "missing_license", "Bearer license key is required");
  return "";
}

async function readJson(request, maxBytes) {
  const raw = await readBody(request, maxBytes);
  try {
    return raw.length ? JSON.parse(raw.toString("utf8")) : {};
  } catch {
    throw httpError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(httpError(413, "body_too_large", "Request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendError(response, error, requestId) {
  const statusCode = Number(error.statusCode || 500);
  sendJson(response, statusCode, {
    ok: false,
    error: {
      code: error.code || "internal_error",
      message: statusCode >= 500 && !error.statusCode ? "Internal server error" : error.message,
      requestId: error.requestId || requestId
    }
  });
}

function sendJson(response, statusCode, payload) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.writeHead(statusCode);
  response.end(JSON.stringify(payload));
}

async function serveFile(response, filePath, contentType) {
  const file = await readFile(filePath, "utf8");
  response.setHeader("content-type", contentType);
  response.writeHead(200);
  response.end(file);
}

async function serveBinaryFile(response, filePath, contentType) {
  const file = await readFile(filePath);
  response.setHeader("content-type", contentType);
  response.writeHead(200);
  response.end(file);
}

async function serveDashboard(response, filePath, operatorApiKey) {
  const file = await readFile(filePath, "utf8");
  const bootstrap =
    `<script>window.__OPERATOR_API_KEY__=${JSON.stringify(String(operatorApiKey || ""))};</script>`;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.writeHead(200);
  response.end(file.replace("</head>", `${bootstrap}</head>`));
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function httpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

module.exports = {
  createApp,
  createRequestHandler,
  isOriginAllowed
};
