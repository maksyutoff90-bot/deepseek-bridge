# Запуск локального шлюза.
# Примеры:
#   .\start-gateway.ps1
#   .\start-gateway.ps1 -Port 8788 -Root "D:\OtherProject"
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [string]$Root = ""
)

$ErrorActionPreference = "Stop"
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $base "gateway\server.mjs"

if (-not (Test-Path $server)) {
  Write-Error "не найден $server"
  exit 1
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Error "Node.js не найден в PATH. Установите Node 22+."
  exit 1
}

$nodeArgs = @($server, "--port", $Port)
if ($Root) {
  $nodeArgs += @("--root", $Root)
}

Write-Host "Запускаю шлюз: node $($nodeArgs -join ' ')" -ForegroundColor DarkGray
& $nodeCmd.Source @nodeArgs
