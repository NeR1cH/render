@echo off
chcp 65001 > nul
title Anime Tracker Hub Launcher
color 07

:menu
cls
echo ======================================================
echo Anime Tracker Hub Launcher
echo ======================================================
echo [1] Check Shikimori and start Telegram bot
echo [2] Run Gemini GitHub bridge
echo [Q] Exit
echo.
choice /c 12Q /n /m "Select an action: "
if errorlevel 3 goto :end
if errorlevel 2 goto :bridge
if errorlevel 1 goto :bot

:bot
cls
echo ======================================================
echo [1/2] Checking Shikimori authorization and tokens...
echo ======================================================

call pnpm test:shikimori
set "TEST_EXIT_CODE=%errorlevel%"
if not "%TEST_EXIT_CODE%"=="0" (
    color 4F
    echo.
    echo [ERROR] Shikimori test failed!
    echo Bot will not start. Check .env tokens and authorization.
    echo.
    pause
    goto :menu
)

echo.
echo ======================================================
echo Shikimori API is ready!
echo [2/2] Starting Anime Tracker Bot...
echo ======================================================
echo.

call pnpm bot
pause
goto :menu

:bridge
cls
echo ======================================================
echo Gemini GitHub bridge
echo ======================================================
echo Required local values: GEMINI_API_KEY, GITHUB_PAT,
echo GITHUB_OWNER, GITHUB_REPO, and GITHUB_BRANCH.
echo The bridge will ask for confirmation before any commit.
echo.
set "AI_TASK="
set /p "AI_TASK=Describe the requested change: "
if not defined AI_TASK goto :menu
echo.
call pnpm ai:bridge "%AI_TASK%"
echo.
pause
goto :menu

:end
color 07
exit /b 0
