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
}

export class AnimeLibService {
  private client: AxiosInstance;
  private readonly baseUrl = 'https://animelib.me';

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

  private getCookie(): string {
    return process.env.ANIMELIB_COOKIE || '';
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
    const cookie = this.getCookie();
    if (!cookie) {
      console.warn('[AnimeLib] ANIMELIB_COOKIE is empty. Skipping bookmarks check.');
      return [];
    }

    try {
      const response = await this.client.get('/api/bookmarks', {
        params: { status: 1, page: 1, limit: 60 },
        headers: { Cookie: cookie },
      });

      const items = response.data?.data || [];
      const result: AnimeLibBookmarkItem[] = [];

      for (const item of items) {
        const media = item.media || item;
        const entry: AnimeLibBookmarkItem = {
          media_id: media.id || item.media_id,
          slug_url: media.slug_url || media.slug || String(media.id),
          name: media.name || media.eng_name || '',
          rus_name: media.rus_name || '',
          current_progress_number: item.current_item_number || item.item_number || 0,
          last_item_number: media.last_item_number || 0,
          poster: media.cover?.default || media.poster,
        };

        dbService.upsertSyncItem({
          media_id: entry.media_id,
          title: entry.name,
          rus_title: entry.rus_name,
          status: 'watching',
          last_tracked_episode: entry.current_progress_number || 0,
        });

        result.push(entry);
      }

      return result;
    } catch (err: any) {
      console.error('[AnimeLib Bookmarks Error]:', err.message);
      return [];
    }
  }

  async getMediaEpisodes(mediaId: number, slugUrl?: string): Promise<AnimeLibEpisodeInfo> {
    const cookie = this.getCookie();
    const headers = cookie ? { Cookie: cookie } : {};

    try {
      const apiRes = await this.client.get(`https://api.lib.social/api/anime/${mediaId}/episodes`, { headers });
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
        const targetUrl = slugUrl ? `https://animelib.me/ru/anime/${slugUrl}` : `https://animelib.me/ru/anime/${mediaId}`;
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