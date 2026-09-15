import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { dbService, DownloadQueueRecord } from '../db/database.js';
import { sourceRegistry } from '../plugins/SourcePluginRegistry.js';
import { StreamResult } from '../plugins/types.js';

// Настройка пути к бинарнику FFmpeg (системный бинарник имеет приоритет над @ffmpeg-installer)
try {
  if (fs.existsSync('/usr/bin/ffmpeg')) {
    ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
  } else if (ffmpegInstaller && ffmpegInstaller.path) {
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
  }
} catch {
  if (ffmpegInstaller && ffmpegInstaller.path) {
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
  }
}

function escapeHtml(text: string): string {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderProgressBar(percent: number, length: number = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * length);
  const empty = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

interface TelegramBotLike {
  api?: {
    editMessageText: (
      chatId: string | number,
      messageId: number,
      text: string,
      options?: { parse_mode?: string }
    ) => Promise<unknown>;
  };
}

let cachedBot: TelegramBotLike | null = null;
async function sendTelegramUpdate(chatId?: string, messageId?: number, text?: string): Promise<void> {
  if (!chatId || !messageId || !text) return;
  try {
    if (!cachedBot) {
      const mod = (await import('../bot/index.js')) as { bot?: TelegramBotLike };
      cachedBot = mod.bot || null;
    }
    if (cachedBot && cachedBot.api) {
      await cachedBot.api.editMessageText(chatId, messageId, text, {
        parse_mode: 'HTML',
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('message is not modified')) {
      console.warn(`[Downloader] Не удалось обновить сообщение Telegram:`, msg);
    }
  }
}

function getEffectiveHeaders(videoUrl: string, streamHeaders?: Record<string, string>): Record<string, string> {
  const userAgent =
    streamHeaders?.['User-Agent'] ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

  const isKodik = videoUrl.includes('kodik') || videoUrl.includes('solodcdn') || videoUrl.includes('aniqit');
  const defaultReferer = isKodik ? 'https://kodikplayer.com/' : 'https://animelib.org/';
  const defaultOrigin = isKodik ? 'https://kodikplayer.com' : 'https://animelib.org';

  const referer = streamHeaders?.['Referer'] || defaultReferer;
  const origin = streamHeaders?.['Origin'] || defaultOrigin;

  return {
    'User-Agent': userAgent,
    'Referer': referer,
    'Origin': origin,
    'Accept': '*/*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    ...(streamHeaders || {}),
  };
}

async function fetchSegmentWithRetry(
  url: string,
  headers: Record<string, string>,
  retries = 3
): Promise<Buffer> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get<ArrayBuffer>(url, {
        headers,
        responseType: 'arraybuffer',
        timeout: 20000,
        validateStatus: (status) => status >= 200 && status < 400,
      });
      return Buffer.from(res.data);
    } catch (err: unknown) {
      if (attempt === retries) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw new Error(`Не удалось загрузить сегмент ${url}`);
}

export class DownloaderService {
  private isProcessing: boolean = false;
  private readonly downloadsDir = path.resolve(process.cwd(), 'downloads');
  private cancelledTaskIds = new Set<number>();

  constructor() {
    this.ensureDownloadsDir();
    this.cleanupOrphanedTempFiles();
  }

  /**
   * Гарантировать существование локальной директории downloads/
   */
  private ensureDownloadsDir(): void {
    try {
      if (!fs.existsSync(this.downloadsDir)) {
        fs.mkdirSync(this.downloadsDir, { recursive: true });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Downloader] Не удалось создать директорию downloads/:', msg);
    }
  }

  /**
   * Удаление брошенных временных файлов (.ts и temp_*) при старте приложения
   */
  cleanupOrphanedTempFiles(): void {
    try {
      if (!fs.existsSync(this.downloadsDir)) return;
      const files = fs.readdirSync(this.downloadsDir);
      let removedCount = 0;
      for (const file of files) {
        if (file.startsWith('temp_') || file.endsWith('.ts')) {
          try {
            fs.unlinkSync(path.join(this.downloadsDir, file));
            removedCount++;
          } catch {}
        }
      }
      if (removedCount > 0) {
        console.log(`[Downloader] Очищено незавершённых временных файлов HLS: ${removedCount}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[Downloader] Ошибка при очистке временных файлов:', msg);
    }
  }

  /**
   * Получить реальную статистику дискового хранилища downloads/
   */
  getStorageStats(): { totalFiles: number; totalSizeBytes: number; totalSizeFormatted: string } {
    try {
      this.ensureDownloadsDir();
      const files = fs.readdirSync(this.downloadsDir);
      let totalFiles = 0;
      let totalSizeBytes = 0;

      for (const file of files) {
        if (file.endsWith('.mp4') || file.endsWith('.mkv')) {
          try {
            const stat = fs.statSync(path.join(this.downloadsDir, file));
            if (stat.isFile()) {
              totalFiles++;
              totalSizeBytes += stat.size;
            }
          } catch {}
        }
      }

      let totalSizeFormatted = '0 МБ';
      if (totalSizeBytes >= 1024 * 1024 * 1024) {
        totalSizeFormatted = `${(totalSizeBytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
      } else {
        totalSizeFormatted = `${(totalSizeBytes / (1024 * 1024)).toFixed(1)} МБ`;
      }

      return { totalFiles, totalSizeBytes, totalSizeFormatted };
    } catch {
      return { totalFiles: 0, totalSizeBytes: 0, totalSizeFormatted: '0 МБ' };
    }
  }

  /**
   * Отмена загрузки задачи
   */
  cancelTask(taskId: number): boolean {
    this.cancelledTaskIds.add(taskId);
    dbService.updateDownloadStatus(taskId, 'error', 0);
    return true;
  }

  isTaskCancelled(taskId: number): boolean {
    return this.cancelledTaskIds.has(taskId);
  }

  /**
   * Добавить задачу на скачивание серии в очередь SQLite
   */
  addToQueue(
    mediaId: number,
    episode: number,
    voiceover?: string,
    telegramChatId?: string,
    telegramMessageId?: number
  ): number {
    return dbService.addToDownloadQueue(mediaId, episode, voiceover, telegramChatId, telegramMessageId);
  }

  /**
   * Получить список всех задач в очереди
   */
  getQueue(limit: number = 50): DownloadQueueRecord[] {
    return dbService.getDownloadQueue(limit);
  }

  /**
   * Получить статус конкретной задачи по её ID
   */
  getStatus(id: number): DownloadQueueRecord | null {
    return dbService.getDownloadById(id);
  }

  /**
   * Скачивание прямого видеофайла (.mp4) через HTTP-стрим (axios -> pipeline -> fs.createWriteStream).
   * Исключает зависания внешнего бинарника FFmpeg на сетевых соединениях.
   */
  private async downloadTaskWithHttpStream(
    task: DownloadQueueRecord,
    videoUrl: string,
    streamHeaders?: Record<string, string>,
    streamSource?: string,
    streamQuality?: string
  ): Promise<string> {
    this.ensureDownloadsDir();

    const stored = dbService.getSyncItemByMediaId(task.media_id);
    const animeTitle = stored?.rus_title || stored?.title || `Тайтл #${task.media_id}`;

    const safeVoiceover = (task.voiceover || 'default')
      .replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '_')
      .substring(0, 30);

    const safeQuality = (streamQuality || '1080p').replace(/[^a-zA-Z0-9_-]/g, '');
    const filename = `anime_${task.media_id}_ep_${task.episode}_${safeQuality}_${safeVoiceover}.mp4`;
    const relativeFilePath = path.join('downloads', filename);
    const absoluteFilePath = path.join(this.downloadsDir, filename);

    const effectiveHeaders = getEffectiveHeaders(videoUrl, streamHeaders);

    const qDisplay = streamQuality === '2160p' ? '4K 2160p' : (streamQuality || '1080p Full HD');
    const srcDisplay = streamSource === 'animelib'
      ? 'AnimeLib Native'
      : (streamSource === 'kodik' ? 'Kodik' : (streamSource || 'AnimeLib Native'));

    console.log(`[Downloader HTTP] Начинаю прямое скачивание задачи #${task.id}...`);
    console.log(`[Downloader HTTP] URL: ${videoUrl}`);
    console.log(`[Downloader HTTP] Целевой файл: ${relativeFilePath}`);

    // Стартовое оповещение в Telegram (0%)
    if (task.telegram_chat_id && task.telegram_message_id) {
      const initialText = [
        '📥 <b>Скачивание серии началось...</b>',
        '━━━━━━━━━━━━━━━━━━━━',
        `📺 <b>Тайтл:</b> ${escapeHtml(animeTitle)}`,
        `🎬 <b>Серия:</b> <code>#${task.episode}</code>`,
        `🎙 <b>Озвучка:</b> <code>${escapeHtml(task.voiceover || 'По умолчанию')}</code>`,
        `📡 <b>Источник:</b> [${escapeHtml(srcDisplay)}]`,
        `🎞 <b>Разрешение:</b> [${escapeHtml(qDisplay)}]`,
        '',
        `<b>[${renderProgressBar(0)}] 0%</b>`,
        '⏳ <i>Установка прямого соединения со стрим-сервером...</i>',
      ].join('\n');
      sendTelegramUpdate(task.telegram_chat_id, task.telegram_message_id, initialText).catch(() => {});
    }

    const writer = fs.createWriteStream(absoluteFilePath);

    try {
      const response = await axios.get(videoUrl, {
        responseType: 'stream',
        headers: effectiveHeaders,
        maxRedirects: 5,
        timeout: 45000,
        validateStatus: (status) => status >= 200 && status < 400,
      });

      const rawContentLength = response.headers['content-length'];
      const totalBytes = typeof rawContentLength === 'number'
        ? rawContentLength
        : parseInt(String(rawContentLength || '0'), 10);

      let downloadedBytes = 0;
      let lastUpdatedProgress = 0;
      let lastReportedStep = 0;
      let lastUpdateTime = Date.now();
      let speedBytesPerSec = 0;
      let lastSpeedMeasurementTime = Date.now();
      let downloadedSinceLastMeasurement = 0;

      const progressTransform = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          downloadedBytes += chunk.length;
          downloadedSinceLastMeasurement += chunk.length;

          const now = Date.now();
          const timeDiff = now - lastSpeedMeasurementTime;
          if (timeDiff >= 1000) {
            speedBytesPerSec = (downloadedSinceLastMeasurement / timeDiff) * 1000;
            downloadedSinceLastMeasurement = 0;
            lastSpeedMeasurementTime = now;
          }

          let percent = totalBytes > 0 ? Math.floor((downloadedBytes / totalBytes) * 100) : 0;
          if (percent > 99) percent = 99;

          if (
            (percent >= lastUpdatedProgress + 5 || now - lastUpdateTime > 2500) &&
            percent > lastUpdatedProgress
          ) {
            lastUpdatedProgress = percent;
            lastUpdateTime = now;
            dbService.updateDownloadStatus(task.id, 'downloading', percent);
            const dlMb = (downloadedBytes / (1024 * 1024)).toFixed(1);
            const totalMb = totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(1) : '?';
            const speedMb = (speedBytesPerSec / (1024 * 1024)).toFixed(1);
            console.log(
              `[Downloader HTTP] Задача #${task.id} прогресс: ${percent}% (${dlMb}/${totalMb} МБ, скорость: ${speedMb} МБ/с)`
            );
          }

          const currentStep = Math.floor(percent / 20) * 20;
          if (currentStep > lastReportedStep && currentStep <= 80 && currentStep > 0) {
            lastReportedStep = currentStep;
            if (task.telegram_chat_id && task.telegram_message_id) {
              const bar = renderProgressBar(currentStep);
              const dlMb = (downloadedBytes / (1024 * 1024)).toFixed(1);
              const totalMb = totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(1) : '?';
              const speedMb = (speedBytesPerSec / (1024 * 1024)).toFixed(1);

              const progressText = [
                '📥 <b>Скачивание серии...</b>',
                '━━━━━━━━━━━━━━━━━━━━',
                `📺 <b>Тайтл:</b> ${escapeHtml(animeTitle)}`,
                `🎬 <b>Серия:</b> <code>#${task.episode}</code>`,
                `🎙 <b>Озвучка:</b> <code>${escapeHtml(task.voiceover || 'По умолчанию')}</code>`,
                '',
                `<b>[${bar}] ${currentStep}%</b>`,
                `📦 <b>Загружено:</b> <code>${dlMb} / ${totalMb} МБ</code> | 🚀 <b>Скорость:</b> <code>${speedMb} МБ/с</code>`,
              ].join('\n');

              sendTelegramUpdate(task.telegram_chat_id, task.telegram_message_id, progressText).catch(() => {});
            }
          }

          callback(null, chunk);
        },
      });

      await pipeline(response.data, progressTransform, writer);

      console.log(`[Downloader HTTP] ✅ Загрузка задачи #${task.id} успешно завершена: ${relativeFilePath}`);
      dbService.updateDownloadStatus(task.id, 'completed', 100, relativeFilePath);

      let fileSizeStr = 'N/A';
      try {
        const stats = fs.statSync(absoluteFilePath);
        fileSizeStr = `${(stats.size / (1024 * 1024)).toFixed(1)} МБ`;
      } catch {}

      if (task.telegram_chat_id && task.telegram_message_id) {
        const successText = [
          '✅ <b>Серия успешно скачана!</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          `📺 <b>Тайтл:</b> ${escapeHtml(animeTitle)}`,
          `🎬 <b>Серия:</b> <code>#${task.episode}</code>`,
          `🎙 <b>Озвучка:</b> <code>${escapeHtml(task.voiceover || 'По умолчанию')}</code>`,
          `📁 <b>Файл:</b> <code>${filename}</code>`,
          `📦 <b>Размер:</b> <code>${fileSizeStr}</code>`,
          '',
          '🎉 <i>Файл сохранен в локальное хранилище и готов к просмотру!</i>',
        ].join('\n');

        sendTelegramUpdate(task.telegram_chat_id, task.telegram_message_id, successText).catch(() => {});
      }

      return relativeFilePath;
    } catch (httpErr: unknown) {
      writer.destroy();
      const errMsg = httpErr instanceof Error ? httpErr.message : 'Ошибка HTTP загрузки';
      console.error(`[Downloader HTTP] ❌ Ошибка для задачи #${task.id}:`, errMsg);

      try {
        if (fs.existsSync(absoluteFilePath)) fs.unlinkSync(absoluteFilePath);
      } catch {}

      dbService.updateDownloadStatus(task.id, 'error', 0);

      if (task.telegram_chat_id && task.telegram_message_id) {
        const errorText = [
          '❌ <b>Ошибка при скачивании серии!</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          `📺 <b>Тайтл:</b> ${escapeHtml(animeTitle)}`,
          `🎬 <b>Серия:</b> <code>#${task.episode}</code>`,
          `⚠️ <i>${escapeHtml(errMsg)}</i>`,
        ].join('\n');
        sendTelegramUpdate(task.telegram_chat_id, task.telegram_message_id, errorText).catch(() => {});
      }

      throw new Error(`HTTP stream error: ${errMsg}`);
    }
  }

  /**
   * Нативная загрузка HLS (.m3u8) без сетевых вызовов в FFmpeg:
   * 1. Скачивание манифеста и выбор потока наилучшего разрешения.
   * 2. Парсинг и последовательная загрузка сегментов .ts пулом по 3 шт. через Node.js.
   * 3. Конкатенация сегментов в локальный TS и локальный офлайн-ремуксинг в MP4 (если доступен FFmpeg).
   */
  private async downloadTaskWithHls(
    task: DownloadQueueRecord,
    videoUrl: string,
    streamHeaders?: Record<string, string>,
    streamSource?: string,
    streamQuality?: string
  ): Promise<string> {
    this.ensureDownloadsDir();

    const stored = dbService.getSyncItemByMediaId(task.media_id);
    const animeTitle = stored?.rus_title || stored?.title || `Тайтл #${task.media_id}`;

    const safeVoiceover = (task.voiceover || 'default')
      .replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '_')
      .substring(0, 30);

    const safeQuality = (streamQuality || '1080p').replace(/[^a-zA-Z0-9_-]/g, '');
    const filename = `anime_${task.media_id}_ep_${task.episode}_${safeQuality}_${safeVoiceover}.mp4`;
    const relativeFilePath = path.join('downloads', filename);
    const absoluteFilePath = path.join(this.downloadsDir, filename);
    const tempTsPath = path.join(
      this.downloadsDir,
      `temp_${Date.now()}_anime_${task.media_id}_ep_${task.episode}.ts`
    );

    const effectiveHeaders = getEffectiveHeaders(videoUrl, streamHeaders);

    const qDisplay = streamQuality === '2160p' ? '4K 2160p' : (streamQuality || '1080p Full HD');
    const srcDisplay = streamSource === 'animelib'
      ? 'AnimeLib Native'
      : (streamSource === 'kodik' ? 'Kodik' : (streamSource || 'AnimeLib Native'));

    console.log(`[Downloader HLS] Начинаю нативный сборщик сегментов для задачи #${task.id}...`);
    console.log(`[Downloader HLS] Манифест: ${videoUrl}`);
    console.log(`[Downloader HLS] Целевой файл: ${relativeFilePath}`);

    try {
      // 1. Скачиваем манифест
      const playlistRes = await axios.get<string>(videoUrl, {
        headers: effectiveHeaders,
        timeout: 15000,
        responseType: 'text',
      });

      let mediaPlaylistUrl = videoUrl;
      let mediaPlaylistText = playlistRes.data;

      // 2. Если это Master Playlist, парсим варианты и берем поток с наивысшим битрейтом
      if (mediaPlaylistText.includes('#EXT-X-STREAM-INF')) {
        const lines = mediaPlaylistText.split(/\r?\n/);
        let bestBandwidth = -1;
        let bestUri = '';

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith('#EXT-X-STREAM-INF')) {
            let bw = 0;
            const bwMatch = line.match(/BANDWIDTH=(\d+)/);
            if (bwMatch) {
              bw = parseInt(bwMatch[1], 10);
            }
            for (let j = i + 1; j < lines.length; j++) {
              const nextLine = lines[j].trim();
              if (nextLine && !nextLine.startsWith('#')) {
                if (bw > bestBandwidth || !bestUri) {
                  bestBandwidth = bw;
                  bestUri = nextLine;
                }
                break;
              }
            }
          }
        }

        if (bestUri) {
          mediaPlaylistUrl = new URL(bestUri, videoUrl).href;
          console.log(
            `[Downloader HLS] Выбран HLS поток наивысшего качества: ${mediaPlaylistUrl}`
          );
          const mediaRes = await axios.get<string>(mediaPlaylistUrl, {
            headers: effectiveHeaders,
            timeout: 15000,
            responseType: 'text',
          });
          mediaPlaylistText = mediaRes.data;
        }
      }

      // 3. Извлекаем сегменты
      const lines = mediaPlaylistText.split(/\r?\n/);
      const segmentUrls: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          try {
            const segUrl = new URL(trimmed, mediaPlaylistUrl).href;
            segmentUrls.push(segUrl);
          } catch {}
        }
      }

      if (segmentUrls.length === 0) {
        throw new Error('В HLS манифесте не обнаружено видеосегментов для загрузки');
      }

      const totalSegments = segmentUrls.length;
      console.log(`[Downloader HLS] Обнаружено сегментов: ${totalSegments}`);

      // Стартовое оповещение в Telegram (0%)
      if (task.telegram_chat_id && task.telegram_message_id) {
        const initialText = [
          '📥 <b>Скачивание серии началось...</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          `📺 <b>Тайтл:</b> ${escapeHtml(animeTitle)}`,
          `🎬 <b>Серия:</b> <code>#${task.episode}</code>`,
          `🎙 <b>Озвучка:</b> <code>${escapeHtml(task.voiceover || 'По умолчанию')}</code>`,
          `📡 <b>Источник:</b> [${escapeHtml(srcDisplay)}]`,
          `🎞 <b>Разрешение:</b> [${escapeHtml(qDisplay)}]`,
          '',
          `<b>[${renderProgressBar(0)}] 0%</b>`,
          `⏳ <i>Загрузка HLS потока (всего сегментов: ${totalSegments})...</i>`,
        ].join('\n');
        sendTelegramUpdate(task.telegram_chat_id, task.telegram_message_id, initialText).catch(() => {});
      }

      // Очищаем временный TS файл перед записью
      if (fs.existsSync(tempTsPath)) {
        fs.unlinkSync(tempTsPath);
      }

      const BATCH_SIZE = 3;
      let completedSegments = 0;
      let lastUpdatedProgress = 0;
      let lastReportedStep = 0;
      let lastUpdateTime = Date.now();

      // 4. Скачиваем сегменты контролируемым пулом по 3 штуки
      for (let i = 0; i < segmentUrls.length; i += BATCH_SIZE) {
        if (this.isTaskCancelled(task.id)) {
          console.log(`[Downloader HLS] Задача #${task.id} отменена пользователем. Прекращение загрузки.`);
          if (fs.existsSync(tempTsPath)) {
            try {
              fs.unlinkSync(tempTsPath);
            } catch {}
          }
          throw new Error('Загрузка отменена пользователем');
        }

        const batch = segmentUrls.slice(i, i + BATCH_SIZE);
        const buffers = await Promise.all(
          batch.map((url) => fetchSegmentWithRetry(url, effectiveHeaders))
        );

        for (const buf of buffers) {
          await fs.promises.appendFile(tempTsPath, buf);
        }

        completedSegments += batch.length;
        const percent = Math.min(99, Math.floor((completedSegments / totalSegments) * 100));
        const now = Date.now();

        if (
          (percent >= lastUpdatedProgress + 5 || now - lastUpdateTime > 2500) &&
          percent > lastUpdatedProgress
        ) {
          lastUpdatedProgress = percent;
          lastUpdateTime = now;
          dbService.updateDownloadStatus(task.id, 'downloading', percent);
          console.log(`[Downloader HLS] Сегмент ${completedSegments} / ${totalSegments} (${percent}%)`);
        }

        const currentStep = Math.floor(percent / 20) * 20;
        if (currentStep > lastReportedStep && currentStep <= 80 && currentStep > 0) {
          lastReportedStep = currentStep;
          if (task.telegram_chat_id && task.telegram_message_id) {
            const bar = renderProgressBar(currentStep);
            const progressText = [
              '📥 <b>Скачивание серии...</b>',
              '━━━━━━━━━━━━━━━━━━━━',
              `📺 <b>Тайтл:</b> ${escapeHtml(animeTitle)}`,
              `🎬 <b>Серия:</b> <code>#${task.episode}</code>`,
              `🎙 <b>Озвучка:</b> <code>${escapeHtml(task.voiceover || 'По умолчанию')}</code>`,
              '',
              `<b>[${bar}] ${currentStep}%</b>`,
              `🧩 <b>Сегменты:</b> <code>${completedSegments} / ${totalSegments}</code>`,
            ].join('\n');
            sendTelegramUpdate(task.telegram_chat_id, task.telegram_message_id, progressText).catch(() => {});
          }
        }
      }

      // 5. Локальный ремуксинг готового TS файла в MP4 (без сетевых вызовов)
      console.log(`[Downloader HLS] Все ${totalSegments} сегментов загружены. Формирование MP4...`);
      try {
        await new Promise<void>((resolve, reject) => {
          ffmpeg(tempTsPath)
            .outputOptions(['-c copy', '-bsf:a aac_adtstoasc', '-movflags +faststart', '-y'])
            .output(absoluteFilePath)
            .on('end', () => {
              try {
                if (fs.existsSync(tempTsPath)) fs.unlinkSync(tempTsPath);
              } catch {}
              resolve();
            })
            .on('error', (err) => {
              reject(err);
            })
            .run();
        });
      } catch (remuxErr: unknown) {
        const msg = remuxErr instanceof Error ? remuxErr.message : String(remuxErr);
        console.warn(
          `[Downloader HLS] Локальный ремуксинг через FFmpeg пропущен (${msg}). Сохраняем прямой поток в MP4.`
        );
        try {
          if (fs.existsSync(absoluteFilePath)) fs.unlinkSync(absoluteFilePath);
          fs.renameSync(tempTsPath, absoluteFilePath);
        } catch {
          fs.copyFileSync(tempTsPath, absoluteFilePath);
          try {
            if (fs.existsSync(tempTsPath)) fs.unlinkSync(tempTsPath);
          } catch {}
        }
      }

      console.log(`[Downloader HLS] ✅ Загрузка задачи #${task.id} успешно завершена: ${relativeFilePath}`);
      dbService.updateDownloadStatus(task.id, 'completed', 100, relativeFilePath);

      let fileSizeStr = 'N/A';
      try {
        const stats = fs.statSync(absoluteFilePath);
        fileSizeStr = `${(stats.size / (1024 * 1024)).toFixed(1)} МБ`;
      } catch {}

      if (task.telegram_chat_id && task.telegram_message_id) {
        const successText = [
          '✅ <b>Серия успешно скачана!</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          `📺 <b>Тайтл:</b> ${escapeHtml(animeTitle)}`,
          `🎬 <b>Серия:</b> <code>#${task.episode}</code>`,
          `🎙 <b>Озвучка:</b> <code>${escapeHtml(task.voiceover || 'По умолчанию')}</code>`,
          `📁 <b>Файл:</b> <code>${filename}</code>`,
          `📦 <b>Размер:</b> <code>${fileSizeStr}</code>`,
          '',
          '🎉 <i>Файл сохранен в локальное хранилище и готов к просмотру!</i>',
        ].join('\n');

        sendTelegramUpdate(task.telegram_chat_id, task.telegram_message_id, successText).catch(() => {});
      }

      return relativeFilePath;
    } catch (hlsErr: unknown) {
      const errMsg = hlsErr instanceof Error ? hlsErr.message : 'Ошибка HLS загрузки';
      console.error(`[Downloader HLS] ❌ Ошибка для задачи #${task.id}:`, errMsg);

      try {
        if (fs.existsSync(tempTsPath)) fs.unlinkSync(tempTsPath);
        if (fs.existsSync(absoluteFilePath)) fs.unlinkSync(absoluteFilePath);
      } catch {}

      dbService.updateDownloadStatus(task.id, 'error', 0);

      if (task.telegram_chat_id && task.telegram_message_id) {
        const errorText = [
          '❌ <b>Ошибка при скачивании серии!</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          `📺 <b>Тайтл:</b> ${escapeHtml(animeTitle)}`,
          `🎬 <b>Серия:</b> <code>#${task.episode}</code>`,
          `⚠️ <i>${escapeHtml(errMsg)}</i>`,
        ].join('\n');
        sendTelegramUpdate(task.telegram_chat_id, task.telegram_message_id, errorText).catch(() => {});
      }

      throw new Error(`HLS stream error: ${errMsg}`);
    }
  }

  /**
   * Основной метод последовательной обработки очереди загрузок
   */
  async processQueue(): Promise<void> {
    if (this.isProcessing) {
      console.log('[Downloader] Очередь уже обрабатывается в данный момент.');
      return;
    }

    this.isProcessing = true;

    try {
      const pendingTasks = dbService.getPendingDownloads();
      if (pendingTasks.length === 0) {
        return;
      }

      console.log(`[Downloader] Найдено задач в очереди: ${pendingTasks.length}`);

      for (const task of pendingTasks) {
        console.log(
          `[Downloader] -----------------------------------------------------\n` +
          `[Downloader] Обработка задачи #${task.id} (Media: ${task.media_id}, Серия: ${task.episode}, Озвучка: ${task.voiceover || 'Любая'})...`
        );

        // Переводим статус в 'downloading'
        dbService.updateDownloadStatus(task.id, 'downloading', 0);

        try {
          // Разрешаем видеопоток через единый реестр плагинов источников
          const stream: StreamResult | null = await sourceRegistry.resolveStreamWithFallback({
            mediaId: task.media_id,
            episode: task.episode,
            voiceover: task.voiceover || undefined,
          });

          if (!stream || !stream.url) {
            console.warn(
              `[Downloader] ❌ Не удалось найти видеопоток ни в одном плагине для задачи #${task.id} (Media ${task.media_id}, Ep ${task.episode})`
            );
            dbService.updateDownloadStatus(task.id, 'error', 0);

            if (task.telegram_chat_id && task.telegram_message_id) {
              const errResolveText = [
                '❌ <b>Не удалось получить ссылку на видеопоток!</b>',
                '━━━━━━━━━━━━━━━━━━━━',
                `🎬 <b>Серия:</b> <code>#${task.episode}</code>`,
                '⚠️ <i>Плееры AnimeLib и Kodik не предоставили рабочий видеопоток.</i>',
              ].join('\n');
              sendTelegramUpdate(task.telegram_chat_id, task.telegram_message_id, errResolveText).catch(() => {});
            }
            continue;
          }

          console.log(
            `[Downloader] Поток найден: [${stream.source}] Качество: ${stream.quality || 'Auto'}, Озвучка: ${stream.voiceover || 'N/A'}, Формат: ${stream.format}`
          );

          if (stream.format === 'mp4') {
            await this.downloadTaskWithHttpStream(task, stream.url, stream.headers, stream.source, stream.quality);
          } else {
            await this.downloadTaskWithHls(task, stream.url, stream.headers, stream.source, stream.quality);
          }
        } catch (taskErr: unknown) {
          const errMsg = taskErr instanceof Error ? taskErr.message : String(taskErr);
          console.error(`[Downloader] Ошибка при обработке задачи #${task.id}:`, errMsg);
          dbService.updateDownloadStatus(task.id, 'error', 0);
        }
      }
    } catch (queueErr: unknown) {
      const errMsg = queueErr instanceof Error ? queueErr.message : String(queueErr);
      console.error('[Downloader] Критическая ошибка в processQueue:', errMsg);
    } finally {
      this.isProcessing = false;
    }
  }
}

export const downloaderService = new DownloaderService();
