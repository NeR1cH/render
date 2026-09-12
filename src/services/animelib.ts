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
  voiceovers?: string[];
}

export interface AnimeLibEpisodeInfo {
  latestEpisode: number;
  voiceovers: string[];
}

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
        'Referer': 'https://animelib.me/',
        'Origin': 'https://animelib.me',
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

      for (const item of rawItems) {
        const media = item.media || item.anime || item;
        const mediaId = media.id || item.media_id || item.anime_id;
        if (!mediaId) {
          console.warn('[AnimeLib] Skipping bookmark without media ID');
          continue;
        }

        // 1. Watched Progress: AnimeLib stores in item.meta?.item_number or item.item?.number
        const rawProgress =
          item.meta?.item_number ??
          item.item?.number ??
          item.current_progress_number ??
          item.current_item_number ??
          item.item_number ??
          0;
        const currentProgress = parseFloat(String(rawProgress)) || 0;

        // 2. Latest Released Episode: media.metadata?.last_item?.number or media.items_count?.uploaded
        const lastItemMeta = media.metadata?.last_item;
        const rawLatest =
          lastItemMeta?.number ??
          media.items_count?.uploaded ??
          media.last_item_number ??
          media.items_count?.total ??
          0;
        const lastEpisode = parseFloat(String(rawLatest)) || 0;

        // 3. Voiceover Teams: embedded inside lastItemMeta.players
        const voiceoverStudios: string[] = [];
        if (Array.isArray(lastItemMeta?.players)) {
          for (const pl of lastItemMeta.players) {
            if (pl.team?.name) {
              const teamName = pl.team.name.trim();
              if (!voiceoverStudios.includes(teamName)) {
                voiceoverStudios.push(teamName);
              }
            }
          }
        }

        const entry: AnimeLibBookmarkItem = {
          media_id: mediaId,
          slug_url: media.slug_url || media.slug || String(mediaId),
          name: media.name || media.eng_name || media.title || '',
          rus_name: media.rus_name || media.russian || '',
          current_progress_number: currentProgress,
          last_item_number: lastEpisode,
          poster: media.cover?.default || media.poster,
          voiceovers: voiceoverStudios,
        };

        try {
          dbService.upsertSyncItem({
            media_id: entry.media_id,
            title: entry.name,
            rus_title: entry.rus_name,
            status: 'watching',
            last_tracked_episode: entry.current_progress_number || 0,
          });
        } catch (dbError: any) {
          console.warn('[AnimeLib] Could not sync bookmark to local DB:', dbError?.message);
        }

        result.push(entry);
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

      for (const ep of episodesData) {
        const num = parseFloat(ep.number || ep.item_number || '0');
        if (num > maxEp) maxEp = num;

        if (Array.isArray(ep.players)) {
          for (const pl of ep.players) {
            if (pl.team?.name) studiosSet.add(pl.team.name.trim());
          }
        }
      }

      return {
        latestEpisode: maxEp,
        voiceovers: Array.from(studiosSet),
      };
    } catch {
      // Fallback: Web Scraping через cheerio
      try {
        const targetUrl = slugUrl ? `https://animelib.org/ru/anime/${slugUrl}` : `https://animelib.org/ru/anime/${mediaId}`;
        const pageRes = await this.client.get(targetUrl, { headers });
        const $ = cheerio.load(pageRes.data);

        const studios: string[] = [];
        $('.team-item, .voiceover-item, [data-studio]').each((_, el) => {
          const name = $(el).text().trim();
          if (name) studios.push(name);
        });

        return {
          latestEpisode: 0,
          voiceovers: studios,
        };
      } catch (scrapeErr: any) {
        return { latestEpisode: 0, voiceovers: [] };
      }
    }
  }
}

export const animelibService = new AnimeLibService();