@echo off
setlocal
cd /d "%~dp0"

echo Starting KartBlitz leaderboard API on http://localhost:8787 ...
start "KartBlitz API" cmd /k python app.py

timeout /t 2 /nobreak >nul

where cloudflared >nul 2>&1
if %ERRORLEVEL%==0 (
  echo Starting Cloudflare quick tunnel...
  start "KartBlitz Tunnel" cmd /k cloudflared tunnel --url http://localhost:8787
  echo.
  echo Leave BOTH windows open. Copy the https://....trycloudflare.com URL from the tunnel window.
) else (
  echo cloudflared not on PATH.
  echo Run manually, e.g.:
  echo   "C:\Users\%%USERNAME%%\Downloads\Applications\cloudflared-windows-amd64.exe" tunnel --url http://localhost:8787
)

echo.
echo Local health check: http://localhost:8787/api/health
pause
