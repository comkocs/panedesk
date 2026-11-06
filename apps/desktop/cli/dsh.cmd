@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\Panedesk.exe" --disable-sigusr1 --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@panedesk\dsh-desktop-host\lib\cli.js" %*
exit /b %errorlevel%
