@echo off
chcp 65001 > nul
title Anime Tracker Bot Runner

echo ======================================================
echo [1/2] Checking Shikimori authorization and tokens...
echo ======================================================

call npm run test:shikimori
set "TEST_EXIT_CODE=%errorlevel%"
if not "%TEST_EXIT_CODE%"=="0" (
    color 4F
    echo.
    echo [ERROR] Shikimori test failed!
    echo Bot will not start. Check .env tokens and authorization.
    echo.
    pause
    exit /b %TEST_EXIT_CODE%
)

echo.
echo ======================================================
echo Shikimori API is ready!
echo [2/2] Starting Anime Tracker Bot...
echo ======================================================
echo.

call npm run bot
pause
