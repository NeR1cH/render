# Anime Tracker Hub

Локальный проект для отслеживания аниме через AnimeLib, синхронизации статусов с Shikimori и запуска Telegram-бота из одного Windows-окружения.

## Что сейчас работает

- AnimeLib bookmarks через рабочий endpoint `https://hapi.hentaicdn.org/api`.
- Поддержка `Authorization: Bearer ...` и/или Cookie-сессии.
- SQLite-хранилище с миграциями и сохранением OAuth-токенов.
- Shikimori OAuth2 с автоматическим refresh и синхронизацией `user_rates`.
- Telegram bot на базе `grammY`.
- Локальный Gemini -> GitHub bridge с защитой от секретов и ручным подтверждением.
- Windows launcher `start.bat` для preflight и мостового сценария.

## Технологический стек

- Node.js 20+
- TypeScript + `tsx`
- `pnpm`
- `grammY` для Telegram
- `axios` и `cheerio`
- SQLite через встроенный `node:sqlite`
- `@google/genai` для Gemini bridge

## Быстрый старт

### 1. Установка

```bash
pnpm install
```

### 2. Настройка окружения

```bash
Copy-Item .env.example .env
```

Затем заполните переменные в `.env`.

### 3. Основные команды

```bash
pnpm bot
pnpm test:shikimori
pnpm ai:bridge "Describe the requested change"
```

Для Windows можно запустить:

```cmd
start.bat
```

## Переменные окружения

Основной шаблон доступен в `.env.example`.

### Telegram

```ini
TELEGRAM_BOT_TOKEN="your_telegram_bot_token"
TELEGRAM_CHAT_ID="your_telegram_chat_id"
```

### AnimeLib

```ini
ANIMELIB_API_URL="https://hapi.hentaicdn.org/api"
ANIMELIB_USER_ID="your_animelib_user_id"
ANIMELIB_COOKIE="Bearer your_access_token"
```

Важно:
- AnimeLib использует статус `21` для списка «Смотрю».
- Для запросов к закладкам требуется корректный `Authorization`, `Origin`, `Referer` и `Site-Id: 5`.
- Не публикуйте токены и Cookie из браузера.

### Shikimori OAuth2

```ini
SHIKIMORI_CLIENT_ID="your_client_id"
SHIKIMORI_CLIENT_SECRET="your_client_secret"
SHIKIMORI_ACCESS_TOKEN="your_access_token"
SHIKIMORI_REFRESH_TOKEN="your_refresh_token"
SHIKIMORI_USER_ID="your_user_id"
SHIKIMORI_USER_AGENT="Anime Tracker Hub (contact: your_email@example.com)"
```

Токены хранятся локально в SQLite и обновляются автоматически при 401/refresh-ошибках.

### Local Gemini -> GitHub bridge

```ini
GEMINI_API_KEY="your_gemini_api_key"
GEMINI_MODEL="gemini-3.8-flash"
GITHUB_PAT="your_fine_grained_github_token"
GITHUB_OWNER="your_github_login"
GITHUB_REPO="your_repository"
GITHUB_BRANCH="feat/ai-github-bridge"
```

Требования к PAT:
- Fine-grained token
- Доступ только к нужному репозиторию
- Разрешение `Contents: Read and write`
- Не храните `PAT` в Git и не добавляйте `.env` в коммиты

## Запуск Telegram-бота

```bash
pnpm bot
```

После запуска бот готов к проверке обновлений и синхронизации статусов.

## Проверка Shikimori до запуска бота

```bash
pnpm test:shikimori
```

Команда проверяет OAuth-токены, SQLite-хранилище и запись `user_rates` для тестового аниме.

## Локальный Gemini -> GitHub bridge

Bridge используется для безопасной отправки задачи в Gemini и, если модель предлагает tool call, создания или обновления файла в GitHub и публикации release.

### Безопасность

Перед GitHub-операцией bridge:
- проверяет путь файла,
- блокирует `.env`, `.db`, `.sqlite`, закрытые ключи и подозрительные паттерны,
- требует ручного подтверждения `y/N`.

### Запуск

```bash
pnpm ai:bridge "Add a short section to README about the local bridge"
```

Или через launcher:

```cmd
start.bat
```

Выбор `2` запускает bridge-подсказку.

> Важно: при `429` в Gemini это означает исчерпание квоты Free Tier. Это не относится к GitHub или локальному коду.

## Windows launcher

`start.bat` предоставляет простой интерфейс:
- `1` — preflight Shikimori + запуск Telegram-бота
- `2` — запуск Gemini bridge
- `Q` — выход

Launcher печатает ASCII-меню и работает как безопасный контрольный центр для локальной разработки.

## SQLite и миграции

При старте проект создаёт `local.db` и необходимые таблицы. Для старой базы добавляется миграция `custom_note` в `animelib_sync`.

Проверить схему можно так:

```bash
pnpm exec tsx -e "import { db } from './src/db/database.ts'; console.log(db.prepare('PRAGMA table_info(animelib_sync)').all())"
```

Не добавляйте в Git:
- `.env`
- `.db`, `.sqlite`, `.sqlite3`
- `local.db*`
- временные логи и repomix-артефакты

## Скрипты проекта

```json
{
  "bot": "tsx src/bot/index.ts",
  "server": "tsx server.ts",
  "dev": "vite",
  "build": "tsc -b && vite build",
  "lint": "tsc --noEmit",
  "test:shikimori": "tsx scripts/test-shikimori-rate.ts",
  "ai:bridge": "tsx scripts/ai-bridge.ts"
}
```

## Безопасность и разработка

- Храните секреты только в локальном `.env`.
- Не отправляйте `.env`, SQLite, ключи, токены и PAT в модель/репозиторий.
- Перед любым GitHub-изменением через bridge проверяйте diff и подтверждайте действия вручную.
- Не используйте автоматический push без подтверждения владельцем процесса.

## История

Последние изменения зафиксированы в [CHANGES.md](CHANGES.md).

Перед коммитом проверьте, что секреты и локальная база не попали в индекс:

```powershell
git status --short
git check-ignore -v .env local.db local.db-wal local.db-shm
```

Добавьте код и документацию:

```bash
git add .
git diff --cached --name-only
git diff --cached -- .env .env.example
```

В staged diff не должно быть реальных токенов. Затем создайте коммит и отправьте текущую ветку:

```bash
git commit -m "docs: add setup guide and protect local secrets"
git push -u origin master
```

Если GitHub-репозиторий использует `main`, выполните `git push -u origin main` вместо `master`.

## Безопасность

- Никогда не коммитьте `.env`, токены Telegram, Shikimori OAuth или AnimeLib Bearer-токен.
- Если токен уже попал в Git или был опубликован, немедленно отзовите и выпустите новый.
- Не публикуйте скриншоты DevTools с заголовком `Authorization` или Cookie.
- Не используйте production-токены в `.env.example`.
