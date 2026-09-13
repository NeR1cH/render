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
}

export interface AnimeLibEpisodeInfo {
  latestEpisode: number;
  voiceovers: string[];
  latestVoiceovers: string[];
}

export interface DirectVideoLinkResult {
  url: string;
  quality?: string;
  voiceover?: string;
  playerType?: string;
  format?: 'm3u8' | 'mp4' | 'stream';
  headers?: Record<string, string>;
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
  if (!pl) return false;
  const pName = (pl.player || '').toLowerCase();
  if (pName.includes('libplayer') || pName.includes('cloudcdn') || pName.includes('animelib')) {
    return true;
  }
  const checkUrl = (urlVal: any): boolean => {
    if (!urlVal) return false;
    if (typeof urlVal === 'string') {
      const u = urlVal.toLowerCase();
      if ((u.includes('.m3u8') || u.includes('.mp4')) && !u.includes('kodik') && !u.includes('/seria/')) {
        return true;
      }
    } else if (typeof urlVal === 'object') {
      return Object.values(urlVal).some((v) => checkUrl(v));
    }
    return false;
  };
  return checkUrl(pl.video) || checkUrl(pl.src) || checkUrl(pl.url) || checkUrl(pl.file) || checkUrl(pl.stream);
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

  async getAllWatching(forceRefresh: boolean = false): Promise<AnimeLibBookmarkItem[]> {
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

    const transformItems = (rawItems: any[]): AnimeLibBookmarkItem[] => {
      const result: AnimeLibBookmarkItem[] = [];
      const toSync: Array<any> = [];

      for (const item of rawItems) {
        const media = item.media || item.anime || item;
        const mediaId = media.id || item.media_id || item.anime_id;
        if (!mediaId) {
          console.warn('[AnimeLib] Skipping bookmark without media ID');
          continue;
        }

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
        };

        toSync.push({
          media_id: entry.media_id,
          title: entry.name,
          rus_title: entry.rus_name,
          status: 'watching',
          last_tracked_episode: entry.current_progress_number || 0,
        });

        result.push(entry);
      }

      try {
        dbService.batchUpsertSyncItems(toSync);
      } catch (dbError: any) {
        console.warn('[AnimeLib] Could not batch sync bookmarks to local DB:', dbError?.message);
      }

      this.watchingCache = { items: result, timestamp: Date.now() };
      return result;
    };

    const getLocalDbFallback = (): AnimeLibBookmarkItem[] => {
      try {
        const cached = dbService.getAllSyncItems('watching');
        if (cached && cached.length > 0) {
          console.log(`[AnimeLib] Using ${cached.length} cached watching titles from local SQLite.`);
          return cached.map((c) => ({
            media_id: c.media_id,
            slug_url: String(c.media_id),
            name: c.title,
            rus_name: c.rus_title || undefined,
            current_progress_number: c.last_tracked_episode,
            last_item_number: c.last_tracked_episode,
          }));
        }
      } catch {}
      return [];
    };

    try {
      const response = await this.client.get('/bookmarks', {
        params: {
          user_id: userId,
          status: 21,
          page: 1,
          limit: 60,
          sort_by: 'created_at',
          sort_type: 'desc',
        },
        headers: requestHeaders,
      });

      console.log(`[AnimeLib] Successfully fetched ${response.data?.data?.length ?? 0} bookmarks via hapi.hentaicdn.org`);
      const items = response.data?.data || response.data || [];
      return transformItems(items);
    } catch (error: any) {
      console.warn(
        '[AnimeLib] Primary /bookmarks failed, trying /users/{id}/bookmarks:',
        error?.response?.status || error?.message
      );

      try {
        const fallbackRes = await this.client.get(`/users/${userId}/bookmarks`, {
          params: {
            status: 21,
            page: 1,
            limit: 60,
            sort_by: 'created_at',
            sort_type: 'desc',
          },
          headers: requestHeaders,
        });
        const items = fallbackRes.data?.data || fallbackRes.data || [];
        console.log('[AnimeLib] Successfully fetched bookmarks via fallback:', items.length);
        return transformItems(items);
      } catch (fallbackError: any) {
        console.error('[AnimeLib] Both endpoints failed:', fallbackError?.response?.status, fallbackError?.message);
        return getLocalDbFallback();
      }
    }
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
          }
        }
      }

      return {
        latestEpisode: maxEp,
        voiceovers: Array.from(studiosSet),
        latestVoiceovers: Array.from(latestStudiosSet),
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
        };
      } catch (scrapeErr: any) {
        return { latestEpisode: 0, voiceovers: [], latestVoiceovers: [] };
      }
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
      const defaultUserAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

      const getRes = await axios.get(pageUrl, {
        headers: {
          'User-Agent': defaultUserAgent,
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
            'User-Agent': defaultUserAgent,
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
          'User-Agent': defaultUserAgent,
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
      if (finalStreamUrl.startsWith('//')) {
        finalStreamUrl = 'https:' + finalStreamUrl;
      }

      return {
        url: finalStreamUrl,
        quality: chosenQuality,
        format: finalStreamUrl.includes('.m3u8') ? 'm3u8' : 'mp4',
        headers: {
          'Referer': 'https://kodikplayer.com/',
          'User-Agent': defaultUserAgent,
        },
      };
    } catch (kodikErr: any) {
      console.warn(`[AnimeLib] Failed to resolve Kodik stream from ${kodikUrl}:`, kodikErr?.message);
      return null;
    }
  }

  /**
   * Получение прямой ссылки на видеопоток (m3u8/mp4/stream) из плеера AnimeLib.
   * Обращается к эндпоинтам эпизодов, находит нужный эпизод, приоритезирует плееры
   * (предпочитая нативные стримы LibPlayer/CloudCDN, затем Kodik с резолвом потока)
   * и возвращает прямую ссылку на медиапоток и нужные HTTP-заголовки.
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

      // 4. Приоритезация и отбор подходящих плееров
      // Приоритет отдается нативным стримам AnimeLib (LibPlayer, CloudCDN, прямые .m3u8/.mp4)
      const sortedPlayers = [...players].sort((a, b) => {
        // Если указана озвучка, проверяем соответствие
        if (targetVoiceover && targetVoiceover.trim()) {
          const normTarget = targetVoiceover.trim().toLowerCase();
          const aTeam = (a.team?.name || '').toLowerCase();
          const bTeam = (b.team?.name || '').toLowerCase();
          const aVoMatch = aTeam && (aTeam.includes(normTarget) || normTarget.includes(aTeam));
          const bVoMatch = bTeam && (bTeam.includes(normTarget) || normTarget.includes(bTeam));
          if (aVoMatch && !bVoMatch) return -1;
          if (!aVoMatch && bVoMatch) return 1;
        }

        // Приоритет нативным стримам над внешними плеерами
        const aNative = isNativeStreamPlayer(a);
        const bNative = isNativeStreamPlayer(b);
        if (aNative && !bNative) return -1;
        if (!aNative && bNative) return 1;

        // Приоритет озвучке (translation_type.id === 2) над субтитрами
        const aVoType = a.translation_type?.id === 2;
        const bVoType = b.translation_type?.id === 2;
        if (aVoType && !bVoType) return -1;
        if (!aVoType && bVoType) return 1;

        return 0;
      });

      // Перебираем кандидатов плееров, пока не найдем рабочий стрим
      for (const player of sortedPlayers) {
        let rawUrl = '';
        let detectedQuality = '720p';

        // Проверяем объект video (разные качества)
        if (player.video) {
          if (typeof player.video === 'string') {
            rawUrl = player.video;
          } else if (typeof player.video === 'object') {
            const qualities = ['1080', '720', '480', '360'];
            for (const q of qualities) {
              if (player.video[q]) {
                rawUrl = player.video[q];
                detectedQuality = `${q}p`;
                break;
              }
            }
            if (!rawUrl && Object.values(player.video).length > 0) {
              rawUrl = String(Object.values(player.video)[0]);
            }
          }
        }

        // Проверяем поля src, url, file, stream
        if (!rawUrl) {
          rawUrl = player.src || player.url || player.file || player.stream || '';
        }

        if (!rawUrl) {
          continue;
        }

        let trimmedUrl = rawUrl.trim();
        if (trimmedUrl.startsWith('//')) {
          trimmedUrl = 'https:' + trimmedUrl;
        }

        // Проверяем, является ли ссылка Kodik или встраиваемым фреймом
        const isKodik =
          trimmedUrl.includes('kodikplayer.com') ||
          trimmedUrl.includes('kodik.info') ||
          trimmedUrl.includes('/seria/') ||
          (player.player || '').toLowerCase().includes('kodik');

        if (isKodik) {
          console.log(`[AnimeLib] Разрешаем реальный HLS-манифест из Kodik плеера: ${trimmedUrl}`);
          const resolvedKodik = await this.resolveKodikStream(trimmedUrl);
          if (resolvedKodik && resolvedKodik.url) {
            return {
              url: resolvedKodik.url,
              quality: resolvedKodik.quality || detectedQuality,
              voiceover: player.team?.name || targetVoiceover || undefined,
              playerType: player.player || 'Kodik',
              format: resolvedKodik.format || 'm3u8',
              headers: resolvedKodik.headers || {
                'Referer': 'https://kodikplayer.com/',
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
              },
            };
          }
          // Если разрешение Kodik не удалось, продолжаем поиск следующего плеера
          console.warn(`[AnimeLib] Не удалось извлечь манифест из Kodik плеера ${player.id}, проверяем следующий`);
          continue;
        }

        // Нативный стрим AnimeLib (LibPlayer, CloudCDN, прямой .m3u8 или .mp4)
        let format: 'm3u8' | 'mp4' | 'stream' = 'stream';
        if (trimmedUrl.includes('.m3u8')) {
          format = 'm3u8';
        } else if (trimmedUrl.includes('.mp4')) {
          format = 'mp4';
        }

        const qualMatch = trimmedUrl.match(/\b(1080|720|480|360)p?\b/i);
        if (qualMatch) {
          detectedQuality = `${qualMatch[1]}p`;
        }

        return {
          url: trimmedUrl,
          quality: detectedQuality,
          voiceover: player.team?.name || targetVoiceover || undefined,
          playerType: player.player || 'AnimeLib',
          format,
          headers: {
            'Referer': `${ANIMELIB_WEB_URL}/`,
            'Origin': ANIMELIB_WEB_URL,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
          },
        };
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