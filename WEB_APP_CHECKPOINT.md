# Web App Integration Checkpoint

Timestamp: 2026-06-05 12:15 PM local

Current repo:
- `C:\Users\bossc\OneDrive\Desktop\stripchat_copilot_full_extension`

Finished state:
- Extension visible version is `2.8.0`.
- The web app dashboard is a real companion app at `https://127.0.0.1:8789/dashboard`.
- The extension and dashboard share the local operator token from `backend-proxy/es-backend-token.txt`.
- The popup has a `Web app` button that requests localhost permission, enables the dashboard bridge, and opens the dashboard.
- The dashboard can generate and queue:
  - viewer replies
  - today's titles
  - exactly five public-room token goal lines
  - room wake prompts
- Queue items can be copied, dismissed, or sent to the extension bridge.
- Same-origin dashboard operator API calls are allowed while `x-operator-key` auth remains required.
- Browser favicon noise was removed so the dashboard console stays clean.
- `START_WEB_APP.cmd` starts the service from the project root.
- `creator-copilot-service/start-local-operator.ps1` now reuses a saved Windows-encrypted OpenAI key or prompts once and saves it encrypted under LocalAppData.
- `README_START_HERE.txt` gives the one-folder load/start flow.

Tests passed:
- `node --check` for the changed JS/MJS files.
- PowerShell parse check for `creator-copilot-service/start-local-operator.ps1`.
- `node --test` in `creator-copilot-service`: 11/11 passing.
- `diagnostics/run_reliability_test.mjs`.
- `diagnostics/run_goal_service_test.mjs`.
- `diagnostics/run_mock_full_test.mjs`.
- `diagnostics/run_dashboard_render_test.mjs`.
- `diagnostics/run_edge_extension_keyboard_test.mjs`.

Verification screenshots:
- `diagnostics/dashboard_desktop_v2.8.0.png`
- `diagnostics/dashboard_mobile_v2.8.0.png`
- `diagnostics/mock_full_test_v2.8.0.png`
- `diagnostics/edge_extension_keyboard_v2.8.0.png`

Packaging target:
- Canonical full-project folder:
  - `C:\Users\bossc\Documents\EclipseStud_Copilot_FULL_PROJECT_v2.8.0`
- Canonical zip:
  - `C:\Users\bossc\Documents\EclipseStud_Copilot_FULL_PROJECT_v2.8.0.zip`

Important final-use note:
- Load the full project folder itself in Edge. Do not load older sibling folders like `stripchat_copilot_full_extension_updated`, `ES_Copilot_AI_FIXED_LOAD_THIS`, or old ready-zip copies.
