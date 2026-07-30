@echo off
REM Starts the BEMMP dashboard and leaves it running.
REM
REM Double-click this file. Keep the window open — closing it stops the server.
REM Anything started from a tool session dies with that session; this does not.

cd /d "%~dp0"

echo Building...
call npm run build
if errorlevel 1 (
  echo.
  echo Build failed. Fix the error above, then run this again.
  pause
  exit /b 1
)

echo.
call npm run serve

REM If serve exits, hold the window open so the reason stays readable.
echo.
echo Server stopped.
pause
