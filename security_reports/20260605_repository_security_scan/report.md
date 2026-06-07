# EclipseStud Copilot Security Scan

Date: 2026-06-05
Scope: `C:\Users\bossc\OneDrive\Desktop\stripchat_copilot_full_extension`

## Executive Summary

Result: no open critical or high severity findings were identified in the reviewed local extension and local web-app service.

Two hardening issues were found and fixed during the scan:

- P2 fixed: local dashboard and backend responses did not deny framing or set basic browser security headers.
- P3 fixed: the page-key bridge accepted forged page `postMessage` payloads with arbitrary key text.

One residual risk remains by design:

- The local operator token lives in `backend-proxy/es-backend-token.txt` so the extension and dashboard can share local auth. This is acceptable for a private local-only package, but the zip should not be shared publicly.

The requested deep subagent fanout could not complete because all six delegated agents hit the account usage limit. I continued with a local repository-wide scan and verified the fixed paths with tests.

## Threat Model

Primary assets:

- OpenAI API key in Chrome extension storage or Windows encrypted storage.
- Local operator token in `backend-proxy/es-backend-token.txt`.
- Generated queue text that can be pasted into StripChat.
- Extension memory, diagnostics, favorites, and live-room context.
- Local dashboard command queue and bridge state.

Trust boundaries:

- StripChat page scripts vs. extension content script and Shadow DOM.
- Extension popup/options/service worker vs. local dashboard service.
- Local dashboard browser page vs. `/v1/operator/*` APIs.
- Local backend proxy vs. OpenAI upstream.
- User-supplied viewer text and AI output vs. rendered dashboard/panel HTML.

## Findings

### P2 Fixed: Local Dashboard Could Be Framed

Evidence:

- The dashboard is served without auth at `GET /dashboard` and embeds an operator key for its own same-origin API calls: `creator-copilot-service/src/app.js:35`, `creator-copilot-service/src/app.js:348-354`.
- Before the fix, neither the web app nor legacy backend proxy set frame denial, no-sniff, no-referrer, or no-store headers.

Impact:

- A malicious local or browser-hosted page could iframe the local dashboard and attempt clickjacking against visible controls. Same-origin policy still prevents reading the operator key, and `/v1/operator/*` requires `x-operator-key`, so this was not a direct remote secret theft path.

Fix applied:

- Added `setSecurityHeaders()` and apply it to service responses: `creator-copilot-service/src/app.js:24`, `creator-copilot-service/src/app.js:225-230`.
- Added the same hardening headers to the legacy backend proxy: `backend-proxy/server.js:175-187`.
- Added regression assertions for the dashboard headers: `creator-copilot-service/test/service.test.js:236-242`.

Status: fixed and tested.

### P3 Fixed: Page-Key Bridge Accepted Forged Page Messages

Evidence:

- The content script uses a bridge for the main-world key guard and listens for `window` `message` events.
- The listener now verifies source window, origin, message source, message type, and that the inserted key is exactly one lowercase/uppercase `c`: `content_script.js:230-238`.

Impact:

- Before the fix, a same-page script could forge the message source and ask the content script to insert arbitrary text into the focused extension panel field. This did not expose secrets and required an active/focused panel field, but it crossed the page-to-extension boundary too loosely.

Fix applied:

- Added origin validation and key shape validation in `content_script.js:234-238`.
- Added a regression test that posts a forged key message and confirms the field is unchanged: `diagnostics/run_mock_full_test.mjs:204-214`.

Status: fixed and tested.

## Security Controls Verified

- Manifest host access is scoped to StripChat, with OpenAI/localhost as optional permissions: `manifest.json:15-24`.
- Extension page CSP blocks remote script/eval execution: `manifest.json:39-40`.
- Dashboard operator APIs require `x-operator-key`: `creator-copilot-service/src/app.js:70-108`, `creator-copilot-service/src/app.js:258-262`.
- Request body size is capped and over-limit requests are destroyed: `creator-copilot-service/src/app.js:289-298`.
- Webhook verification uses HMAC over the raw body: `creator-copilot-service/src/app.js:265-270`.
- Extension settings returned to UI strip secrets: `service_worker.js:137-150`, `ai_service.js:130-134`.
- OpenAI API key storage uses session storage by default and local storage only when "remember key" is enabled: `service_worker.js:783-827`.
- Dashboard-rendered queue, feed, diagnostics, and setup data use `textContent`, not HTML injection: `creator-copilot-service/public/operator.js:292-370`.
- Popup reply rendering escapes generated text before using `innerHTML`: `popup.js:128-138`.
- OpenAI request/response paths use schema-constrained suggestions and enforce exact counts: `creator-copilot-service/src/ai-provider.js:7-28`, `creator-copilot-service/src/ai-provider.js:91-115`, `creator-copilot-service/src/ai-provider.js:125-153`.
- Token-goal prompts require five concise public-room lines and prohibit private-room promotion: `creator-copilot-service/src/ai-provider.js:254-260`.
- Operator commands expire before execution and are limited to `paste_text`: `service_worker.js:1134-1143`.

## Residual Risk

### P3 Accepted: Local Operator Token Is Stored in the Project Folder

Evidence:

- The operator token is read from `backend-proxy/es-backend-token.txt`: `service_worker.js:764-771`, `creator-copilot-service/start-local-operator.ps1:126-135`.
- The dashboard embeds the operator token into the local dashboard page: `creator-copilot-service/src/app.js:348-354`.

Assessment:

- This is acceptable for the current private, local-only workflow because the token only authorizes the local dashboard/extension bridge. It is not the OpenAI key.
- The package should not be distributed publicly or uploaded to a shared repository with that token intact.

Recommended future hardening:

- Generate the operator token during first run and write it to both the extension load folder and service config at setup time.
- Exclude `backend-proxy/es-backend-token.txt` from public release packages.

## Verification

Commands passed after fixes:

```text
node --check content_script.js
node --check creator-copilot-service/src/app.js
node --check backend-proxy/server.js
node --check diagnostics/run_mock_full_test.mjs
node --test   (in creator-copilot-service) - 11/11 pass
node diagnostics/run_mock_full_test.mjs
node diagnostics/run_dashboard_render_test.mjs
node diagnostics/run_reliability_test.mjs
node diagnostics/run_goal_service_test.mjs
node diagnostics/run_edge_extension_keyboard_test.mjs
```

Screenshots regenerated by verification:

- `diagnostics/mock_full_test_v2.8.0.png`
- `diagnostics/dashboard_desktop_v2.8.0.png`
- `diagnostics/dashboard_mobile_v2.8.0.png`
- `diagnostics/edge_extension_keyboard_v2.8.0.png`

## Final Status

The repository has been scanned across extension code, local web-app service code, startup scripts, packaging flow, and credential handling. The concrete findings found during this scan were fixed and verified. No critical or high severity open finding remains in the reviewed scope.
