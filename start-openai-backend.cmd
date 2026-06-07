@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0backend-proxy\start-openai-backend.ps1"
