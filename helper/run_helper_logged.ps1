param(
  [Parameter(Mandatory = $true)]
  [string]$NodeExe,

  [Parameter(Mandatory = $true)]
  [string]$AppDir,

  [Parameter(Mandatory = $true)]
  [string]$LogFile
)

$ErrorActionPreference = "Continue"

if (-not (Test-Path -LiteralPath $NodeExe)) {
  throw "Node executable not found: $NodeExe"
}

if (-not (Test-Path -LiteralPath $AppDir)) {
  throw "App directory not found: $AppDir"
}

$logDir = Split-Path -Parent $LogFile
if ($logDir -and -not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
}

Set-Location -LiteralPath $AppDir

Write-Host "Strong Bridge helper log: $LogFile"
Write-Host "Press Ctrl+C to stop helper."

& $NodeExe "helper\ocr_helper_server.js" 2>&1 | Tee-Object -FilePath $LogFile -Append

$exitCode = if ($LASTEXITCODE -ne $null) { [int]$LASTEXITCODE } else { 0 }
Write-Host "Helper exited with code $exitCode"
exit $exitCode
