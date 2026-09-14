import axios from 'axios';
import { BaseSourcePlugin } from '../BaseSourcePlugin.js';
import { EpisodeQuery, StreamResult } from '../types.js';

interface RawEpisodePlayer {
  id?: number;
  player?: string;
  translation?: { title?: string };
  team?: { name?: string };
  src?: string | { host?: string };
  video?: { src?: string; href?: string };
}

export class KodikPlugin extends BaseSourcePlugin {
  readonly id = 'kodik';
  readonly name = 'Kodik External Player';
  readonly priority = 50;

  private readonly apiBase = 'https://api.lib.social/api';

  async getStreams(query: EpisodeQuery): Promise<StreamResult[]> {
    const { mediaId, episode, voiceover } = query;
    const kodikUrls = await this.findKodikPlayerUrls(mediaId, episode);

    if (kodikUrls.length === 0) {
      return [];
    }

    const results: StreamResult[] = [];

    for (const item of kodikUrls) {
      const stream = await this.resolveKodikManifest(item.url, item.voiceover || voiceover);
      if (stream) {
        const isAlive = await this.isStreamLikelyAlive(stream.url, stream.headers);
        if (isAlive) {
          results.push(stream);
        }
      }
    }

    return results;
  }

  private async findKodikPlayerUrls(
    mediaId: number,
    episode: number
  ): Promise<Array<{ url: string; voiceover?: string }>> {
    try {
      console.log(`[KodikPlugin] Запрос серий для mediaId: ${mediaId}...`);
      const epUrl = `${this.apiBase}/anime/${mediaId}/episodes`;
      const res = await axios.get<any>(epUrl, {
        headers: this.buildHeaders('https://animelib.org/'),
        timeout: 7000,
      });

      const epList = Array.isArray(res.data) ? res.data : (res.data?.data || []);
      console.log(
        `[KodikPlugin] Найдено серий в API: ${epList.length}. Доступные номера: ${epList.map((e: any) => e.number || e.item_number || e.episode).slice(0, 10).join(', ')}...`
      );

      const targetEp = epList.find((e: any) => Number(e.number || e.item_number || e.episode) === Number(episode));
      if (!targetEp) {
        console.warn(`[KodikPlugin] Серия #${episode} отсутствует в списке доступных серий тайтла ${mediaId}`);
        return [];
      }

      const epPlayersUrl = `${this.apiBase}/anime/${mediaId}/episodes/${targetEp.id}/players`;
      const playersRes = await axios.get<any>(epPlayersUrl, {
        headers: this.buildHeaders('https://animelib.org/'),
        timeout: 7000,
      });

      const players = Array.isArray(playersRes.data) ? playersRes.data : (playersRes.data?.data || []);
      const list: Array<{ url: string; voiceover?: string }> = [];

      for (const pl of players) {
        const playerType = String(pl.player || '').toLowerCase();
        let src = typeof pl.src === 'string' ? pl.src : pl.video?.src || pl.video?.href;

        if (src && (playerType.includes('kodik') || src.includes('kodik') || src.includes('aniqit'))) {
          if (src.startsWith('//')) {
            src = `https:${src}`;
          } else if (src.startsWith('/')) {
            src = `https://kodikplayer.com${src}`;
          }
          const v = pl.translation?.title || pl.team?.name || 'Kodik';
          list.push({ url: src, voiceover: v });
        }
      }

      return list;
    } catch (err: any) {
      console.warn(`[KodikPlugin] Ошибка при запросе эпизодов:`, err?.response?.status, err?.message);
      return [];
    }
  }

  private async resolveKodikManifest(kodikUrl: string, voiceover?: string): Promise<StreamResult | null> {
    try {
      const parsed = new URL(kodikUrl);
      const origin = `${parsed.protocol}//${parsed.host}`;

      const res = await axios.get<string>(kodikUrl, {
        headers: this.buildHeaders(kodikUrl, origin),
        timeout: 8000,
      });

      const html = res.data;
      if (typeof html !== 'string') {
        return null;
      }

      // 1. Поиск прямого m3u8 в исходном коде плеера
      const m3u8Match = html.match(/https?:\/\/[^"'\s\\]+?\.m3u8[^"'\s\\]*/i);
      if (m3u8Match && m3u8Match[0]) {
        const cleanUrl = m3u8Match[0].replace(/\\/g, '');
        return {
          url: cleanUrl,
          quality: '1080p',
          format: 'm3u8',
          headers: this.buildHeaders(kodikUrl, origin),
          voiceover: voiceover || 'Kodik',
          source: this.id,
        };
      }

      // 2. Поиск конфигураций urlParams / videoInfo в скриптах kodik
      const urlParamsMatch = html.match(/urlParams\s*=\s*['"]([^'"]+)['"]/);
      if (urlParamsMatch && urlParamsMatch[1]) {
        // Декодируем параметры или ищем сериализованные ссылки
        const rawJson = Buffer.from(urlParamsMatch[1], 'base64').toString('utf-8');
        const streamUrlMatch = rawJson.match(/https?:\/\/[^"'\s\\]+?\.m3u8[^"'\s\\]*/i);
        if (streamUrlMatch && streamUrlMatch[0]) {
          return {
            url: streamUrlMatch[0].replace(/\\/g, ''),
            quality: '1080p',
            format: 'm3u8',
            headers: this.buildHeaders(kodikUrl, origin),
            voiceover: voiceover || 'Kodik',
            source: this.id,
          };
        }
      }

      return null;
    } catch {
      return null;
    }
  }
}
