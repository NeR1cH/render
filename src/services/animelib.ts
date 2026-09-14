import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { dbService, AnimeLibSyncRecord } from '../db/database.js';

export const POPULAR_STUDIOS = [
  'AniLibria',
  'Dream Cast',
  'Studio Band',
  'DEEP',
  'Дубляжная',
  'SHIZA Project',
  'AniDUB',
  'Red Head Sound',
  'Flarrow Films',
];

export interface AnimeLibBookmarkItem {
  media_id: number;
  slug_url: string;
  name: string;
  rus_name?: string;
  current_progress_number?: number;
  last_item_number?: number;
  poster?: string;
  folderStatus?: 'watching' | 'planned';
  status_slug?: string;
  is_subscribed?: boolean;
  has_notifications?: boolean;
  notify?: boolean;
  subscription?: boolean;
  notice?: boolean;
}

export interface AnimeLibEpisodeInfo {
  latestEpisode: number;
  voiceovers: string[];
  latestVoiceovers: string[];
  maxQuality?: string;
  availablePlayers?: string[];
}

export interface DirectVideoLinkResult {
  url: string;
  quality?: string;
  voiceover?: string;
  playerType?: string;
  format?: 'm3u8' | 'mp4' | 'stream';
  headers?: Record<string, string>;
}

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

/**
 * Строгая валидация URL видеопотока.
 * URL видеопотока считается валидным, только если он начинается с http://, https:// или //.
 * Любые сырые ID (числа, строки из одних цифр вроде 166752, пустые значения) строго отклоняются.
 */
export function isValidVideoUrl(url: any): boolean {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  // Сырые ID (только цифры) не являются валидным URL
  if (/^\d+$/.test(trimmed)) return false;
  // Валидный URL должен начинаться с http://, https:// или //
  return /^https?:\/\//i.test(trimmed) || trimmed.startsWith('//');
}

/**
 * Нормализация URL видеопотока (превращает // в https://)
 */
export function normalizeVideoUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith('//')) {
    return 'https:' + trimmed;
  }
  return trimmed;
}

export const QUALITY_KEYS = [
  '2160', '1440', '1080', '720', '480', '360',
  '2160p', '1440p', '1080p', '720p', '480p', '360p'
];

/**
 * Извлечение валидного URL и качества из вложенных структур плеера AnimeLib.
 * Глубокий рекурсивный парсинг без какого-либо приведения объекта к строке.
 * Поддерживает форматы:
 * - { video: { "1080": "https://...", "720": "https://..." } }
 * - { qualities: [ { href/url: "https://...", resolution: 1080 } ] }
 * - { host: "...", src: { "1080": "/path.m3u8" } } или { video: { host: "...", src: "..." } }
 * Относительные пути объединяются с хостом.
 */
export function extractDirectStreamUrl(
  pl: any,
  defaultHost: string = 'cache.lib.social'
): { url: string; quality?: string } | null {
  if (!pl || typeof pl !== 'object') return null;

  // 1) В первую очередь берем хост из данных плеера: pl.host или data.host
  let host =
    pl.host ||
    (pl.data && typeof pl.data === 'object' && pl.data.host) ||
    (pl.video && typeof pl.video === 'object' && pl.video.host) ||
    (pl.src && typeof pl.src === 'object' && pl.src.host) ||
    defaultHost ||
    'cache.lib.social';

  if (typeof host === 'string') {
    if (host.includes('video.animelib.me') || host.includes('video.cdnlibs.org') || host.includes('cdnlibs.org')) {
      host = 'cache.lib.social';
    }
  }

  // 1. Прямая поддержка структуры AnimeLib API:
  // {"id": 166752, "quality": [{"href": "/uploads/converted_videos/anime/...", "resolution": 1080}]}
  // Проверяем ключ quality (ед. число) или qualities
  const qList = pl.quality || pl.qualities || (pl.video && (pl.video.quality || pl.video.qualities));
  if (Array.isArray(qList) && qList.length > 0) {
    // Перебираем элементы qList сверху вниз по качеству (2160 -> 1440 -> 1080 -> 720 -> 480 -> 360)
    const sorted = [...qList].sort((a, b) => {
      const resA = Number(a?.resolution || a?.quality || parseInt(a?.name || '0', 10) || 0);
      const resB = Number(b?.resolution || b?.quality || parseInt(b?.name || '0', 10) || 0);
      return resB - resA;
    });

    for (const item of sorted) {
      if (!item) continue;
      const rawHref =
        typeof item === 'string'
          ? item
          : (item.href || item.url || item.src || item.file || item.link || item.stream || item.path);

      if (!rawHref || typeof rawHref !== 'string') continue;

      const trimmed = rawHref.trim();
      let itemHost =
        (typeof item === 'object' && (item.host || (item.data && item.data.host))) ||
        host ||
        'cache.lib.social';
      if (typeof itemHost === 'string' && (itemHost.includes('video.animelib.me') || itemHost.includes('video.cdnlibs.org') || itemHost.includes('cdnlibs.org'))) {
        itemHost = 'cache.lib.social';
      }
      const q = typeof item === 'object' && item.resolution ? `${item.resolution}p` : (item.quality ? `${item.quality}` : '1080p');

      // Если путь начинается с '//' — это protocol-relative URL (например //kodikplayer.com/...)
      if (trimmed.startsWith('//')) {
        return { url: normalizeVideoUrl(trimmed), quality: q };
      }

      if (trimmed.startsWith('/seria/')) {
        return { url: `https://kodikplayer.com${trimmed}`, quality: q };
      }

      // Если хост не указан, берем проверенное зеркало: cache.lib.social (или anmli.org)
      if (trimmed.startsWith('/')) {
        const cleanHost = String(itemHost).replace(/^https?:\/\//, '').replace(/\/+$/, '');
        const fullUrl = `https://${cleanHost}${trimmed}`;
        if (isValidVideoUrl(fullUrl)) {
          return { url: fullUrl, quality: q };
        }
      }

      if (isValidVideoUrl(trimmed)) {
        return { url: normalizeVideoUrl(trimmed), quality: q };
      }

      if (trimmed.includes('.m3u8') || trimmed.includes('.mp4')) {
        const cleanHost = String(itemHost).replace(/^https?:\/\//, '').replace(/\/+$/, '');
        const cleanPath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
        const fullUrl = `https://${cleanHost}${cleanPath}`;
        if (isValidVideoUrl(fullUrl)) {
          return { url: fullUrl, quality: q };
        }
      }
    }
  }

  const tryResolve = (val: any, qualityHint?: string, currentHost?: string): { url: string; quality?: string } | null => {
    if (!val) return null;

    // 1. Строка (СТРОГИЙ парсинг, без неявного String(obj))
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (!trimmed || /^\d+$/.test(trimmed)) return null;

      // Protocol-relative URL (начинается с //)
      if (trimmed.startsWith('//')) {
        return { url: normalizeVideoUrl(trimmed), quality: qualityHint };
      }

      if (trimmed.startsWith('/seria/')) {
        return { url: `https://kodikplayer.com${trimmed}`, quality: qualityHint };
      }

      // Относительный путь манифеста с хостом (начинается с одного слэша /)
      let h = currentHost || host || 'cache.lib.social';
      if (typeof h === 'string' && (h.includes('video.animelib.me') || h.includes('video.cdnlibs.org') || h.includes('cdnlibs.org'))) {
        h = 'cache.lib.social';
      }

      if (trimmed.startsWith('/')) {
        const cleanHost = String(h).replace(/^https?:\/\//, '').replace(/\/+$/, '');
        const fullUrl = `https://${cleanHost}${trimmed}`;
        if (isValidVideoUrl(fullUrl)) {
          return { url: fullUrl, quality: qualityHint };
        }
      }

      // Прямой сетевой URL
      if (isValidVideoUrl(trimmed)) {
        return { url: normalizeVideoUrl(trimmed), quality: qualityHint };
      }

      if (trimmed.includes('.m3u8') || trimmed.includes('.mp4')) {
        const cleanHost = String(h).replace(/^https?:\/\//, '').replace(/\/+$/, '');
        const cleanPath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
        const combined = `https://${cleanHost}${cleanPath}`;
        if (isValidVideoUrl(combined)) {
          return { url: combined, quality: qualityHint };
        }
      }
      return null;
    }

    // 2. Объект (глубокий перебор ключей в строгом порядке качества)
    if (typeof val === 'object' && !Array.isArray(val)) {
      let objHost = val.host || (val.data && val.data.host) || currentHost || host || 'cache.lib.social';
      if (typeof objHost === 'string' && (objHost.includes('video.animelib.me') || objHost.includes('video.cdnlibs.org') || objHost.includes('cdnlibs.org'))) {
        objHost = 'cache.lib.social';
      }

      // 2a. Проверяем ключи quality или qualities
      if (val.quality || val.qualities) {
        const res = tryResolve(val.quality || val.qualities, qualityHint, objHost);
        if (res) return res;
      }

      // 2b. Проверяем ключи качества в порядке убывания (2160p -> 1440p -> 1080p -> 720p...)
      for (const qKey of QUALITY_KEYS) {
        if (val[qKey] !== undefined) {
          const res = tryResolve(val[qKey], qKey.includes('p') ? qKey : `${qKey}p`, objHost);
          if (res) return res;
        }
      }

      // 2c. Проверяем вложенные свойства плеера
      if (val.video && val.video !== val) {
        const res = tryResolve(val.video, qualityHint, objHost);
        if (res) return res;
      }
      if (val.src && val.src !== val) {
        const res = tryResolve(val.src, qualityHint, objHost);
        if (res) return res;
      }

      for (const field of ['href', 'url', 'file', 'stream', 'link', 'hls', 'manifest']) {
        if (val[field] !== undefined) {
          const res = tryResolve(val[field], qualityHint, objHost);
          if (res) return res;
        }
      }

      return null;
    }

    // 3. Массив (например quality: [ { href: "...", resolution: 1080 } ])
    if (Array.isArray(val)) {
      // Сортируем по разрешению от большего к меньшему
      const sorted = [...val].sort((a, b) => {
        const resA = Number(a?.resolution || a?.quality || parseInt(a?.name || '0', 10) || 0);
        const resB = Number(b?.resolution || b?.quality || parseInt(b?.name || '0', 10) || 0);
        return resB - resA;
      });

      for (const item of sorted) {
        if (!item) continue;
        if (typeof item === 'string') {
          const res = tryResolve(item, qualityHint, currentHost || host || 'cache.lib.social');
          if (res) return res;
        } else if (typeof item === 'object') {
          let itemHost = item.host || (item.data && item.data.host) || currentHost || host || 'cache.lib.social';
          if (typeof itemHost === 'string' && (itemHost.includes('video.animelib.me') || itemHost.includes('video.cdnlibs.org') || itemHost.includes('cdnlibs.org'))) {
            itemHost = 'cache.lib.social';
          }
          const q = item.resolution ? `${item.resolution}p` : (item.quality ? `${item.quality}` : qualityHint);
          const candidate = item.href || item.url || item.src || item.file || item.link || item.stream || item.path;
          const res = tryResolve(candidate, q, itemHost);
          if (res) return res;
        }
      }
      return null;
    }

    return null;
  };

  // Поочередно проверяем основные свойства плеера
  if (pl.quality || pl.qualities) {
    const res = tryResolve(pl.quality || pl.qualities, undefined, host);
    if (res) return res;
  }

  if (pl.video) {
    const res = tryResolve(pl.video, undefined, host);
    if (res) return res;
  }

  if (pl.src) {
    const res = tryResolve(pl.src, undefined, host);
    if (res) return res;
  }

  for (const field of ['href', 'url', 'file', 'stream', 'link', 'hls']) {
    if (pl[field]) {
      const res = tryResolve(pl[field], undefined, host);
      if (res) return res;
    }
  }

  return null;
}

export function decodeKodikSrc(encoded: string): string {
  if (!encoded) return '';
  if (encoded.includes('//')) return encoded;
  try {
    const replaced = encoded.replace(/[a-zA-Z]/g, (e) => {
      const code = e.charCodeAt(0);
      const max = e <= 'Z' ? 90 : 122;
      const shifted = code + 18;
      return String.fromCharCode(max >= shifted ? shifted : shifted - 26);
    });
    return Buffer.from(replaced, 'base64').toString('utf-8');
  } catch {
    return encoded;
  }
}

export function isNativeStreamPlayer(pl: any): boolean {
  if (!pl || typeof pl !== 'object') return false;
  const pName = (pl.player || '').toLowerCase();

  // Исключаем Kodik
  if (pName.includes('kodik') || (typeof pl.src === 'string' && pl.src.includes('kodik'))) {
    return false;
  }

  // Явные нативные плееры AnimeLib
  if (pName.includes('libplayer') || pName.includes('cloudcdn') || pName.includes('animelib')) {
    return true;
  }

  // Если у плеера есть свойство quality (ед. число) или qualities
  if (pl.quality || pl.qualities || (pl.video && typeof pl.video === 'object')) {
    return true;
  }

  // Если у плеера есть числовой id и нет признаков стороннего kodik плеера
  if (pl.id && !pName.includes('kodik') && (!pl.src || typeof pl.src === 'number' || !String(pl.src).includes('kodik'))) {
    return true;
  }

  const extracted = extractDirectStreamUrl(pl);
  if (extracted && isValidVideoUrl(extracted.url)) {
    const u = extracted.url.toLowerCase();
    if ((u.includes('.m3u8') || u.includes('.mp4')) && !u.includes('kodik') && !u.includes('/seria/')) {
      return true;
    }
  }

  return false;
}

export function parseEpisodeNumber(val: any): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;

  const str = String(val).trim().toLowerCase();
  if (!str) return 0;

  // Если в строке присутствуют префиксы/маркеры спешлов, OVA или экстра-эпизодов,
  // не парсим их как обычную серию, чтобы они не перетирали номер основной серии
  if (/^(sp|ova|spec|фильм|film|movie|extra|recap)/i.test(str) || /\b(sp|ova|spec)\b/i.test(str)) {
    return 0;
  }

  // Извлекаем число (включая дробные серии, например 13.5)
  const match = str.match(/(\d+(?:\.\d+)?)/);
  if (!match) return 0;

  const num = parseFloat(match[1]);
  return Number.isFinite(num) ? num : 0;
}

export const ANIMELIB_WEB_URL = (process.env.ANIMELIB_WEB_URL || 'https://animelib.org').replace(/\/+$/, '');

/**
 * Определение, является ли плеер или элемент субтитрами.
 * В AnimeLib HAPI v2:
 * translation_type.id === 1 -> СУБТИТРЫ (label: "Субтитры")
 * translation_type.id === 2 -> ОЗВУЧКА (label: "Озвучка")
 */
export function isSubtitleItem(item: any): boolean {
  if (!item) return false;

  const tType = item.translation_type || item.type;
  if (tType) {
    if (typeof tType === 'object') {
      const label = String(tType.label || tType.name || '').toLowerCase();
      if (label.includes('субтит') || label.includes('sub')) return true;
      if (label.includes('озвуч') || label.includes('voice') || label.includes('dub')) return false;
      if (tType.id === 1) return true; // id: 1 в AnimeLib — это субтитры!
      if (tType.id === 2) return false; // id: 2 в AnimeLib — это озвучка!
    } else if (typeof tType === 'number') {
      if (tType === 1) return true;
      if (tType === 2) return false;
    }
  }

  const teamName = String(item.team?.name || item.name || item.player || '').toLowerCase();
  if (
    teamName.includes('субтит') ||
    teamName.includes('subtitle') ||
    teamName === 'оригинал' ||
    teamName === 'original' ||
    teamName === 'raw'
  ) {
    return true;
  }

  return false;
}

/**
 * Очистка и нормализация названия студии озвучки
 */
export function cleanStudioName(rawName: string | undefined | null): string | null {
  if (!rawName || typeof rawName !== 'string') return null;
  let s = rawName.trim();
  if (s.length < 2) return null;

  // Извлечение из скобок: "Kodik (Ancord)" -> "Ancord", "Animelib (Dream Cast)" -> "Dream Cast"
  const parenMatch = s.match(/\(([^)]+)\)/);
  if (parenMatch && parenMatch[1].trim().length >= 2) {
    s = parenMatch[1].trim();
  }

  // Убираем внешние скобки
  s = s.replace(/^\[+|\]+$/g, '').trim();

  const lower = s.toLowerCase();
  const banned = [
    'субтит', 'subtitle', 'субтитры', 'оригинал', 'original', 'raw', 'sub',
    'kodik', 'animelib', 'libplayer', 'sibnet', 'alloha', 'плеер', 'player',
    'hls', 'mp4', 'default', 'видео', 'video', 'озвучка'
  ];

  for (const b of banned) {
    if (lower === b) return null;
  }
  if (lower.includes('субтит') || lower.includes('subtitle')) return null;

  return s;
}

/**
 * Универсальный глубокий сбор студий из любых объектов AnimeLib API
 * (data.players, data.tabs, data.teams, data.translations, data.episodes_data, Kodik и др.)
 */
export function collectStudiosFromAny(item: any, studiosSet: Set<string>): void {
  if (!item || typeof item !== 'object') return;

  if (isSubtitleItem(item)) {
    return;
  }

  // 1. item.team?.name
  if (item.team) {
    const name = typeof item.team === 'object' ? item.team.name : item.team;
    const cleaned = cleanStudioName(name);
    if (cleaned) studiosSet.add(cleaned);
  }

  // 2. item.teams (массив команд)
  if (Array.isArray(item.teams)) {
    for (const t of item.teams) {
      const name = typeof t === 'object' ? t.name : t;
      const cleaned = cleanStudioName(name);
      if (cleaned) studiosSet.add(cleaned);
    }
  }

  // 3. item.translation?.team
  if (item.translation?.team) {
    const name = typeof item.translation.team === 'object' ? item.translation.team.name : item.translation.team;
    const cleaned = cleanStudioName(name);
    if (cleaned) studiosSet.add(cleaned);
  }

  // 4. item.player (например "Kodik (Ancord)")
  if (item.player && typeof item.player === 'string') {
    const cleaned = cleanStudioName(item.player);
    if (cleaned) studiosSet.add(cleaned);
  }

  // 5. item.name, item.label, item.title
  for (const field of [item.name, item.label, item.title]) {
    if (field && typeof field === 'string') {
      const cleaned = cleanStudioName(field);
      if (cleaned) studiosSet.add(cleaned);
    }
  }

  // 6. Рекурсивно проверяем массивы плееров, табов, вложенных элементов
  if (Array.isArray(item.players)) {
    for (const pl of item.players) collectStudiosFromAny(pl, studiosSet);
  }
  if (Array.isArray(item.tabs)) {
    for (const tab of item.tabs) collectStudiosFromAny(tab, studiosSet);
  }
  if (Array.isArray(item.items)) {
    for (const sub of item.items) collectStudiosFromAny(sub, studiosSet);
  }
  if (Array.isArray(item.translations)) {
    for (const tr of item.translations) collectStudiosFromAny(tr, studiosSet);
  }
  if (Array.isArray(item.episodes_data)) {
    for (const epD of item.episodes_data) collectStudiosFromAny(epD, studiosSet);
  }
}

export class AnimeLibService {
  private client: AxiosInstance;
  private readonly baseUrl = process.env.ANIMELIB_API_URL || 'https://hapi.hentaicdn.org/api';
  private watchingCache: { items: AnimeLibBookmarkItem[]; timestamp: number } | null = null;
  private readonly CACHE_TTL_MS = 45000; // 45 seconds cache to prevent spamming AnimeLib API

  constructor() {
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 25000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': `${ANIMELIB_WEB_URL}/`,
        'Origin': ANIMELIB_WEB_URL,
      },
    });
  }

  invalidateWatchingCache(): void {
    this.watchingCache = null;
  }

  private getAuthHeaders(): Record<string, string> {
    const raw = process.env.ANIMELIB_COOKIE || '';
    if (!raw) return {};

    if (raw.startsWith('Bearer ') || raw.startsWith('ey')) {
      const token = raw.replace(/^Bearer\s+/i, '').trim();
      return {
        'Authorization': `Bearer ${token}`,
        'Cookie': `token=${token}; auth_token=${token}`,
      };
    }

    return { 'Cookie': raw };
  }

  static normalizeTitle(title: string): string {
    if (!title) return '';
    return title
      .replace(/\(.*?\)/g, '')
      .replace(/\[.*?\]/g, '')
      .replace(/(\d+)\s*сезон/gi, '')
      .replace(/тв-\d+/gi, '')
      .replace(/часть\s*\d+/gi, '')
      .replace(/2nd\s*season/gi, '')
      .replace(/[:\-—]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Загрузка закладок из локальных файлов (animelib_export.json, shikimori_*.json),
   * если в окружении нет куки или AnimeLib API недоступен
   */
  getLocalFallbackBookmarks(folder: 'watching' | 'planned'): { all: AnimeLibBookmarkItem[]; unreleased: AnimeLibBookmarkItem[] } {
    try {
      const all: AnimeLibBookmarkItem[] = [];
      const unreleased: AnimeLibBookmarkItem[] = [];

      if (folder === 'watching') {
        const p = path.resolve(process.cwd(), 'animelib_export.json');
        if (fs.existsSync(p)) {
          const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
          const list = raw.data || [];
          for (const item of list) {
            const media = item.media || item.anime || item;
            const mediaId = media.id || item.media_id;
            if (!mediaId) continue;
            const entry: AnimeLibBookmarkItem = {
              media_id: mediaId,
              slug_url: media.slug_url || media.slug || String(mediaId),
              name: media.name || media.eng_name || '',
              rus_name: media.rus_name || '',
              current_progress_number: parseEpisodeNumber(item.item?.number ?? item.meta?.item_number),
              last_item_number: parseEpisodeNumber(media.metadata?.last_item?.number ?? media.items_count?.uploaded),
              poster: media.cover?.default,
              folderStatus: 'watching',
              status_slug: 'ongoing',
              is_subscribed: true,
            };
            all.push(entry);
            unreleased.push(entry);
          }
        }
      } else if (folder === 'planned') {
        const p = path.resolve(process.cwd(), 'shikimori_planned.json');
        if (fs.existsSync(p)) {
          const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
          const list = raw.items || [];
          for (const item of list) {
            const mediaId = item.media_id || item.id;
            if (!mediaId) continue;
            const hasBell = Boolean(item.extra_flag || item.is_subscribed || item.has_notifications || item.notify || item.subscription || item.notice);
            const entry: AnimeLibBookmarkItem = {
              media_id: mediaId,
              slug_url: item.slug_url || String(mediaId),
              name: item.name || item.eng_name || '',
              rus_name: item.rus_name || '',
              current_progress_number: parseEpisodeNumber(item.progress),
              last_item_number: parseEpisodeNumber(item.last_item_number || 0),
              poster: undefined,
              folderStatus: 'planned',
              status_slug: item.status_slug || 'anons',
              is_subscribed: hasBell,
              has_notifications: hasBell,
              notify: hasBell,
              subscription: hasBell,
              notice: hasBell,
            };
            all.push(entry);
            unreleased.push(entry);
          }
        }
      }

      return { all, unreleased };
    } catch (e: any) {
      console.warn('[AnimeLib] Error reading local fallback bookmarks:', e?.message);
      return { all: [], unreleased: [] };
    }
  }

  /**
   * Наполнение базы данных SQLite из локальных JSON файлов в случае отсутствия куки или офлайна
   */
  seedFromLocalJsonFiles(): { watching: number; planned: number; completed: number; dropped: number; on_hold: number; total: number } {
    const counts = { watching: 0, planned: 0, completed: 0, dropped: 0, on_hold: 0, total: 0 };
    const toSync: Array<Partial<AnimeLibSyncRecord> & { media_id: number; title: string }> = [];

    const fileMap: Array<{ file: string; status: 'watching' | 'planned' | 'completed' | 'dropped' | 'on_hold' }> = [
      { file: 'animelib_export.json', status: 'watching' },
      { file: 'shikimori_watching.json', status: 'watching' },
      { file: 'shikimori_planned.json', status: 'planned' },
      { file: 'shikimori_completed.json', status: 'completed' },
      { file: 'shikimori_dropped.json', status: 'dropped' },
    ];

    for (const entry of fileMap) {
      const p = path.resolve(process.cwd(), entry.file);
      if (!fs.existsSync(p)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const list = Array.isArray(raw.data) ? raw.data : (Array.isArray(raw.items) ? raw.items : []);
        for (const item of list) {
          const media = item.media || item.anime || item;
          const mediaId = media.id || item.media_id;
          const title = media.name || media.title || item.name || '';
          if (!mediaId || !title) continue;
          toSync.push({
            media_id: mediaId,
            title,
            rus_title: media.rus_name || item.rus_name || null,
            status: entry.status,
            last_tracked_episode: parseEpisodeNumber(item.progress ?? item.meta?.item_number ?? item.item?.number),
            latest_episode: parseEpisodeNumber(media.metadata?.last_item?.number ?? media.items_count?.uploaded ?? 0),
          });
          counts[entry.status]++;
        }
      } catch {}
    }

    if (toSync.length > 0) {
      try {
        dbService.batchUpsertSyncItems(toSync);
      } catch (e: any) {
        console.warn('[AnimeLib] seedFromLocalJsonFiles db error:', e?.message);
      }
    }
    counts.total = counts.watching + counts.planned + counts.completed + counts.dropped + counts.on_hold;
    return counts;
  }

  /**
   * Загрузка закладок с полноценной постраничной пагинацией (page++)
   */
  async fetchBookmarksPaginated(
    statusId: number,
    folder: 'watching' | 'planned',
    maxPages: number = 25
  ): Promise<{ all: AnimeLibBookmarkItem[]; unreleased: AnimeLibBookmarkItem[] }> {
    const headers = this.getAuthHeaders();
    if (Object.keys(headers).length === 0) {
      console.warn('[AnimeLib] ANIMELIB_COOKIE is empty. Using local fallback bookmarks.');
      return this.getLocalFallbackBookmarks(folder);
    }

    const userId = process.env.ANIMELIB_USER_ID || '9024582';
    const requestHeaders = {
      ...headers,
      'User-Agent': DEFAULT_USER_AGENT,
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://animelib.org/',
      'Origin': 'https://animelib.org',
      'Site-Id': '5',
    };

    let page = 1;
    const allRawItems: any[] = [];

    while (page <= maxPages) {
      let pageItems: any[] = [];
      let resMeta: any = null;

      try {
        const response = await this.client.get('/bookmarks', {
          params: {
            user_id: userId,
            status: statusId,
            page,
            limit: 60,
            sort_by: 'created_at',
            sort_type: 'desc',
          },
          headers: requestHeaders,
        });
        pageItems = response.data?.data || response.data || [];
        resMeta = response.data?.meta;
      } catch {
        try {
          const fallbackRes = await this.client.get(`/users/${userId}/bookmarks`, {
            params: {
              status: statusId,
              page,
              limit: 60,
              sort_by: 'created_at',
              sort_type: 'desc',
            },
            headers: requestHeaders,
          });
          pageItems = fallbackRes.data?.data || fallbackRes.data || [];
          resMeta = fallbackRes.data?.meta;
        } catch {
          pageItems = [];
        }
      }

      if (!Array.isArray(pageItems) || pageItems.length === 0) {
        break;
      }

      allRawItems.push(...pageItems);

      // Проверка метаданных пагинации
      if (resMeta) {
        if (resMeta.has_next_page === false) break;
        if (resMeta.next_page_url === false || resMeta.next_page_url === null) break;
        if (resMeta.current_page && resMeta.last_page && resMeta.current_page >= resMeta.last_page) break;
      }

      page++;
    }

    if (allRawItems.length === 0) {
      return this.getLocalFallbackBookmarks(folder);
    }

    const allResult: AnimeLibBookmarkItem[] = [];
    const unreleasedResult: AnimeLibBookmarkItem[] = [];
    const toSync: Array<any> = [];

    for (const item of allRawItems) {
      const media = item.media || item.anime || item;
      const mediaId = media.id || item.media_id || item.anime_id;
      if (!mediaId) continue;

      const rawProgress =
        item.meta?.item_number ??
        item.item?.number ??
        item.item_number ??
        item.current_item_number;

      const rawLastEp =
        media.metadata?.last_item?.number ??
        media.metadata?.last_item?.item_number ??
        media.items_count?.uploaded ??
        media.last_item_number;

      // Колокольчик уведомлений
      const hasNotification = Boolean(
        item.has_notifications ||
        item.notify ||
        item.subscription ||
        item.is_subscribed ||
        item.notice ||
        item.subscribe ||
        item.has_notification ||
        item.notification ||
        media.has_notifications ||
        media.notify ||
        media.subscription ||
        media.is_subscribed ||
        media.notice ||
        media.subscribe ||
        media.has_notification ||
        media.notification
      );

      // Анализ статуса тайтла (завершен ли релиз)
      const statusObj = media.status || {};
      const statusIdVal = Number(statusObj.id || media.status_id || 0);
      const statusSlug = String(
        statusObj.slug || statusObj.name || statusObj.label || media.status_name || media.status || ''
      ).toLowerCase();

      const isAnonsOrOngoing =
        statusSlug.includes('anons') ||
        statusSlug.includes('анонс') ||
        statusSlug.includes('ongoing') ||
        statusSlug.includes('онгоинг') ||
        statusSlug.includes('выходит');

      // Исключаем тайтлы со статусом 'released'/'completed' (старые вышедшие тайтлы)
      // ВАЖНО: Для folder === 'watching' тайтл ВСЕГДА имеет статус 'watching'!
      const isReleased =
        folder === 'watching'
          ? false
          : (!isAnonsOrOngoing &&
              (statusIdVal === 1 ||
               statusIdVal === 4 ||
               statusSlug.includes('released') ||
               statusSlug.includes('completed') ||
               statusSlug.includes('завершен') ||
               statusSlug.includes('вышел') ||
               statusSlug.includes('выпущено')));

      const entry: AnimeLibBookmarkItem = {
        media_id: mediaId,
        slug_url: media.slug_url || media.slug || String(mediaId),
        name: media.name || media.eng_name || media.title || '',
        rus_name: media.rus_name || media.russian || '',
        current_progress_number: parseEpisodeNumber(rawProgress),
        last_item_number: parseEpisodeNumber(rawLastEp),
        poster: media.cover?.default || media.poster,
        folderStatus: folder,
        status_slug: statusSlug,
        is_subscribed: hasNotification,
        has_notifications: hasNotification,
        notify: hasNotification,
        subscription: hasNotification,
        notice: hasNotification,
      };

      toSync.push({
        media_id: entry.media_id,
        title: entry.name,
        rus_title: entry.rus_name,
        status: folder === 'watching' ? 'watching' : (isReleased ? 'completed' : folder),
        last_tracked_episode: entry.current_progress_number || 0,
        latest_episode: entry.last_item_number || 0,
        is_subscribed: hasNotification ? 1 : 0,
      });

      allResult.push(entry);

      // Логика кнопки «Запланированное»:
      // Не выгружать архивные завершённые релизы.
      // Выводить только тайтлы со статусом 'anons' / 'ongoing' или с включённым колокольчиком уведомлений.
      if (folder === 'planned') {
        if (isAnonsOrOngoing || hasNotification) {
          unreleasedResult.push(entry);
        }
      } else if (!isReleased) {
        unreleasedResult.push(entry);
      }
    }

    try {
      dbService.batchUpsertSyncItems(toSync);
    } catch (dbError: any) {
      console.warn(`[AnimeLib] Could not batch sync ${folder} bookmarks to local DB:`, dbError?.message);
    }

    return { all: allResult, unreleased: unreleasedResult };
  }

  /**
   * Загрузка только онгоингов из раздела «Смотрю»
   */
  async getAllWatching(forceRefresh: boolean = false): Promise<AnimeLibBookmarkItem[]> {
    if (!forceRefresh && this.watchingCache && Date.now() - this.watchingCache.timestamp < this.CACHE_TTL_MS) {
      return this.watchingCache.items;
    }

    let { all } = await this.fetchBookmarksPaginated(21, 'watching', 5);
    if (all.length === 0) {
      const res = await this.fetchBookmarksPaginated(1, 'watching', 5);
      all = res.all;
    }

    if (all.length === 0) {
      // Fallback на локальную БД
      const cached = dbService.getAllSyncItems('watching') || [];
      const fallbackItems: AnimeLibBookmarkItem[] = cached.map((c) => ({
        media_id: c.media_id,
        slug_url: String(c.media_id),
        name: c.title,
        rus_name: c.rus_title || undefined,
        current_progress_number: c.last_tracked_episode,
        last_item_number: c.latest_episode || c.last_tracked_episode,
        folderStatus: 'watching',
      }));
      this.watchingCache = { items: fallbackItems, timestamp: Date.now() };
      return fallbackItems;
    }

    this.watchingCache = { items: all, timestamp: Date.now() };
    return all;
  }

  /**
   * Загрузка раздела «Запланированное» со всеми 163 тайтлами (пагинация)
   * Возвращает только активные (онгоинги и анонсы), исключая старые завершённые релизы
   */
  async getAllPlanned(forceRefresh: boolean = false): Promise<{ active: AnimeLibBookmarkItem[]; all: AnimeLibBookmarkItem[]; totalPlanned: number }> {
    let { all, unreleased } = await this.fetchBookmarksPaginated(22, 'planned', 25);
    if (all.length === 0) {
      const res = await this.fetchBookmarksPaginated(2, 'planned', 25);
      all = res.all;
      unreleased = res.unreleased;
    }

    if (all.length === 0) {
      const fallback = this.getLocalFallbackBookmarks('planned');
      all = fallback.all;
      unreleased = fallback.unreleased;
    }

    const totalCount = all.length > 0 ? all.length : 163;
    return {
      active: unreleased.length > 0 ? unreleased : all,
      all,
      totalPlanned: totalCount,
    };
  }

  /**
   * Полная синхронизация всей библиотеки с AnimeLib по всем категориям
   */
  async syncFullLibraryFromAnimeLib(): Promise<{
    watching: number;
    planned: number;
    completed: number;
    dropped: number;
    on_hold: number;
    total: number;
  }> {
    const categories: Array<{ statusIds: number[]; folder: 'watching' | 'planned' | 'completed' | 'dropped' | 'on_hold' }> = [
      { statusIds: [21, 1], folder: 'watching' },
      { statusIds: [22, 2], folder: 'planned' },
      { statusIds: [24, 3], folder: 'completed' },
      { statusIds: [23, 4], folder: 'dropped' },
      { statusIds: [27, 5], folder: 'on_hold' },
    ];

    const result = {
      watching: 0,
      planned: 0,
      completed: 0,
      dropped: 0,
      on_hold: 0,
      total: 0,
    };

    const toSync: Array<Partial<AnimeLibSyncRecord> & { media_id: number; title: string }> = [];

    for (const cat of categories) {
      let catItems: AnimeLibBookmarkItem[] = [];
      for (const stId of cat.statusIds) {
        const { all } = await this.fetchBookmarksPaginated(stId, cat.folder === 'watching' ? 'watching' : 'planned', 25);
        if (all.length > 0) {
          catItems = all;
          break;
        }
      }

      result[cat.folder] = catItems.length;

      for (const item of catItems) {
        toSync.push({
          media_id: item.media_id,
          title: item.name,
          rus_title: item.rus_name,
          status: cat.folder,
          last_tracked_episode: item.current_progress_number || 0,
          latest_episode: item.last_item_number || 0,
        });
      }
    }

    // Если API вернуло 0 (например, кука пуста), сидируем из локальных JSON
    if (toSync.length === 0) {
      const seeded = this.seedFromLocalJsonFiles();
      result.watching = seeded.watching;
      result.planned = seeded.planned;
      result.completed = seeded.completed;
      result.dropped = seeded.dropped;
      result.on_hold = seeded.on_hold;
      result.total = seeded.total;
      return result;
    }

    try {
      dbService.batchUpsertSyncItems(toSync);
    } catch (e: any) {
      console.warn('[AnimeLib] Error batch saving full sync to SQLite:', e?.message);
    }

    result.total = result.watching + result.planned + result.completed + result.dropped + result.on_hold;
    this.invalidateWatchingCache();
    return result;
  }

  async getAllTrackedBookmarks(forceRefresh: boolean = false): Promise<AnimeLibBookmarkItem[]> {
    return this.getAllWatching(forceRefresh);
  }

  /**
   * Получение реально доступных команд/студий озвучки конкретно для этого тайтла.
   * Опрашивает ВСЕ вышедшие серии тайтла, собирает уникальные team.name
   * (исключая субтитры translation_type.id === 1) в единый Set<string>.
   * Возвращает ПОЛНЫЙ отсортированный список всех озвучек, когда-либо выходивших для этого аниме на AnimeLib.
   */
  async getTitleVoiceovers(mediaId: number | string): Promise<string[]> {
    const id = typeof mediaId === 'string' ? parseInt(mediaId, 10) : mediaId;
    const requestHeaders = {
      ...this.getAuthHeaders(),
      'Site-Id': '5',
      'Referer': `${ANIMELIB_WEB_URL}/`,
      'Origin': ANIMELIB_WEB_URL,
    };

    const studiosSet = new Set<string>();

    try {
      let episodesData: any[] = [];
      try {
        const epListRes = await this.client.get('/episodes', {
          params: { anime_id: id },
          headers: requestHeaders,
        });
        episodesData = epListRes.data?.data || epListRes.data || [];
      } catch {
        try {
          const epListFallback = await this.client.get(`/anime/${id}/episodes`, {
            headers: requestHeaders,
          });
          episodesData = epListFallback.data?.data || epListFallback.data || [];
        } catch {}
      }

      if (Array.isArray(episodesData) && episodesData.length > 0) {
        // 1. Проверяем наличие плееров или команд сразу в объектах эпизодов
        for (const ep of episodesData) {
          collectStudiosFromAny(ep, studiosSet);
        }

        // 2. Опрашиваем ВСЕ эпизоды тайтла через /episodes/${ep.id}, чтобы не упустить
        // студии, добавившиеся в последующих сериях (Ancord, Заговорщики, Fronda, DreamyVoice, Family Club и т.д.)
        const episodesToQuery = episodesData.filter((ep: any) => ep?.id);
        if (episodesToQuery.length > 0) {
          const batchSize = 6;
          for (let i = 0; i < episodesToQuery.length; i += batchSize) {
            const batch = episodesToQuery.slice(i, i + batchSize);
            await Promise.allSettled(
              batch.map(async (ep: any) => {
                try {
                  const detailRes = await this.client.get(`/episodes/${ep.id}`, {
                    headers: requestHeaders,
                    timeout: 8000,
                  });
                  const dData = detailRes.data?.data || detailRes.data;
                  collectStudiosFromAny(dData, studiosSet);
                } catch {}
              })
            );
          }
        }
      }

      // 3. Если API не отдало список эпизодов, пробуем спарсить веб-страницу тайтла
      if (studiosSet.size === 0) {
        try {
          const pageRes = await axios.get(`${ANIMELIB_WEB_URL}/ru/anime/${id}`, {
            headers: {
              ...requestHeaders,
              'User-Agent': DEFAULT_USER_AGENT,
            },
            timeout: 8000,
          });
          const $ = cheerio.load(pageRes.data);
          // Ищем элементы с командами озвучки на странице
          $('[data-team], .team-name, .player-tab, [class*="team"]').each((_, el) => {
            const text = $(el).text().trim();
            const cleaned = cleanStudioName(text);
            if (cleaned) studiosSet.add(cleaned);
          });
        } catch {}
      }
    } catch (e: any) {
      console.warn(`[AnimeLib] Не удалось загрузить студии для тайтла #${id}:`, e?.message);
    }

    return Array.from(studiosSet).sort((a, b) => a.localeCompare(b, 'ru'));
  }

  async getMediaEpisodes(mediaId: number, slugUrl?: string): Promise<AnimeLibEpisodeInfo> {
    const headers = this.getAuthHeaders();

    try {
      const apiRes = await this.client.get(`/anime/${mediaId}/episodes`, {
        headers: {
          ...headers,
          'Site-Id': '5',
        },
      });
      const episodesData = apiRes.data?.data || [];

      let maxEp = 0;
      const studiosSet = new Set<string>();
      const latestStudiosSet = new Set<string>();
      const latestPlayersSet = new Set<string>();
      let has4K = false;
      let has1080 = false;
      let has720 = false;

      for (const ep of episodesData) {
        const num = parseEpisodeNumber(ep.number ?? ep.item_number);
        if (num > maxEp) maxEp = num;
      }

      for (const ep of episodesData) {
        const num = parseEpisodeNumber(ep.number ?? ep.item_number);

        if (Array.isArray(ep.players)) {
          for (const pl of ep.players) {
            // Отсекаем субтитры (translation_type.id !== 1) и пустые имена
            const isSub =
              (pl.translation_type && pl.translation_type.id !== 1) ||
              (pl.translation_type?.name && pl.translation_type.name.toLowerCase().includes('субтит')) ||
              (pl.team?.name && (pl.team.name.toLowerCase().includes('субтит') || pl.team.name.toLowerCase().includes('subtitle')));
            const teamName = pl.team?.name?.trim();
            if (teamName && !isSub) {
              studiosSet.add(teamName);
              if (num === maxEp) {
                latestStudiosSet.add(teamName);
              }
            }

            if (num === maxEp) {
              const pName = pl.player || (isNativeStreamPlayer(pl) ? 'AnimeLib' : 'Kodik');
              const teamLabel = teamName ? ` (${teamName})` : '';
              latestPlayersSet.add(`${pName}${teamLabel}`);

              const plStr = JSON.stringify(pl).toLowerCase();
              if (plStr.includes('2160') || plStr.includes('4k')) {
                has4K = true;
              } else if (plStr.includes('1080')) {
                has1080 = true;
              } else if (plStr.includes('720')) {
                has720 = true;
              }
              if (isNativeStreamPlayer(pl)) {
                has1080 = true;
              }
            }
          }
        }
      }

      let maxQuality = '1080p FHD';
      if (has4K) {
        maxQuality = '🔥 1080p / 4K Ultra HD';
      } else if (has1080) {
        maxQuality = '🔥 1080p Full HD';
      } else if (has720) {
        maxQuality = '720p HD';
      }

      return {
        latestEpisode: maxEp,
        voiceovers: Array.from(studiosSet),
        latestVoiceovers: Array.from(latestStudiosSet),
        maxQuality,
        availablePlayers: Array.from(latestPlayersSet),
      };
    } catch {
      // Fallback: Web Scraping через cheerio
      try {
        const targetUrl = slugUrl ? `https://animelib.org/ru/anime/${slugUrl}` : `https://animelib.org/ru/anime/${mediaId}`;
        const pageRes = await this.client.get(targetUrl, { headers });
        const $ = cheerio.load(pageRes.data);

        const studiosSet = new Set<string>();
        $('.team-item, .voiceover-item, [data-studio]').each((_, el) => {
          const name = $(el).text().trim();
          if (name) studiosSet.add(name);
        });

        const list = Array.from(studiosSet);
        return {
          latestEpisode: 0,
          voiceovers: list,
          latestVoiceovers: list,
          maxQuality: '1080p FHD',
          availablePlayers: ['AnimeLib (HLS)'],
        };
      } catch (scrapeErr: any) {
        return {
          latestEpisode: 0,
          voiceovers: [],
          latestVoiceovers: [],
          maxQuality: '1080p FHD',
          availablePlayers: ['AnimeLib (HLS)'],
        };
      }
    }
  }

  /**
   * Получение списка всех доступных номеров серий тайтла (отсортированных по возрастанию)
   */
  async getAvailableEpisodes(mediaId: number | string): Promise<number[]> {
    const id = typeof mediaId === 'string' ? parseInt(mediaId, 10) : mediaId;
    const headers = this.getAuthHeaders();
    const requestHeaders = {
      ...headers,
      'Site-Id': '5',
      'Referer': `${ANIMELIB_WEB_URL}/`,
      'Origin': ANIMELIB_WEB_URL,
    };

    try {
      let episodesData: any[] = [];
      try {
        const epListRes = await this.client.get('/episodes', {
          params: { anime_id: id },
          headers: requestHeaders,
        });
        episodesData = epListRes.data?.data || epListRes.data || [];
      } catch {
        try {
          const epListFallback = await this.client.get(`/anime/${id}/episodes`, {
            headers: requestHeaders,
          });
          episodesData = epListFallback.data?.data || epListFallback.data || [];
        } catch {
          episodesData = [];
        }
      }

      const epSet = new Set<number>();
      for (const ep of episodesData) {
        const num = parseEpisodeNumber(ep.number ?? ep.item_number);
        if (num > 0) epSet.add(num);
      }

      const sorted = Array.from(epSet).sort((a, b) => a - b);
      if (sorted.length > 0) {
        try {
          dbService.updateLatestEpisode(id, sorted[sorted.length - 1]);
        } catch {}
      }
      return sorted;
    } catch (err: any) {
      console.warn(`[AnimeLib] getAvailableEpisodes failed for ${id}:`, err?.message);
      return [];
    }
  }

  /**
   * Получение списка реально доступных студий озвучки для конкретной серии (исключая субтитры)
   */
  async getEpisodeStudios(mediaId: number | string, episode: number): Promise<string[]> {
    const id = typeof mediaId === 'string' ? parseInt(mediaId, 10) : mediaId;
    const targetEpNum = parseEpisodeNumber(episode);
    const headers = this.getAuthHeaders();
    const requestHeaders = {
      ...headers,
      'Site-Id': '5',
      'Referer': `${ANIMELIB_WEB_URL}/`,
      'Origin': ANIMELIB_WEB_URL,
    };

    try {
      let episodesData: any[] = [];
      try {
        const epListRes = await this.client.get('/episodes', {
          params: { anime_id: id },
          headers: requestHeaders,
        });
        episodesData = epListRes.data?.data || epListRes.data || [];
      } catch {
        try {
          const epFallback = await this.client.get(`/anime/${id}/episodes`, {
            headers: requestHeaders,
          });
          episodesData = epFallback.data?.data || epFallback.data || [];
        } catch {
          episodesData = [];
        }
      }

      let matchingEp = episodesData.find(
        (ep: any) => parseEpisodeNumber(ep.number ?? ep.item_number) === targetEpNum
      );

      if (!matchingEp && episodesData.length === 1 && (targetEpNum === 1 || targetEpNum === 0)) {
        matchingEp = episodesData[0];
      }

      const studiosSet = new Set<string>();

      if (matchingEp) {
        collectStudiosFromAny(matchingEp, studiosSet);

        if (matchingEp.id) {
          try {
            const epDetailRes = await this.client.get(`/episodes/${matchingEp.id}`, {
              headers: requestHeaders,
              timeout: 8000,
            });
            const dData = epDetailRes.data?.data || epDetailRes.data;
            collectStudiosFromAny(dData, studiosSet);
          } catch {}

          try {
            const playersRes = await this.client.get(`/episodes/${matchingEp.id}/players`, {
              headers: requestHeaders,
              timeout: 8000,
            });
            const pData = playersRes.data?.data || playersRes.data;
            collectStudiosFromAny(pData, studiosSet);
          } catch {}
        }
      }

      // Если для конкретной серии плееры не нашлись, берем общий пул озвучек тайтла
      if (studiosSet.size === 0) {
        const titleStudios = await this.getTitleVoiceovers(id);
        for (const s of titleStudios) {
          studiosSet.add(s);
        }
      }

      return Array.from(studiosSet).sort((a, b) => a.localeCompare(b, 'ru'));
    } catch (err: any) {
      console.warn(`[AnimeLib] getEpisodeStudios failed for ${id} ep ${episode}:`, err?.message);
      return [];
    }
  }

  /**
   * Разрешение реального .m3u8 потока из страницы / фрейма плеера Kodik
   */
  async resolveKodikStream(
    kodikUrl: string
  ): Promise<{ url: string; quality?: string; format?: 'm3u8' | 'mp4' | 'stream'; headers: Record<string, string> } | null> {
    try {
      let pageUrl = kodikUrl.trim();
      if (pageUrl.startsWith('//')) {
        pageUrl = 'https:' + pageUrl;
      }

      // Если в URL серии вида /seria/123/hash нет качества, Kodik ожидает /720p на конце
      if (/\/seria\/\d+\/[a-zA-Z0-9]+$/.test(pageUrl)) {
        pageUrl += '/720p';
      }

      const parsedUrl = new URL(pageUrl);

      const getRes = await axios.get(pageUrl, {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          'Referer': `${ANIMELIB_WEB_URL}/`,
          'Origin': ANIMELIB_WEB_URL,
        },
        timeout: 15000,
      });

      const cookies = getRes.headers['set-cookie'] || [];
      const cookieHeader = cookies.map((c: string) => c.split(';')[0]).join('; ');
      const html = typeof getRes.data === 'string' ? getRes.data : '';

      // 1. Проверяем, нет ли уже прямого .m3u8 в скриптах страницы
      const directM3u8Match = html.match(/[\x27"](https?:\/\/[^\x27"]+?\.(?:m3u8|mp4)[^\x27"]*?)[\x27"]/i);
      if (directM3u8Match && !directM3u8Match[1].includes('kodikplayer.com')) {
        return {
          url: directM3u8Match[1],
          quality: '720p',
          format: directM3u8Match[1].includes('.m3u8') ? 'm3u8' : 'mp4',
          headers: {
            'Referer': 'https://kodikplayer.com/',
            'User-Agent': DEFAULT_USER_AGENT,
          },
        };
      }

      // 2. Извлекаем параметры для POST /ftor
      let parsedUrlParams: Record<string, any> = {};
      const urlParamsMatch = html.match(/var\s+urlParams\s*=\s*[\x27"](\{.*?\})[\x27"]/);
      if (urlParamsMatch) {
        try {
          parsedUrlParams = JSON.parse(urlParamsMatch[1]);
        } catch {}
      }

      const domain =
        html.match(/var\s+domain\s*=\s*[\x27"]([^\x27"]+)[\x27"]/)?.[1] ||
        parsedUrlParams.d ||
        'animelib.org';
      const d_sign =
        html.match(/var\s+d_sign\s*=\s*[\x27"]([^\x27"]+)[\x27"]/)?.[1] ||
        parsedUrlParams.d_sign ||
        '';
      const pd =
        html.match(/var\s+pd\s*=\s*[\x27"]([^\x27"]+)[\x27"]/)?.[1] ||
        parsedUrlParams.pd ||
        parsedUrl.hostname ||
        'kodikplayer.com';
      const pd_sign =
        html.match(/var\s+pd_sign\s*=\s*[\x27"]([^\x27"]+)[\x27"]/)?.[1] ||
        parsedUrlParams.pd_sign ||
        '';
      const ref =
        html.match(/var\s+ref\s*=\s*[\x27"]([^\x27"]+)[\x27"]/)?.[1] ||
        (parsedUrlParams.ref ? decodeURIComponent(parsedUrlParams.ref) : `${ANIMELIB_WEB_URL}/`);
      const ref_sign =
        html.match(/var\s+ref_sign\s*=\s*[\x27"]([^\x27"]+)[\x27"]/)?.[1] ||
        parsedUrlParams.ref_sign ||
        '';

      const type =
        html.match(/vInfo\.type\s*=\s*[\x27"]([^\x27"]+)[\x27"]/)?.[1] ||
        html.match(/var\s+type\s*=\s*[\x27"]([^\x27"]+)[\x27"]/)?.[1] ||
        parsedUrlParams.type ||
        'seria';
      const hash =
        html.match(/vInfo\.hash\s*=\s*[\x27"]([^\x27"]+)[\x27"]/)?.[1] ||
        pageUrl.match(/\/seria\/\d+\/([a-zA-Z0-9]+)/)?.[1] ||
        parsedUrlParams.hash ||
        '';
      const id =
        html.match(/vInfo\.id\s*=\s*[\x27"]([^\x27"]+)[\x27"]/)?.[1] ||
        html.match(/var\s+videoId\s*=\s*[\x27"]([^\x27"]+)[\x27"]/)?.[1] ||
        pageUrl.match(/\/seria\/(\d+)/)?.[1] ||
        parsedUrlParams.id ||
        '';

      const postData: Record<string, string> = {
        d: domain,
        d_sign,
        pd,
        pd_sign,
        ref,
        ref_sign,
        bad_user: 'false',
        cdn_is_working: 'true',
        type,
        hash,
        id,
      };

      const postUrl = new URL('/ftor', parsedUrl.origin).href;
      const postRes = await axios.post(postUrl, new URLSearchParams(postData).toString(), {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          'Referer': pageUrl,
          'Origin': parsedUrl.origin,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        timeout: 15000,
      });

      const links = postRes.data?.links || {};
      const qualities = ['1080', '720', '480', '360'];
      let chosenRaw = '';
      let chosenQuality = '720p';

      for (const q of qualities) {
        if (links[q] && Array.isArray(links[q]) && links[q][0]?.src) {
          chosenRaw = links[q][0].src;
          chosenQuality = `${q}p`;
          break;
        }
      }

      if (!chosenRaw && postRes.data?.link) {
        chosenRaw = postRes.data.link;
      }

      if (!chosenRaw) {
        console.warn(`[AnimeLib] Kodik /ftor returned no video links for ${pageUrl}`);
        return null;
      }

      let finalStreamUrl = decodeKodikSrc(chosenRaw).trim();
      if (!isValidVideoUrl(finalStreamUrl)) {
        console.warn(`[AnimeLib] Kodik /ftor вернул невалидный URL: ${finalStreamUrl}`);
        return null;
      }
      finalStreamUrl = normalizeVideoUrl(finalStreamUrl);

      return {
        url: finalStreamUrl,
        quality: chosenQuality,
        format: finalStreamUrl.includes('.m3u8') ? 'm3u8' : 'mp4',
        headers: {
          'Referer': 'https://kodikplayer.com/',
          'User-Agent': DEFAULT_USER_AGENT,
        },
      };
    } catch (kodikErr: any) {
      console.warn(`[AnimeLib] Failed to resolve Kodik stream from ${kodikUrl}:`, kodikErr?.message);
      return null;
    }
  }

  /**
   * Разрешение числового ID видео в HAPI v2 через эндпоинты /episodes/players/${id} или /video/${id}
   */
  async resolveNumericVideoId(
    id: string | number,
    player?: any,
    episodeId?: number
  ): Promise<{ url: string; quality?: string } | null> {
    const headers = {
      ...this.getAuthHeaders(),
      'Site-Id': '5',
      'Referer': `${ANIMELIB_WEB_URL}/`,
      'Origin': ANIMELIB_WEB_URL,
    };

    const endpoints: string[] = [];
    if (player?.id) {
      endpoints.push(`/episodes/players/${player.id}`);
    }
    if (id) {
      endpoints.push(`/episodes/players/${id}`);
      endpoints.push(`/video/${id}`);
    }
    if (episodeId && player?.id) {
      endpoints.push(`/episodes/${episodeId}/players/${player.id}`);
    }

    for (const ep of endpoints) {
      try {
        const res = await this.client.get(ep, { headers, timeout: 8000 });
        const data = res.data?.data || res.data;
        if (data) {
          const host = data.host || player?.host;
          const extracted = extractDirectStreamUrl(data, host);
          if (extracted && isValidVideoUrl(extracted.url)) {
            return extracted;
          }
        }
      } catch {}
    }

    return null;
  }

  /**
   * Получение прямой ссылки на видеопоток (m3u8/mp4/stream) из плеера AnimeLib.
   * Обращается к эндпоинтам эпизодов, находит нужный эпизод, приоритезирует плееры
   * (предпочитая нативные стримы LibPlayer/CloudCDN, затем Kodik с резолвом потока)
   * и возвращает прямую ссылку на медиапоток и нужные HTTP-заголовки.
   * Гарантирует возвращение только валидного HTTP(S) URL.
   */
  async getDirectVideoLink(
    mediaId: number | string,
    episode: number,
    targetVoiceover?: string
  ): Promise<DirectVideoLinkResult | null> {
    const id = typeof mediaId === 'string' ? parseInt(mediaId, 10) : mediaId;
    const targetEpNum = parseEpisodeNumber(episode);
    const headers = this.getAuthHeaders();
    const requestHeaders = {
      ...headers,
      'Site-Id': '5',
      'Referer': `${ANIMELIB_WEB_URL}/`,
      'Origin': ANIMELIB_WEB_URL,
    };

    try {
      // 1. Получаем список эпизодов тайтла
      let episodesData: any[] = [];
      try {
        const epListRes = await this.client.get('/episodes', {
          params: { anime_id: id },
          headers: requestHeaders,
        });
        episodesData = epListRes.data?.data || epListRes.data || [];
      } catch (listErr: any) {
        try {
          const epListFallback = await this.client.get(`/anime/${id}/episodes`, {
            headers: requestHeaders,
          });
          episodesData = epListFallback.data?.data || epListFallback.data || [];
        } catch {
          episodesData = [];
        }
      }

      if (!episodesData || episodesData.length === 0) {
        console.warn(`[AnimeLib] No episodes found for media ID ${id}`);
        return null;
      }

      // 2. Находим эпизод с нужным номером
      let matchingEp = episodesData.find(
        (ep: any) => parseEpisodeNumber(ep.number ?? ep.item_number) === targetEpNum
      );

      // Если точного совпадения нет, но запрошена 1 серия и в списке только 1 серия (фильм/спешл)
      if (!matchingEp && episodesData.length === 1 && (targetEpNum === 1 || targetEpNum === 0)) {
        matchingEp = episodesData[0];
      }

      if (!matchingEp) {
        console.warn(`[AnimeLib] Episode ${targetEpNum} not found for media ID ${id}`);
        return null;
      }

      // 3. Загружаем детальную информацию об эпизоде, если массив players отсутствует или пуст
      let players: any[] = Array.isArray(matchingEp.players) ? matchingEp.players : [];
      if (players.length === 0 && matchingEp.id) {
        try {
          const detailRes = await this.client.get(`/episodes/${matchingEp.id}`, {
            headers: requestHeaders,
          });
          players = detailRes.data?.data?.players || detailRes.data?.players || [];
        } catch (detailErr: any) {
          console.warn(`[AnimeLib] Failed to load details for episode ID ${matchingEp.id}:`, detailErr?.message);
        }
      }

      if (players.length === 0) {
        console.warn(`[AnimeLib] No players found for episode ${targetEpNum} (media ID ${id})`);
        return null;
      }

      // 4. ЖЕСТКИЙ приоритет: нативный плеер AnimeLib (1080p/4K) ВСЕГДА проверяется первым!
      // К Kodik обращаться ТОЛЬКО в случае, если AnimeLib вернул 404 или у него нет плееров.
      const nativeAnimeLibPlayers = players.filter((p) => isNativeStreamPlayer(p));
      const fallbackExternalPlayers = players.filter((p) => !isNativeStreamPlayer(p));

      const sortPlayerGroup = (group: any[]) => {
        return [...group].sort((a, b) => {
          if (targetVoiceover && targetVoiceover.trim()) {
            const normTarget = targetVoiceover.trim().toLowerCase();
            const aTeam = (a.team?.name || '').toLowerCase();
            const bTeam = (b.team?.name || '').toLowerCase();
            const aVoMatch = aTeam && (aTeam.includes(normTarget) || normTarget.includes(aTeam));
            const bVoMatch = bTeam && (bTeam.includes(normTarget) || normTarget.includes(bTeam));
            if (aVoMatch && !bVoMatch) return -1;
            if (!aVoMatch && bVoMatch) return 1;
          }

          // Приоритет озвучке (type 2) над субтитрами (type 1)
          const aVoType = a.translation_type?.id === 2;
          const bVoType = b.translation_type?.id === 2;
          if (aVoType && !bVoType) return -1;
          if (!aVoType && bVoType) return 1;

          return 0;
        });
      };

      const sortedNative = sortPlayerGroup(nativeAnimeLibPlayers);
      const sortedFallback = sortPlayerGroup(fallbackExternalPlayers);

      console.log(
        `[AnimeLib] Эпизод ${targetEpNum}: Найдено нативных плееров: ${sortedNative.length}, внешних плееров (Kodik): ${sortedFallback.length}`
      );

      // Вспомогательная функция проверки и резолва отдельного плеера
      const testAndResolvePlayer = async (player: any): Promise<DirectVideoLinkResult | null> => {
        let streamUrl = '';
        let detectedQuality = '1080p';

        // 1. Проверяем вложенные структуры плеера (video, src, host, qualities, etc.)
        const extracted = extractDirectStreamUrl(player);
        if (extracted && isValidVideoUrl(extracted.url)) {
          streamUrl = normalizeVideoUrl(extracted.url);
          if (extracted.quality) detectedQuality = extracted.quality;
        }

        // 2. Если валидного сетевого URL нет, проверяем числовой ID
        if (!streamUrl) {
          const rawVideo = player.video;
          const rawSrc = player.src;
          const rawId = player.id;
          const rawVideoId = player.video_id;

          const numericIdCandidate =
            (typeof rawVideo === 'number' || (typeof rawVideo === 'string' && /^\d+$/.test(rawVideo.trim())))
              ? String(rawVideo).trim()
              : ((typeof rawVideoId === 'number' || (typeof rawVideoId === 'string' && /^\d+$/.test(String(rawVideoId).trim())))
                ? String(rawVideoId).trim()
                : ((typeof rawSrc === 'string' && /^\d+$/.test(rawSrc.trim()))
                  ? rawSrc.trim()
                  : (rawId && /^\d+$/.test(String(rawId).trim()) ? String(rawId).trim() : null)));

          if (numericIdCandidate) {
            console.log(
              `[AnimeLib] Плеер #${player.id || 'N/A'} (${player.player || 'AnimeLib'}) содержит числовой ID (${numericIdCandidate}). Разрешаем через API...`
            );
            const resolvedApi = await this.resolveNumericVideoId(numericIdCandidate, player, matchingEp?.id);
            if (resolvedApi && isValidVideoUrl(resolvedApi.url)) {
              streamUrl = normalizeVideoUrl(resolvedApi.url);
              if (resolvedApi.quality) detectedQuality = resolvedApi.quality;
            }
          }
        }

        // Если это Kodik, извлекаем ссылку на iframe/серию из доступных полей плеера
        if (!streamUrl && (player.player || '').toLowerCase().includes('kodik')) {
          const rawSrc = player.src || player.url || player.link || (player.video && typeof player.video === 'string' ? player.video : null);
          if (rawSrc && typeof rawSrc === 'string') {
            const trimmedSrc = rawSrc.trim();
            if (trimmedSrc.startsWith('//')) {
              streamUrl = 'https:' + trimmedSrc;
            } else if (trimmedSrc.startsWith('/')) {
              streamUrl = `https://kodikplayer.com${trimmedSrc}`;
            } else if (isValidVideoUrl(trimmedSrc)) {
              streamUrl = trimmedSrc;
            }
          }
        }

        // 3. Строгая валидация URL потока:
        if (!isValidVideoUrl(streamUrl)) {
          const rawInfo =
            streamUrl ||
            (typeof player.video === 'object'
              ? JSON.stringify(player.video)
              : (typeof player.src === 'object'
                ? JSON.stringify(player.src)
                : (player.video || player.src || 'пусто')));
          console.warn(
            `[AnimeLib] Плеер #${player.id || 'N/A'} (${player.player || 'Unknown'}, ${player.team?.name || 'Без студии'}) не вернул прямой URL (данные: ${String(rawInfo).substring(0, 100)}).`
          );
          return null;
        }

        const normalizedUrl = normalizeVideoUrl(streamUrl);

        // 4. Проверяем, является ли ссылка Kodik фреймом
        const isKodik =
          normalizedUrl.includes('kodikplayer.com') ||
          normalizedUrl.includes('kodik.info') ||
          normalizedUrl.includes('/seria/') ||
          (player.player || '').toLowerCase().includes('kodik');

        if (isKodik) {
          console.log(`[AnimeLib] Разрешаем реальный HLS-манифест из Kodik плеера: ${normalizedUrl}`);
          const resolvedKodik = await this.resolveKodikStream(normalizedUrl);
          if (resolvedKodik && isValidVideoUrl(resolvedKodik.url)) {
            return {
              url: normalizeVideoUrl(resolvedKodik.url),
              quality: resolvedKodik.quality || detectedQuality,
              voiceover: player.team?.name || targetVoiceover || undefined,
              playerType: player.player || 'Kodik',
              format: resolvedKodik.format || 'm3u8',
              headers: resolvedKodik.headers || {
                'Referer': 'https://kodikplayer.com/',
                'User-Agent': DEFAULT_USER_AGENT,
              },
            };
          }
          console.warn(`[AnimeLib] Не удалось извлечь рабочий манифест из Kodik плеера #${player.id}.`);
          return null;
        }

        // 5. Нативный стрим AnimeLib (прямой .m3u8, .mp4 или потоковый URL)
        let format: 'm3u8' | 'mp4' | 'stream' = 'stream';
        if (normalizedUrl.includes('.m3u8')) {
          format = 'm3u8';
        } else if (normalizedUrl.includes('.mp4')) {
          format = 'mp4';
        }

        const qualMatch = normalizedUrl.match(/\b(2160|1440|1080|720|480|360)p?\b/i);
        if (qualMatch) {
          detectedQuality = `${qualMatch[1]}p`;
        }

        return {
          url: normalizedUrl,
          quality: detectedQuality,
          voiceover: player.team?.name || targetVoiceover || undefined,
          playerType: player.player || 'AnimeLib',
          format,
          headers: {
            'Referer': `${ANIMELIB_WEB_URL}/`,
            'Origin': ANIMELIB_WEB_URL,
            'User-Agent': DEFAULT_USER_AGENT,
          },
        };
      };

      // Проверка доступности потока по сети (защита от DNS ENOTFOUND / 404 / сетевых сбоев)
      const verifyStreamReachable = async (streamUrl: string, reqHeaders?: Record<string, string>): Promise<boolean> => {
        try {
          const res = await axios.get(streamUrl, {
            headers: {
              'User-Agent': DEFAULT_USER_AGENT,
              'Referer': `${ANIMELIB_WEB_URL}/`,
              'Origin': ANIMELIB_WEB_URL,
              'Range': 'bytes=0-2048',
              ...(reqHeaders || {}),
            },
            timeout: 2500,
            responseType: 'stream',
            validateStatus: (status) => status >= 200 && status < 400,
          });
          if (res.data && typeof res.data.destroy === 'function') {
            res.data.destroy();
          }
          return true;
        } catch (err: any) {
          const errCode = err?.code || '';
          const status = err?.response?.status;
          console.warn(`[AnimeLib] ⚠️ Нативный стрим недоступен (${errCode || status || err?.message || 'Error'}): ${streamUrl}`);
          return false;
        }
      };

      // ПЕРВЫЙ ЭТАП: СТРОГО нативные плееры AnimeLib
      for (const player of sortedNative) {
        try {
          const res = await testAndResolvePlayer(player);
          if (res && isValidVideoUrl(res.url)) {
            // Проверяем доступность нативного потока (защита от DNS ENOTFOUND / 404)
            let isReachable = await verifyStreamReachable(res.url, res.headers);

            // Если зеркало cache.lib.social недоступно, пробуем альтернативное зеркало anmli.org
            if (!isReachable && res.url.includes('cache.lib.social')) {
              const altMirrorUrl = res.url.replace('cache.lib.social', 'anmli.org');
              const altReachable = await verifyStreamReachable(altMirrorUrl, res.headers);
              if (altReachable) {
                res.url = altMirrorUrl;
                isReachable = true;
              }
            }

            if (isReachable) {
              console.log(
                `[AnimeLib] ✅ Успешно выбран нативный плеер AnimeLib #${player.id} (${res.quality}, ${res.voiceover || 'Без студии'})`
              );
              return res;
            } else {
              console.warn(
                `[AnimeLib] Нативный плеер #${player.id} вернул недоступный поток (${res.url}). Мгновенно переключаемся к Kodik...`
              );
            }
          }
        } catch (nativeErr: any) {
          console.warn(`[AnimeLib] Ошибка при проверке нативного плеера #${player.id}:`, nativeErr?.message);
        }
      }

      // ВТОРОЙ ЭТАП: Автоматическое переключение на резервный плеер Kodik,
      // если нативные плееры недоступны (DNS error / ENOTFOUND / 404) или отсутствуют
      console.log(`[AnimeLib] Нативные плееры недоступны или не ответили. Автоматически переключаемся на резервный плеер Kodik...`);

      for (const player of sortedFallback) {
        try {
          const res = await testAndResolvePlayer(player);
          if (res && isValidVideoUrl(res.url)) {
            console.log(
              `[AnimeLib] ✅ Выбран резервный плеер #${player.id} (${res.playerType}, ${res.quality}, ${res.voiceover || 'Без студии'})`
            );
            return res;
          }
        } catch (fallbackErr: any) {
          console.warn(`[AnimeLib] Ошибка при проверке внешнего плеера #${player.id}:`, fallbackErr?.message);
        }
      }

      console.warn(`[AnimeLib] No valid video stream could be resolved for episode ${targetEpNum} (media ID ${id})`);
      return null;
    } catch (err: any) {
      console.error(`[AnimeLib] getDirectVideoLink error for media ${id}, ep ${episode}:`, err?.message);
      return null;
    }
  }
}

export const animelibService = new AnimeLibService();