@echo off
rem Запуск локального шлюза без PowerShell (обходит политику выполнения скриптов).
rem Двойной клик по этому файлу или: start-gateway.cmd
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден в PATH. Установите Node 22+ и повторите.
  pause
  exit /b 1
)

echo Запускаю WebCode gateway...
node "%~dp0gateway\server.mjs" %*
if errorlevel 1 pause
