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

### Shikimori OAuth2

#### Создание OAuth-приложения

1. Войдите на [shikimori.one](https://shikimori.one).
2. Откройте настройки OAuth-приложений: [shikimori.one/oauth/applications](https://shikimori.one/oauth/applications).
3. Создайте приложение.
4. Укажите название, например `Anime Tracker Bot`.
5. Для redirect URI используйте значение, поддерживаемое текущей формой Shikimori. Для старого out-of-band flow это `urn:ietf:wg:oauth:2.0:oob`.
6. Скопируйте `Client ID` и `Client Secret` в `.env`.

```ini
SHIKIMORI_CLIENT_ID="your_shikimori_client_id"
SHIKIMORI_CLIENT_SECRET="your_shikimori_client_secret"
SHIKIMORI_USER_AGENT="Anime Tracker Hub (contact: your_email@example.com)"
```

#### Получение access и refresh token

Сформируйте URL авторизации, заменив `CLIENT_ID`:

```text
https://shikimori.one/oauth/authorize?client_id=CLIENT_ID&redirect_uri=urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob&response_type=code&scope=user_rates+comments
```

После подтверждения доступа обменяйте одноразовый `code` на токены:

```bash
curl -L -X POST "https://shikimori.one/oauth/token" \
  -H "User-Agent: Anime Tracker Hub (contact: your_email@example.com)" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&client_id=CLIENT_ID&client_secret=CLIENT_SECRET&code=AUTH_CODE&redirect_uri=urn:ietf:wg:oauth:2.0:oob"
```

Сохраните полученные значения локально:

```ini
SHIKIMORI_ACCESS_TOKEN="your_access_token"
SHIKIMORI_REFRESH_TOKEN="your_refresh_token"
```

Если Shikimori изменит или отключит OOB-flow, используйте redirect URI и flow, доступные в форме OAuth-приложения, и обновите команду обмена кода соответственно.

#### Shikimori User ID

1. Откройте свой профиль на Shikimori.
2. Найдите числовой ID через API профиля или исходный код страницы (`Ctrl+U`, поиск `data-user-id`).
3. Запишите его:

```ini
SHIKIMORI_USER_ID="your_shikimori_numeric_id"
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
