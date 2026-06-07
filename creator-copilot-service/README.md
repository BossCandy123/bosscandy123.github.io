# Creator Copilot Service

This is the isolated commercial foundation for Creator Copilot. It does not modify or depend on the personal StripChat extension.

The service provides:

- Hashed customer license keys that are shown only when issued
- Trial, Creator, Pro, and Agency plans with monthly request limits
- Account and usage status
- An OpenAI Responses API suggestion endpoint
- A local operator dashboard at `https://127.0.0.1:8789/dashboard`
- A local operator event bridge at `POST /v1/operator/events`
- Admin license creation, listing, and revocation
- Signed, idempotent subscription events for billing-provider integration
- Bounded OpenAI upstream requests with clear timeout, authentication, quota, rate-limit, and model-access errors

The service creates suggestions only. Customers must review and send every suggestion themselves.

## Run Locally

Node.js 20 or newer is required. No package installation is needed.

```powershell
cd creator-copilot-service
node --test
.\start-local-operator.ps1
```

The service has one runtime AI provider: OpenAI. It defaults to `gpt-5-mini`. Set
`OPENAI_MODEL_TIER=quality` to use `gpt-5`, or set `OPENAI_MODEL` to an explicit model.
Replace every development secret before deployment.

Set the OpenAI key in the current PowerShell session before starting:

```powershell
$env:OPENAI_API_KEY = "YOUR_OPENAI_API_KEY"
.\start-local-operator.ps1
```

For the quality model:

```powershell
$env:OPENAI_API_KEY = "YOUR_OPENAI_API_KEY"
.\start-local-operator.ps1 -ModelTier quality
```

The default upstream deadline is 20 seconds. Override it with
`OPENAI_REQUEST_TIMEOUT_MS` or `-RequestTimeoutMs` when starting locally. The service
returns explicit OpenAI error codes instead of silently substituting canned suggestions.
The launcher also rejects stale services running with a different provider or model instead
of reporting them as ready.

Then open:

```text
https://127.0.0.1:8789/dashboard
```

The startup script creates or reuses a trusted localhost certificate in the current user store, exports a randomly protected local PFX under `%LOCALAPPDATA%\CreatorCopilot\certs`, and starts HTTPS on `8789` with an HTTP redirect on `8788`. Certificate material and its passphrase stay outside the OneDrive repo.

The dashboard is intentionally separate from the extension UI. It acts like a local operator console, and the extension can post room events into it over localhost with HTTPS.

## Issue A Test License

```powershell
$body = @{
  email = "creator@example.com"
  plan = "creator"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:8788/v1/admin/licenses" `
  -Headers @{ "x-admin-key" = "dev-admin-key" } `
  -ContentType "application/json" `
  -Body $body
```

The returned `licenseKey` is displayed once. The data file stores only its HMAC hash.

## Generate Suggestions

```powershell
$licenseKey = "cc_live_REPLACE_ME"
$body = @{
  task = "reply_suggestions"
  message = "What game should we play next?"
  tone = "playful"
  persona = @{
    name = "Alex"
    style = "warm, quick, and slightly witty"
  }
} | ConvertTo-Json -Depth 4

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:8788/v1/generate" `
  -Headers @{ Authorization = "Bearer $licenseKey" } `
  -ContentType "application/json" `
  -Body $body
```

Supported tasks are `reply_suggestions`, `stream_titles`, and `engagement_prompts`.

## Billing Events

`POST /v1/billing/webhook` accepts:

- `subscription.activated`
- `subscription.updated`
- `subscription.canceled`

Sign the exact raw JSON body with HMAC-SHA256 using `BILLING_WEBHOOK_SECRET` and send the hex digest in `x-creator-copilot-signature`. Repeated `eventId` values are handled idempotently.

## Production Boundary

This MVP store is durable for one server process. Before running multiple instances, replace the JSON license store with Postgres or another transactional database.

Use a payment provider that explicitly approves the final business category. Keep the commercial product platform-neutral and do not market it as software for adult services unless the payment provider and distribution channel have approved that use.

Next commercial layers are a generic customer client, approved billing-provider checkout, automatic license delivery, and a customer dashboard.
