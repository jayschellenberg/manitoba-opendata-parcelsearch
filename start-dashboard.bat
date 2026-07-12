@echo off
REM start-dashboard.bat — launch the Data Refresh Control Panel.
REM
REM Runs the zero-dependency Node server in dashboard\server.js and
REM opens the page in your default browser. Leave this window open
REM while you're using the dashboard; close it (or hit Ctrl-C) to stop.
REM
REM You can drop a Windows shortcut to this file on your desktop:
REM   Right-click → New → Shortcut → browse to this .bat → Finish.

setlocal

REM Always run from this script's directory (the mb-parcelsearch repo root),
REM not whatever folder the user happened to be in when launching it.
cd /d "%~dp0"

set DASHBOARD_PORT=5180

REM Open the page after a short delay so the server has time to bind.
start "" /b cmd /c "timeout /t 2 /nobreak > nul & start http://localhost:%DASHBOARD_PORT%"

echo === Data Refresh Control Panel ===
echo Working dir: %CD%
echo URL:         http://localhost:%DASHBOARD_PORT%
echo.
echo Close this window or press Ctrl-C to stop the server.
echo.

node dashboard\server.js

endlocal
