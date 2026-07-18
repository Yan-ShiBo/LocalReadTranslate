@echo off
chcp 65001 >nul 2>nul
setlocal
title Kokoro TTS Setup

set "ENV_NAME=kokoro-tts"
set "PROJECT_DIR=%~dp0"

echo.
echo ========================================
echo    Kokoro TTS Environment Setup
echo ========================================
echo.

echo [0/5] Checking prerequisites...
where conda >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Conda was not found in PATH.
    echo         Install Miniconda or Anaconda, then reopen this terminal.
    goto :fail
)

where espeak-ng >nul 2>nul
if errorlevel 1 (
    echo [ERROR] eSpeak-NG was not found in PATH.
    echo         Install it from:
    echo         https://github.com/espeak-ng/espeak-ng/releases
    goto :fail
)
echo [OK] Conda and eSpeak-NG are available.
echo.

echo [1/5] Checking Conda environment...
call conda env list | findstr /R /C:"^%ENV_NAME% " >nul
if errorlevel 1 (
    echo Creating %ENV_NAME% with Python 3.10...
    call conda create -n "%ENV_NAME%" python=3.10 -y
    if errorlevel 1 (
        echo [ERROR] Failed to create Conda environment.
        goto :fail
    )
) else (
    echo [OK] Environment already exists.
)
echo.

echo [2/5] Installing PyTorch 2.6.0 with CUDA 12.4...
call conda run -n "%ENV_NAME%" python -m pip install ^
    torch==2.6.0 torchaudio==2.6.0 ^
    --index-url https://download.pytorch.org/whl/cu124
if errorlevel 1 (
    echo [ERROR] PyTorch installation failed.
    goto :fail
)
echo.

echo [3/5] Installing project dependencies...
call conda run -n "%ENV_NAME%" python -m pip install -r "%PROJECT_DIR%requirements.txt"
if errorlevel 1 (
    echo [ERROR] Project dependency installation failed.
    goto :fail
)
echo.

echo [4/5] Verifying the environment...
call conda run -n "%ENV_NAME%" python -m pip check
if errorlevel 1 (
    echo [ERROR] Dependency verification failed.
    goto :fail
)

call conda run -n "%ENV_NAME%" python -c "import fastapi, imageio_ffmpeg, kokoro, paramiko, PIL, pystray, soundfile, torch; print('[OK] Imports passed. CUDA:', torch.cuda.is_available())"
if errorlevel 1 (
    echo [ERROR] Import verification failed.
    goto :fail
)

call conda run -n "%ENV_NAME%" python -c "import imageio_ffmpeg, pathlib, subprocess; exe=imageio_ffmpeg.get_ffmpeg_exe(); assert pathlib.Path(exe).is_file(); subprocess.run([exe, '-version'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)); print('[OK] Bundled FFmpeg passed:', exe)"
if errorlevel 1 (
    echo [ERROR] Bundled FFmpeg verification failed.
    goto :fail
)

echo.
echo [5/5] Registering the browser start link for the current user...
call conda run -n "%ENV_NAME%" python "%PROJECT_DIR%windows_protocol.py" register
if errorlevel 1 (
    echo [ERROR] Could not register localreadtranslate://start.
    echo         You can still start the app manually with Kokoro TTS.bat.
    goto :fail
)

echo.
echo ========================================
echo    Setup complete!
echo    Next: click Start local service in the userscript
echo          or double-click Kokoro TTS.bat.
echo    Re-run setup.bat after moving this project folder.
echo ========================================
echo.
pause
exit /b 0

:fail
echo.
echo Setup stopped because a required step failed.
echo No success message has been emitted.
echo.
pause
exit /b 1
