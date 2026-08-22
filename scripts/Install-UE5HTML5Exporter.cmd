@echo off
setlocal

set "SETUP_SCRIPT=%~dp0scripts\Start-UE5HTML5Setup.ps1"
if not exist "%SETUP_SCRIPT%" set "SETUP_SCRIPT=%~dp0Start-UE5HTML5Setup.ps1"

if not exist "%SETUP_SCRIPT%" (
  echo UE5HTML5Exporter setup component was not found: "%SETUP_SCRIPT%"
  exit /b 1
)

if /I "%~1"=="--check" goto check
if "%~1"=="" goto choose_project

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -STA -File "%SETUP_SCRIPT%" -Project "%~f1"
goto finish

:choose_project
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -STA -File "%SETUP_SCRIPT%"
goto finish

:check
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -STA -File "%SETUP_SCRIPT%" -LauncherCheck

:finish
set "SETUP_EXIT=%ERRORLEVEL%"

if not "%UE5HTML5_NO_PAUSE%"=="1" pause
exit /b %SETUP_EXIT%
