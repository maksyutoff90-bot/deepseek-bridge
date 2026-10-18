# Открыть локальную заглушку чата — проверить мост без DeepSeek.
#   .\open-mock.ps1            (шлюз должен быть запущен на 8787)
#   .\open-mock.ps1 -Port 8788
param([int]$Port = 8787)

$url = "http://127.0.0.1:$Port/webcode-mock/chat.html"
try {
  $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 3
} catch {
  Write-Host "Шлюз на порту $Port не отвечает. Сначала запустите .\start-gateway.ps1" -ForegroundColor Yellow
}

Start-Process $url
Write-Host "Открыл $url" -ForegroundColor DarkGray
