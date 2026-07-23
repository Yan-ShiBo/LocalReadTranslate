@echo off
chcp 65001 >nul 2>nul
setlocal
title Remove LocalReadTranslate Document Add-ins

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall_document_addins.ps1"
if errorlevel 1 (
    echo.
    echo [ERROR] Uninstallation did not complete.
    pause
    exit /b 1
)

echo.
echo [OK] Add-in registrations were removed.
pause
exit /b 0
