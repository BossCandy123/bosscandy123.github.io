$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$node = "C:\Users\bossc\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$backendTokenFile = Join-Path $PSScriptRoot "es-backend-token.txt"

if (-not (Test-Path $node)) {
  throw "Bundled Node.js was not found at $node"
}

if (-not $env:OPENAI_API_KEY) {
  $secureToken = Read-Host "Paste OpenAI API key" -AsSecureString
  $tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  try {
    $env:OPENAI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr)
  }
}

$env:AI_PROVIDER = "openai"
$env:OPENAI_BASE_URL = "https://api.openai.com"
$env:OPENAI_MODEL = "gpt-5-mini"
if (-not (Test-Path $backendTokenFile)) {
  $secret = "$([guid]::NewGuid().ToString('N'))$([guid]::NewGuid().ToString('N'))"
  Set-Content -Path $backendTokenFile -Value $secret -Encoding ASCII -NoNewline
}
$env:ES_COPILOT_BACKEND_TOKEN = (Get-Content -Path $backendTokenFile -Raw).Trim()

Set-Location $repoRoot
Write-Host "Starting EclipseStud Copilot OpenAI backend at http://127.0.0.1:8787/generate"
Write-Host "Model: $env:OPENAI_MODEL"
Write-Host "Local request auth: enabled"
& $node ".\backend-proxy\server.js"
