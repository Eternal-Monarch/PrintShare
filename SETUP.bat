@echo off
title PrintShare - One-time setup
cd /d "%~dp0"
echo.
echo  PrintShare one-time setup
echo  -------------------------
where node >nul 2>nul
if errorlevel 1 goto NONODE

echo.
echo  [1/2] Installing PrintShare components (needs internet)...
call npm install --no-fund --no-audit
if errorlevel 1 goto NPMFAIL

echo.
echo  [2/2] Installing Cloudflare Tunnel (cloudflared)...
where cloudflared >nul 2>nul
if not errorlevel 1 goto CFDONE
winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
:CFDONE
echo.
echo  Setup finished. Now double-click START.bat
echo  (If START.bat says cloudflared is missing, restart Windows once and try again.)
echo.
pause
exit /b 0

:NONODE
echo.
echo  Node.js is not installed. Install the LTS version from https://nodejs.org
echo  then run SETUP.bat again.
echo.
pause
exit /b 1

:NPMFAIL
echo.
echo  Installing components failed. Check your internet connection and run SETUP.bat again.
echo.
pause
exit /b 1
