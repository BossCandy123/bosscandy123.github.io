param(
  [string]$OutputDir = (Join-Path $env:LOCALAPPDATA "CreatorCopilot\certs"),
  [string]$FriendlyName = "Creator Copilot Localhost",
  [System.Security.SecureString]$PfxPassword = $null
)

$ErrorActionPreference = "Stop"

if (-not $PfxPassword) {
  $passwordBytes = New-Object byte[] 32
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($passwordBytes)
  } finally {
    $generator.Dispose()
  }
  $plainPassword = [Convert]::ToBase64String($passwordBytes)
  $PfxPassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force
} else {
  $secureStringBSTR = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($PfxPassword)
  try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto($secureStringBSTR)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secureStringBSTR)
  }
}

$existing = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.FriendlyName -eq $FriendlyName -and $_.NotAfter -gt (Get-Date).AddDays(30) } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1

if (-not $existing) {
  $existing = New-SelfSignedCertificate `
    -FriendlyName $FriendlyName `
    -Subject "CN=localhost" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears(3) `
    -TextExtension @(
      "2.5.29.17={text}DNS=localhost&IPAddress=127.0.0.1&IPAddress=::1",
      "2.5.29.37={text}1.3.6.1.5.5.7.3.1"
    )
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$pfxPath = Join-Path $OutputDir "creator-copilot-localhost.pfx"
$cerPath = Join-Path $OutputDir "creator-copilot-localhost.cer"
$passphraseFile = Join-Path $OutputDir "creator-copilot-localhost.pass.txt"
$securePassword = ConvertTo-SecureString $PfxPassword -AsPlainText -Force

Export-PfxCertificate -Cert "Cert:\CurrentUser\My\$($existing.Thumbprint)" -FilePath $pfxPath -Password $securePassword | Out-Null
Export-Certificate -Cert "Cert:\CurrentUser\My\$($existing.Thumbprint)" -FilePath $cerPath -Force | Out-Null

$trusted = Get-ChildItem Cert:\CurrentUser\Root | Where-Object Thumbprint -eq $existing.Thumbprint
if (-not $trusted) {
  Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
}

Set-Content -Path $passphraseFile -Value $PfxPassword -NoNewline

[pscustomobject]@{
  thumbprint = $existing.Thumbprint
  pfxPath = $pfxPath
  cerPath = $cerPath
  passphraseFile = $passphraseFile
  httpsUrl = "https://127.0.0.1:8789/dashboard"
} | ConvertTo-Json -Compress
