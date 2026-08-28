@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy-and-restart.ps1"
if errorlevel 1 exit /b %errorlevel%
endlocal
