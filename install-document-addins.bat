@echo off
chcp 65001 >nul 2>nul
setlocal
title LocalReadTranslate Document Add-ins

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install_document_addins.ps1"
if errorlevel 1 (
    echo.
    echo [ERROR] Installation did not complete.
    pause
    exit /b 1
)

echo.
echo [OK] Installation completed. Reopen Word and WPS Office once.
pause
exit /b 0
