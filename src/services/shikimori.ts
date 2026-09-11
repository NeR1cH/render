import axios, { AxiosInstance } from 'axios';
import { dbService } from '../db/database.js';

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

export class ShikimoriService {
  private client: AxiosInstance;
  private readonly baseUrl = 'https://shikimori.one';
  private readonly graphqlUrl = 'https://shikimori.one/api/graphql';

  constructor() {
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: {
        'User-Agent': process.env.SHIKIMORI_USER_AGENT || 'ANIME ASSISTANT v2.0 (contact: githubsup972@gmail.com)',
        'Content-Type': 'application/json',
      },
    });
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