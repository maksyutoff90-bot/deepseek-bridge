# Включает автозапуск шлюза WebCode при входе в Windows.
# Запуск: powershell -ExecutionPolicy Bypass -File install-autostart.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $root "start-gateway-hidden.vbs"
if (-not (Test-Path $vbs)) { throw "start-gateway-hidden.vbs not found" }

$startup = [Environment]::GetFolderPath("Startup")
$link = Join-Path $startup "WebCode gateway.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = (Join-Path $env:WINDIR "System32\wscript.exe")
$shortcut.Arguments = '"' + $vbs + '"'
$shortcut.WorkingDirectory = $root
$shortcut.WindowStyle = 7
$shortcut.Description = "WebCode gateway (hidden)"
$shortcut.Save()

Write-Host "Autostart enabled: $link"
