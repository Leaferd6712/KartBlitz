@echo off
setlocal
cd /d "%~dp0"

echo Starting KartBlitz leaderboard API on port 8787...
start "KartBlitz API" cmd /k "python app.py"

timeout /t 2 /nobreak >nul

where cloudflared >nul 2>&1
if errorlevel 1 (
  echo.
  echo cloudflared was not found on PATH.
  echo Install it from:
  echo   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
  echo Then re-run this script, or run manually:
  echo   cloudflared tunnel --url http://localhost:8787
  echo.
  echo API is still running locally at http://localhost:8787/KartBlitz.html
  pause
  exit /b 1
)

echo Starting Cloudflare quick tunnel...
echo Copy the https://....trycloudflare.com URL and open /KartBlitz.html on it.
start "KartBlitz Tunnel" cmd /k "cloudflared tunnel --url http://localhost:8787"

echo.
echo Both windows should stay open while people play.
echo Keep the laptop plugged in and awake.
pause
