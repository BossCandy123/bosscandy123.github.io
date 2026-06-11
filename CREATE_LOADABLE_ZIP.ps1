# CREATE_LOADABLE_ZIP.ps1
# Creates a clean zip of the EclipseStud Copilot loadable extension folder (v2.8.0)
# Excludes secrets, logs, certs, data, git, zips, and the full service runtime data.
# The resulting zip can be extracted and loaded unpacked in Edge.

param(
  [string]$OutputName = "EclipseStud_Copilot_v2.8.0_loadable.zip"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$zipPath = Join-Path $root $OutputName

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$itemsToInclude = @(
  "ai_service.js",
  "assets",
  "backend-proxy",
  "content_script.js",
  "creator-copilot-service",
  "manifest.json",
  "options.*",
  "page_key_guard.js",
  "popup.*",
  "README.md",
  "README_START_HERE.txt",
  "service_worker.js",
  "START_WEB_APP.cmd",
  "start-openai-backend.cmd",
  "CREATE_LOADABLE_ZIP.ps1"
)

$excludePatterns = @(
  "*.git*",
  "creator-copilot-service/certs/*",
  "creator-copilot-service/data/*",
  "creator-copilot-service/creator-copilot-service/*",
  "creator-copilot-service/*/certs/*",
  "creator-copilot-service/*/data/*",
  "backend-proxy/es-backend-token.txt",
  "creator-copilot-service/*.log",
  "creator-copilot-service/*/*.log",
  "*.log",
  "*.zip",
  "node_modules/*",
  "diagnostics/*.png",   # large verification screenshots - optional, remove line to include
  ".github/*"            # dev agents/prompts - optional
)

Write-Host "Creating loadable zip: $zipPath"

# Simple filter: include listed top-level items, then filter excludes
$files = Get-ChildItem -Path $root -Recurse -File | Where-Object {
  $rel = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
  $include = $false
  foreach ($inc in $itemsToInclude) {
    if ($rel -like "$inc*" -or $rel -eq $inc) { $include = $true; break }
  }
  if (-not $include) { return $false }
  foreach ($ex in $excludePatterns) {
    if ($rel -like $ex) { return $false }
  }
  return $true
}

if ($files.Count -eq 0) {
  Write-Error "No files matched for packaging."
  exit 1
}

$tempDir = Join-Path $env:TEMP "es-copilot-zip-$(Get-Date -Format yyyyMMddHHmmss)"
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

foreach ($f in $files) {
  $rel = $f.FullName.Substring($root.Length + 1)
  $dest = Join-Path $tempDir $rel
  $destDir = Split-Path $dest -Parent
  if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
  Copy-Item $f.FullName $dest -Force
}

Compress-Archive -Path (Join-Path $tempDir "*") -DestinationPath $zipPath -Force
Remove-Item $tempDir -Recurse -Force

Write-Host "Created: $zipPath"
Write-Host "Size: $([math]::Round((Get-Item $zipPath).Length / 1MB, 2)) MB"
Write-Host "Load this zip contents (the inner folder) as unpacked extension in Edge."
