import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { dbService, getTokens, saveTokens } from '../db/database.js';
import { animelibService, AnimeLibService } from './animelib.js';

export interface UserExclusionData {
  excludedIds: Set<number>;
  excludedKeywords: Set<string>;
}

export interface ShikimoriPoster {
  id: string;
  originalUrl: string;
  mainUrl: string;
}

export interface ShikimoriGenre {
  id: string;
  name: string;
  russian: string;
  kind?: string;
}

export interface ShikimoriAnime {
  id: string | number;
  name: string;
  russian?: string;
  score?: number;
  status?: string;
  episodes?: number;
  episodesAired?: number;
  genres?: ShikimoriGenre[];
  poster?: ShikimoriPoster;
  description?: string;
  nextEpisodeAt?: string;
}

export interface UserRateInput {
  target_id: number;
  status?: 'watching' | 'completed' | 'planned' | 'dropped' | 'on_hold' | 'rewatching';
  score?: number;
  episodes?: number;
}

const SHIKIMORI_URL = process.env.SHIKIMORI_API_URL || 'https://shikimori.io';

export const shikimoriClient = axios.create({
  baseURL: SHIKIMORI_URL,
  timeout: 15000,
  headers: {
    'User-Agent': process.env.SHIKIMORI_USER_AGENT || 'Anime Tracker Bot v2.0 (contact: boykonik2@gmail.com)',
    'Content-Type': 'application/json',
  },
  beforeRedirect: (options: any, responseDetails: any) => {
    const authorization = responseDetails.headers?.authorization;
    if (authorization) {
      options.headers = options.headers || {};
      options.headers.Authorization = authorization;
    }
  },
});

shikimoriClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const tokens = getTokens('shikimori');
  const token = tokens?.access_token || process.env.SHIKIMORI_ACCESS_TOKEN;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

shikimoriClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as (InternalAxiosRequestConfig & { _retry?: boolean }) | undefined;
    if (error.response?.status !== 401 || !originalRequest || originalRequest._retry) {
      return Promise.reject(error);
    }

    originalRequest._retry = true;
    const tokens = getTokens('shikimori');
    const refreshToken = tokens?.refresh_token || process.env.SHIKIMORI_REFRESH_TOKEN;
    if (!refreshToken) {
      console.error('[Shikimori] Missing refresh token for session renewal.');
      return Promise.reject(error);
    }

    try {
      console.log('[Shikimori] Access token expired, refreshing session...');
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.SHIKIMORI_CLIENT_ID || '',
        client_secret: process.env.SHIKIMORI_CLIENT_SECRET || '',
        refresh_token: refreshToken,
      });
      const refreshRes = await axios.post(`${SHIKIMORI_URL}/oauth/token`, params.toString(), {
        headers: {
          'User-Agent': process.env.SHIKIMORI_USER_AGENT || 'Anime Tracker Bot v2.0 (contact: githubsup972@gmail.com)',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      const { access_token, refresh_token: newRefreshToken, expires_in } = refreshRes.data;
      saveTokens('shikimori', access_token, newRefreshToken || refreshToken, expires_in || 86400);
      originalRequest.headers.Authorization = `Bearer ${access_token}`;
      return shikimoriClient(originalRequest);
    } catch (refreshError) {
      console.error('[Shikimori] Token refresh failed:', refreshError);
      return Promise.reject(refreshError);
    }
  }
);

export type ShikimoriStatus = 'planned' | 'watching' | 'completed' | 'on_hold' | 'dropped';

export function mapAnimeLibStatusToShikimori(statusId: number): ShikimoriStatus {
  switch (statusId) {
    case 21: return 'watching';
    case 22: return 'planned';
    case 23: return 'dropped';
    case 24: return 'completed';
    case 25: return 'completed'; // Любимое
    case 26: return 'watching';  // Пересматриваю
    case 27: return 'on_hold';
    // Fallback для альтернативных/устаревших кодов
    case 1: return 'planned';
    case 2: return 'watching';
    case 3: return 'completed';
    case 4: return 'dropped';
    case 5: return 'on_hold';
    default: return 'planned';
  }
}

export interface UserRatePayload {
  user_id: number;
  target_id: number;
  target_type: 'Anime';
  status: ShikimoriStatus;
  episodes?: number;
  score?: number;
}

export async function upsertUserRate(payload: UserRatePayload): Promise<any> {
  const safePayload: UserRatePayload = {
    ...payload,
    // Shikimori REST API v2 принимает для episodes строго Integer
    episodes: payload.episodes !== undefined ? Math.floor(Number(payload.episodes) || 0) : undefined,
  };

  try {
    const response = await shikimoriClient.post('/api/v2/user_rates', { user_rate: safePayload });
    return response.data;
  } catch (error: any) {
    if (error.response?.status !== 422) {
      throw error;
    }

    const ratesResponse = await shikimoriClient.get('/api/v2/user_rates', {
      params: {
        user_id: safePayload.user_id,
        target_id: safePayload.target_id,
        target_type: 'Anime',
      },
    });
    const existingRate = Array.isArray(ratesResponse.data) ? ratesResponse.data[0] : undefined;
    if (!existingRate?.id) {
      throw error;
    }

    const patchResponse = await shikimoriClient.patch(`/api/v2/user_rates/${existingRate.id}`, {
      user_rate: {
        status: safePayload.status,
        episodes: safePayload.episodes,
        score: safePayload.score,
      },
    });
    return patchResponse.data;
  }
}

export class ShikimoriService {
  private client: AxiosInstance;
  private readonly graphqlUrl = `${SHIKIMORI_URL}/api/graphql`;
  private userRatesCache: { rates: any[]; timestamp: number } | null = null;
  private exclusionCache: { data: UserExclusionData; timestamp: number } | null = null;

  constructor() {
    this.client = shikimoriClient;
  }

  invalidateExclusionCache(): void {
    this.userRatesCache = null;
    this.exclusionCache = null;
  }

  private async getHeaders() {
    const token = process.env.SHIKIMORI_ACCESS_TOKEN;
    return {
      'User-Agent': process.env.SHIKIMORI_USER_AGENT || 'ANIME ASSISTANT v2.0',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async searchAnime(searchTitle: string, limit: number = 5): Promise<ShikimoriAnime[]> {
    const query = `
      query SearchAnime($search: String, $limit: PositiveInt) {
        animes(search: $search, limit: $limit) {
          id
          name
          russian
          score
          status
          episodes
          episodesAired
          genres {
            id
            name
            russian
          }
          poster {
            id
            originalUrl
            mainUrl
          }
        }
      }
    `;

    try {
      const response = await this.client.post(
        this.graphqlUrl,
        { query, variables: { search: searchTitle, limit } },
        { headers: await this.getHeaders() }
      );
      return response.data?.data?.animes || [];
    } catch (err: any) {
      console.error(`[Shikimori GraphQL Search Error for "${searchTitle}"]`, err.message);
      return [];
    }
  }

  async getAnimeById(id: number | string): Promise<ShikimoriAnime | null> {
    const query = `
      query GetAnime($id: String!) {
        animes(ids: $id) {
          id
          name
          russian
          score
          status
          episodes
          episodesAired
          description
          genres {
            id
            name
            russian
          }
          poster {
            id
            originalUrl
            mainUrl
          }
        }
      }
    `;

    try {
      const response = await this.client.post(
        this.graphqlUrl,
        { query, variables: { id: String(id) } },
        { headers: await this.getHeaders() }
      );
      const list = response.data?.data?.animes;
      return list && list.length > 0 ? list[0] : null;
    } catch (err: any) {
      console.error(`[Shikimori GraphQL GetById Error for ${id}]`, err.message);
      return null;
    }
  }

  async getCalendar(): Promise<any[]> {
    try {
      const res = await this.client.get('/api/calendar', { headers: await this.getHeaders() });
      return res.data || [];
    } catch (err: any) {
      console.error('[Shikimori Calendar Error]', err.message);
      return [];
    }
  }

  async getUserProfile(): Promise<any | null> {
    const userId = process.env.SHIKIMORI_USER_ID;
    if (!userId) return null;

    try {
      const res = await this.client.get(`/api/users/${userId}`, { headers: await this.getHeaders() });
      return res.data;
    } catch (err: any) {
      console.error('[Shikimori Profile Error]', err.message);
      return null;
    }
  }

  async getUserFavourites(): Promise<{ animes?: any[] } | null> {
    const userId = process.env.SHIKIMORI_USER_ID;
    if (!userId) return null;

    try {
      const res = await this.client.get(`/api/users/${userId}/favourites`, { headers: await this.getHeaders() });
      return res.data || null;
    } catch (err: any) {
      return null;
    }
  }

  async getAllUserRates(forceRefresh = false): Promise<any[]> {
    const userId = process.env.SHIKIMORI_USER_ID;
    if (!userId) return [];

    if (!forceRefresh && this.userRatesCache && Date.now() - this.userRatesCache.timestamp < 300000) {
      return this.userRatesCache.rates;
    }

    try {
      const res = await this.client.get('/api/v2/user_rates', {
        params: { user_id: userId, target_type: 'Anime', limit: 5000 },
        headers: await this.getHeaders(),
      });
      const rates = Array.isArray(res.data) ? res.data : [];
      this.userRatesCache = { rates, timestamp: Date.now() };
      return rates;
    } catch (err: any) {
      console.warn('[Shikimori] Failed to fetch all user rates:', err.message);
      return this.userRatesCache ? this.userRatesCache.rates : [];
    }
  }

  async getUserExclusionData(forceRefresh = false): Promise<UserExclusionData> {
    if (!forceRefresh && this.exclusionCache && Date.now() - this.exclusionCache.timestamp < 180000) {
      return this.exclusionCache.data;
    }

    const excludedIds = new Set<number>();
    const excludedKeywords = new Set<string>();

    // 1. From Shikimori user rates: completed, watching, rewatching, dropped, on_hold
    try {
      const rates = await this.getAllUserRates(forceRefresh);
      for (const r of rates) {
        const id = Number(r.target_id);
        const status = r.status;
        if (['completed', 'watching', 'rewatching', 'dropped', 'on_hold'].includes(status)) {
          if (id) excludedIds.add(id);
        }
      }
    } catch (e: any) {
      console.warn('[Shikimori] Error processing rates for exclusion:', e.message);
    }

    // 2. From local SQLite database: watching & completed
    try {
      const allDb = dbService.getAllSyncItems();
      for (const item of allDb) {
        if (['watching', 'completed', 'dropped'].includes(item.status)) {
          if (item.shiki_id) excludedIds.add(Number(item.shiki_id));
          if (item.title) excludedKeywords.add(AnimeLibService.normalizeTitle(item.title).toLowerCase());
          if (item.rus_title) excludedKeywords.add(AnimeLibService.normalizeTitle(item.rus_title).toLowerCase());
        }
      }
    } catch (e: any) {
      console.warn('[Shikimori] Error reading SQLite for exclusion:', e.message);
    }

    // 3. From AnimeLib watching cache
    try {
      const watchingLib = await animelibService.getAllWatching();
      for (const item of watchingLib) {
        if (item.name) excludedKeywords.add(AnimeLibService.normalizeTitle(item.name).toLowerCase());
        if (item.rus_name) excludedKeywords.add(AnimeLibService.normalizeTitle(item.rus_name).toLowerCase());
      }
    } catch (e: any) {
      // Ignored if network issue, DB items already covered it
    }

    const data: UserExclusionData = { excludedIds, excludedKeywords };
    this.exclusionCache = { data, timestamp: Date.now() };
    return data;
  }

  isAnimeExcluded(anime: ShikimoriAnime, exclusion: UserExclusionData, extraExcludeIds: number[] = []): boolean {
    const id = Number(anime.id);
    if (!id) return false;

    // Direct ID check
    if (extraExcludeIds.includes(id)) return true;
    if (exclusion.excludedIds.has(id)) return true;

    // Title keywords check (prevents recommending Grand Blue Season 3 / Необъятный океан 3, etc.)
    const normRus = AnimeLibService.normalizeTitle(anime.russian || '').toLowerCase();
    const normEng = AnimeLibService.normalizeTitle(anime.name || '').toLowerCase();

    for (const kw of exclusion.excludedKeywords) {
      if (!kw || kw.length < 3) continue;
      if (normRus === kw || normEng === kw) return true;
      if (kw.length >= 4) {
        if (normRus && (normRus.includes(kw) || kw.includes(normRus))) return true;
        if (normEng && (normEng.includes(kw) || kw.includes(normEng))) return true;
      }
    }

    return false;
  }

  async getUserPlannedAnimeIds(): Promise<number[]> {
    try {
      const rates = await this.getAllUserRates();
      return rates.filter((r) => r.status === 'planned').map((r) => Number(r.target_id)).filter(Boolean);
    } catch (err: any) {
      console.error('[Shikimori Planned Error]', err.message);
      return [];
    }
  }

  async getOngoingAnime(limit: number = 25, page: number = 1): Promise<ShikimoriAnime[]> {
    const query = `
      query GetOngoing($page: PositiveInt, $limit: PositiveInt) {
        animes(status: "ongoing", order: popularity, page: $page, limit: $limit) {
          id
          name
          russian
          score
          status
          episodes
          episodesAired
          description
          genres {
            id
            name
            russian
          }
          poster {
            id
            originalUrl
            mainUrl
          }
        }
      }
    `;

    try {
      const response = await this.client.post(
        this.graphqlUrl,
        { query, variables: { page, limit } },
        { headers: await this.getHeaders() }
      );
      return response.data?.data?.animes || [];
    } catch (err: any) {
      console.error('[Shikimori Ongoing Error]', err.message);
      return [];
    }
  }

  async getRandomPlannedAnime(): Promise<ShikimoriAnime | null> {
    const rec = await this.getRandomRecommendation('planned');
    return rec ? rec.anime : null;
  }

  private async getRandomPlannedRecommendation(
    exclusion: UserExclusionData,
    excludeIds: number[]
  ): Promise<{ anime: ShikimoriAnime; source: 'planned' } | null> {
    const plannedIds = await this.getUserPlannedAnimeIds();
    // Exclude anything in excludeIds or user exclusion (watching/completed)
    const eligibleIds = plannedIds.filter((id) => !exclusion.excludedIds.has(id) && !excludeIds.includes(id));

    if (eligibleIds.length === 0) {
      return null;
    }

    // Try up to 10 random candidates to find one that passes title exclusion
    const shuffled = [...eligibleIds].sort(() => Math.random() - 0.5).slice(0, 10);
    for (const randomId of shuffled) {
      const anime = await this.getAnimeById(randomId);
      if (anime && !this.isAnimeExcluded(anime, exclusion, excludeIds)) {
        return { anime, source: 'planned' };
      }
    }
    return null;
  }

  private async getRandomOngoingRecommendation(
    exclusion: UserExclusionData,
    excludeIds: number[]
  ): Promise<{ anime: ShikimoriAnime; source: 'ongoing'; isAlsoPlanned?: boolean } | null> {
    const randomPage = Math.floor(Math.random() * 4) + 1;
    let ongoings = await this.getOngoingAnime(25, randomPage);
    if (ongoings.length === 0 && randomPage !== 1) {
      ongoings = await this.getOngoingAnime(25, 1);
    }

    const candidates = ongoings.filter((a) => !this.isAnimeExcluded(a, exclusion, excludeIds));

    if (candidates.length > 0) {
      const picked = candidates[Math.floor(Math.random() * candidates.length)];
      const fullAnime = picked.description ? picked : (await this.getAnimeById(picked.id)) || picked;

      const plannedIds = await this.getUserPlannedAnimeIds();
      const isAlsoPlanned = plannedIds.includes(Number(fullAnime.id));

      return { anime: fullAnime, source: 'ongoing', isAlsoPlanned };
    }

    // Fallback: try page 1
    const page1Ongoings = await this.getOngoingAnime(30, 1);
    const p1Candidates = page1Ongoings.filter((a) => !this.isAnimeExcluded(a, exclusion, excludeIds));
    if (p1Candidates.length > 0) {
      const picked = p1Candidates[Math.floor(Math.random() * p1Candidates.length)];
      const fullAnime = picked.description ? picked : (await this.getAnimeById(picked.id)) || picked;
      const plannedIds = await this.getUserPlannedAnimeIds();
      const isAlsoPlanned = plannedIds.includes(Number(fullAnime.id));
      return { anime: fullAnime, source: 'ongoing', isAlsoPlanned };
    }

    return null;
  }

  async getRandomRecommendation(
    category: 'all' | 'planned' | 'ongoing' = 'all',
    excludeIds: number[] = []
  ): Promise<{ anime: ShikimoriAnime; source: 'planned' | 'ongoing'; isAlsoPlanned?: boolean } | null> {
    const exclusion = await this.getUserExclusionData();

    // 1. If strictly 'planned'
    if (category === 'planned') {
      return this.getRandomPlannedRecommendation(exclusion, excludeIds);
    }

    // 2. If strictly 'ongoing'
    if (category === 'ongoing') {
      return this.getRandomOngoingRecommendation(exclusion, excludeIds);
    }

    // 3. If 'all' (randomly balance between unstarted planned and ongoing)
    const preferPlanned = Math.random() < 0.5;
    if (preferPlanned) {
      const planned = await this.getRandomPlannedRecommendation(exclusion, excludeIds);
      if (planned) return planned;
      return this.getRandomOngoingRecommendation(exclusion, excludeIds);
    } else {
      const ongoing = await this.getRandomOngoingRecommendation(exclusion, excludeIds);
      if (ongoing) return ongoing;
      return this.getRandomPlannedRecommendation(exclusion, excludeIds);
    }
  }

  async updateUserRate(rate: UserRateInput): Promise<any> {
    this.invalidateExclusionCache();
    const userId = process.env.SHIKIMORI_USER_ID;
    if (!userId) throw new Error('SHIKIMORI_USER_ID is missing in .env');

    const headers = await this.getHeaders();

    const checkRes = await this.client.get('/api/v2/user_rates', {
      params: { user_id: userId, target_id: rate.target_id, target_type: 'Anime' },
      headers,
    });

    const existingList = checkRes.data || [];

    if (existingList.length > 0) {
      const existingId = existingList[0].id;
      const patchData: any = {};
      if (rate.status) patchData.status = rate.status;
      if (rate.episodes !== undefined) patchData.episodes = Math.floor(Number(rate.episodes) || 0);
      if (rate.score !== undefined) patchData.score = rate.score;

      const res = await this.client.patch(`/api/v2/user_rates/${existingId}`, { user_rate: patchData }, { headers });
      return res.data;
    } else {
      const postData = {
        user_id: Number(userId),
        target_id: rate.target_id,
        target_type: 'Anime',
        status: rate.status || 'watching',
        episodes: rate.episodes !== undefined ? Math.floor(Number(rate.episodes) || 0) : 0,
        score: rate.score || 0,
      };

      const res = await this.client.post('/api/v2/user_rates', { user_rate: postData }, { headers });
      return res.data;
    }
  }
}

export const shikimoriService = new ShikimoriService();