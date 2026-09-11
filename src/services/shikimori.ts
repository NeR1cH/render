import axios, { AxiosInstance } from 'axios';
import dotenv from 'dotenv';
import { dbService } from '../db/database';

dotenv.config();

// User-Agent is strictly required by Shikimori to avoid Cloudflare/DDoS-GUARD blocks
const SHIKIMORI_USER_AGENT =
  process.env.SHIKIMORI_USER_AGENT || 'ANIME ASSISTANT v2.0 (contact: boykonik2@gmail.com)';
const SHIKIMORI_GRAPHQL_URL = 'https://shikimori.one/api/graphql';
const SHIKIMORI_API_V2_URL = 'https://shikimori.one/api/v2';
const SHIKIMORI_API_V1_URL = 'https://shikimori.one/api';
const SHIKIMORI_OAUTH_TOKEN_URL = 'https://shikimori.one/oauth/token';

export interface ShikimoriAnime {
  id: string | number;
  malId?: string | number;
  name: string;
  russian?: string;
  licenseNameRu?: string;
  english?: string;
  kind?: string;
  score?: number;
  status?: string;
  episodes?: number;
  episodesAired?: number;
  description?: string;
  poster?: {
    id?: string;
    originalUrl?: string;
    mainUrl?: string;
  };
  genres?: Array<{ id: string; name: string; russian: string }>;
  nextEpisodeAt?: string;
  url?: string;
}

export interface UserRateInput {
  target_id: number;
  target_type?: 'Anime';
  status: 'watching' | 'completed' | 'planned' | 'dropped' | 'on_hold' | 'rewatching';
  episodes?: number;
  score?: number;
  re_watches?: number;
  text?: string;
}

export class ShikimoriService {
  private client: AxiosInstance;
  private clientId: string;
  private clientSecret: string;

  constructor() {
    this.clientId = process.env.SHIKIMORI_CLIENT_ID || '';
    this.clientSecret = process.env.SHIKIMORI_CLIENT_SECRET || '';

    this.client = axios.create({
      headers: {
        'User-Agent': SHIKIMORI_USER_AGENT,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
  }

  /**
   * Helper to get active OAuth access token, refreshing it if expired
   */
  public async getValidAccessToken(): Promise<string | null> {
    const tokenRecord = dbService.getAuthTokens('shikimori');
    if (!tokenRecord || !tokenRecord.access_token) {
      return process.env.SHIKIMORI_ACCESS_TOKEN || null;
    }

    const now = Math.floor(Date.now() / 1000);
    // Check if token expires in less than 5 minutes (300 seconds)
    if (tokenRecord.expires_at && tokenRecord.expires_at - now < 300 && tokenRecord.refresh_token) {
      try {
        const refreshed = await this.refreshToken(tokenRecord.refresh_token);
        return refreshed;
      } catch (err) {
        console.error('Failed to refresh Shikimori OAuth token:', err);
        return tokenRecord.access_token;
      }
    }

    return tokenRecord.access_token;
  }

  /**
   * Refresh OAuth token using refresh_token grant
   */
  public async refreshToken(refreshToken: string): Promise<string> {
    const res = await axios.post(
      SHIKIMORI_OAUTH_TOKEN_URL,
      {
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
      },
      {
        headers: {
          'User-Agent': SHIKIMORI_USER_AGENT,
          'Content-Type': 'application/json',
        },
      }
    );

    const { access_token, refresh_token: new_refresh_token, expires_in } = res.data;
    const expires_at = Math.floor(Date.now() / 1000) + (expires_in || 86400);

    dbService.saveAuthTokens({
      service: 'shikimori',
      access_token,
      refresh_token: new_refresh_token || refreshToken,
      expires_at,
    });

    return access_token;
  }

  /**
   * Universal GraphQL Query Executor for Shikimori
   */
  public async queryGraphQL<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
    const token = await this.getValidAccessToken();
    const headers: Record<string, string> = {
      'User-Agent': SHIKIMORI_USER_AGENT,
      'Content-Type': 'application/json',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await this.client.post(
      SHIKIMORI_GRAPHQL_URL,
      {
        query,
        variables,
      },
      { headers }
    );

    if (response.data.errors && response.data.errors.length > 0) {
      throw new Error(`Shikimori GraphQL Error: ${JSON.stringify(response.data.errors)}`);
    }

    return response.data.data;
  }

  // ==========================================
  // 1. Search Anime (GraphQL)
  // ==========================================
  public async searchAnime(searchTitle: string, limit: number = 10): Promise<ShikimoriAnime[]> {
    const query = `
      query SearchAnime($search: String!, $limit: Int!) {
        animes(search: $search, limit: $limit, order: ranked) {
          id
          malId
          name
          russian
          licenseNameRu
          english
          kind
          score
          status
          episodes
          episodesAired
          description
          poster {
            id
            originalUrl
            mainUrl
          }
          genres {
            id
            name
            russian
          }
          nextEpisodeAt
          url
        }
      }
    `;

    const data = await this.queryGraphQL<{ animes: ShikimoriAnime[] }>(query, {
      search: searchTitle,
      limit,
    });

    return data?.animes || [];
  }

  // ==========================================
  // 2. Top Anime (GraphQL)
  // ==========================================
  public async getTopAnime(limit: number = 15, page: number = 1): Promise<ShikimoriAnime[]> {
    const query = `
      query GetTopAnime($limit: Int!, $page: Int!) {
        animes(page: $page, limit: $limit, order: ranked) {
          id
          name
          russian
          kind
          score
          status
          episodes
          episodesAired
          poster {
            mainUrl
          }
          genres {
            russian
          }
          url
        }
      }
    `;

    const data = await this.queryGraphQL<{ animes: ShikimoriAnime[] }>(query, {
      limit,
      page,
    });

    return data?.animes || [];
  }

  // ==========================================
  // 3. Ongoing Anime (GraphQL)
  // ==========================================
  public async getOngoingAnime(limit: number = 15, page: number = 1): Promise<ShikimoriAnime[]> {
    const query = `
      query GetOngoingAnime($limit: Int!, $page: Int!) {
        animes(page: $page, limit: $limit, status: "ongoing", order: popularity) {
          id
          name
          russian
          kind
          score
          status
          episodes
          episodesAired
          nextEpisodeAt
          poster {
            mainUrl
          }
          genres {
            russian
          }
          url
        }
      }
    `;

    const data = await this.queryGraphQL<{ animes: ShikimoriAnime[] }>(query, {
      limit,
      page,
    });

    return data?.animes || [];
  }

  // ==========================================
  // 4. Update / Create user_rate (API v2)
  // ==========================================
  /**
   * Updates or creates a user_rate record on Shikimori (watching, completed, planned, dropped).
   * Uses Shikimori API v2 /api/v2/user_rates with OAuth Bearer token.
   */
  public async updateUserRate(rate: UserRateInput): Promise<any> {
    const token = await this.getValidAccessToken();
    if (!token) {
      throw new Error(
        'Missing Shikimori OAuth access token. Please authorize via OAuth to update user_rates.'
      );
    }

    const tokenRecord = dbService.getAuthTokens('shikimori');
    const userId = tokenRecord?.user_id || process.env.SHIKIMORI_USER_ID;

    if (!userId) {
      throw new Error('Shikimori user_id is required to synchronize user_rates.');
    }

    const payload = {
      user_rate: {
        user_id: parseInt(userId, 10),
        target_id: rate.target_id,
        target_type: rate.target_type || 'Anime',
        status: rate.status,
        episodes: rate.episodes,
        score: rate.score,
        rewatches: rate.re_watches,
        text: rate.text,
      },
    };

    try {
      // First try to check existing user_rate for this anime
      const existingRes = await this.client.get(
        `${SHIKIMORI_API_V2_URL}/user_rates`,
        {
          params: {
            user_id: userId,
            target_id: rate.target_id,
            target_type: 'Anime',
          },
          headers: {
            'User-Agent': SHIKIMORI_USER_AGENT,
            Authorization: `Bearer ${token}`,
          },
        }
      );

      const existingRates = existingRes.data;
      if (Array.isArray(existingRates) && existingRates.length > 0) {
        const rateId = existingRates[0].id;
        // PATCH existing user_rate
        const patchRes = await this.client.patch(
          `${SHIKIMORI_API_V2_URL}/user_rates/${rateId}`,
          payload,
          {
            headers: {
              'User-Agent': SHIKIMORI_USER_AGENT,
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          }
        );
        return patchRes.data;
      } else {
        // POST new user_rate
        const postRes = await this.client.post(
          `${SHIKIMORI_API_V2_URL}/user_rates`,
          payload,
          {
            headers: {
              'User-Agent': SHIKIMORI_USER_AGENT,
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          }
        );
        return postRes.data;
      }
    } catch (err: any) {
      const errMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      throw new Error(`Failed to update user_rate on Shikimori: ${errMsg}`);
    }
  }

  // ==========================================
  // 5. Direct Details by ID (GraphQL)
  // ==========================================
  public async getAnimeById(id: number | string): Promise<ShikimoriAnime | null> {
    const query = `
      query GetAnimeById($ids: String!) {
        animes(ids: $ids, limit: 1) {
          id
          malId
          name
          russian
          english
          kind
          score
          status
          episodes
          episodesAired
          description
          poster {
            originalUrl
            mainUrl
          }
          genres {
            name
            russian
          }
          nextEpisodeAt
          url
        }
      }
    `;

    const data = await this.queryGraphQL<{ animes: ShikimoriAnime[] }>(query, {
      ids: String(id),
    });

    return data?.animes?.[0] || null;
  }
}

export const shikimoriService = new ShikimoriService();
