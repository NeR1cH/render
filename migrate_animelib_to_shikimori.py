#!/usr/bin/env python3
"""
migrate_animelib_to_shikimori.py

Пакетный перенос закладок (тайтлов и статусов просмотра) с AnimeLib на
Shikimori через официальный API Shikimori (OAuth2 + REST v1/v2).

AnimeLib отдаёт закладки по вкладкам (Смотрю/Просмотрено/Запланировано/...),
поэтому обычно у вас будет НЕСКОЛЬКО файлов экспорта — по одному на категорию.
Скрипт принимает их все сразу через повторяемый --input:

    python migrate_animelib_to_shikimori.py \
        --input watching.json completed.json planned.json dropped.json \
        --dry-run

Если передан только один файл (или флаг --input не указан вовсе), работает
как раньше — с animelib_export.json по умолчанию.

Рекомендуемый порядок запуска:

    (На Windows cmd.exe маска *.json сама не раскроется в список файлов —
     перечисляйте файлы явно, как в примере выше. В PowerShell можно так:
     --input (Get-ChildItem *.json).Name В bash/zsh маска сработает как есть.)

    1. python migrate_animelib_to_shikimori.py --input watching.json completed.json ... --inspect
       -> смотрим реальную структуру каждого файла, включая список
          уникальных значений статуса — сразу видно, если какой-то код
          статуса ещё не замаплен в STATUS_MAP / STATUS_MAP_NUMERIC ниже.

    2. python migrate_animelib_to_shikimori.py --input watching.json completed.json ... --dry-run
       -> проверяем, как тайтлы и статусы сопоставятся с Shikimori,
          НИЧЕГО не отправляя на сервер. Смотрим errors.txt.

    3. python migrate_animelib_to_shikimori.py --input watching.json completed.json ...
       -> реальный перенос. Скрипт идемпотентен: его можно прерывать
          и перезапускать, уже перенесённые записи не дублируются
          (см. .migration_progress.json).

Перед первым запуском задайте переменные окружения (см. README.md):
    export SHIKIMORI_CLIENT_ID="..."
    export SHIKIMORI_CLIENT_SECRET="..."
"""

from __future__ import annotations

import argparse
import dataclasses
import difflib
import json
import logging
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Iterable

import requests

# ---------------------------------------------------------------------------
# КОНФИГУРАЦИЯ — здесь почти всё, что может потребоваться подправить руками
# ---------------------------------------------------------------------------

SHIKIMORI_BASE = "https://shikimori.io"

# Shikimori банит IP за пустой/дефолтный/неуникальный User-Agent. Мало того,
# что имя должно совпадать с тем, что вы указали при регистрации приложения
# на shikimori.io/oauth/applications — стандартные заголовки вида
# "AppName/1.0" массово встречаются у десятков чужих скриптов и банятся
# автоматически. Добавьте в скобках контакт (e-mail или Telegram-юзернейм),
# ЗАМЕНИВ плейсхолдер ниже на свои реальные данные:
USER_AGENT = "ANIME ASSISTANT v2.0 (contact: your-email@example.com | @your_telegram)"

# Официальный лимит Shikimori — около 90 запросов/мин и 5/сек. Берём с запасом.
MIN_REQUEST_INTERVAL = 0.8  # секунд между запросами -> ~75 запросов/мин
MAX_RETRIES = 5

TOKEN_FILE = Path(".shikimori_token.json")
CREDENTIALS_FILE = Path(".shikimori_credentials.json")
MATCH_CACHE_FILE = Path(".shiki_match_cache.json")
PROGRESS_FILE = Path(".migration_progress.json")
ERRORS_FILE = Path("errors.txt")

# Статусы на стороне Shikimori (GET /api/constants/user_rate):
#   planned, watching, rewatching, completed, on_hold, dropped
STATUS_MAP: dict[str, str] = {
    "смотрю": "watching",
    "смотрит": "watching",
    "watching": "watching",
    "в планах": "planned",
    "запланировано": "planned",
    "буду смотреть": "planned",
    "planned": "planned",
    "план": "planned",
    "брошено": "dropped",
    "заброшено": "dropped",
    "dropped": "dropped",
    "просмотрено": "completed",
    "просмотрен": "completed",
    "завершено": "completed",
    "завершен": "completed",
    "completed": "completed",
    "отложено": "on_hold",
    "на паузе": "on_hold",
    "приостановлено": "on_hold",
    "on_hold": "on_hold",
    "пересматриваю": "rewatching",
    "rewatching": "rewatching",
}

# Если в вашем animelib_export.json статус — ЧИСЛО, а не текст (это станет
# видно после --inspect), допишите сюда соответствие, например:
#   STATUS_MAP_NUMERIC = {1: "watching", 2: "planned", 3: "completed", 4: "dropped"}
STATUS_MAP_NUMERIC: dict[int, str] = {
    21: "watching",
    22: "planned",
    23: "dropped",
    24: "completed",
    25: "completed",
    26: "rewatching",
    27: "on_hold",
    2280926: "completed",
    2643707: "completed",
}

# Точная структура ответа AnimeLib не документирована публично, поэтому
# парсер проверяет несколько правдоподобных вариантов ключей — как на
# верхнем уровне записи, так и внутри вложенного объекта тайтла (многие
# такие API оборачивают тайтл во вложенный объект вида {"anime": {...}}).
NESTED_TITLE_KEYS = ("anime", "manga", "item", "content", "title_obj")
TITLE_KEYS = ("rus_name", "russian", "name_ru", "title", "name", "eng_name")
STATUS_KEYS = ("status", "read_status", "user_status", "list_status")
EXTERNAL_ID_KEYS = ("shikimori_id", "shiki_id", "mal_id", "myanimelist_id", "mal")

AUTO_ACCEPT_THRESHOLD = 0.80  # авто-принять совпадение
AMBIGUOUS_THRESHOLD = 0.70  # ниже этого — считать "не найдено", не "неуверенно"

# Ручные правила для тайтлов, которые авто-поиску трудно сопоставить.
# Ключ — нормализованное название из AnimeLib, значение — объект с id и
# заголовком, который будет использоваться в Shikimori.
MANUAL_TITLE_OVERRIDES: dict[str, dict[str, Any]] = {
    # Пример:
    # "fate strange fake zoku hen": {"id": 55830, "name": "Судьба/Странная подделка"},
}


# ---------------------------------------------------------------------------
# Модели данных
# ---------------------------------------------------------------------------


@dataclasses.dataclass
class BookmarkEntry:
    """Одна запись из экспорта AnimeLib, приведённая к общему виду."""

    title: str
    status_raw: Any
    external_id: int | None
    raw: dict


@dataclasses.dataclass
class MatchResult:
    shiki_id: int
    matched_title: str
    score: float
    source: str  # "external_id" | "cache" | "search"


class ShikimoriAPIError(Exception):
    def __init__(self, message: str, status_code: int | None = None, payload: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


# ---------------------------------------------------------------------------
# OAuth2 (Authorization Code, redirect_uri = urn:ietf:wg:oauth:2.0:oob)
# ---------------------------------------------------------------------------


class ShikimoriAuth:
    def __init__(self, client_id: str, client_secret: str, session: requests.Session):
        self.client_id = client_id
        self.client_secret = client_secret
        self.session = session

    def authorize_url(self, scope: str = "user_rates") -> str:
        return (
            f"{SHIKIMORI_BASE}/oauth/authorize"
            f"?client_id={self.client_id}"
            "&redirect_uri=urn:ietf:wg:oauth:2.0:oob"
            "&response_type=code"
            f"&scope={scope}"
        )

    def _token_request(self, payload: dict) -> dict:
        # Добавляем стандартные заголовки, чтобы DDoS-GUARD не паниковал.
        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Host": "shikimori.one",
        }
        resp = self.session.post(
            f"{SHIKIMORI_BASE}/oauth/token",
            data=payload,
            headers=headers,
            timeout=15,
        )
        if resp.status_code >= 400:
            raise ShikimoriAPIError(
                f"Не удалось получить токен: {resp.status_code} {resp.text}", resp.status_code
            )
        data = resp.json()
        data["obtained_at"] = time.time()
        return data

    def exchange_code(self, code: str) -> dict:
        return self._token_request(
            {
                "grant_type": "authorization_code",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "code": code,
                "redirect_uri": "urn:ietf:wg:oauth:2.0:oob",
            }
        )

    def refresh(self, refresh_token: str) -> dict:
        return self._token_request(
            {
                "grant_type": "refresh_token",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "refresh_token": refresh_token,
            }
        )

    def load_or_authorize(self) -> dict:
        if TOKEN_FILE.exists():
            token = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
            expires_at = token.get("obtained_at", 0) + token.get("expires_in", 0)
            if expires_at - time.time() > 120:
                return token
            logging.info("Токен истёк, обновляю через refresh_token...")
            try:
                token = self.refresh(token["refresh_token"])
                self._save_token(token)
                return token
            except ShikimoriAPIError:
                logging.warning("Не удалось обновить токен — нужна повторная авторизация.")

        print("\nОткройте эту ссылку в браузере, войдите и разрешите доступ приложению:")
        print(self.authorize_url())
        code = input("Вставьте полученный код авторизации сюда: ").strip()
        token = self.exchange_code(code)
        self._save_token(token)
        return token

    @staticmethod
    def _save_token(token: dict) -> None:
        TOKEN_FILE.write_text(json.dumps(token, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            os.chmod(TOKEN_FILE, 0o600)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Ограничение скорости запросов + клиент Shikimori
# ---------------------------------------------------------------------------


# Компактный GraphQL-запрос: забираем только id/name/russian вместо тяжёлого
# REST-ответа /api/animes (там на каждый тайтл прилетают постеры, жанры,
# описание и т.д.). Порядок — "чем ближе тайтл, тем выше" нам не важен: мы
# всё равно прогоняем кандидатов через собственный fuzzy-matcher (best_match),
# поэтому явный order не задаём и полагаемся на server-side ranked по умолчанию.
# censored: false — не отфильтровываем 18+-тайтлы, чтобы не терять совпадения.
ANIME_SEARCH_QUERY = """
query SearchAnime($search: String, $limit: PositiveInt) {
  animes(search: $search, limit: $limit, censored: false) {
    id
    name
    russian
  }
}
"""


class RateLimiter:
    def __init__(self, min_interval: float):
        self.min_interval = min_interval
        self._last_call = 0.0

    def wait(self) -> None:
        elapsed = time.monotonic() - self._last_call
        remaining = self.min_interval - elapsed
        if remaining > 0:
            time.sleep(remaining)
        self._last_call = time.monotonic()


class ShikimoriClient:
    def __init__(self, access_token: str):
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": USER_AGENT,
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            }
        )
        self.limiter = RateLimiter(MIN_REQUEST_INTERVAL)
        self.user_id: int | None = None

    def _request(self, method: str, path: str, **kwargs) -> requests.Response:
        url = f"{SHIKIMORI_BASE}{path}"
        last_resp: requests.Response | None = None
        for attempt in range(1, MAX_RETRIES + 1):
            self.limiter.wait()
            try:
                resp = self.session.request(method, url, timeout=20, **kwargs)
            except requests.exceptions.RequestException as e:
                if attempt == MAX_RETRIES:
                    raise
                wait = min(2**attempt, 30)
                logging.warning("Ошибка сети: %s, повтор через %s с...", e, wait)
                time.sleep(wait)
                continue

            last_resp = resp
            if resp.status_code == 429:
                retry_after = float(resp.headers.get("Retry-After", 5))
                logging.warning("429 от Shikimori, жду %.1f с...", retry_after)
                time.sleep(retry_after)
                continue
            if resp.status_code >= 500:
                wait = min(2**attempt, 30)
                logging.warning("Ошибка сервера %s, повтор через %s с...", resp.status_code, wait)
                time.sleep(wait)
                continue
            return resp
        raise ShikimoriAPIError(
            f"Превышено число попыток для {method} {path}",
            last_resp.status_code if last_resp is not None else None,
        )

    def whoami(self) -> dict:
        resp = self._request("GET", "/api/users/whoami")
        if resp.status_code != 200:
            raise ShikimoriAPIError("Не удалось получить текущего пользователя", resp.status_code, resp.text)
        return resp.json()

    def search_anime(self, query: str, limit: int = 5) -> list[dict]:
        """Ищет тайтлы через GraphQL (POST /api/graphql), а не через тяжёлый
        REST-эндпоинт /api/animes. Тот же RateLimiter и та же логика ретраев
        из _request() применяются автоматически — это по-прежнему один HTTP-
        запрос на тайтл, но каждый ответ намного компактнее (id/name/russian
        вместо полного объекта тайтла с постерами, жанрами и описанием),
        что снижает нагрузку и на сеть, и на сериализацию на стороне Shikimori.
        """
        resp = self._request(
            "POST",
            "/api/graphql",
            json={"query": ANIME_SEARCH_QUERY, "variables": {"search": query, "limit": limit}},
        )
        if resp.status_code != 200:
            raise ShikimoriAPIError(f"Ошибка GraphQL-поиска «{query}»", resp.status_code, resp.text)

        body = resp.json()
        if body.get("errors"):
            # GraphQL-ошибки (например, невалидный запрос) Shikimori отдаёт
            # с HTTP 200 и массивом "errors" вместо кода ответа >= 400.
            raise ShikimoriAPIError(f"GraphQL-ошибка поиска «{query}»", resp.status_code, body["errors"])

        animes = (body.get("data") or {}).get("animes") or []
        # GraphQL-скаляр ID сериализуется как строка ("123"), а не число —
        # приводим к int, чтобы дальше по коду (MatchResult.shiki_id,
        # target_id в create_user_rate и т.д.) тип совпадал с тем, что был
        # раньше при REST-поиске.
        for anime in animes:
            anime["id"] = int(anime["id"])
        return animes

    def create_user_rate(self, target_id: int, status: str) -> dict:
        # GraphQL API Shikimori — фактически read-only (в схеме Mutation
        # содержит только служебный testField), поэтому создание записи в
        # списке пользователя по-прежнему делаем через REST v2, как и раньше.
        payload = {
            "user_rate": {
                "user_id": str(self.user_id),
                "target_id": str(target_id),
                "target_type": "Anime",
                "status": status,
            }
        }
        resp = self._request("POST", "/api/v2/user_rates", json=payload)
        if resp.status_code == 201:
            return resp.json()
        raise ShikimoriAPIError(
            f"Ошибка создания записи (target_id={target_id})", resp.status_code, resp.text
        )


# ---------------------------------------------------------------------------
# Парсинг экспорта AnimeLib (структура не документирована — парсим гибко)
# ---------------------------------------------------------------------------


def _first_present(d: dict, keys: Iterable[str]) -> Any:
    for k in keys:
        if k in d and d[k] not in (None, ""):
            return d[k]
    return None


def _iter_candidate_dicts(value: Any) -> Iterable[dict]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _iter_candidate_dicts(child)
    elif isinstance(value, list):
        for item in value:
            yield from _iter_candidate_dicts(item)


def _extract_title_object(entry: dict) -> dict:
    for key in NESTED_TITLE_KEYS:
        nested = entry.get(key)
        if isinstance(nested, dict):
            return nested
    return entry


def _unwrap_list(raw: Any) -> list:
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        for key in ("data", "items", "bookmarks", "result", "results"):
            if isinstance(raw.get(key), list):
                return raw[key]
    raise ValueError(
        "Не нашёл список закладок в animelib_export.json. Откройте файл, "
        "посмотрите, под каким ключом лежит массив записей, и добавьте его "
        "в _unwrap_list() (или запустите скрипт с --inspect)."
    )


def parse_animelib_export(path: Path) -> list[BookmarkEntry]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    items = _unwrap_list(raw)

    entries: list[BookmarkEntry] = []
    for item in items:
        if not isinstance(item, dict):
            continue

        title = None
        status_raw = None
        ext_id = None
        for container in _iter_candidate_dicts(item):
            if title is None:
                title = _first_present(container, TITLE_KEYS)
            if status_raw is None:
                status_raw = _first_present(container, STATUS_KEYS)
            if ext_id is None:
                ext_id = _first_present(container, EXTERNAL_ID_KEYS)
            if title is not None and status_raw is not None and ext_id is not None:
                break

        if title is None:
            title = _first_present(item, TITLE_KEYS)
        if status_raw is None:
            status_raw = _first_present(item, STATUS_KEYS)
        if ext_id is None:
            ext_id = _first_present(item, EXTERNAL_ID_KEYS)

        try:
            ext_id = int(ext_id) if ext_id is not None else None
        except (TypeError, ValueError):
            ext_id = None

        entries.append(
            BookmarkEntry(
                title=str(title) if title else "<без названия>",
                status_raw=status_raw,
                external_id=ext_id,
                raw=item,
            )
        )

    return entries


def inspect_export(path: Path, n: int = 3) -> None:
    """Печатает структуру первых записей — чтобы подобрать TITLE_KEYS/STATUS_KEYS
    под конкретный формат вашего экспорта до первого обращения к Shikimori."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    items = _unwrap_list(raw)
    print(f"Всего записей: {len(items)}")
    statuses = set()
    for item in items:
        if isinstance(item, dict):
            for container in _iter_candidate_dicts(item):
                val = _first_present(container, STATUS_KEYS)
                if val is not None:
                    statuses.add(val)
                    break
    print(f"Уникальные значения статуса в файле: {sorted(statuses, key=str)}")
    unmapped = [s for s in statuses if map_status(s) is None]
    if unmapped:
        print(
            f"⚠️  Не сопоставлены с Shikimori (добавьте в STATUS_MAP / "
            f"STATUS_MAP_NUMERIC): {unmapped}"
        )
    print()
    for i, item in enumerate(items[:n], 1):
        print(f"--- Запись {i} ---")
        print(json.dumps(item, ensure_ascii=False, indent=2)[:1500])
        print()


# ---------------------------------------------------------------------------
# Сопоставление статусов и тайтлов
# ---------------------------------------------------------------------------


def normalize_title(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"[^\w\s]", "", s, flags=re.UNICODE)
    s = re.sub(r"\s+", " ", s)
    return s


def simplify_title_for_search(title: str) -> str:
    title = title.strip()
    title = re.sub(r"\s*\(\d{4}\)$", "", title)
    title = re.sub(r"\s+[IVX]+$", "", title, flags=re.IGNORECASE)
    title = re.sub(r"\s+сезон$", "", title, flags=re.IGNORECASE)
    title = re.sub(r"\s+\d+$", "", title)
    return title.strip()


def get_manual_override(title: str) -> dict[str, Any] | None:
    return MANUAL_TITLE_OVERRIDES.get(normalize_title(title))


def map_status(status_raw: Any) -> str | None:
    if status_raw is None or isinstance(status_raw, bool):
        return None
    if isinstance(status_raw, (int, float)):
        return STATUS_MAP_NUMERIC.get(int(status_raw))
    text = str(status_raw).strip()
    if text.isdigit():
        return STATUS_MAP_NUMERIC.get(int(text))
    return STATUS_MAP.get(normalize_title(text))


def best_match(query_title: str, candidates: list[dict]) -> tuple[dict, float] | None:
    if not candidates:
        return None
    norm_query = normalize_title(query_title)
    best: tuple[dict, float] | None = None
    for cand in candidates:
        for field in ("russian", "name"):
            value = cand.get(field)
            if not value:
                continue
            score = difflib.SequenceMatcher(None, norm_query, normalize_title(value)).ratio()
            if best is None or score > best[1]:
                best = (cand, score)
    return best


def match_anime(
    entry: BookmarkEntry, client: ShikimoriClient, cache: dict
) -> tuple[MatchResult | None, str | None]:
    """Возвращает (результат, None) при успехе или (None, причина) при неудаче."""
    if entry.external_id:
        return MatchResult(entry.external_id, entry.title, 1.0, "external_id"), None

    override = get_manual_override(entry.title)
    if override is not None:
        return MatchResult(override["id"], override.get("name", entry.title), 1.0, "manual"), None

    norm = normalize_title(entry.title)
    if norm in cache:
        cached = cache[norm]
        return MatchResult(cached["id"], cached["name"], cached["score"], "cache"), None

    search_query = simplify_title_for_search(entry.title)
    candidates = client.search_anime(search_query)
    match = best_match(entry.title, candidates)
    if match is None and search_query != entry.title:
        candidates = client.search_anime(entry.title)
        match = best_match(entry.title, candidates)

    if match is None:
        return None, "не найдено на Shikimori"

    cand, score = match
    matched_title = cand.get("russian") or cand.get("name") or entry.title
    if score >= AUTO_ACCEPT_THRESHOLD:
        result = MatchResult(cand["id"], matched_title, score, "search")
        cache[norm] = {"id": result.shiki_id, "name": result.matched_title, "score": score}
        return result, None
    if score >= AMBIGUOUS_THRESHOLD:
        names = ", ".join(f"{c.get('russian') or c.get('name')} (id={c['id']})" for c in candidates[:5])
        return None, f"неуверенное совпадение (score={score:.2f}): {names}"
    return None, "нет уверенного совпадения на Shikimori"


# ---------------------------------------------------------------------------
# Кэш сопоставлений и прогресс переноса (идемпотентность повторных запусков)
# ---------------------------------------------------------------------------


def load_json(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            logging.warning("Не удалось прочитать %s, начинаю с чистого состояния.", path)
    return default


def save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Точка входа
# ---------------------------------------------------------------------------


def load_credentials() -> tuple[str, str]:
    client_id = (os.environ.get("SHIKIMORI_CLIENT_ID") or "").strip()
    client_secret = (os.environ.get("SHIKIMORI_CLIENT_SECRET") or "").strip()
    if client_id and client_secret:
        return client_id, client_secret

    if CREDENTIALS_FILE.exists():
        try:
            creds = json.loads(CREDENTIALS_FILE.read_text(encoding="utf-8"))
            client_id = (creds.get("client_id") or "").strip()
            client_secret = (creds.get("client_secret") or "").strip()
            if client_id and client_secret:
                return client_id, client_secret
        except json.JSONDecodeError:
            logging.warning("Не удалось прочитать %s, игнорирую.", CREDENTIALS_FILE)

    sys.exit(
        "Задайте переменные окружения SHIKIMORI_CLIENT_ID и SHIKIMORI_CLIENT_SECRET "
        f"(получить на {SHIKIMORI_BASE}/oauth/applications), либо создайте файл "
        f"{CREDENTIALS_FILE} с полями client_id и client_secret."
    )


def run(input_paths: list[Path], dry_run: bool, limit: int | None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")

    client_id, client_secret = load_credentials()
    # Явно показываем, что реально ушло в запрос — частая причина "unknown
    # client" это невидимый пробел/перенос строки, случайно попавший в .env.
    masked = client_id[:4] + "…" + client_id[-4:] if len(client_id) > 8 else client_id
    logging.info(
        "SHIKIMORI_BASE=%s  client_id=%s (длина %d символов)", SHIKIMORI_BASE, masked, len(client_id)
    )

    entries: list[BookmarkEntry] = []
    for path in input_paths:
        file_entries = parse_animelib_export(path)
        logging.info("  %s: %d записей", path.name, len(file_entries))
        entries.extend(file_entries)
    if limit:
        entries = entries[:limit]
    logging.info("Загружено %d записей всего из %d файла(ов)", len(entries), len(input_paths))

    auth = ShikimoriAuth(client_id, client_secret, requests.Session())
    token = auth.load_or_authorize()

    client = ShikimoriClient(token["access_token"])
    me = client.whoami()
    client.user_id = me["id"]
    logging.info("Авторизован как %s (id=%s)", me.get("nickname"), me["id"])

    match_cache = load_json(MATCH_CACHE_FILE, {})
    progress = load_json(PROGRESS_FILE, {})  # {"<shiki_id>": true, ...}

    errors: list[str] = []
    created = skipped_done = skipped_error = 0

    try:
        for i, entry in enumerate(entries, 1):
            status = map_status(entry.status_raw)
            if status is None:
                errors.append(
                    f"[статус] «{entry.title}»: не удалось сопоставить статус "
                    f"(исходное значение: {entry.status_raw!r}). Добавьте его в STATUS_MAP."
                )
                skipped_error += 1
                continue

            try:
                match, problem = match_anime(entry, client, match_cache)
            except ShikimoriAPIError as e:
                errors.append(f"[поиск] «{entry.title}»: {e}")
                skipped_error += 1
                continue

            if match is None:
                errors.append(f"[совпадение] «{entry.title}»: {problem}")
                skipped_error += 1
                continue

            key = str(match.shiki_id)
            if progress.get(key):
                skipped_done += 1
                continue

            logging.info(
                "[%d/%d] %s -> %s (id=%s, статус=%s, source=%s, score=%.2f)",
                i,
                len(entries),
                entry.title,
                match.matched_title,
                match.shiki_id,
                status,
                match.source,
                match.score,
            )

            if dry_run:
                continue

            try:
                client.create_user_rate(match.shiki_id, status)
                progress[key] = True
                created += 1
            except ShikimoriAPIError as e:
                if e.status_code == 422:
                    errors.append(
                        f"[уже в списке?] «{entry.title}» (id={match.shiki_id}): {e.payload} "
                        "— чаще всего значит, что тайтл уже есть на Shikimori. Не отмечено "
                        "как перенесённое намеренно, чтобы не спрятать настоящую ошибку — "
                        "проверьте вручную."
                    )
                else:
                    errors.append(f"[запись] «{entry.title}» (id={match.shiki_id}): {e}")
                skipped_error += 1

            if i % 20 == 0:
                save_json(MATCH_CACHE_FILE, match_cache)
                save_json(PROGRESS_FILE, progress)
    finally:
        save_json(MATCH_CACHE_FILE, match_cache)
        save_json(PROGRESS_FILE, progress)
        if errors:
            ERRORS_FILE.write_text("\n".join(errors) + "\n", encoding="utf-8")

    mode = "ПРОБНЫЙ ЗАПУСК — ничего не отправлено" if dry_run else "перенос завершён"
    logging.info(
        "%s. Создано: %d, уже было: %d, с ошибками: %d. %s",
        mode,
        created,
        skipped_done,
        skipped_error,
        f"Подробности — в {ERRORS_FILE}" if errors else "Ошибок нет.",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Перенос закладок AnimeLib -> Shikimori")
    parser.add_argument(
        "--input",
        type=Path,
        nargs="+",
        default=[Path("animelib_export.json")],
        help="один или несколько файлов экспорта — по одному на каждую категорию "
        "AnimeLib (Смотрю/Просмотрено/Запланировано/...), все будут объединены",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="ничего не отправлять, только проверить сопоставление"
    )
    parser.add_argument(
        "--limit", type=int, default=None, help="обработать только первые N записей (суммарно по всем файлам)"
    )
    parser.add_argument(
        "--inspect",
        action="store_true",
        help="показать структуру первых записей экспорта(ов) и выйти (без обращения к Shikimori)",
    )
    args = parser.parse_args()

    missing = [p for p in args.input if not p.exists()]
    if missing:
        sys.exit("Файл(ы) не найден(ы): " + ", ".join(str(p) for p in missing))

    if args.inspect:
        for path in args.input:
            print(f"=== {path} ===")
            inspect_export(path)
        return

    run(args.input, args.dry_run, args.limit)


if __name__ == "__main__":
    main()