# Установка расширения без магазина.
# Копирует extension/ в стабильную папку и кладёт путь в буфер обмена,
# чтобы его можно было вставить в диалог «Загрузить распакованное».
#
#   .\install.ps1
#   .\install.ps1 -Target "D:\tools\deepseek-bridge\extension"
[CmdletBinding()]
param(
  [string]$Target = (Join-Path $env:LOCALAPPDATA 'deepseek-bridge\extension'),
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'extension'

if (-not (Test-Path (Join-Path $src 'manifest.json'))) {
  Write-Error "не найдена папка extension рядом со скриптом ($src)"
  exit 1
}

New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item (Join-Path $src '*') $Target -Recurse -Force
Set-Clipboard -Value $Target

Write-Host ""
Write-Host "  Расширение скопировано:" -ForegroundColor Green
Write-Host "  $Target" -ForegroundColor White
Write-Host "  Путь уже в буфере обмена." -ForegroundColor Gray
Write-Host ""
Write-Host "  Дальше:" -ForegroundColor Cyan
Write-Host "   1. Откройте chrome://extensions (или edge://extensions)"
Write-Host "   2. Включите «Режим разработчика»"
Write-Host "   3. «Загрузить распакованное» → вставьте путь (Ctrl+V) → выбрать папку"
Write-Host "   4. Настройки расширения (⚙) → вставьте токен из gateway\.token"
Write-Host ""

if (-not $NoOpen) {
  $chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1

  if ($chrome) {
    try {
      Start-Process $chrome 'chrome://extensions'
    } catch {
      Write-Host "  Chrome не открылся автоматически — откройте chrome://extensions вручную." -ForegroundColor Yellow
    }
  } else {
    Write-Host "  Chrome не найден — откройте chrome://extensions вручную." -ForegroundColor Yellow
  }
}
