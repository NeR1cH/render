#!/usr/bin/env python3
"""
migrate_animelib_to_shikimori.py

Извлекает данные закладок (bookmarks) пользователя AnimeLib из .har-архивов
(экспорт сетевых запросов браузера), группирует тайтлы по статусам и
сохраняет их в json-файлы, готовые для последующего импорта в Shikimori.

===========================================================================
ИСТОРИЯ ИСПРАВЛЕНИЙ КАРТЫ СТАТУСОВ (важно!)
===========================================================================
В первой версии этого скрипта STATUS_MAP_NUMERIC был построен по КОСВЕННЫМ
признакам (наличие/отсутствие прогресса просмотра, характер тайтлов),
потому что человекочитаемые названия статусов нигде не приходят в JSON —
AnimeLib рисует их на фронтенде по числу. Эта версия была ЧАСТИЧНО НЕВЕРНОЙ:

    было (догадка)              стало (подтверждено кликом по вкладке в UI)
    ---------------------------  --------------------------------------------
    22 -> Запланировано          22 -> Запланировано   (совпало)
    23 -> Просмотрено   [WRONG]  23 -> Брошено
    24 -> Смотрю        [WRONG]  24 -> Просмотрено
    25 -> Отложено      [WRONG]  25 -> Любимое
    26 -> Брошено       [WRONG]  26 -> Пересматриваю
    27 -> Пересматриваю [WRONG]  27 -> Отложено
    (21 вообще не встречался)    21 -> Смотрю

Подтверждение получено из новой пачки .har-файлов, где каждый файл назван
по вкладке, которую Никита реально открыл на сайте (смотрю.har, fate.har,
брошено.har и т.д.) — то есть карта ниже построена на прямом наблюдении
URL-параметра `status=N`, который сайт сам подставил при клике по вкладке
с этим названием, а не на анализе паттернов данных. Это финальный источник
истины для этого проекта.

===========================================================================
СТАТУСЫ vs КАСТОМНЫЕ СПИСКИ
===========================================================================
Коды 21-27 — это официальные встроенные статусы AnimeLib (аналог того, что
на MangaLib называется "Мои списки", но для аниме на пункты больше: там
есть ещё "Пересматриваю" и "Отложено").

Отдельно встречаются коды с большими случайными числами (2280926, 2643707)
— это ПОЛЬЗОВАТЕЛЬСКИЕ папки, которые Никита создал сам:
  - 2280926 ("fate.har") — 21 тайтл, вся франшиза Fate.
  - 2643707 ("хент.har") — 3 тайтла одного 18+ сериала.
Они не являются "статусом просмотра" в смысле Shikimori, поэтому
обрабатываются отдельно (см. CUSTOM_LISTS) и по умолчанию для миграции на
Shikimori трактуются как "completed" + тег с названием папки — так они не
теряются, но и не портят чистоту стандартных списков.
"Любимое" (id 25) — исключение: это НЕ кастомная папка с произвольным ID,
а официальный статус (как "Любимые" в getMyList() у MangaLib), поэтому он
идёт в стандартную карту, но т.к. в Shikimori нет отдельного списка
"избранное" (только статусы просмотра + отдельный флаг избранного), он тоже
маппится в "completed" + отдельный флаг favorite=True.
===========================================================================
"""

import argparse
import json
import os
import sys
from collections import defaultdict

BOOKMARKS_PATH_MARKER = "/api/bookmarks"

STATUS_MAP_NUMERIC = {
    21: {
        "slug": "watching", "label": "Смотрю",
        "shikimori_status": "watching", "extra_flag": None,
        "confirmed_via": "клик по вкладке «Смотрю» -> status=21",
    },
    22: {
        "slug": "planned", "label": "Запланировано",
        "shikimori_status": "planned", "extra_flag": None,
        "confirmed_via": "клик по вкладке «Запланировано» -> status=22",
    },
    23: {
        "slug": "dropped", "label": "Брошено",
        "shikimori_status": "dropped", "extra_flag": None,
        "confirmed_via": "клик по вкладке «Брошено» -> status=23",
    },
    24: {
        "slug": "completed", "label": "Просмотрено",
        "shikimori_status": "completed", "extra_flag": None,
        "confirmed_via": "клик по вкладке «Просмотрено» -> status=24",
    },
    25: {
        "slug": "favorites", "label": "Любимое",
        "shikimori_status": "completed", "extra_flag": "favorite",
        "confirmed_via": "клик по вкладке «Любимое» -> status=25",
    },
    26: {
        "slug": "rewatching", "label": "Пересматриваю",
        "shikimori_status": "rewatching", "extra_flag": None,
        "confirmed_via": "клик по вкладке «Пересматриваю» -> status=26 (0 тайтлов у Никиты)",
    },
    27: {
        "slug": "on_hold", "label": "Отложено",
        "shikimori_status": "on_hold", "extra_flag": None,
        "confirmed_via": "клик по вкладке «Отложено» -> status=27 (0 тайтлов у Никиты)",
    },
}

CUSTOM_LISTS = {
    2280926: {
        "slug": "custom_fate", "label": "FATE (пользовательский список)",
        "shikimori_status": "completed", "extra_flag": "tag:FATE",
    },
    2643707: {
        "slug": "custom_hentai", "label": "hent (пользовательский список)",
        "shikimori_status": "completed", "extra_flag": "tag:hentai",
    },
}


def iter_har_files(paths):
    files = []
    for p in paths:
        if os.path.isdir(p):
            for name in sorted(os.listdir(p)):
                full = os.path.join(p, name)
                if os.path.isfile(full):
                    files.append(full)
        else:
            files.append(p)
    return files


def looks_like_har(path):
    try:
        with open(path, encoding="utf-8") as fh:
            head = fh.read(4096)
        return '"log"' in head and '"entries"' in head
    except (UnicodeDecodeError, OSError):
        return False


def extract_bookmark_responses(har_paths):
    records_by_status = defaultdict(list)
    seen_media_ids_by_status = defaultdict(set)
    pagination_info = defaultdict(lambda: {"max_page_seen": 0, "incomplete": False})

    skipped = []
    for path in har_paths:
        if not looks_like_har(path):
            skipped.append(path)
            continue
        with open(path, encoding="utf-8") as fh:
            har = json.load(fh)

        for entry in har.get("log", {}).get("entries", []):
            request = entry.get("request", {})
            if request.get("method") != "GET":
                continue
            url = request.get("url", "")
            if BOOKMARKS_PATH_MARKER not in url:
                continue

            content = entry.get("response", {}).get("content", {})
            text = content.get("text")
            if not text:
                continue
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                continue

            data = payload.get("data", [])
            meta = payload.get("meta", {}) or {}
            links = payload.get("links", {}) or {}

            if not data:
                status_from_url = url.split("status=")[-1].split("&")[0]
                try:
                    status_from_url = int(status_from_url)
                except ValueError:
                    continue
                pagination_info[status_from_url]["max_page_seen"] = max(
                    pagination_info[status_from_url]["max_page_seen"],
                    meta.get("current_page", 1),
                )
                continue

            status = data[0].get("status")
            page = meta.get("current_page", 1)
            has_next = bool(meta.get("next_page_url")) or bool(links.get("next"))

            if page >= pagination_info[status]["max_page_seen"]:
                pagination_info[status]["incomplete"] = has_next
            pagination_info[status]["max_page_seen"] = max(
                pagination_info[status]["max_page_seen"], page
            )

            for item in data:
                media_id = item.get("media_id")
                if media_id in seen_media_ids_by_status[status]:
                    continue
                seen_media_ids_by_status[status].add(media_id)

                media = item.get("media") or {}
                records_by_status[status].append(
                    {
                        "bookmark_id": item.get("id"),
                        "media_id": media_id,
                        "status": status,
                        "progress": item.get("progress"),
                        "created_at": item.get("created_at"),
                        "updated_at": item.get("updated_at"),
                        "name": media.get("name"),
                        "rus_name": media.get("rus_name"),
                        "eng_name": media.get("eng_name"),
                        "slug_url": media.get("slug_url"),
                        "anilist_id": media.get("anilist_id"),
                    }
                )

    return records_by_status, pagination_info, skipped


def category_meta_for(status_code):
    if status_code in STATUS_MAP_NUMERIC:
        return STATUS_MAP_NUMERIC[status_code], False
    if status_code in CUSTOM_LISTS:
        return CUSTOM_LISTS[status_code], True
    return {
        "slug": f"unknown_{status_code}",
        "label": f"Неизвестный статус {status_code}",
        "shikimori_status": None,
        "extra_flag": None,
    }, True


def write_source_category_files(records_by_status, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for status_code, records in records_by_status.items():
        meta, is_custom = category_meta_for(status_code)
        filename = f"animelib_{meta['slug']}.json"
        path = os.path.join(out_dir, filename)
        payload = {
            "status_code": status_code,
            "label": meta["label"],
            "is_custom_list": is_custom,
            "count": len(records),
            "items": records,
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        written.append((status_code, meta["label"], path, len(records)))
    return written


def write_shikimori_ready_files(records_by_status, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    merged = defaultdict(list)

    for status_code, records in records_by_status.items():
        meta, is_custom = category_meta_for(status_code)
        target = meta.get("shikimori_status") or "unmapped"
        for rec in records:
            enriched = dict(rec)
            enriched["source_label"] = meta["label"]
            enriched["source_status_code"] = status_code
            enriched["extra_flag"] = meta.get("extra_flag")
            merged[target].append(enriched)

    written = []
    for target_status, records in merged.items():
        path = os.path.join(out_dir, f"shikimori_{target_status}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {"shikimori_status": target_status, "count": len(records), "items": records},
                f, ensure_ascii=False, indent=2,
            )
        written.append((target_status, path, len(records)))
    return written


def inspect(records_by_status, pagination_info):
    print("=" * 82)
    print("ИНСПЕКЦИЯ ЗАКЛАДОК ANIMELIB")
    print("=" * 82)

    total = 0
    rows = []
    for status_code in sorted(records_by_status.keys()):
        records = records_by_status[status_code]
        meta, is_custom = category_meta_for(status_code)
        count = len(records)
        total += count
        pag = pagination_info.get(status_code, {})
        incomplete = pag.get("incomplete", False)
        rows.append((status_code, meta["label"], count, is_custom, incomplete, meta.get("shikimori_status")))

    standard_rows = [r for r in rows if not r[3]]
    custom_rows = [r for r in rows if r[3]]

    print("\nСтандартные статусы AnimeLib (подтверждено кликом по вкладке в UI):")
    print(f"{'код':>4} | {'категория':<16} | {'кол-во':>7} | {'-> Shikimori':<12} | выгрузка")
    print("-" * 82)
    for status_code, label, count, is_custom, incomplete, shiki in standard_rows:
        status_str = "НЕПОЛНАЯ (есть след. стр.)" if incomplete else "полная"
        print(f"{status_code:>4} | {label:<16} | {count:>7} | {shiki or '-':<12} | {status_str}")

    if custom_rows:
        print("\nПользовательские списки (собственные папки, не стандартные статусы):")
        print(f"{'код':>9} | {'описание':<32} | {'кол-во':>7} | -> Shikimori")
        print("-" * 82)
        for status_code, label, count, is_custom, incomplete, shiki in custom_rows:
            print(f"{status_code:>9} | {label:<32} | {count:>7} | {shiki or '-'}")

    print("-" * 82)
    print(f"ИТОГО тайтлов извлечено: {total}")

    incomplete_codes = [r[0] for r in rows if r[4]]
    if incomplete_codes:
        print()
        print("⚠ ВНИМАНИЕ: для статусов " + ", ".join(str(c) for c in incomplete_codes)
              + " в переданных файлах всё ещё есть недосчитанные страницы")
        print("  (next_page_url=true на последней увиденной странице).")
    else:
        print("\n✓ Пагинация по всем найденным статусам выглядит завершённой "
              "(последняя увиденная страница каждой категории имеет next_page_url=false).")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("har_paths", nargs="+", help="Пути к .har файлам и/или директориям с ними")
    parser.add_argument("--out-dir", default="animelib_export",
                         help="Куда сохранять json по категориям AnimeLib (по умолчанию: ./animelib_export)")
    parser.add_argument("--shikimori-out-dir", default="shikimori_import",
                         help="Куда сохранять итоговые json, сгруппированные по статусу Shikimori "
                              "(по умолчанию: ./shikimori_import)")
    parser.add_argument("--inspect", action="store_true",
                         help="Показать сводку по количеству тайтлов в каждой категории")
    args = parser.parse_args()

    har_files = iter_har_files(args.har_paths)
    if not har_files:
        print("Не найдено ни одного файла по указанным путям.", file=sys.stderr)
        sys.exit(1)

    records_by_status, pagination_info, skipped = extract_bookmark_responses(har_files)

    if not records_by_status:
        print("Не удалось найти ни одного ответа /api/bookmarks в переданных файлах.", file=sys.stderr)
        sys.exit(1)

    written_source = write_source_category_files(records_by_status, args.out_dir)
    print(f"Сохранено файлов по категориям AnimeLib: {len(written_source)} в '{args.out_dir}':")
    for status_code, label, path, count in sorted(written_source, key=lambda r: r[0]):
        print(f"  [{status_code:>7}] {label:<32} -> {path} ({count} тайтлов)")

    written_shiki = write_shikimori_ready_files(records_by_status, args.shikimori_out_dir)
    print(f"\nСохранено файлов для импорта в Shikimori: {len(written_shiki)} в '{args.shikimori_out_dir}':")
    for target_status, path, count in sorted(written_shiki, key=lambda r: r[0]):
        print(f"  {target_status:<12} -> {path} ({count} тайтлов)")

    if skipped:
        print(f"\n(Пропущено {len(skipped)} файлов, не похожих на .har: {', '.join(skipped)})")

    if args.inspect:
        print()
        inspect(records_by_status, pagination_info)


if __name__ == "__main__":
    main()