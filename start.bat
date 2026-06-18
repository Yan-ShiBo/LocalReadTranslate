@echo off
chcp 65001 >nul 2>nul
title Kokoro TTS Server

echo.
echo ========================================
echo    Kokoro TTS Local Server
echo ========================================
echo.

:: Check eSpeak-NG
where espeak-ng >nul 2>nul
if errorlevel 1 (
    echo [ERROR] eSpeak-NG not found!
    echo         Please run setup.bat first.
    pause
    exit /b 1
)

set "CONDA_ENV=kokoro-tts"
set "PYTHON_EXE="

:: Find the env Python directly. This avoids requiring "conda init" in cmd.exe.
if exist "%USERPROFILE%\.conda\envs\%CONDA_ENV%\python.exe" set "PYTHON_EXE=%USERPROFILE%\.conda\envs\%CONDA_ENV%\python.exe"
if not defined PYTHON_EXE if exist "%USERPROFILE%\anaconda3\envs\%CONDA_ENV%\python.exe" set "PYTHON_EXE=%USERPROFILE%\anaconda3\envs\%CONDA_ENV%\python.exe"
if not defined PYTHON_EXE if exist "%USERPROFILE%\miniconda3\envs\%CONDA_ENV%\python.exe" set "PYTHON_EXE=%USERPROFILE%\miniconda3\envs\%CONDA_ENV%\python.exe"
if not defined PYTHON_EXE if exist "%ProgramData%\anaconda3\envs\%CONDA_ENV%\python.exe" set "PYTHON_EXE=%ProgramData%\anaconda3\envs\%CONDA_ENV%\python.exe"
if not defined PYTHON_EXE if exist "%ProgramData%\miniconda3\envs\%CONDA_ENV%\python.exe" set "PYTHON_EXE=%ProgramData%\miniconda3\envs\%CONDA_ENV%\python.exe"

if not defined PYTHON_EXE (
    for /f "delims=" %%P in ('conda run -n %CONDA_ENV% python -c "import sys; print(sys.executable)" 2^>nul') do (
        if exist "%%P" set "PYTHON_EXE=%%P"
    )
)

if not defined PYTHON_EXE (
    echo [ERROR] kokoro-tts conda env Python not found!
    echo         Please run setup.bat first.
    pause
    exit /b 1
)

echo Starting Kokoro TTS server...
echo Using: %PYTHON_EXE%
echo Press Ctrl+C to stop.
echo.
"%PYTHON_EXE%" "%~dp0server.py"

pause
