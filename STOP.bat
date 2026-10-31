@echo off
title Stopping PrintShare
echo Stopping Cloudflare Tunnel...
taskkill /F /IM cloudflared.exe >nul 2>nul
echo Stopping PrintShare server...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:"127.0.0.1:3000 .*LISTENING"') do taskkill /F /T /PID %%P >nul 2>nul
echo.
echo Done. Your uploaded PDFs are still safely stored in the "uploads" folder.
timeout /t 4 >nul
