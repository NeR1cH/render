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

  constructor() {
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': `${ANIMELIB_WEB_URL}/`,
        'Origin': ANIMELIB_WEB_URL,
      },
    });
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

  async getAllWatching(): Promise<AnimeLibBookmarkItem[]> {
    const headers = this.getAuthHeaders();
    if (Object.keys(headers).length === 0) {
      console.warn('[AnimeLib] ANIMELIB_COOKIE is empty. Skipping bookmarks check.');
      return [];
    }

    const userId = process.env.ANIMELIB_USER_ID || '9024582';
    const requestHeaders = {
      ...headers,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
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

      return result;
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
        return [];
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
}

export const animelibService = new AnimeLibService();