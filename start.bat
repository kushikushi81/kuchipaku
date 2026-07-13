@echo off
cd /d "%~dp0"

set PORT=8000

start "" "http://localhost:%PORT%/"
python server.py %PORT%
