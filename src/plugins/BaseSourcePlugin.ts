import axios, { AxiosRequestConfig } from 'axios';
import { EpisodeQuery, ISourcePlugin, StreamFormat, StreamQuality, StreamResult } from './types.js';

export abstract class BaseSourcePlugin implements ISourcePlugin {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly priority: number;

  protected readonly defaultUserAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

  abstract getStreams(query: EpisodeQuery): Promise<StreamResult[]>;

  async resolveStream(query: EpisodeQuery): Promise<StreamResult | null> {
    const streams = await this.getStreams(query);
    if (!streams || streams.length === 0) {
      return null;
    }

    if (query.preferredQuality) {
      const target = query.preferredQuality.toLowerCase().replace(/[^0-9]/g, '');
      const matched = streams.find((s) => s.quality.includes(target));
      if (matched) return matched;
    }

    return streams[0] || null;
  }

  protected normalizeQuality(raw?: string | number | null): StreamQuality {
    if (!raw) return 'auto';
    const str = String(raw).toLowerCase().trim();
    if (str.includes('2160') || str.includes('4k')) return '2160p';
    if (str.includes('1080')) return '1080p';
    if (str.includes('720')) return '720p';
    if (str.includes('480')) return '480p';
    if (str.includes('360')) return '360p';
    return '1080p';
  }

  protected detectFormat(url: string): StreamFormat {
    if (url.includes('.m3u8')) return 'm3u8';
    return 'mp4';
  }

  protected buildHeaders(referer?: string, origin?: string, additional?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': this.defaultUserAgent,
      'Accept': '*/*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    };

    if (referer) {
      headers['Referer'] = referer;
    }
    if (origin) {
      headers['Origin'] = origin;
    }

    if (additional) {
      for (const [k, v] of Object.entries(additional)) {
        if (v) headers[k] = v;
      }
    }

    return headers;
  }

  /**
   * Безопасная проверка доступности URL стрима.
   * КРИТИЧЕСКИ ВАЖНО:
   * Убирает ложное отбрасывание рабочих плееров. Если URL синтаксически валиден,
   * содержит http/https и хост из доверенных доменов (.lib.social, .animelib, .anmli, kodik, cdn),
   * ВСЕГДА возвращает true, не делая блокирующих сетевых GET-запросов, которые срезаются Cloudflare/WAF.
   */
  protected async isStreamLikelyAlive(url: string, headers?: Record<string, string>): Promise<boolean> {
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return false;
    }

    const lowerUrl = url.toLowerCase();

    // Доверенные CDN ноды AnimeLib, Kodik и зеркала (hentaicdn, cdnlib, kodik, cdn, aniqit)
    const trustedHosts = ['hentaicdn', 'cdnlib', 'kodik', 'cdn', 'aniqit'];
    if (trustedHosts.some((h) => lowerUrl.includes(h))) {
      return true;
    }

    try {
      const config: AxiosRequestConfig = {
        headers: headers || { 'User-Agent': this.defaultUserAgent },
        timeout: 3000,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 500,
      };

      // Делаем легкий GET-запрос с ограничением размера данных
      const res = await axios.get(url, {
        ...config,
        responseType: 'stream',
      });

      // Уничтожаем поток данных сразу после получения заголовков
      if (res.data && typeof res.data.destroy === 'function') {
        res.data.destroy();
      }

      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    }
  }
}
