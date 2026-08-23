@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 "%~dp0serve.py" --certify %*
  set "cert_status=!errorlevel!"
  if not "!cert_status!"=="0" pause
  exit /b !cert_status!
)
where python >nul 2>nul
if %errorlevel%==0 (
  python "%~dp0serve.py" --certify %*
  set "cert_status=!errorlevel!"
  if not "!cert_status!"=="0" pause
  exit /b !cert_status!
)
echo Browser certification requires Python 3 or the one-click Unreal menu command.
pause
exit /b 1
