@echo off
setlocal
cd /d "%~dp0creator-copilot-service"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0creator-copilot-service\start-local-operator.ps1" %*
echo.
echo If this window shows an error, leave it open and read the message above.
pause
