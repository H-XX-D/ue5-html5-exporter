@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 "%~dp0serve.py" --discord-preview %*
  exit /b %errorlevel%
)
where python >nul 2>nul
if %errorlevel%==0 (
  python "%~dp0serve.py" --discord-preview %*
  exit /b %errorlevel%
)
echo Discord Activity preview requires Python 3 or the one-click Unreal menu command.
exit /b 1
