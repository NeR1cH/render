import axios from 'axios';
import { BaseSourcePlugin } from '../BaseSourcePlugin.js';
import { EpisodeQuery, StreamResult } from '../types.js';
import { animelibService } from '../../services/animelib.js';

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

  private readonly apiBases = [
    process.env.ANIMELIB_API_URL,
    'https://hapi.hentaicdn.org/api',
  ].filter(Boolean) as string[];

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
    const kodikUrls = await this.findKodikPlayerUrls(mediaId, episode);

    const results: StreamResult[] = [];

    for (const item of kodikUrls) {
      // 1. Если плеер kodik имеет суффикс /720p или не имеет суффикса, генерируем вариант 1080p
      let candidateUrls: Array<{ url: string; targetQuality: '1080p' | '720p' }> = [];
      const trimmedUrl = item.url.trim();

      if (/\/720p(?:\/)?$/.test(trimmedUrl)) {
        candidateUrls.push({
          url: trimmedUrl.replace(/\/720p(?:\/)?$/, '/1080p'),
          targetQuality: '1080p',
        });
        candidateUrls.push({
          url: trimmedUrl,
          targetQuality: '720p',
        });
      } else if (/\/1080p(?:\/)?$/.test(trimmedUrl)) {
        candidateUrls.push({
          url: trimmedUrl,
          targetQuality: '1080p',
        });
        candidateUrls.push({
          url: trimmedUrl.replace(/\/1080p(?:\/)?$/, '/720p'),
          targetQuality: '720p',
        });
      } else {
        candidateUrls.push({
          url: trimmedUrl.replace(/\/$/, '') + '/1080p',
          targetQuality: '1080p',
        });
        candidateUrls.push({
          url: trimmedUrl.replace(/\/$/, '') + '/720p',
          targetQuality: '720p',
        });
      }

      for (const cand of candidateUrls) {
        const stream = await this.resolveKodikManifest(cand.url, item.voiceover || voiceover, cand.targetQuality);
        if (stream) {
          const isAlive = await this.isStreamLikelyAlive(stream.url, stream.headers);
          if (isAlive) {
            // Предотвращаем дублирование одинаковых stream.url
            if (!results.some(r => r.url === stream.url && r.quality === stream.quality)) {
              results.push(stream);
            }
          }
        }
      }
    }

    // Если прямое извлечение не вернуло результат, пробуем разрешить через animelibService.resolveKodikStream
    if (results.length === 0 && kodikUrls.length > 0) {
      for (const item of kodikUrls) {
        try {
          const resolved = await animelibService.resolveKodikStream(item.url);
          if (resolved && resolved.url) {
            results.push({
              url: resolved.url,
              quality: this.normalizeQuality(resolved.quality || '1080p'),
              format: (resolved.format as any) || this.detectFormat(resolved.url),
              headers: resolved.headers || this.buildHeaders(item.url, 'https://kodikplayer.com'),
              voiceover: item.voiceover || voiceover || 'Kodik',
              source: this.id,
            });
          }
        } catch {}
      }
    }

    return results;
  }

  private async findKodikPlayerUrls(
    mediaId: number,
    episode: number
  ): Promise<Array<{ url: string; voiceover?: string }>> {
    console.log(`[KodikPlugin] Запрос серий для mediaId: ${mediaId}...`);
    const requestHeaders = this.getAnimelibApiHeaders();

    for (const base of this.apiBases) {
      try {
        const epUrl = `${base}/anime/${mediaId}/episodes`;
        let res: any;
        try {
          res = await axios.get<any>(epUrl, {
            headers: requestHeaders,
            timeout: 8000,
          });
        } catch {
          res = await axios.get<any>(`${base}/episodes`, {
            params: { anime_id: mediaId },
            headers: requestHeaders,
            timeout: 8000,
          });
        }

        const epList = Array.isArray(res.data) ? res.data : (res.data?.data || []);
        console.log(
          `[KodikPlugin] Найдено серий в API (${base}): ${epList.length}. Доступные номера: ${epList.map((e: any) => e.number || e.item_number || e.episode).slice(0, 10).join(', ')}...`
        );

        const targetEp = epList.find((e: any) => Number(e.number || e.item_number || e.episode) === Number(episode));
        if (!targetEp) {
          console.warn(`[KodikPlugin] Серия #${episode} отсутствует в списке доступных серий тайтла ${mediaId}`);
          return [];
        }

        let players: any[] = Array.isArray(targetEp.players) ? targetEp.players : [];

        if (players.length === 0) {
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
              const fetched = Array.isArray(playersRes.data) ? playersRes.data : (playersRes.data?.data || []);
              if (fetched.length > 0) {
                players = fetched;
                break;
              }
            } catch {}
          }
        }

        if (players.length === 0) {
          try {
            const epDetailRes = await axios.get<any>(`${base}/episodes/${targetEp.id}`, {
              headers: requestHeaders,
              timeout: 8000,
            });
            players = epDetailRes.data?.data?.players || epDetailRes.data?.players || [];
          } catch {}
        }

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

        if (list.length > 0) {
          return list;
        }
      } catch (err: any) {
        console.warn(`[KodikPlugin] Ошибка при запросе эпизодов через ${base}:`, err?.code || err?.response?.status || err?.message);
      }
    }

    return [];
  }

  private async resolveKodikManifest(
    kodikUrl: string,
    voiceover?: string,
    targetQuality: '1080p' | '720p' = '1080p'
  ): Promise<StreamResult | null> {
    let targetUrl = kodikUrl.trim();
    if (targetUrl.startsWith('//')) {
      targetUrl = 'https:' + targetUrl;
    }
    if (/\/seria\/\d+\/[a-zA-Z0-9]+(?:\/)?$/.test(targetUrl.replace(/\/$/, ''))) {
      targetUrl = targetUrl.replace(/\/$/, '') + `/${targetQuality}`;
    }

    try {
      const parsed = new URL(targetUrl);
      const origin = `${parsed.protocol}//${parsed.host}`;

      let html: string | null = null;
      let effectiveUrl = targetUrl;
      let effectiveQuality = targetQuality;

      try {
        const res = await axios.get<string>(targetUrl, {
          headers: this.buildHeaders(targetUrl, origin),
          timeout: 8000,
        });
        html = typeof res.data === 'string' ? res.data : null;
      } catch (err: any) {
        // Если запрос на 1080p вернул 404, откатываемся к 720p
        if (err?.response?.status === 404 && targetUrl.includes('/1080p')) {
          const fallbackUrl = targetUrl.replace('/1080p', '/720p');
          console.log(`[KodikPlugin] 1080p вернул 404, fallback к 720p: ${fallbackUrl}`);
          try {
            const fallbackRes = await axios.get<string>(fallbackUrl, {
              headers: this.buildHeaders(fallbackUrl, origin),
              timeout: 8000,
            });
            html = typeof fallbackRes.data === 'string' ? fallbackRes.data : null;
            effectiveUrl = fallbackUrl;
            effectiveQuality = '720p';
          } catch {
            return null;
          }
        } else {
          return null;
        }
      }

      if (!html) {
        return null;
      }

      // 1. Поиск прямого m3u8 в исходном коде плеера
      const m3u8Match = html.match(/https?:\/\/[^"'\s\\]+?\.m3u8[^"'\s\\]*/i);
      if (m3u8Match && m3u8Match[0]) {
        const cleanUrl = m3u8Match[0].replace(/\\/g, '');
        return {
          url: cleanUrl,
          quality: effectiveQuality,
          format: 'm3u8',
          headers: this.buildHeaders(effectiveUrl, origin),
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
            quality: effectiveQuality,
            format: 'm3u8',
            headers: this.buildHeaders(effectiveUrl, origin),
            voiceover: voiceover || 'Kodik',
            source: this.id,
          };
        }
      }

      // 3. Если прямого URL нет в HTML, пытаемся разрешить через animelibService.resolveKodikStream (POST /ftor)
      const resolved = await animelibService.resolveKodikStream(effectiveUrl);
      if (resolved && resolved.url) {
        return {
          url: resolved.url,
          quality: this.normalizeQuality(resolved.quality || effectiveQuality),
          format: (resolved.format as any) || this.detectFormat(resolved.url),
          headers: resolved.headers || this.buildHeaders(effectiveUrl, 'https://kodikplayer.com'),
          voiceover: voiceover || 'Kodik',
          source: this.id,
        };
      }

      return null;
    } catch {
      return null;
    }
  }
}
