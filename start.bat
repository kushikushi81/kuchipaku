@echo off
cd /d "%~dp0"

set PORT=8000

where python >nul 2>nul
if %errorlevel%==0 (
    set PYCMD=python
) else (
    where py >nul 2>nul
    if %errorlevel%==0 (
        set PYCMD=py
    ) else (
        echo Python が見つかりません。https://www.python.org/ からインストールしてください。
        pause
        exit /b 1
    )
)

start "" "http://localhost:%PORT%/"
%PYCMD% server.py %PORT%
if errorlevel 1 pause
