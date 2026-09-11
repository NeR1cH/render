# Anime Tracker Bot

Автономный Telegram-бот на TypeScript для отслеживания онгоингов на AnimeLib, синхронизации статусов и эпизодов с Shikimori и быстрого поиска раздач на RuTracker.

## Технологический стек

- Node.js 20+
- TypeScript и `tsx`
- `pnpm`
- Telegram Bot API через `grammY`
- HTTP-клиент `axios`
- SQLite через встроенный `node:sqlite`
- `cheerio` для HTML fallback AnimeLib

## Возможности

- Получение списка «Смотрю» из AnimeLib через `hapi.hentaicdn.org`.
- Отслеживание новых эпизодов и доступных озвучек.
- Поиск соответствий в Shikimori.
- Синхронизация отметки «Просмотрено» с Shikimori.
- Telegram-карточки с постерами, прогрессом, кнопками AnimeLib, Shikimori и RuTracker.
- Фоновая проверка серий каждые 30 минут.
- Локальный SQLite-кэш без внешнего сервера базы данных.

## Пошаговое развёртывание

### 1. Клонирование и установка

```bash
git clone https://github.com/NeR1cH/render.git
cd render
pnpm install
```

Если проект опубликован в другом репозитории, замените URL и имя каталога на свои.

### 2. Создание окружения

Скопируйте шаблон и заполните только локальный `.env`:

```bash
cp .env.example .env
```

В Windows PowerShell аналогичная команда:

```powershell
Copy-Item .env.example .env
```

Файл `.env` нельзя добавлять в Git. Шаблон `.env.example` содержит только безопасные примеры.

## Получение credentials

### Telegram Bot Token и Chat ID

1. Откройте [@BotFather](https://t.me/BotFather) в Telegram.
2. Выполните `/newbot`, задайте имя и username.
3. Скопируйте токен в `TELEGRAM_BOT_TOKEN`.
4. Напишите [@userinfobot](https://t.me/userinfobot), чтобы узнать числовой `TELEGRAM_CHAT_ID`.
5. Не запускайте два процесса бота одновременно: Telegram вернёт `409 Conflict` для второго `getUpdates`.

Пример:

```ini
TELEGRAM_BOT_TOKEN="your_telegram_bot_token"
TELEGRAM_CHAT_ID="your_telegram_chat_id"
```

### AnimeLib: токен и ID пользователя

API закладок вызывается через рабочий шлюз:

```ini
ANIMELIB_API_URL="https://hapi.hentaicdn.org/api"
```

Чтобы получить Bearer-токен и ID:

1. Войдите на [animelib.org](https://animelib.org).
2. Нажмите `F12`.
3. Откройте **Application** в Chrome/Edge или **Storage** в Firefox.
4. Выберите **Local Storage** и домен AnimeLib.
5. Найдите ключ `auth`.
6. В объекте авторизации найдите `access_token`, обычно начинающийся с `eyJ`.
7. Найдите числовой `id` пользователя.
8. Запишите значения в `.env`:

```ini
ANIMELIB_USER_ID="9024582"
ANIMELIB_COOKIE="Bearer eyJ..."
```

Проверка в DevTools:

1. Откройте вкладку **Network**.
2. Отфильтруйте запросы по `bookmarks`.
3. Откройте запрос `GET` к `hapi.hentaicdn.org`.
4. Проверьте query-параметры `user_id` и `status=21`.
5. В заголовках должны присутствовать авторизация, `Origin`, `Referer` и `Site-Id: 5`.

AnimeLib использует статус `21` для списка «Смотрю». Не публикуйте токен, Cookie или экспорт Local Storage.

### 3. Shikimori: OAuth2 авторизация и User ID

Для синхронизации списков используется официальный OAuth2 протокол Shikimori.

#### А. Создание приложения

1. Авторизуйтесь на [shikimori.one](https://shikimori.one).
2. Перейдите в **Настройки** -> **OAuth-приложения**: [shikimori.one/oauth/applications](https://shikimori.one/oauth/applications).
3. Нажмите **«Создать приложение»**:
   - **Название:** `Anime Tracker Bot`
   - **Redirect URI:** `urn:ietf:wg:oauth:2.0:oob`
   - **Области видимости (Scopes):** отметьте `user_rates` и `comments`.
   - **Конфиденциальное:** галочка должна быть установлена.
   - Нажмите **«Создать»** внизу страницы.
4. Скопируйте сгенерированные `Client ID` и `Client Secret`.

#### Б. Получение токенов через браузер и curl

1. Сформируйте ссылку для получения одноразового кода, подставив свой `Client ID`:

```text
https://shikimori.one/oauth/authorize?client_id=ВАШ_CLIENT_ID&redirect_uri=urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob&response_type=code&scope=user_rates+comments
```

2. Откройте ссылку в браузере, нажмите **«Разрешить»** и скопируйте отобразившийся одноразовый код (`code`).
3. Сразу обменяйте код на токены. Код действует однократно:

```bash
curl -L -X POST "https://shikimori.one/oauth/token" \
  -H "User-Agent: Anime Tracker Bot v2.0 (contact: your_email@example.com)" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&client_id=ВАШ_CLIENT_ID&client_secret=ВАШ_CLIENT_SECRET&code=ВАШ_КОД_ИЗ_БРАУЗЕРА&redirect_uri=urn:ietf:wg:oauth:2.0:oob"
```

4. В ответе придёт JSON:

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "token_type": "Bearer"
}
```

Внесите `access_token` и `refresh_token` в локальный `.env`.

#### Shikimori User ID

1. Откройте свой профиль на Shikimori.
2. Найдите числовой ID через API профиля или исходный код страницы (`Ctrl+U`, поиск `data-user-id`).
3. Запишите его:

```ini
SHIKIMORI_USER_ID="your_shikimori_numeric_id"
```

## LM Studio и Continue

Если вы используете LM Studio для локального ассистирования по кодовой базе через расширение Continue в VS Code, введите в строке чата `@codebase` и нажмите Enter, чтобы переиндексировать `src/` и README.

Чтобы локальная модель не получила приватные токены и базы данных, в корне проекта создан `.continueignore` со следующими исключениями:

```text
.env
.env.*
*.sqlite
*.db
dist/
node_modules/
```

## SQLite и миграции

При старте приложение автоматически создаёт `local.db` и необходимые таблицы. Для старой базы миграция добавляет колонку `custom_note` в `animelib_sync`.

Проверить схему можно так:

```bash
pnpm exec tsx -e "import { db } from './src/db/database.ts'; console.log(db.prepare('PRAGMA table_info(animelib_sync)').all())"
```

Не добавляйте `local.db`, `local.db-shm` или `local.db-wal` в Git.

## Проверка и запуск

Проверка TypeScript:

```bash
pnpm exec tsc --noEmit
```

Запуск Telegram-бота:

```bash
pnpm bot
```

Доступные npm-скрипты:

- `pnpm bot` — Telegram-бот.
- `pnpm server` — локальный Express-сервер.
- `pnpm dev` — Vite dev server.
- `pnpm build` — TypeScript build и Vite build.
- `pnpm lint` — проверка TypeScript.

После запуска используйте меню Telegram:

- **🔄 Проверить серии** — получить закладки и найти новые эпизоды.
- **📺 Мой список** — показать отслеживаемые тайтлы.
- **📅 Календарь** — посмотреть расписание релизов.
- **🎲 Что глянуть?** — получить рекомендацию.
- **⚙️ Настройки** — настроить озвучки и качество.

## Публикация на GitHub

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
