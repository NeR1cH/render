# 📖 ПОЛНЫЙ ОТЧЁТ ОБ ИЗМЕНЕНИЯХ И РУКОВОДСТВО К ПРОЕКТУ
**Anime Tracker Hub (v2.0)** — Персональный автономный трекер аниме (AnimeLib ↔ Shikimori ↔ Telegram)

---

## 🎯 Что было сделано (Глобальный рефакторинг)

Ранее проект задумывался на основе тяжеловесного стека: **n8n**, **Docker Compose**, **PostgreSQL**, **Caddy** и скрипта миграции на **Python**. Это требовало сложной настройки контейнеров, проксирования портов и постоянного контроля баз данных.

В рамках выполненных работ проект был **полностью переписан на современный, легковесный, высокопроизводительный стек**:
* **Язык**: TypeScript (Node.js ES2022 / ESNext);
* **БД**: `better-sqlite3` (локальная SQLite БД в одном файле `local.db` без необходимости поднимать Postgres-сервер);
* **Telegram-бот**: `grammY` (современный, быстрый фреймворк с типизацией и инлайн-клавиатурами);
* **HTTP & Парсинг**: `axios` + `cheerio` (с двухуровневым фоллбеком при защите Cloudflare);
* **API**: Прямые GraphQL-запросы к Shikimori и REST API v2 (`user_rates`) с защитой от банов (`User-Agent`).

---

## 🧱 4 Архитектурных Блока (Детализация файлов)

### 1. Блок 1: Локальная база данных (`src/db/database.ts`)
Локальный файл `local.db` работает через синглтон с оптимизациями SQLite:
```typescript
dbInstance.pragma('journal_mode = WAL');
dbInstance.pragma('synchronous = NORMAL');
dbInstance.pragma('foreign_keys = ON');
```

Созданы 3 таблицы:
1. **`auth_tokens`**:
   * Поля: `service` (UNIQUE), `access_token`, `refresh_token`, `user_id`, `expires_at`, `updated_at`.
   * Назначение: безопасное хранение OAuth-токенов Shikimori с авто-обновлением перед истечением срока годности.
2. **`anime_match_cache`**:
   * Поля: `normalized_title` (UNIQUE INDEX), `shiki_id`, `shiki_title`, `score`, `matched_at`.
   * Назначение: моментальный кэш сопоставления названий AnimeLib ➔ ID Шикимори без повторных сетевых запросов.
3. **`animelib_sync`**:
   * Поля: `media_id` (UNIQUE INDEX), `title`, `rus_title`, `status`, `last_tracked_episode`, `preferred_voiceover`, `shiki_id`, `shiki_synced`, `last_checked_at`.
   * Назначение: локальный трекинг последней просмотренной серии и статуса («Смотрю», «Просмотрено»).

Готовый объект `dbService` содержит методы:
* `saveAuthTokens()`
* `getAuthTokens()`
* `getCachedMatch()` / `setCachedMatch()`
* `getAllSyncItems()` / `getSyncItemByMediaId()`
* `upsertSyncItem()`
* `updateTrackedEpisode()`
* `markShikiSynced()`

---

### 2. Блок 2: Сервис Shikimori GraphQL & REST v2 (`src/services/shikimori.ts`)
* **Безопасность**: передача обязательного заголовка `User-Agent: ANIME ASSISTANT v2.0 (contact: boykonik2@gmail.com)` для прохождения фильтров DDoS-GUARD.
* **Авто-обновление токенов**: метод `getValidAccessToken()` проверяет время жизни токена и, если осталось менее 5 минут, автоматически вызывает `refreshToken()`.
* **GraphQL запросы**:
  * `searchAnime(title, limit)` — поиск по названию с получением постеров, оценок, дат выхода серий и жанров.
  * `getTopAnime(limit, page)` — выборка лучших тайтлов по рейтингу (`order: ranked`).
  * `getOngoingAnime(limit, page)` — выборка онгоингов с таймстемпом следующей серии (`nextEpisodeAt`).
  * `getAnimeById(id)` — получение полной информации по ID.
* **Синхронизация статусов (REST API v2)**:
  * Метод `updateUserRate({ target_id, status: 'completed', ... })`:
    * Сначала выполняет `GET /api/v2/user_rates?user_id=...&target_id=...` для проверки текущей записи.
    * Если тайтл уже в списке пользователя — выполняет `PATCH /api/v2/user_rates/:id`.
    * Если тайтла ещё нет — выполняет `POST /api/v2/user_rates`.

---

### 3. Блок 3: Парсер AnimeLib (`src/services/animelib.ts`)
* **Авторизация**: поддержка работы по сессионной куке браузера `ANIMELIB_COOKIE`.
* **Проверка сессии**: метод `checkAuth()` валидирует куку через `/api/auth/me`.
* **Выгрузка закладок**: метод `getAllWatching()` постранично выгружает все активные тайтлы из раздела «Смотрю» через внутренний шлюз `api.lib.social`.
* **Мониторинг озвучек**: метод `getMediaEpisodes()` получает номер последней доступной серии и массив всех команд дубляжа (*AniLibria, Dream Cast, Дубляжная, Red Head Sound* и др.).
* **Cheerio Fallback**: если API-шлюз блокируется Cloudflare, подключается встроенный HTML-парсер страниц через `cheerio`.
* **Нормализация**: `normalizeTitle()` очищает названия от кавычек («», "", ''), знаков пунктуации и приводит к единому регистру для точного мэтчинга.

---

### 4. Блок 4: Telegram-бот и Планировщик (`src/bot/index.ts`)
* Реализован на фреймворке **`grammY`**.
* **Команды**:
  * `/start` — интерактивное приветствие и клавиатура быстрых действий.
  * `/check` — ручная проверка обновлений во всех тайтлах из списка «Смотрю».
  * `/watching` — список отслеживаемых аниме с текущим номером серии.
  * `/ongoings` — список горячих онгоингов сезона.
  * `/top` — топ-10 тайтлов по рейтингу Shikimori.
* **Карточки релизов**:
  ```
  🎬 Клинок, рассекающий демонов (Kimetsu no Yaiba)
  ⭐ 8.7 / 10
  🏷 Сёнен, Демоны, Экшен
  🔔 Новая серия: 8 (просмотрено: 7)
  🎙 Озвучка: AniLibria, Dream Cast (+еще 2)

  📖 Танджиро продолжает своё обучение...
  ```
* **Инлайн-клавиатура под карточкой**:
  * `[🌐 AnimeLib]` ➔ прямой переход к просмотру на AnimeLib.
  * `[📊 Shikimori]` ➔ страница тайтла на Shikimori.
  * `[📥 Скачать (RuTracker)]` ➔ готовая поисковая ссылка для скачивания торрента.
  * `[✅ В "Просмотрено"]` ➔ мгновенно переносит тайтл в `completed` на Шикимори.
* **Планировщик фоновых проверок (`startScheduler`)**:
  * Каждые 30 минут без участия пользователя проверяет обновления серий.
  * При обнаружении новой серии отправляет постер, карточку и кнопки в ваш Telegram-чат (`TELEGRAM_CHAT_ID`).

---

## 💻 Пошаговая инструкция: Как запустить локально

### 1. Как скачать проект
* **Вариант А (ZIP-архив)**:
  В правом верхнем углу интерфейса Google AI Studio нажмите `...` (меню) ➔ **Download ZIP**. Распакуйте архив в удобное место, например: `C:\Projects\anime-tracker`.
* **Вариант Б (Git)**:
  В терминале Windows PowerShell выполните:
  ```powershell
  git clone https://github.com/NeR1cH/render.git anime-tracker
  cd anime-tracker
  ```

### 2. Установка зависимостей через `pnpm`
В папке проекта выполните:
```powershell
pnpm install
```
*(Все зависимости зафиксированы в `package.json`).*

### 3. Создание и настройка `.env`
Скопируйте файл примера:
```powershell
Copy-Item .env.example .env
```
Откройте `.env` в VS Code или блокноте и заполните:
```ini
# 1. Telegram (токен от @BotFather, ID чата от @userinfobot)
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_CHAT_ID=123456789

# 2. AnimeLib кука сессии (скопируйте из браузера со страницы animelib.me)
# DevTools (F12) -> Application -> Cookies -> animelib.me -> скопируйте всю куку (или remember_web_...)
ANIMELIB_COOKIE=remember_web_59ba36addc2b2f9401580f014c7f58e4e0802934=...;

# 3. Shikimori API (создайте OAuth-приложение в настройках профиля Shikimori)
SHIKIMORI_CLIENT_ID=ваш_client_id
SHIKIMORI_CLIENT_SECRET=ваш_client_secret
SHIKIMORI_USER_ID=ваш_id_на_шикимори
SHIKIMORI_ACCESS_TOKEN=ваш_токен_доступа
```

### 4. Запуск бота
```powershell
pnpm bot
```
Вы увидите сообщение:
```text
🤖 Starting Telegram bot via grammY long polling...
⏱️ Scheduler initialized. Checking updates every 30 minutes.
✅ Telegram bot @YourBotName successfully started!
```

---

## 📋 Таблица соответствия команд

| Действие | Команда в боте | Что происходит под капотом |
| :--- | :--- | :--- |
| **Проверить серии** | `/check` | Сканирует AnimeLib ➔ сравнивает с SQLite ➔ находит новые серии ➔ шлёт карточки с озвучками |
| **Список просмотра** | `/watching` | Показывает текущие тайтлы и ваш прогресс |
| **Онгоинги сезона** | `/ongoings` | Выполняет GraphQL запрос к Shikimori с сортировкой по популярности |
| **Топ аниме** | `/top` | Возвращает десятку лучших тайтлов по рейтингу |
| **Пометить просмотренным** | Кнопка `✅ В "Просмотрено"` | Вызывает `shikimoriService.updateUserRate()` (PATCH/POST v2 API) и обновляет SQLite |

---

## 🛡️ Безопасность и хранение данных
* Никаких внешних серверов баз данных — вся информация о синхронизации хранится в защищённом локальном файле `local.db`.
* Ваши токены и пароли изолированы в `.env` и никогда не попадут в репозиторий.
* `User-Agent` гарантирует защиту от капчи и блокировок Shikimori.
