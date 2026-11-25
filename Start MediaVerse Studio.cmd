@echo off
rem Double-click to build and start MediaVerse Studio from source (development prototype).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-mediaverse.ps1" %*
if errorlevel 1 pause
