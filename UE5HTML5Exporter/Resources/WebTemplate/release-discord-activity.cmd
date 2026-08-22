@echo off
setlocal
cd /d "%~dp0"
node scripts\activity-release-assistant.mjs %*
set "UE5_ACTIVITY_EXIT=%ERRORLEVEL%"
if not "%UE5_ACTIVITY_NO_PAUSE%"=="1" pause
exit /b %UE5_ACTIVITY_EXIT%
