import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { dbService, DownloadQueueRecord } from '../db/database';
import { animelibService, ANIMELIB_WEB_URL } from './animelib';

// Настройка пути к бинарнику FFmpeg
if (ffmpegInstaller && ffmpegInstaller.path) {
  ffmpeg.setFfmpegPath(ffmpegInstaller.path);
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
  addToQueue(mediaId: number, episode: number, voiceover?: string): number {
    return dbService.addToDownloadQueue(mediaId, episode, voiceover);
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
   * Скачивание отдельной задачи через FFmpeg (HLS .m3u8 -> MP4 с ремуксингом)
   */
  private async downloadTaskWithFFmpeg(
    task: DownloadQueueRecord,
    videoUrl: string
  ): Promise<string> {
    this.ensureDownloadsDir();

    const safeVoiceover = (task.voiceover || 'default')
      .replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '_')
      .substring(0, 30);

    const filename = `anime_${task.media_id}_ep_${task.episode}_${safeVoiceover}.mp4`;
    const relativeFilePath = path.join('downloads', filename);
    const absoluteFilePath = path.join(this.downloadsDir, filename);

    // Подготовка заголовков для обхода 403 Forbidden от CDN AnimeLib
    const userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
    const referer = `${ANIMELIB_WEB_URL}/`;
    const headersOption = `Referer: ${referer}\r\nUser-Agent: ${userAgent}\r\n`;

    return new Promise((resolve, reject) => {
      let lastUpdatedProgress = 0;
      let lastUpdateTime = 0;

      console.log(`[Downloader] Начинаю загрузку задачи #${task.id}...`);
      console.log(`[Downloader] URL потока: ${videoUrl}`);
      console.log(`[Downloader] Целевой файл: ${relativeFilePath}`);

      const command = ffmpeg(videoUrl)
        .inputOptions([
          '-headers', headersOption,
        ])
        .outputOptions([
          '-c copy',
          '-bsf:a aac_adtstoasc',
          '-y',
        ])
        .output(absoluteFilePath);

      command.on('start', (commandLine) => {
        console.log(`[Downloader] FFmpeg запущен для задачи #${task.id}: ${commandLine}`);
      });

      command.on('progress', (progress) => {
        const now = Date.now();
        // В HLS-потоках progress.percent может быть не определен, если нет точной длительности
        let percent = Math.floor(progress.percent || 0);

        if (percent > 99) percent = 99;

        // Обновляем статус при шаге от 5% или раз в 2.5 секунды
        if (
          (percent >= lastUpdatedProgress + 5 || now - lastUpdateTime > 2500) &&
          percent > lastUpdatedProgress
        ) {
          lastUpdatedProgress = percent;
          lastUpdateTime = now;
          dbService.updateDownloadStatus(task.id, 'downloading', percent);
          console.log(
            `[Downloader] Задача #${task.id} прогресс: ${percent}% (время: ${progress.timemark || 'N/A'}, fps: ${progress.currentFps || 0})`
          );
        }
      });

      command.on('end', () => {
        console.log(`[Downloader] ✅ Загрузка задачи #${task.id} успешно завершена: ${relativeFilePath}`);
        dbService.updateDownloadStatus(task.id, 'completed', 100, relativeFilePath);
        resolve(relativeFilePath);
      });

      command.on('error', (err, stdout, stderr) => {
        const errMsg = err?.message || 'Неизвестная ошибка FFmpeg';
        console.error(`[Downloader] ❌ Ошибка FFmpeg для задачи #${task.id}:`, errMsg);
        if (stderr) {
          console.error(`[Downloader] FFmpeg stderr:\n`, stderr.substring(0, 400));
        }
        dbService.updateDownloadStatus(task.id, 'error', 0);
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

          if (!videoLink || !videoLink.url) {
            console.warn(
              `[Downloader] ❌ Не удалось разрешить видеопоток для задачи #${task.id} (Media ${task.media_id}, Ep ${task.episode})`
            );
            dbService.updateDownloadStatus(task.id, 'error', 0);
            continue;
          }

          console.log(
            `[Downloader] Поток найден: [${videoLink.playerType}] Качество: ${videoLink.quality || 'Auto'}, Озвучка: ${videoLink.voiceover || 'N/A'}, Формат: ${videoLink.format}`
          );

          // Запуск скачивания через FFmpeg
          await this.downloadTaskWithFFmpeg(task, videoLink.url);
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
