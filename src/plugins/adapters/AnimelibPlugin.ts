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

  private readonly apiBase = 'https://api.lib.social/api';
  private readonly defaultMirrorHost = 'cache.lib.social';

  async getStreams(query: EpisodeQuery): Promise<StreamResult[]> {
    const { mediaId, episode, voiceover } = query;
    const rawPlayers = await this.fetchEpisodePlayers(mediaId, episode);

    if (!rawPlayers || rawPlayers.length === 0) {
      return [];
    }

    const results: StreamResult[] = [];

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

    return results;
  }

  private async fetchEpisodePlayers(mediaId: number, episode: number): Promise<RawPlayerPayload[]> {
    try {
      const url = `${this.apiBase}/anime/${mediaId}/episodes`;
      const res = await axios.get<{ data?: Array<{ id: number; number: number | string }> }>(url, {
        headers: this.buildHeaders('https://animelib.org/'),
        timeout: 7000,
      });

      const epList = res.data?.data || [];
      const targetEp = epList.find((e) => Number(e.number) === episode);
      if (!targetEp) {
        return [];
      }

      // Получаем плееры конкретного эпизода
      const epPlayersUrl = `${this.apiBase}/anime/${mediaId}/episodes/${targetEp.id}/players`;
      const playersRes = await axios.get<{ data?: RawPlayerPayload[] }>(epPlayersUrl, {
        headers: this.buildHeaders('https://animelib.org/'),
        timeout: 7000,
      });

      return playersRes.data?.data || [];
    } catch {
      return [];
    }
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
            headers: this.buildHeaders('https://animelib.org/', 'https://animelib.org'),
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
              headers: this.buildHeaders('https://animelib.org/', 'https://animelib.org'),
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
              headers: this.buildHeaders('https://animelib.org/', 'https://animelib.org'),
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
        list.push({
          url: streamUrl,
          quality: '1080p',
          format: this.detectFormat(streamUrl),
          headers: this.buildHeaders('https://animelib.org/', 'https://animelib.org'),
          voiceover,
          source: this.id,
        });
      }
    }

    // Сортировка по качеству (2160p -> 1080p -> 720p -> 480p -> 360p)
    return this.sortStreamsByQuality(list);
  }

  private resolvePlayerHost(player: RawPlayerPayload): string {
    let host =
      player.host ||
      player.video?.host ||
      (typeof player.src === 'object' && player.src?.host ? player.src.host : null) ||
      this.defaultMirrorHost;

    if (
      typeof host === 'string' &&
      (host.includes('video.animelib.me') || host.includes('video.cdnlibs.org') || host.includes('cdnlibs.org'))
    ) {
      host = this.defaultMirrorHost;
    }

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

    const cleanHost = (host || this.defaultMirrorHost).replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (trimmed.startsWith('/')) {
      return `https://${cleanHost}${trimmed}`;
    }

    return `https://${cleanHost}/${trimmed}`;
  }

  private sortStreamsByQuality(streams: StreamResult[]): StreamResult[] {
    const weight: Record<StreamQuality, number> = {
      '2160p': 5,
      '1080p': 4,
      '720p': 3,
      '480p': 2,
      '360p': 1,
      'auto': 0,
    };

    return [...streams].sort((a, b) => (weight[b.quality] || 0) - (weight[a.quality] || 0));
  }
}
