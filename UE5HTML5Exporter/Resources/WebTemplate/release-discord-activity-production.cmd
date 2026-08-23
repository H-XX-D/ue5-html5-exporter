@echo off
setlocal
call "%~dp0release-discord-activity.cmd" --environment production --promote %*
exit /b %ERRORLEVEL%
