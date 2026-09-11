import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { dbService, getTokens, saveTokens } from '../db/database.js';

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
  try {
    const response = await shikimoriClient.post('/api/v2/user_rates', { user_rate: payload });
    return response.data;
  } catch (error: any) {
    if (error.response?.status !== 422) {
      throw error;
    }

    const ratesResponse = await shikimoriClient.get('/api/v2/user_rates', {
      params: {
        user_id: payload.user_id,
        target_id: payload.target_id,
        target_type: 'Anime',
      },
    });
    const existingRate = Array.isArray(ratesResponse.data) ? ratesResponse.data[0] : undefined;
    if (!existingRate?.id) {
      throw error;
    }

    const patchResponse = await shikimoriClient.patch(`/api/v2/user_rates/${existingRate.id}`, {
      user_rate: {
        status: payload.status,
        episodes: payload.episodes,
        score: payload.score,
      },
    });
    return patchResponse.data;
  }
}

export class ShikimoriService {
  private client: AxiosInstance;
  private readonly graphqlUrl = `${SHIKIMORI_URL}/api/graphql`;

  constructor() {
    this.client = shikimoriClient;
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

  async getRandomPlannedAnime(): Promise<ShikimoriAnime | null> {
    try {
      const searchResults = await this.searchAnime('', 10);
      if (searchResults && searchResults.length > 0) {
        const random = searchResults[Math.floor(Math.random() * searchResults.length)];
        return await this.getAnimeById(random.id);
      }
      return null;
    } catch {
      return null;
    }
  }

  async updateUserRate(rate: UserRateInput): Promise<any> {
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
      if (rate.episodes !== undefined) patchData.episodes = rate.episodes;
      if (rate.score !== undefined) patchData.score = rate.score;

      const res = await this.client.patch(`/api/v2/user_rates/${existingId}`, { user_rate: patchData }, { headers });
      return res.data;
    } else {
      const postData = {
        user_id: Number(userId),
        target_id: rate.target_id,
        target_type: 'Anime',
        status: rate.status || 'watching',
        episodes: rate.episodes || 0,
        score: rate.score || 0,
      };

      const res = await this.client.post('/api/v2/user_rates', { user_rate: postData }, { headers });
      return res.data;
    }
  }
}

export const shikimoriService = new ShikimoriService();