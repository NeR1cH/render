@echo off
chcp 65001 > nul
title Anime Tracker & Bot Runner
color 0F

echo ================================================================
echo               ANIME ASSISTANT & TRACKER HUB v2.0
echo ================================================================
echo.
echo Выберите режим запуска:
echo.
echo   [1] Запустить Веб-интерфейс (http://localhost:3000)
echo   [2] Запустить Telegram-бота (автономно)
echo   [3] Запустить всё вместе (Веб-интерфейс + Telegram-бот)
echo.
echo ================================================================
set /p choice="Ваш выбор [1, 2 или 3, по умолчанию 1]: "

if "%choice%"=="" set choice=1

if "%choice%"=="1" (
    echo.
    echo [OK] Запуск веб-интерфейса Anime Assistant...
    echo Адрес в браузере: http://localhost:3000
    echo.
    start http://localhost:3000
    call npm run dev
    goto end
)

if "%choice%"=="2" (
    echo.
    echo [1/2] Проверка авторизации Shikimori...
    call npm run test:shikimori
    echo.
    echo [2/2] Запуск Telegram-бота...
    call npm run bot
    goto end
)

if "%choice%"=="3" (
    echo.
    echo [1/2] Запуск Telegram-бота в отдельном окне...
    start "Telegram Anime Bot" cmd /c "npm run bot"
    echo.
    echo [2/2] Запуск веб-интерфейса на http://localhost:3000...
    start http://localhost:3000
    call npm run dev
    goto end
)

echo Неверный выбор, запускаю веб-интерфейс...
start http://localhost:3000
call npm run dev

:end
pause
