@echo off
setlocal
cd /d "%~dp0"

set "UE5_ACTIVITY_NODE_PATH_FILE=%TEMP%\ue5html5-node-%RANDOM%-%RANDOM%.txt"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0scripts\Start-DiscordActivityRelease.ps1" -PathFile "%UE5_ACTIVITY_NODE_PATH_FILE%"
set "UE5_ACTIVITY_EXIT=%ERRORLEVEL%"
if not "%UE5_ACTIVITY_EXIT%"=="0" goto cleanup

set /p "UE5_ACTIVITY_NODE="<"%UE5_ACTIVITY_NODE_PATH_FILE%"
if not exist "%UE5_ACTIVITY_NODE%" (
  echo Compatible Node.js path was not returned by the Windows bootstrap.
  set "UE5_ACTIVITY_EXIT=1"
  goto cleanup
)
for %%D in ("%UE5_ACTIVITY_NODE%") do set "PATH=%%~dpD;%PATH%"
"%UE5_ACTIVITY_NODE%" scripts\activity-release-assistant.mjs --guided %*
set "UE5_ACTIVITY_EXIT=%ERRORLEVEL%"

:cleanup
if exist "%UE5_ACTIVITY_NODE_PATH_FILE%" del /q "%UE5_ACTIVITY_NODE_PATH_FILE%"
if not "%UE5_ACTIVITY_NO_PAUSE%"=="1" pause
exit /b %UE5_ACTIVITY_EXIT%
