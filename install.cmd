@echo off
rem Установка расширения без магазина (обходит политику выполнения скриптов).
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 pause
