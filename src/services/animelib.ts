import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import { dbService } from '../db/database';

dotenv.config();

export interface AnimeLibPlayer {
  id: number;
  player: string;
  translation_type: {
    id: number;
    label: string;
  };
  team: {
    id: number;
    name: string;
    slug?: string;
  };
  views?: number;
}

export interface AnimeLibBookmarkItem {
  bookmark_id: number;
  media_id: number;
  name: string;
  rus_name: string;
  eng_name?: string;
  slug_url: string;
  status: string; // 'watching' | 'completed' | 'planned' | 'dropped'
  status_id: number;
  last_item_number: number;
  current_progress_number: number;
  available_teams: Array<{ id: number; name: string }>;
  cover_url?: string;
  updated_at?: string;
}

export class AnimeLibService {
  private client: AxiosInstance;
  private sessionCookie: string;
  private baseUrl: string = 'https://api.lib.social'; // AnimeLib / MangaLib unified API gateway
  private fallbackWebUrl: string = 'https://animelib.me';

  constructor(cookie?: string) {
    this.sessionCookie = cookie || process.env.ANIMELIB_COOKIE || '';
    this.client = this.createHttpClient();
  }

  public setCookie(cookie: string) {
    this.sessionCookie = cookie;
    this.client = this.createHttpClient();
  }

  private createHttpClient(): AxiosInstance {
    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      Origin: 'https://animelib.me',
      Referer: 'https://animelib.me/',
    };

    if (this.sessionCookie) {
      headers['Cookie'] = this.sessionCookie;
    }

    return axios.create({
      baseURL: this.baseUrl,
      headers,
      timeout: 15000,
    });
  }

  /**
   * Title normalization for matching between AnimeLib and Shikimori
   */
  public static normalizeTitle(title: string | null | undefined): string {
    return (title || '')
      .toLowerCase()
      .replace(/[«»"'`]/g, '')
      .replace(/[^a-zа-я0-9\s]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Map AnimeLib numeric status IDs to unified status strings
   * 1 = Watching (Смотрю)
   * 2 = Completed (Просмотрено)
   * 3 = Planned (В планах)
   * 4 = Dropped (Брошено)
   * 21 = Watching (Custom group or sub-status)
   */
  public static mapStatusIdToString(statusId: number): string {
    switch (statusId) {
      case 1:
      case 21:
        return 'watching';
      case 2:
        return 'completed';
      case 3:
        return 'planned';
      case 4:
        return 'dropped';
      default:
        return 'watching';
    }
  }

  /**
   * Check if the session cookie is valid and authorized
   */
  public async checkAuth(): Promise<{ authorized: boolean; username?: string; id?: number }> {
    if (!this.sessionCookie) {
      return { authorized: false };
    }

    try {
      const res = await this.client.get('/api/auth/me');
      if (res.data && res.data.data) {
        return {
          authorized: true,
          username: res.data.data.username || res.data.data.name,
          id: res.data.data.id,
        };
      }
      return { authorized: false };
    } catch {
      // If /api/auth/me is not accessible, test bookmarks endpoint
      try {
        const testRes = await this.client.get('/api/bookmarks?page=1');
        if (testRes.status === 200 && testRes.data?.data) {
          return { authorized: true };
        }
      } catch {
        // Not authorized or blocked
      }
      return { authorized: false };
    }
  }

  /**
   * Fetch bookmarks by status type from AnimeLib API
   * Status 1 = Watching (Смотрю)
   * Status 2 = Completed (Просмотрено)
   * Status 3 = Planned (В планах)
   */
  public async getBookmarks(status: number = 1, page: number = 1): Promise<{
    items: AnimeLibBookmarkItem[];
    hasMore: boolean;
    currentPage: number;
  }> {
    try {
      // Primary route: AnimeLib bookmarks API
      const res = await this.client.get('/api/bookmarks', {
        params: {
          status,
          page,
          type: 'anime',
        },
      });

      const rawItems: any[] = res.data?.data || [];
      const items = rawItems.map((item) => this.transformBookmark(item));
      const hasMore = !!res.data?.links?.next || !!res.data?.meta?.next_page_url;

      return {
        items,
        hasMore,
        currentPage: page,
      };
    } catch (err: any) {
      // Fallback: If API gateway is protected by Cloudflare, attempt parsing HTML profile via Cheerio
      return await this.fetchBookmarksViaWebScrape(status, page);
    }
  }

  /**
   * Helper to retrieve all titles from the "Смотрю" (Watching) list
   */
  public async getAllWatching(): Promise<AnimeLibBookmarkItem[]> {
    const all: AnimeLibBookmarkItem[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 10) {
      // Status 1 = Watching
      const result = await this.getBookmarks(1, page);
      all.push(...result.items);
      hasMore = result.hasMore;
      page++;

      if (result.items.length === 0) break;
    }

    // Also sync retrieved items to local SQLite
    for (const item of all) {
      dbService.upsertSyncItem({
        media_id: item.media_id,
        title: item.name,
        rus_title: item.rus_name,
        status: 'watching',
        last_tracked_episode: item.last_item_number,
      });
    }

    return all;
  }

  /**
   * Get fresh episodes and available voiceovers for a specific title
   */
  public async getMediaEpisodes(mediaId: number, slugUrl: string): Promise<{
    latestEpisode: number;
    voiceovers: string[];
    rawPlayers: AnimeLibPlayer[];
  }> {
    try {
      const res = await this.client.get(`/api/anime/${mediaId}/episodes`);
      const episodesData = res.data?.data || [];

      let maxEpisode = 0;
      const voiceoverSet = new Set<string>();
      const players: AnimeLibPlayer[] = [];

      for (const ep of episodesData) {
        const epNumber = parseInt(ep.number || ep.item_number || '0', 10);
        if (epNumber > maxEpisode) {
          maxEpisode = epNumber;
        }

        if (Array.isArray(ep.players)) {
          for (const p of ep.players) {
            if (p.team?.name) {
              voiceoverSet.add(p.team.name);
            }
            players.push(p);
          }
        }
      }

      return {
        latestEpisode: maxEpisode,
        voiceovers: Array.from(voiceoverSet),
        rawPlayers: players,
      };
    } catch (err) {
      // Web scrape fallback
      return await this.scrapeMediaEpisodes(slugUrl);
    }
  }

  /**
   * Fallback: Web Scraper for HTML pages using Cheerio
   */
  private async fetchBookmarksViaWebScrape(
    status: number,
    page: number
  ): Promise<{ items: AnimeLibBookmarkItem[]; hasMore: boolean; currentPage: number }> {
    try {
      const response = await axios.get(`${this.fallbackWebUrl}/ru/user/bookmarks`, {
        params: { status, page },
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Cookie: this.sessionCookie,
        },
      });

      const $ = cheerio.load(response.data);
      const items: AnimeLibBookmarkItem[] = [];

      $('[data-media-id], .media-card, .bookmark-item').each((_, el) => {
        const mediaId = parseInt($(el).attr('data-media-id') || '0', 10);
        const rusName = $(el).find('.media-card__title, .title, h3').first().text().trim();
        const engName = $(el).find('.media-card__subtitle, .subtitle').first().text().trim();
        const href = $(el).find('a').first().attr('href') || '';
        const slugUrl = href.replace(/^.*\/anime\//, '');

        if (mediaId && rusName) {
          items.push({
            bookmark_id: mediaId,
            media_id: mediaId,
            name: engName || rusName,
            rus_name: rusName,
            eng_name: engName,
            slug_url: slugUrl,
            status: AnimeLibService.mapStatusIdToString(status),
            status_id: status,
            last_item_number: 0,
            current_progress_number: 0,
            available_teams: [],
          });
        }
      });

      return {
        items,
        hasMore: items.length >= 20,
        currentPage: page,
      };
    } catch (e) {
      return { items: [], hasMore: false, currentPage: page };
    }
  }

  private async scrapeMediaEpisodes(slugUrl: string): Promise<{
    latestEpisode: number;
    voiceovers: string[];
    rawPlayers: AnimeLibPlayer[];
  }> {
    try {
      const res = await axios.get(`${this.fallbackWebUrl}/ru/anime/${slugUrl}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Cookie: this.sessionCookie,
        },
      });

      const $ = cheerio.load(res.data);
      let latestEpisode = 0;
      const voiceoverSet = new Set<string>();

      $('.episode-item, [data-episode-number]').each((_, el) => {
        const epNum = parseInt($(el).attr('data-episode-number') || $(el).text() || '0', 10);
        if (epNum > latestEpisode) latestEpisode = epNum;
      });

      $('.team-name, .player-item__team, .voice-team').each((_, el) => {
        const team = $(el).text().trim();
        if (team) voiceoverSet.add(team);
      });

      return {
        latestEpisode,
        voiceovers: Array.from(voiceoverSet),
        rawPlayers: [],
      };
    } catch {
      return { latestEpisode: 0, voiceovers: [], rawPlayers: [] };
    }
  }

  /**
   * Parse single raw bookmark object from JSON response
   */
  private transformBookmark(raw: any): AnimeLibBookmarkItem {
    const media = raw.media || {};
    const meta = raw.meta || {};
    const lastItem = media.metadata?.last_item || {};

    const availableTeams: Array<{ id: number; name: string }> = [];
    if (Array.isArray(lastItem.players)) {
      for (const p of lastItem.players) {
        if (p.team?.id && p.team?.name) {
          availableTeams.push({ id: p.team.id, name: p.team.name });
        }
      }
    }

    const lastItemNumber = parseInt(lastItem.number || '0', 10);
    const progressNumber = parseInt(meta.item_number || raw.item_number || '0', 10);

    return {
      bookmark_id: raw.id,
      media_id: raw.media_id || media.id,
      name: media.name || media.rus_name || '',
      rus_name: media.rus_name || media.name || '',
      eng_name: media.eng_name || '',
      slug_url: media.slug_url || `${media.id}--${media.slug}`,
      status: AnimeLibService.mapStatusIdToString(raw.status),
      status_id: raw.status,
      last_item_number: lastItemNumber,
      current_progress_number: progressNumber,
      available_teams: availableTeams,
      cover_url: media.cover?.default || media.cover?.thumbnail || '',
      updated_at: raw.updated_at,
    };
  }
}

export const animelibService = new AnimeLibService();
