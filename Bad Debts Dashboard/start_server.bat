@echo off
echo ========================================
echo    Bad Debts Dashboard Web Server
echo ========================================
echo.
echo Starting web server...
echo.
echo Dashboard will be available at:
echo http://localhost:8000
echo.
echo To access from other devices on your network:
echo http://[YOUR_IP_ADDRESS]:8000
echo.
echo Press Ctrl+C to stop the server
echo ========================================
echo.

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not installed or not in PATH
    echo Please install Python from https://python.org
    pause
    exit /b 1
)

REM Start Python HTTP server
python -m http.server 8000

echo.
echo Server stopped.
pause
