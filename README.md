# EclipseStud Copilot

Manifest V3 live-room copilot extension with an in-page assistant panel, realistic viewer replies, room title helpers, five-goal ladders, session memory, and diagnostics.

## Load Folder

For development from GitHub, load the repository root in Edge after cloning this repo locally.

```text
stripchat_copilot_full_extension-ver2.80/
```

For a packaged operator build, generate a clean local copy and load that folder instead.

```text
EclipseStud_Copilot_FULL_PROJECT_v2.8.0/
```

Correct markers:

```text
Extension: EclipseStud Copilot OpenAI - LOAD THIS
Version: 2.8.0
Panel: EclipseStud Copilot OpenAI v2.8.0
```

## Recommended Setup

Recommended fast setup:

```text
Mode: Direct AI API
Direct API base URL: https://api.openai.com
Model ID: gpt-5-mini
Fallback model: gpt-5-nano
```

AI modes are strict: if OpenAI fails, the panel shows the real error instead of silently using local fallback. The optional operator-dashboard command bridge is disabled by default so stale dashboard commands cannot paste into StripChat.

Live tools include public-room tip reactions, wake lines, quick challenges, AI goals, today's title, and synced saved lines.

## Web App Dashboard

Run the local dashboard with:

```text
START_WEB_APP.cmd
```

Then open:

```text
https://127.0.0.1:8789/dashboard
```

The dashboard shares a local operator token with the extension, queues replies/titles/five-goal ladders, receives room events, and can send selected lines back to the StripChat composer when the extension bridge is enabled.

## Commercial Product Work

The extension remains isolated from the platform-neutral commercial foundation in:

```text
creator-copilot-service
```

That service owns hosted AI suggestions, license keys, plans, usage limits, and billing-event provisioning. It can be developed and deployed without changing the extension.

## Site

Source: https://stripchataffiliate.github.io/

This project can be placed/copied under a `/plugins/EclipseStud_Copilot` (or similar) directory in a larger monorepo of creator tools if desired.

See `README_START_HERE.txt` for the one-folder load + START_WEB_APP.cmd flow.
See `CREATE_LOADABLE_ZIP.ps1` for a helper to produce a clean loadable zip (excludes secrets/logs/certs by default).
