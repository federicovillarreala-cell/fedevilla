@echo off
rem Makes sure the background server is running, then opens the app.
cd /d "%~dp0"
start "" pythonw "%~dp0keepalive.pyw"
timeout /t 2 /nobreak >nul
start "" http://localhost:5190
