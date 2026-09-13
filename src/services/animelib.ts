import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import { dbService } from '../db/database.js';

export interface AnimeLibBookmarkItem {
  media_id: number;
  slug_url: string;
  name: string;
  rus_name?: string;
  current_progress_number?: number;
  last_item_number?: number;
  poster?: string;
  folderStatus?: 'watching' | 'planned';
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
  defaultHost?: string
): { url: string; quality?: string } | null {
  if (!pl || typeof pl !== 'object') return null;

  // Извлекаем host, если он указан на любом уровне
  let host = pl.host || defaultHost;
  if (pl.video && typeof pl.video === 'object' && pl.video.host) {
    host = pl.video.host;
  }
  if (pl.src && typeof pl.src === 'object' && pl.src.host) {
    host = pl.src.host;
  }

  const tryResolve = (val: any, qualityHint?: string, currentHost?: string): { url: string; quality?: string } | null => {
    if (!val) return null;

    // 1. Строка (СТРОГИЙ парсинг, без неявного String(obj))
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (!trimmed || /^\d+$/.test(trimmed)) return null;

      // Прямой сетевой URL
      if (isValidVideoUrl(trimmed)) {
        return { url: normalizeVideoUrl(trimmed), quality: qualityHint };
      }

      // Относительный путь манифеста с хостом
      const h = currentHost || host;
      if (h && (trimmed.startsWith('/') || trimmed.includes('.m3u8') || trimmed.includes('.mp4'))) {
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
      const objHost = val.host || currentHost || host;

      // 2a. Проверяем ключи качества в порядке убывания (2160p -> 1440p -> 1080p -> 720p...)
      for (const qKey of QUALITY_KEYS) {
        if (val[qKey] !== undefined) {
          const res = tryResolve(val[qKey], qKey.includes('p') ? qKey : `${qKey}p`, objHost);
          if (res) return res;
        }
      }

      // 2b. Проверяем вложенные свойства плеера
      if (val.qualities) {
        const res = tryResolve(val.qualities, qualityHint, objHost);
        if (res) return res;
      }
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

    // 3. Массив (например qualities: [ { href: "...", resolution: 1080 } ])
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
          const res = tryResolve(item, qualityHint, currentHost);
          if (res) return res;
        } else if (typeof item === 'object') {
          const itemHost = item.host || currentHost || host;
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
  if (pl.qualities) {
    const res = tryResolve(pl.qualities, undefined, host);
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

  // Если у плеера есть видеообъект или качества от AnimeLib
  if (pl.video && typeof pl.video === 'object') {
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

  async getAllTrackedBookmarks(forceRefresh: boolean = false): Promise<AnimeLibBookmarkItem[]> {
    if (!forceRefresh && this.watchingCache && Date.now() - this.watchingCache.timestamp < this.CACHE_TTL_MS) {
      return this.watchingCache.items;
    }

    const headers = this.getAuthHeaders();
    if (Object.keys(headers).length === 0) {
      console.warn('[AnimeLib] ANIMELIB_COOKIE is empty. Skipping bookmarks check.');
      return [];
    }

    const userId = process.env.ANIMELIB_USER_ID || '9024582';
    const requestHeaders = {
      ...headers,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://animelib.org/',
      'Origin': 'https://animelib.org',
      'Site-Id': '5',
    };

    const fetchBookmarksForStatus = async (statusId: number, folder: 'watching' | 'planned'): Promise<AnimeLibBookmarkItem[]> => {
      const transformItems = (rawItems: any[]): AnimeLibBookmarkItem[] => {
        const result: AnimeLibBookmarkItem[] = [];
        const toSync: Array<any> = [];

        for (const item of rawItems) {
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

          const entry: AnimeLibBookmarkItem = {
            media_id: mediaId,
            slug_url: media.slug_url || media.slug || String(mediaId),
            name: media.name || media.eng_name || media.title || '',
            rus_name: media.rus_name || media.russian || '',
            current_progress_number: parseEpisodeNumber(rawProgress),
            last_item_number: parseEpisodeNumber(rawLastEp),
            poster: media.cover?.default || media.poster,
            folderStatus: folder,
          };

          toSync.push({
            media_id: entry.media_id,
            title: entry.name,
            rus_title: entry.rus_name,
            status: folder,
            last_tracked_episode: entry.current_progress_number || 0,
            latest_episode: entry.last_item_number || 0,
          });

          result.push(entry);
        }

        try {
          dbService.batchUpsertSyncItems(toSync);
        } catch (dbError: any) {
          console.warn(`[AnimeLib] Could not batch sync ${folder} bookmarks to local DB:`, dbError?.message);
        }

        return result;
      };

      try {
        const response = await this.client.get('/bookmarks', {
          params: {
            user_id: userId,
            status: statusId,
            page: 1,
            limit: 80,
            sort_by: 'created_at',
            sort_type: 'desc',
          },
          headers: requestHeaders,
        });
        const items = response.data?.data || response.data || [];
        return transformItems(items);
      } catch {
        try {
          const fallbackRes = await this.client.get(`/users/${userId}/bookmarks`, {
            params: {
              status: statusId,
              page: 1,
              limit: 80,
              sort_by: 'created_at',
              sort_type: 'desc',
            },
            headers: requestHeaders,
          });
          const items = fallbackRes.data?.data || fallbackRes.data || [];
          return transformItems(items);
        } catch {
          return [];
        }
      }
    };

    // Загружаем параллельно статус 21 (Смотрю) и статус 22 (Запланировано)
    const [watchingItems, plannedItems] = await Promise.all([
      fetchBookmarksForStatus(21, 'watching'),
      fetchBookmarksForStatus(22, 'planned'),
    ]);

    const combined = [...watchingItems];
    const seenMediaIds = new Set(combined.map((i) => i.media_id));

    for (const p of plannedItems) {
      if (!seenMediaIds.has(p.media_id)) {
        seenMediaIds.add(p.media_id);
        combined.push(p);
      }
    }

    if (combined.length === 0) {
      // Fallback на локальную базу данных
      try {
        const cachedWatching = dbService.getAllSyncItems('watching') || [];
        const cachedPlanned = dbService.getAllSyncItems('planned') || [];
        const allCached = [...cachedWatching, ...cachedPlanned];
        if (allCached.length > 0) {
          return allCached.map((c) => ({
            media_id: c.media_id,
            slug_url: String(c.media_id),
            name: c.title,
            rus_name: c.rus_title || undefined,
            current_progress_number: c.last_tracked_episode,
            last_item_number: c.latest_episode || c.last_tracked_episode,
            folderStatus: c.status === 'planned' ? 'planned' : 'watching',
          }));
        }
      } catch {}
    }

    this.watchingCache = { items: combined, timestamp: Date.now() };
    return combined;
  }

  async getAllWatching(forceRefresh: boolean = false): Promise<AnimeLibBookmarkItem[]> {
    const all = await this.getAllTrackedBookmarks(forceRefresh);
    return all.filter((item) => item.folderStatus !== 'planned');
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
            // Отсекаем субтитры (translation_type.id === 1) и пустые имена
            const isSub = pl.translation_type?.id === 1;
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

      if (!matchingEp) {
        return [];
      }

      let players: any[] = Array.isArray(matchingEp.players) ? matchingEp.players : [];
      if (players.length === 0 && matchingEp.id) {
        try {
          const epDetailRes = await this.client.get(`/episodes/${matchingEp.id}`, {
            headers: requestHeaders,
          });
          players = epDetailRes.data?.data?.players || epDetailRes.data?.players || [];
        } catch (detailErr: any) {
          console.warn(`[AnimeLib] Failed to load episode detail for ${matchingEp.id}:`, detailErr?.message);
        }
      }

      const studiosSet = new Set<string>();
      for (const pl of players) {
        // Отсекаем субтитры (translation_type.id === 1) и пустые имена
        const isSub =
          pl.translation_type?.id === 1 ||
          (pl.translation_type?.name && pl.translation_type.name.toLowerCase().includes('субтит')) ||
          (pl.team?.name && pl.team.name.toLowerCase().includes('subtitle'));
        const teamName = pl.team?.name?.trim();
        if (teamName && !isSub) {
          studiosSet.add(teamName);
        }
      }

      return Array.from(studiosSet);
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

      // ПЕРВЫЙ ЭТАП: СТРОГО нативные плееры AnimeLib
      for (const player of sortedNative) {
        try {
          const res = await testAndResolvePlayer(player);
          if (res && isValidVideoUrl(res.url)) {
            console.log(
              `[AnimeLib] ✅ Успешно выбран нативный плеер AnimeLib #${player.id} (${res.quality}, ${res.voiceover || 'Без студии'})`
            );
            return res;
          }
        } catch (nativeErr: any) {
          console.warn(`[AnimeLib] Ошибка при проверке нативного плеера #${player.id}:`, nativeErr?.message);
        }
      }

      // ВТОРОЙ ЭТАП: ТОЛЬКО если AnimeLib не дал рабочего потока — переходим к Kodik
      if (sortedNative.length > 0) {
        console.warn(
          `[AnimeLib] ⚠️ Нативные плееры AnimeLib (${sortedNative.length}) недоступны или вернули ошибку. Выполняем fallback на внешние плееры (Kodik)...`
        );
      } else {
        console.log(`[AnimeLib] Нативных плееров AnimeLib не обнаружено. Используем внешние плееры (Kodik)...`);
      }

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