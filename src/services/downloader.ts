import fs from 'fs';
import path from 'path';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { dbService, DownloadQueueRecord } from '../db/database';
import { animelibService, ANIMELIB_WEB_URL, isValidVideoUrl } from './animelib';

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

let cachedBot: any = null;
async function sendTelegramUpdate(chatId?: string, messageId?: number, text?: string) {
  if (!chatId || !messageId || !text) return;
  try {
    if (!cachedBot) {
      const mod = await import('../bot/index');
      cachedBot = mod.bot;
    }
    if (cachedBot && cachedBot.api) {
      await cachedBot.api.editMessageText(chatId, messageId, text, {
        parse_mode: 'HTML',
      });
    }
  } catch (err: any) {
    if (!err?.message?.includes('message is not modified')) {
      console.warn(`[Downloader] Не удалось обновить сообщение Telegram:`, err?.message);
    }
  }
}

function getEffectiveHeaders(videoUrl: string, streamHeaders?: Record<string, string>): Record<string, string> {
  const userAgent =
    streamHeaders?.['User-Agent'] ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

  const isKodik = videoUrl.includes('kodik') || videoUrl.includes('solodcdn');
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

export class DownloaderService {
  private isProcessing: boolean = false;
  private readonly downloadsDir = path.resolve(process.cwd(), 'downloads');

  constructor() {
    this.ensureDownloadsDir();
  }

  /**
   * Гарантировать существование локальной директории downloads/
   */
  private ensureDownloadsDir(): void {
    try {
      if (!fs.existsSync(this.downloadsDir)) {
        fs.mkdirSync(this.downloadsDir, { recursive: true });
      }
    } catch (err: any) {
      console.error('[Downloader] Не удалось создать директорию downloads/:', err?.message);
    }
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
   * Скачивание прямого видеофайла (.mp4) через HTTP-стрим (axios -> fs.createWriteStream).
   * Исключает падения внешнего бинарника FFmpeg на прямых видеофайлах и дает точнейший прогресс в байтах и процентах.
   */
  private async downloadTaskWithHttpStream(
    task: DownloadQueueRecord,
    videoUrl: string,
    streamHeaders?: Record<string, string>
  ): Promise<string> {
    this.ensureDownloadsDir();

    const stored = dbService.getSyncItemByMediaId(task.media_id);
    const animeTitle = stored?.rus_title || stored?.title || `Тайтл #${task.media_id}`;

    const safeVoiceover = (task.voiceover || 'default')
      .replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '_')
      .substring(0, 30);

    const filename = `anime_${task.media_id}_ep_${task.episode}_${safeVoiceover}.mp4`;
    const relativeFilePath = path.join('downloads', filename);
    const absoluteFilePath = path.join(this.downloadsDir, filename);

    const effectiveHeaders = getEffectiveHeaders(videoUrl, streamHeaders);

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
        '',
        `<b>[${renderProgressBar(0)}] 0%</b>`,
        '⏳ <i>Установка прямого соединения с CDN AnimeLib...</i>',
      ].join('\n');
      sendTelegramUpdate(task.telegram_chat_id, task.telegram_message_id, initialText).catch(() => {});
    }

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

      const writer = fs.createWriteStream(absoluteFilePath);

      return new Promise<string>((resolve, reject) => {
        response.data.on('data', (chunk: Buffer) => {
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

          // Обновляем статус в базе при шаге от 5% или раз в 2.5 секунды
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

          // Интерактивное обновление шкалы в Telegram каждые 20% (20, 40, 60, 80)
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
        });

        response.data.on('error', (err: any) => {
          writer.close();
          try {
            if (fs.existsSync(absoluteFilePath)) fs.unlinkSync(absoluteFilePath);
          } catch {}
          reject(err);
        });

        writer.on('error', (err: any) => {
          try {
            if (fs.existsSync(absoluteFilePath)) fs.unlinkSync(absoluteFilePath);
          } catch {}
          reject(err);
        });

        writer.on('finish', () => {
          console.log(`[Downloader HTTP] ✅ Загрузка задачи #${task.id} успешно завершена: ${relativeFilePath}`);
          dbService.updateDownloadStatus(task.id, 'completed', 100, relativeFilePath);

          // Расчет итогового размера файла
          let fileSizeStr = 'N/A';
          try {
            const stats = fs.statSync(absoluteFilePath);
            fileSizeStr = `${(stats.size / (1024 * 1024)).toFixed(1)} МБ`;
          } catch {}

          // Финальное сообщение в Telegram с метаданными
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

          resolve(relativeFilePath);
        });

        response.data.pipe(writer);
      });
    } catch (httpErr: any) {
      const errMsg = httpErr?.message || 'Ошибка HTTP загрузки';
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
   * Скачивание HLS манифестов (.m3u8) через FFmpeg с ремуксингом в MP4
   */
  private async downloadTaskWithFFmpeg(
    task: DownloadQueueRecord,
    videoUrl: string,
    streamHeaders?: Record<string, string>
  ): Promise<string> {
    this.ensureDownloadsDir();

    const stored = dbService.getSyncItemByMediaId(task.media_id);
    const animeTitle = stored?.rus_title || stored?.title || `Тайтл #${task.media_id}`;

    const safeVoiceover = (task.voiceover || 'default')
      .replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '_')
      .substring(0, 30);

    const filename = `anime_${task.media_id}_ep_${task.episode}_${safeVoiceover}.mp4`;
    const relativeFilePath = path.join('downloads', filename);
    const absoluteFilePath = path.join(this.downloadsDir, filename);

    const effectiveHeaders = getEffectiveHeaders(videoUrl, streamHeaders);

    // Заголовки для FFmpeg должны объединяться СТРОГО через \r\n и обязательно оканчиваться финальным \r\n
    const headersOption =
      Object.entries(effectiveHeaders)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') + '\r\n';

    return new Promise((resolve, reject) => {
      let lastUpdatedProgress = 0;
      let lastReportedStep = 0;
      let lastUpdateTime = 0;

      console.log(`[Downloader FFmpeg] Начинаю HLS загрузку задачи #${task.id}...`);
      console.log(`[Downloader FFmpeg] URL потока: ${videoUrl}`);
      console.log(`[Downloader FFmpeg] Целевой файл: ${relativeFilePath}`);

      // Стартовое оповещение в Telegram (0%)
      if (task.telegram_chat_id && task.telegram_message_id) {
        const initialText = [
          '📥 <b>Скачивание серии началось...</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          `📺 <b>Тайтл:</b> ${escapeHtml(animeTitle)}`,
          `🎬 <b>Серия:</b> <code>#${task.episode}</code>`,
          `🎙 <b>Озвучка:</b> <code>${escapeHtml(task.voiceover || 'По умолчанию')}</code>`,
          '',
          `<b>[${renderProgressBar(0)}] 0%</b>`,
          '⏳ <i>Инициализация HLS потока и буферизация FFmpeg...</i>',
        ].join('\n');
        sendTelegramUpdate(task.telegram_chat_id, task.telegram_message_id, initialText).catch(() => {});
      }

      // Настройка флагов FFmpeg:
      // ВАЖНО: -bsf:a aac_adtstoasc добавляется ТОЛЬКО для .m3u8 (HLS)! Для прямых .mp4 он вызывает I/O error.
      const outputOptions = [
        '-c copy',
        '-y',
      ];
      const inputOptions: string[] = [
        '-headers', headersOption,
      ];
      if (videoUrl.includes('.m3u8')) {
        outputOptions.push('-bsf:a aac_adtstoasc');
        inputOptions.push(
          '-reconnect', '1',
          '-reconnect_at_eof', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5'
        );
      }

      const command = ffmpeg(videoUrl)
        .inputOptions(inputOptions)
        .outputOptions(outputOptions)
        .output(absoluteFilePath);

      command.on('start', (commandLine) => {
        console.log(`[Downloader FFmpeg] Запущен для задачи #${task.id}: ${commandLine}`);
      });

      command.on('progress', (progress) => {
        const now = Date.now();
        let percent = Math.floor(progress.percent || 0);

        // Если HLS не отдает общую длительность, рассчитываем прогресс по таймкоду (серия ~24 мин = 1440 сек)
        if (percent <= 0 && progress.timemark) {
          try {
            const parts = progress.timemark.split(':');
            if (parts.length === 3) {
              const sec = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
              percent = Math.min(98, Math.floor((sec / 1440) * 100));
            }
          } catch {}
        }

        if (percent > 99) percent = 99;

        // Обновляем статус в базе при шаге от 5% или раз в 2.5 секунды
        if (
          (percent >= lastUpdatedProgress + 5 || now - lastUpdateTime > 2500) &&
          percent > lastUpdatedProgress
        ) {
          lastUpdatedProgress = percent;
          lastUpdateTime = now;
          dbService.updateDownloadStatus(task.id, 'downloading', percent);
          console.log(
            `[Downloader FFmpeg] Задача #${task.id} прогресс: ${percent}% (время: ${progress.timemark || 'N/A'}, fps: ${progress.currentFps || 0})`
          );
        }

        // Интерактивное обновление шкалы в Telegram каждые 20% (20, 40, 60, 80)
        const currentStep = Math.floor(percent / 20) * 20;
        if (currentStep > lastReportedStep && currentStep <= 80 && currentStep > 0) {
          lastReportedStep = currentStep;
          if (task.telegram_chat_id && task.telegram_message_id) {
            const bar = renderProgressBar(currentStep);
            let speedStr = '1.0x';
            if (progress.currentFps && progress.currentFps > 0) {
              speedStr = `${(progress.currentFps / 24).toFixed(1)}x`;
            } else if (progress.currentKbps) {
              speedStr = `${Math.round(progress.currentKbps)} кбит/с`;
            }

            const timemark = progress.timemark ? progress.timemark.split('.')[0] : '00:00';
            const progressText = [
              '📥 <b>Скачивание серии...</b>',
              '━━━━━━━━━━━━━━━━━━━━',
              `📺 <b>Тайтл:</b> ${escapeHtml(animeTitle)}`,
              `🎬 <b>Серия:</b> <code>#${task.episode}</code>`,
              `🎙 <b>Озвучка:</b> <code>${escapeHtml(task.voiceover || 'По умолчанию')}</code>`,
              '',
              `<b>[${bar}] ${currentStep}%</b>`,
              `⏱ <b>Таймкод:</b> <code>${timemark}</code> | 🚀 <b>Скорость:</b> <code>${speedStr}</code>`,
            ].join('\n');

            sendTelegramUpdate(task.telegram_chat_id, task.telegram_message_id, progressText).catch(() => {});
          }
        }
      });

      command.on('end', () => {
        console.log(`[Downloader FFmpeg] ✅ Загрузка задачи #${task.id} успешно завершена: ${relativeFilePath}`);
        dbService.updateDownloadStatus(task.id, 'completed', 100, relativeFilePath);

        // Расчет итогового размера файла
        let fileSizeStr = 'N/A';
        try {
          const stats = fs.statSync(absoluteFilePath);
          fileSizeStr = `${(stats.size / (1024 * 1024)).toFixed(1)} МБ`;
        } catch {}

        // Финальное сообщение в Telegram с метаданными
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

        resolve(relativeFilePath);
      });

      command.on('error', (err, stdout, stderr) => {
        const errMsg = err?.message || 'Неизвестная ошибка FFmpeg';
        console.error(`[Downloader FFmpeg] ❌ Ошибка FFmpeg для задачи #${task.id}:`, errMsg);
        if (stderr) {
          console.error(`[Downloader FFmpeg] FFmpeg stderr:\n`, stderr.substring(0, 400));
        }
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

        reject(new Error(`FFmpeg error: ${errMsg}`));
      });

      command.run();
    });
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
          // Получаем прямую ссылку на видеопоток
          const videoLink = await animelibService.getDirectVideoLink(
            task.media_id,
            task.episode,
            task.voiceover || undefined
          );

          if (!videoLink || !videoLink.url || !isValidVideoUrl(videoLink.url)) {
            console.warn(
              `[Downloader] ❌ Не удалось разрешить валидный URL видеопотока для задачи #${task.id} (Media ${task.media_id}, Ep ${task.episode}, URL: ${videoLink?.url || 'пусто'})`
            );
            dbService.updateDownloadStatus(task.id, 'error', 0);

            if (task.telegram_chat_id && task.telegram_message_id) {
              const errResolveText = [
                '❌ <b>Не удалось получить ссылку на видеопоток!</b>',
                '━━━━━━━━━━━━━━━━━━━━',
                `🎬 <b>Серия:</b> <code>#${task.episode}</code>`,
                '⚠️ <i>Плееры AnimeLib и Kodik не предоставили рабочий HLS/MP4 поток.</i>',
              ].join('\n');
              sendTelegramUpdate(task.telegram_chat_id, task.telegram_message_id, errResolveText).catch(() => {});
            }
            continue;
          }

          console.log(
            `[Downloader] Поток найден: [${videoLink.playerType}] Качество: ${videoLink.quality || 'Auto'}, Озвучка: ${videoLink.voiceover || 'N/A'}, Формат: ${videoLink.format}`
          );

          // Проверяем формат: HLS (.m3u8) или прямой MP4 файл
          const isHls = videoLink.url.includes('.m3u8') || videoLink.format === 'm3u8';

          if (isHls) {
            // Для HLS плейлистов используем FFmpeg
            await this.downloadTaskWithFFmpeg(task, videoLink.url, videoLink.headers);
          } else {
            // Для прямых видеофайлов (например .mp4 на видеосервере AnimeLib) скачиваем через HTTP Stream
            await this.downloadTaskWithHttpStream(task, videoLink.url, videoLink.headers);
          }
        } catch (taskErr: any) {
          console.error(`[Downloader] Ошибка при обработке задачи #${task.id}:`, taskErr?.message);
          dbService.updateDownloadStatus(task.id, 'error', 0);
        }
      }
    } catch (queueErr: any) {
      console.error('[Downloader] Критическая ошибка в processQueue:', queueErr?.message);
    } finally {
      this.isProcessing = false;
    }
  }
}

export const downloaderService = new DownloaderService();


