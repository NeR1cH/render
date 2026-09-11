# 🎬 Anime Tracker Hub v2.0
> Автономный персональный трекер аниме: мониторинг выхода новых серий на **AnimeLib** в любимой озвучке, быстрый поиск раздач на **RuTracker** и автосинхронизация списков с **Shikimori** через **Telegram-бота**.

---

## ⚡ Особенности архитектуры v2.0

* **Полный отказ от n8n, Docker и PostgreSQL**: всё работает локально на чистом TypeScript и Node.js.
* **Быстрая база SQLite (`better-sqlite3`)**: вся история просмотров, кэш сопоставлений тайтлов и OAuth-токены хранятся в одном файле `local.db` с оптимизациями WAL.
* **Shikimori GraphQL & REST v2**:
  * Быстрый поиск, топы и онгоинги через GraphQL;
  * Авто-обновление протухших OAuth-токенов (`refreshToken`);
  * Синхронизация статуса «Просмотрено» в один клик (`/api/v2/user_rates`).
* **Парсер AnimeLib**:
  * Прямая работа с API шлюзом закладок;
  * Отслеживание команд дубляжа (*AniLibria, Dream Cast, Дубляжная, Red Head Sound* и др.);
  * Двухуровневый fallback на парсер `cheerio` при защите Cloudflare.
* **Telegram-бот (`grammY`)**:
  * Интерактивные карточки с постерами, рейтингом и списком озвучек;
  * Кнопки прямого перехода: **AnimeLib**, **Shikimori**, поиск торрента на **RuTracker**, и отметка «В Просмотрено»;
  * Фоновый планировщик, проверяющий выходы серий каждые 30 минут.

---

## 🚀 Быстрый старт

### 1. Установка зависимостей (через pnpm)
```bash
pnpm install
```

### 2. Настройка переменных окружения
Скопируйте шаблон конфига:
```bash
cp .env.example .env
```
Заполните `.env`:
```ini
# Токен бота из @BotFather и ID вашего чата из @userinfobot
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_CHAT_ID=123456789

# Кука сессии из браузера со страницы animelib.me
ANIMELIB_COOKIE=remember_web_...=...;

# Данные OAuth Shikimori
SHIKIMORI_CLIENT_ID=...
SHIKIMORI_CLIENT_SECRET=...
SHIKIMORI_USER_ID=...
SHIKIMORI_ACCESS_TOKEN=...
```

### 3. Запуск бота
```bash
pnpm bot
```

---

## 📱 Команды Telegram-бота

* `/start` — Приветствие и быстрые интерактивные кнопки.
* `/check` — Принудительная проверка выхода новых серий из списка «Смотрю».
* `/watching` — Список всех тайтлов, находящихся сейчас в процессе просмотра.
* `/ongoings` — Самые популярные онгоинги текущего сезона с Shikimori.
* `/top` — Топ-10 лучших аниме по рейтингу Shikimori.

---

## 📂 Структура проекта

```text
├── local.db                 # Локальная база данных SQLite (создается автоматически)
├── CHANGES.md               # Полное подробное описание всех изменений и примеров
├── package.json             # Зависимости и скрипты запуска (pnpm bot, pnpm dev, pnpm build)
├── tsconfig.json            # Настройки компилятора TypeScript
├── src/
│   ├── bot/
│   │   └── index.ts         # Telegram-бот на grammY и планировщик проверок
│   ├── db/
│   │   └── database.ts      # Инициализация SQLite, схемы таблиц и CRUD-сервис
│   └── services/
│       ├── animelib.ts      # Сессионный клиент, парсер серий и озвучек AnimeLib
│       └── shikimori.ts     # GraphQL-клиент, REST v2 API и OAuth Shikimori
```

Подробную техническую документацию и примеры смотрите в файле [CHANGES.md](./CHANGES.md).
