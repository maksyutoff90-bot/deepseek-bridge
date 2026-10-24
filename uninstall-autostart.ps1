# Выключает автозапуск шлюза WebCode.
# Запуск: powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1

$startup = [Environment]::GetFolderPath("Startup")
$link = Join-Path $startup "WebCode gateway.lnk"
if (Test-Path $link) {
    Remove-Item $link -Force
    Write-Host "Autostart disabled: $link"
} else {
    Write-Host "Autostart is not enabled."
}
