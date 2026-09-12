@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 > nul
title Anime Tracker Hub :: Local Runtime
color 0B

goto :menu

:menu
cls
color 0B
echo.
echo   ===========================================================================
echo       A N I M E   T R A C K E R   H U B   //   LOCAL RUNTIME
echo   ===========================================================================
echo.
echo       Main workspace: Google AI Studio
echo       Runtime mode: single-process, no extra console windows
echo.
echo       +--------------------------------------------------------------------+
echo       ^|  [1]  RUN BACKEND                                                ^|
echo       ^|  [2]  RUN BOT                                                   ^|
echo       ^|  [3]  RUN AI BRIDGE                                              ^|
echo       ^|  [Q]  EXIT                                                       ^|
echo       +--------------------------------------------------------------------+
echo.
choice /c 123Q /n /m "       Select an action: "
if errorlevel 4 goto :end
if errorlevel 3 goto :bridge
if errorlevel 2 goto :bot
if errorlevel 1 goto :backend
goto :menu

:backend
color 0A
echo.
echo       [ STARTING BACKEND ]
echo       Local runtime for the project API and database.
echo       ------------------------------------------------------------------
call npm run backend
set "BACKEND_EXIT_CODE=!errorlevel!"
echo.
echo       Backend stopped with code !BACKEND_EXIT_CODE!.
pause
goto :menu

:bot
color 0E
echo.
echo       [ STARTING BOT ]
echo       Checking Shikimori connectivity before launch.
echo       ------------------------------------------------------------------
call npm run bot:check
set "CHECK_EXIT_CODE=!errorlevel!"
if not "!CHECK_EXIT_CODE!"=="0" (
    color 4F
    echo.
    echo       [FAILED] Shikimori check returned code !CHECK_EXIT_CODE!.
    echo       Bot launch was skipped.
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
echo       Bot stopped with code !BOT_EXIT_CODE!.
pause
goto :menu

:bridge
color 0D
echo.
echo       [ AI BRIDGE ]
echo       Secure GitHub / Gemini workflow, manual confirmation required.
echo       ------------------------------------------------------------------
set "AI_TASK="
set /p "AI_TASK=       Describe the requested change: "
if not defined AI_TASK goto :menu

echo.
echo       Sending request to Gemini...
echo       ------------------------------------------------------------------
call npm run bridge "!AI_TASK!"
set "BRIDGE_EXIT_CODE=!errorlevel!"
echo.
if "!BRIDGE_EXIT_CODE!"=="0" (
    color 0A
    echo       [OK] Bridge finished successfully.
) else (
    color 4F
    echo       [ERROR] Bridge ended with code !BRIDGE_EXIT_CODE!.
)

echo.
pause
goto :menu

:end
color 07
echo.
echo       Session closed.
echo.
endlocal
exit /b 0
