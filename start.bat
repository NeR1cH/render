@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 > nul
title Anime Tracker Hub :: Local Runtime
color 0B

:: Detect package manager (prefer pnpm, fallback to npm)
where pnpm >nul 2>nul
if !errorlevel! equ 0 (
    set "PM=pnpm"
) else (
    set "PM=npm"
)

goto :menu

:menu
cls
color 0B
echo.
echo   ===========================================================================
echo       A N I M E   T R A C K E R   H U B   //   LOCAL RUNTIME
echo   ===========================================================================
echo.
echo       Package Manager: !PM!
echo       Branch:          feat/ai-github-bridge
echo.
echo       +--------------------------------------------------------------------+
echo       ^|  [1]  GIT PULL     -- Подтянуть обновления из репозитория         ^|
echo       ^|  [2]  BUILD CHECK  -- Проверить компиляцию (!PM! run build)        ^|
echo       ^|  [3]  RUN ALL      -- Запуск веб-сервера и API (!PM! run dev)     ^|
echo       ^|  [4]  RUN BOT      -- Запуск Telegram-бота (!PM! run bot)         ^|
echo       ^|  [5]  AI BRIDGE    -- Gemini AI Bridge workflow                   ^|
echo       ^|  [6]  GIT STATUS   -- Проверка измененных файлов                  ^|
echo       ^|  [Q]  EXIT         -- Выход                                       ^|
echo       +--------------------------------------------------------------------+
echo.
choice /c 123456Q /n /m "       Выберите действие [1-6, Q]: "
if errorlevel 7 goto :end
if errorlevel 6 goto :gitstatus
if errorlevel 5 goto :bridge
if errorlevel 4 goto :bot
if errorlevel 3 goto :dev
if errorlevel 2 goto :build
if errorlevel 1 goto :gitpull
goto :menu

:gitpull
color 0E
echo.
echo       [ GIT PULL ]
echo       Подтягиваем свежие обновления из ветки feat/ai-github-bridge...
echo       ------------------------------------------------------------------
call git pull origin feat/ai-github-bridge
set "PULL_CODE=%errorlevel%"
echo.
if "%PULL_CODE%"=="0" (
    color 0A
    echo       [OK] Обновления успешно подтянуты!
) else (
    color 4F
    echo       [ERROR] Ошибка при выполнении git pull - код: %PULL_CODE%
)
echo.
pause
goto :menu

:build
color 0E
echo.
echo       [ BUILD CHECK ]
echo       Запуск сборки TypeScript и Vite для проверки компиляции...
echo       ------------------------------------------------------------------
call !PM! run build
set "BUILD_CODE=%errorlevel%"
echo.
if "%BUILD_CODE%"=="0" (
    color 0A
    echo       [OK] Сборка прошла успешно! Ошибок компиляции нет.
) else (
    color 4F
    echo       [ERROR] Сборка завершилась с ошибкой - код: %BUILD_CODE%
)
echo.
pause
goto :menu

:dev
color 0A
echo.
echo       [ STARTING FULL APP ]
echo       Запуск сервера, веб-интерфейса и фонового планировщика...
echo       ------------------------------------------------------------------
call !PM! run dev
set "DEV_CODE=%errorlevel%"
echo.
echo       Сервер остановлен с кодом: %DEV_CODE%
echo.
pause
goto :menu

:bot
color 0E
echo.
echo       [ STARTING BOT ]
echo       Шаг 1/2: Проверка связи с Shikimori...
echo       ------------------------------------------------------------------
call !PM! run bot:check
set "CHECK_EXIT_CODE=%errorlevel%"
if not "%CHECK_EXIT_CODE%"=="0" (
    color 4F
    echo.
    echo       [FAILED] Проверка Shikimori вернула код: %CHECK_EXIT_CODE%
    echo       Запуск бота отменен.
    echo.
    pause
    goto :menu
)

color 0A
echo.
echo       [OK] Связь с Shikimori в норме.
echo.
echo       Шаг 2/2: Запуск Telegram-бота...
echo       ------------------------------------------------------------------
call !PM! run bot
set "BOT_EXIT_CODE=%errorlevel%"
echo.
echo       Бот остановлен с кодом: %BOT_EXIT_CODE%
echo.
pause
goto :menu

:bridge
color 0D
echo.
echo       [ AI BRIDGE ]
echo       Gemini AI workflow для синхронизации и модификации.
echo       ------------------------------------------------------------------
set "AI_TASK="
set /p "AI_TASK=       Опишите задачу или изменение: "
if not defined AI_TASK goto :menu

echo.
echo       Отправка запроса в Gemini...
echo       ------------------------------------------------------------------
call !PM! run bridge "!AI_TASK!"
set "BRIDGE_EXIT_CODE=%errorlevel%"
echo.
if "%BRIDGE_EXIT_CODE%"=="0" (
    color 0A
    echo       [OK] AI Bridge успешно выполнен.
) else (
    color 4F
    echo       [ERROR] AI Bridge завершился с кодом: %BRIDGE_EXIT_CODE%
)
echo.
pause
goto :menu

:gitstatus
color 0B
echo.
echo       [ GIT STATUS ]
echo       Текущее состояние локальной ветки и файлов:
echo       ------------------------------------------------------------------
call git status
echo.
pause
goto :menu

:end
color 07
echo.
echo       Работа завершена. До встречи!
echo.
endlocal
exit /b 0