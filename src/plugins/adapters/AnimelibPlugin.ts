import axios from 'axios';
import { BaseSourcePlugin } from '../BaseSourcePlugin.js';
import { EpisodeQuery, StreamQuality, StreamResult } from '../types.js';

interface RawQualityItem {
  resolution?: number | string;
  quality?: string | number;
  href?: string;
  url?: string;
  src?: string;
  file?: string;
  link?: string;
  stream?: string;
  path?: string;
  host?: string;
  data?: { host?: string };
}

interface RawPlayerPayload {
  id?: number | string;
  player?: string;
  translation?: { title?: string; id?: number };
  team?: { name?: string; id?: number };
  video?: {
    host?: string;
    quality?: RawQualityItem[] | Record<string, string | RawQualityItem>;
    src?: string;
    href?: string;
  };
  src?: string | { host?: string; quality?: RawQualityItem[] };
  host?: string;
  quality?: RawQualityItem[] | Record<string, string | RawQualityItem>;
  qualities?: RawQualityItem[];
}

export class AnimelibPlugin extends BaseSourcePlugin {
  readonly id = 'animelib';
  readonly name = 'AnimeLib Native HAPI v2';
  readonly priority = 100;

  private readonly apiBases = [
    process.env.ANIMELIB_API_URL,
    'https://hapi.hentaicdn.org/api',
  ].filter(Boolean) as string[];

  private readonly defaultApiHost = 'hapi.hentaicdn.org';

  private getAnimelibApiHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Site-Id': '5',
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://animelib.me',
      'Referer': 'https://animelib.me/',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    };

    if (process.env.ANIMELIB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.ANIMELIB_TOKEN.replace(/^Bearer\s+/i, '')}`;
    }

    if (process.env.ANIMELIB_COOKIE) {
      headers['Cookie'] = process.env.ANIMELIB_COOKIE;
    }

    return headers;
  }

  async getStreams(query: EpisodeQuery): Promise<StreamResult[]> {
    const { mediaId, episode, voiceover } = query;
    const rawPlayers = await this.fetchEpisodePlayers(mediaId, episode);

    const results: StreamResult[] = [];

    if (rawPlayers && rawPlayers.length > 0) {
      // Фильтрация и сортировка плееров
      const sortedPlayers = this.sortPlayersByVoiceover(rawPlayers, voiceover);

      for (const player of sortedPlayers) {
        // Игнорируем Kodik плееры в этом плагине — для них есть KodikPlugin
        const playerType = String(player.player || '').toLowerCase();
        if (playerType.includes('kodik')) {
          continue;
        }

        const voiceoverName =
          player.translation?.title || player.team?.name || player.player || 'Оригинал / AnimeLib';

        const streams = this.extractStreamsFromPlayer(player, voiceoverName);
        for (const stream of streams) {
          // Логируем реальный сгенерированный URL стрима перед проверкой
          console.log(`[AnimelibPlugin] Проверка нативного стрима (${stream.quality}, ${stream.voiceover}): ${stream.url}`);
          // Проверяем живой ли стрим, не отбрасывая доверенные ноды
          const isAlive = await this.isStreamLikelyAlive(stream.url, stream.headers);
          if (isAlive) {
            results.push(stream);
          }
        }

        // Если нашли качественные стримы для подходящей озвучки, возвращаем их
        if (results.length > 0 && voiceover) {
          const matchesVoiceover = voiceoverName.toLowerCase().includes(voiceover.toLowerCase());
          if (matchesVoiceover) {
            break;
          }
        }
      }
    }

    return results;
  }

  private async fetchEpisodePlayers(mediaId: number, episode: number): Promise<RawPlayerPayload[]> {
    console.log(`[AnimelibPlugin] Запрос серий для mediaId: ${mediaId}...`);
    const requestHeaders = this.getAnimelibApiHeaders();

    for (const base of this.apiBases) {
      try {
        const url = `${base}/anime/${mediaId}/episodes`;
        let res: any;
        try {
          res = await axios.get<any>(url, {
            headers: requestHeaders,
            timeout: 8000,
          });
        } catch {
          // Альтернативный эндпоинт query param
          res = await axios.get<any>(`${base}/episodes`, {
            params: { anime_id: mediaId },
            headers: requestHeaders,
            timeout: 8000,
          });
        }

        const epList = Array.isArray(res.data) ? res.data : (res.data?.data || []);
        console.log(
          `[AnimelibPlugin] Найдено серий в API (${base}): ${epList.length}. Доступные номера: ${epList.map((e: any) => e.number || e.item_number || e.episode).slice(0, 10).join(', ')}...`
        );

        const targetEp = epList.find((e: any) => Number(e.number || e.item_number || e.episode) === Number(episode));
        if (!targetEp) {
          console.warn(`[AnimelibPlugin] Серия #${episode} отсутствует в списке доступных серий тайтла ${mediaId}`);
          return [];
        }

        // Если у эпизода уже есть массив players
        if (Array.isArray(targetEp.players) && targetEp.players.length > 0) {
          console.log('[AnimelibPlugin] Ответ API плееров (из списка эпизодов):', JSON.stringify(targetEp.players));
          return targetEp.players;
        }

        // Получаем плееры конкретного эпизода через эндпоинты плееров
        const epPlayersEndpoints = [
          `${base}/anime/${mediaId}/episodes/${targetEp.id}/players`,
          `${base}/episodes/${targetEp.id}/players`,
        ];

        for (const epPlayersUrl of epPlayersEndpoints) {
          try {
            const playersRes = await axios.get<any>(epPlayersUrl, {
              headers: requestHeaders,
              timeout: 8000,
            });
            console.log('[AnimelibPlugin] Ответ API плееров:', JSON.stringify(playersRes.data));
            const players = Array.isArray(playersRes.data) ? playersRes.data : (playersRes.data?.data || []);
            if (players.length > 0) return players;
          } catch {}
        }

        try {
          const epDetailRes = await axios.get<any>(`${base}/episodes/${targetEp.id}`, {
            headers: requestHeaders,
            timeout: 8000,
          });
          console.log('[AnimelibPlugin] Ответ API деталей эпизода:', JSON.stringify(epDetailRes.data));
          const players = epDetailRes.data?.data?.players || epDetailRes.data?.players || [];
          if (players.length > 0) return players;
        } catch {}

        return [];
      } catch (err: any) {
        console.warn(`[AnimelibPlugin] Ошибка при запросе эпизодов через ${base}:`, err?.code || err?.response?.status || err?.message);
      }
    }

    return [];
  }

  private sortPlayersByVoiceover(players: RawPlayerPayload[], preferredVoiceover?: string): RawPlayerPayload[] {
    if (!preferredVoiceover) return players;

    const query = preferredVoiceover.toLowerCase().trim();
    return [...players].sort((a, b) => {
      const aName = `${a.translation?.title || ''} ${a.team?.name || ''}`.toLowerCase();
      const bName = `${b.translation?.title || ''} ${b.team?.name || ''}`.toLowerCase();

      const aMatch = aName.includes(query);
      const bMatch = bName.includes(query);

      if (aMatch && !bMatch) return -1;
      if (!aMatch && bMatch) return 1;
      return 0;
    });
  }

  private extractStreamsFromPlayer(player: RawPlayerPayload, voiceover: string): StreamResult[] {
    const list: StreamResult[] = [];
    const baseHost = this.resolvePlayerHost(player);

    const rawQualities =
      player.video?.quality ||
      player.quality ||
      player.qualities ||
      (typeof player.src === 'object' && player.src !== null ? player.src.quality : undefined);

    if (Array.isArray(rawQualities)) {
      for (const item of rawQualities) {
        const streamUrl = this.normalizeHref(
          item.href || item.url || item.src || item.file || item.link || item.stream || item.path,
          item.host || item.data?.host || baseHost
        );
        if (streamUrl) {
          const q = this.normalizeQuality(item.resolution || item.quality);
          list.push({
            url: streamUrl,
            quality: q,
            format: this.detectFormat(streamUrl),
            headers: this.buildHeaders('https://animelib.me/', 'https://animelib.me'),
            voiceover,
            source: this.id,
          });
        }
      }
    } else if (rawQualities && typeof rawQualities === 'object') {
      const entries = Object.entries(rawQualities);
      for (const [qKey, val] of entries) {
        if (typeof val === 'string') {
          const streamUrl = this.normalizeHref(val, baseHost);
          if (streamUrl) {
            list.push({
              url: streamUrl,
              quality: this.normalizeQuality(qKey),
              format: this.detectFormat(streamUrl),
              headers: this.buildHeaders('https://animelib.me/', 'https://animelib.me'),
              voiceover,
              source: this.id,
            });
          }
        } else if (val && typeof val === 'object') {
          const streamUrl = this.normalizeHref(
            val.href || val.url || val.src || val.file || val.link || val.stream || val.path,
            val.host || val.data?.host || baseHost
          );
          if (streamUrl) {
            list.push({
              url: streamUrl,
              quality: this.normalizeQuality(val.resolution || val.quality || qKey),
              format: this.detectFormat(streamUrl),
              headers: this.buildHeaders('https://animelib.me/', 'https://animelib.me'),
              voiceover,
              source: this.id,
            });
          }
        }
      }
    }

    // Проверяем прямое поле video.src или src
    const singleSrc =
      (typeof player.video?.src === 'string' && player.video.src) ||
      (typeof player.video?.href === 'string' && player.video.href) ||
      (typeof player.src === 'string' && player.src);

    if (singleSrc && list.length === 0) {
      const streamUrl = this.normalizeHref(singleSrc, baseHost);
      if (streamUrl) {
        // Определяем качество из URL или метаданных плеера, иначе дефолт 1080p
        const detectedQuality = this.normalizeQuality(
          (player as any).resolution || (player as any).quality || (player.video as any)?.resolution || singleSrc
        );
        list.push({
          url: streamUrl,
          quality: detectedQuality,
          format: this.detectFormat(streamUrl),
          headers: this.buildHeaders('https://animelib.me/', 'https://animelib.me'),
          voiceover,
          source: this.id,
        });

        // Если это шаблонный URL вида ..._1080.mp4 или .../1080p.mp4, генерируем альтернативные качества при наличии флага
        if (streamUrl.includes('_1080.mp4')) {
          const url720 = streamUrl.replace('_1080.mp4', '_720.mp4');
          list.push({
            url: url720,
            quality: '720p',
            format: 'mp4',
            headers: this.buildHeaders('https://animelib.me/', 'https://animelib.me'),
            voiceover,
            source: this.id,
          });
        }
      }
    }

    // Сортировка по качеству (2160p -> 1440p -> 1080p -> 720p -> 480p -> 360p)
    return this.sortStreamsByQuality(list);
  }

  private resolvePlayerHost(player: RawPlayerPayload): string {
    const host =
      player.host ||
      player.video?.host ||
      (typeof player.src === 'object' && player.src?.host ? player.src.host : null) ||
      this.defaultApiHost;

    return String(host).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }

  private normalizeHref(href?: string | null, host?: string): string | null {
    if (!href || typeof href !== 'string') return null;
    const trimmed = href.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }

    if (trimmed.startsWith('//')) {
      return `https:${trimmed}`;
    }

    const cleanHost = (host || this.defaultApiHost).replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (trimmed.startsWith('/')) {
      return `https://${cleanHost}${trimmed}`;
    }

    return `https://${cleanHost}/${trimmed}`;
  }

  private sortStreamsByQuality(streams: StreamResult[]): StreamResult[] {
    const weight: Record<StreamQuality, number> = {
      '2160p': 6,
      '1440p': 5,
      '1080p': 4,
      '720p': 3,
      '480p': 2,
      '360p': 1,
      'auto': 0,
    };

    return [...streams].sort((a, b) => (weight[b.quality] || 0) - (weight[a.quality] || 0));
  }
}
