@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 > nul
title Anime Tracker Hub :: Control Center
color 0B

goto :menu

:header
cls
color 0B
echo.
echo   ==========================================================================
echo       A N I M E   T R A C K E R   H U B   //   C O N T R O L   C E N T E R
echo   ==========================================================================
echo.
echo       +----------------------------------------------------------------+
echo       ^|  TELEGRAM BOT  ^|  SHIKIMORI OAUTH  ^|  GEMINI GITHUB BRIDGE  ^|
echo       +----------------------------------------------------------------+
echo.
exit /b 0

:menu
call :header
echo       STATUS: READY
echo       MODE:   SAFE - every GitHub action requires confirmation
echo.
echo       +----------------------------------------------------------------+
echo       ^|  [1]  CHECK SHIKIMORI  ^>  START TELEGRAM BOT                  ^|
echo       ^|  [2]  RUN GEMINI      ^>  GITHUB BRIDGE                        ^|
echo       ^|  [Q]  EXIT                                                     ^|
echo       +----------------------------------------------------------------+
echo.
choice /c 12Q /n /m "       Select an action: "
if errorlevel 3 goto :end
if errorlevel 2 goto :bridge
if errorlevel 1 goto :bot
goto :menu

:bot
call :header
color 0E
echo       [ BOT STARTUP ]
echo.
echo       STEP 1/2  Checking Shikimori OAuth and user_rate access...
echo       ------------------------------------------------------------------
call npm run test:shikimori
set "TEST_EXIT_CODE=!errorlevel!"

if not "!TEST_EXIT_CODE!"=="0" (
    color 4F
    echo.
    echo       [FAILED] Shikimori preflight returned code !TEST_EXIT_CODE!.
    echo.
    echo       The Telegram bot was NOT started.
    echo       Check SHIKIMORI_ACCESS_TOKEN and SHIKIMORI_REFRESH_TOKEN in .env.
    echo.
    pause
    goto :menu
)

color 0A
echo.
echo       [OK] Shikimori API is ready.
echo.
echo       STEP 2/2  Starting Telegram bot...
echo       ------------------------------------------------------------------
call npm run bot
set "BOT_EXIT_CODE=!errorlevel!"
echo.
echo       Bot process ended with code !BOT_EXIT_CODE!.
pause
goto :menu

:bridge
call :header
color 0D
echo       [ GEMINI GITHUB BRIDGE ]
echo.
echo       The bridge can prepare a commit or release through GitHub API.
echo       Secret files are blocked. A manual y/N confirmation is required.
echo.
echo       Required .env values:
echo         GEMINI_API_KEY   GITHUB_PAT   GITHUB_OWNER
echo         GITHUB_REPO      GITHUB_BRANCH
echo.
set "AI_TASK="
set /p "AI_TASK=       Describe the requested change: "
if not defined AI_TASK goto :menu

echo.
echo       Sending request to Gemini...
echo       ------------------------------------------------------------------
call npm run ai:bridge "!AI_TASK!"
set "BRIDGE_EXIT_CODE=!errorlevel!"
echo.
if "!BRIDGE_EXIT_CODE!"=="0" (
    color 0A
    echo       [OK] Bridge completed successfully.
) else (
    color 4F
    echo       [ERROR] Bridge ended with code !BRIDGE_EXIT_CODE!.
    echo       No automatic retry was performed.
)
echo.
pause
goto :menu

:end
color 07
echo.
echo       Session closed. Goodbye.
echo.
endlocal
exit /b 0
