param(
  [string]$NodePath = "C:\Users\bossc\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe",
  [ValidateSet("fast", "quality")]
  [string]$ModelTier = "fast",
  [ValidateRange(1000, 120000)]
  [int]$RequestTimeoutMs = 20000
)

$ErrorActionPreference = "Stop"
$healthUrl = "https://127.0.0.1:8789/health"
$sharedTokenFile = Join-Path (Split-Path $PSScriptRoot -Parent) "backend-proxy\\es-backend-token.txt"
$certDir = Join-Path $env:LOCALAPPDATA "CreatorCopilot\certs"
$expectedModel = if (-not [string]::IsNullOrWhiteSpace($env:OPENAI_MODEL)) {
  $env:OPENAI_MODEL
} elseif ($ModelTier -eq "quality") {
  "gpt-5"
} else {
  "gpt-5-mini"
}

try {
  $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
  if ($health.ok -and $health.provider -eq "openai" -and $health.model -eq $expectedModel) {
    Write-Output "Creator Copilot OpenAI service is already running with $expectedModel at https://127.0.0.1:8789/dashboard"
    exit 0
  }
  if ($health.ok) {
    throw "A stale or differently configured Creator Copilot service is already running on port 8789 (provider: $($health.provider), model: $($health.model)). Stop it before starting the OpenAI $expectedModel service."
  }
} catch {
  if ($_.Exception.Message -like "A stale or differently configured Creator Copilot service*") {
    throw
  }
  # Continue into startup when the service is not healthy.
}

$occupiedPorts = @(8788, 8789) | Where-Object {
  Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue
}
if ($occupiedPorts.Count -gt 0) {
  throw "Cannot start Creator Copilot because port(s) $($occupiedPorts -join ', ') are already in use."
}

function New-RandomSecret {
  $bytes = New-Object byte[] 48
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return [Convert]::ToBase64String($bytes)
}

function Get-OrCreateSecret {
  param(
    [string]$EnvName,
    [string]$FileName
  )

  $existing = (Get-Item "Env:$EnvName" -ErrorAction SilentlyContinue).Value
  if (-not [string]::IsNullOrWhiteSpace($existing)) {
    return $existing.Trim()
  }

  New-Item -ItemType Directory -Path $certDir -Force | Out-Null
  $secretPath = Join-Path $certDir $FileName
  if (Test-Path $secretPath) {
    $saved = (Get-Content $secretPath -Raw).Trim()
    if (-not [string]::IsNullOrWhiteSpace($saved)) {
      return $saved
    }
  }

  $generated = New-RandomSecret
  Set-Content -Path $secretPath -Value $generated -NoNewline -Encoding ASCII
  return $generated
}

function Convert-SecureStringToPlainText {
  param([securestring]$SecureValue)

  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    if ($pointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
  }
}

function Get-OrPromptOpenAiKey {
  $existing = (Get-Item "Env:OPENAI_API_KEY" -ErrorAction SilentlyContinue).Value
  if (-not [string]::IsNullOrWhiteSpace($existing)) {
    return $existing.Trim()
  }

  New-Item -ItemType Directory -Path $certDir -Force | Out-Null
  $secretPath = Join-Path $certDir "creator-copilot-openai-api-key.secure.txt"
  if (Test-Path $secretPath) {
    try {
      $saved = (Get-Content $secretPath -Raw).Trim()
      if (-not [string]::IsNullOrWhiteSpace($saved)) {
        $secureSaved = $saved | ConvertTo-SecureString
        $plainSaved = Convert-SecureStringToPlainText -SecureValue $secureSaved
        if (-not [string]::IsNullOrWhiteSpace($plainSaved)) {
          return $plainSaved.Trim()
        }
      }
    } catch {
      Write-Warning "Saved OpenAI API key could not be read. You will be prompted again."
    }
  }

  Write-Host "Paste your OpenAI API key once. It will be saved encrypted for this Windows user only."
  $secureInput = Read-Host -Prompt "OpenAI API key" -AsSecureString
  $plainInput = Convert-SecureStringToPlainText -SecureValue $secureInput
  if ([string]::IsNullOrWhiteSpace($plainInput)) {
    throw "OPENAI_API_KEY is required to start Creator Copilot."
  }
  $secureInput | ConvertFrom-SecureString | Set-Content -Path $secretPath -NoNewline -Encoding ASCII
  return $plainInput.Trim()
}

$sharedOperatorToken = ""
if (-not [string]::IsNullOrWhiteSpace((Get-Item "Env:OPERATOR_API_KEY" -ErrorAction SilentlyContinue).Value)) {
  $sharedOperatorToken = (Get-Item "Env:OPERATOR_API_KEY").Value.Trim()
} else {
  if (-not (Test-Path $sharedTokenFile)) {
    New-Item -ItemType Directory -Path (Split-Path $sharedTokenFile -Parent) -Force | Out-Null
    Set-Content -Path $sharedTokenFile -Value (New-RandomSecret) -NoNewline -Encoding ASCII
  }
  $sharedOperatorToken = (Get-Content $sharedTokenFile -Raw).Trim()
}

$env:OPENAI_API_KEY = Get-OrPromptOpenAiKey
$env:OPERATOR_API_KEY = $sharedOperatorToken
$env:ADMIN_API_KEY = Get-OrCreateSecret -EnvName "ADMIN_API_KEY" -FileName "creator-copilot-admin.key"
$env:LICENSE_HASH_SECRET = Get-OrCreateSecret -EnvName "LICENSE_HASH_SECRET" -FileName "creator-copilot-license-hash.key"
$env:BILLING_WEBHOOK_SECRET = Get-OrCreateSecret -EnvName "BILLING_WEBHOOK_SECRET" -FileName "creator-copilot-billing-webhook.key"

$certInfo = & (Join-Path $PSScriptRoot "ensure-localhost-https.ps1") -OutputDir $certDir | ConvertFrom-Json

$env:HTTPS_PFX_FILE = $certInfo.pfxPath
$env:HTTPS_PFX_PASSPHRASE_FILE = $certInfo.passphraseFile
$env:PORT = "8788"
$env:HTTPS_PORT = "8789"
$env:OPENAI_MODEL_TIER = $ModelTier
$env:OPENAI_REQUEST_TIMEOUT_MS = [string]$RequestTimeoutMs

if (-not (Test-Path $NodePath)) {
  $NodePath = "node"
}

Push-Location $PSScriptRoot
try {
  & $NodePath server.js
} finally {
  Pop-Location
}
