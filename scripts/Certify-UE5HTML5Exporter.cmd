@echo off
setlocal

set "CERTIFY_SCRIPT=%~dp0scripts\Start-UE5HTML5Certification.ps1"
if not exist "%CERTIFY_SCRIPT%" set "CERTIFY_SCRIPT=%~dp0Start-UE5HTML5Certification.ps1"

if not exist "%CERTIFY_SCRIPT%" (
  echo UE5HTML5Exporter certification component was not found: "%CERTIFY_SCRIPT%"
  exit /b 1
)

if /I "%~1"=="--check" goto check
if "%~1"=="" goto choose_project
if "%~2"=="" goto project_only

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -STA -File "%CERTIFY_SCRIPT%" -Project "%~f1" -Map "%~2"
goto finish

:project_only
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -STA -File "%CERTIFY_SCRIPT%" -Project "%~f1"
goto finish

:choose_project
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -STA -File "%CERTIFY_SCRIPT%"
goto finish

:check
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -STA -File "%CERTIFY_SCRIPT%" -LauncherCheck

:finish
set "CERTIFY_EXIT=%ERRORLEVEL%"

if not "%UE5HTML5_NO_PAUSE%"=="1" pause
exit /b %CERTIFY_EXIT%
