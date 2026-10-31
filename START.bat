@echo off
title PrintShare Launcher
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

if not exist "node_modules\express" (
  echo First run: installing components, please wait...
  call npm install --no-fund --no-audit
  if errorlevel 1 goto NPMFAIL
)

if not exist data mkdir data
if not exist uploads mkdir uploads
if exist data\tunnel.log del /q data\tunnel.log >nul 2>nul

set "PATH=%PATH%;%ProgramFiles(x86)%\cloudflared;%ProgramFiles%\cloudflared"

echo Starting PrintShare server...
start "PrintShare Server" /min cmd /c "node server.js & pause"

set /a TRIES=0
:WAITSERVER
set /a TRIES+=1
curl -s -o nul http://127.0.0.1:3000/healthz
if not errorlevel 1 goto SERVERUP
if %TRIES% GEQ 20 goto SERVERFAIL
timeout /t 1 /nobreak >nul
goto WAITSERVER

:SERVERUP
where cloudflared >nul 2>nul
if errorlevel 1 goto NOTUNNEL
if exist tunnel-token.txt goto NAMEDTUNNEL

echo Starting Cloudflare Quick Tunnel...
start "PrintShare Tunnel" /min cmd /c "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3000 --logfile data\tunnel.log & pause"
goto OPENUI

:NAMEDTUNNEL
echo Starting your named Cloudflare Tunnel...
set /p TUNNEL_TOKEN=<tunnel-token.txt
start "PrintShare Tunnel" /min cmd /c "cloudflared tunnel --no-autoupdate --logfile data\tunnel.log run --token %TUNNEL_TOKEN% & pause"
goto OPENUI

:NOTUNNEL
echo.
echo WARNING: cloudflared is not installed, so the internet cannot reach your laptop yet.
echo Run SETUP.bat (or see README section 5). The dashboard will still open.
echo.

:OPENUI
timeout /t 3 /nobreak >nul
start "" http://localhost:3000
echo.
echo PrintShare is running. The dashboard opened in your browser.
echo Two minimized windows (Server, Tunnel) must stay open. Use STOP.bat to shut down.
echo You can close THIS window.
timeout /t 8 >nul
exit /b 0

:NONODE
echo Node.js is not installed. Install the LTS version from https://nodejs.org and run SETUP.bat.
pause
exit /b 1

:NPMFAIL
echo Installing components failed. Check your internet connection and try again.
pause
exit /b 1

:SERVERFAIL
echo.
echo The server did not start. Open the "PrintShare Server" window in your taskbar to read the error.
echo Common cause: PrintShare is already running. Run STOP.bat, then START.bat.
pause
exit /b 1
