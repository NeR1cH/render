import { Bot, InlineKeyboard, Keyboard, Context } from 'grammy';
import dotenv from 'dotenv';
import { animelibService, AnimeLibService, ANIMELIB_WEB_URL, AnimeLibBookmarkItem, POPULAR_STUDIOS } from '../services/animelib';
import { shikimoriService, ShikimoriAnime } from '../services/shikimori';
import { dbService, AnimeLibSyncRecord, UserPreferencesRecord } from '../db/database';
import { getLibraryComprehensiveStats } from '../services/libraryStats';
import { downloaderService } from '../services/downloader';
import { sourceRegistry } from '../plugins/SourcePluginRegistry.js';
import { StreamResult } from '../plugins/types.js';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) {
  console.warn('⚠️ TELEGRAM_BOT_TOKEN is not defined in .env. Bot will not connect to Telegram until token is set.');
}

export const bot = new Bot(BOT_TOKEN || '000000000:AAFakeTokenForOfflineMode');

export { POPULAR_STUDIOS };

// In-memory cache for studio voiceovers per title and per episode to guarantee <64 byte callback_data
export const titleVoiceoversCache = new Map<number, string[]>();
export const episodeVoiceoversCache = new Map<string, string[]>();
export const episodeStreamsCache = new Map<string, StreamResult[]>();

// ==========================================
// Persistent Bottom Menu (Reply Keyboard)
// ==========================================
export function getMainMenuKeyboard(): Keyboard {
  return new Keyboard()
    .text('🔍 Проверить обновления')
    .text('📥 Скачать серию')
    .row()
    .text('📋 Мой список («Смотрю»)')
    .text('⏳ Запланированное')
    .row()
    .text('📊 Статистика медиатеки')
    .text('⚙️ Настройки и озвучки')
    .resized()
    .persistent();
}

// ==========================================
// HTML Card Formatters (Personalized & Rich)
// ==========================================

export function formatAnimeCard(data: {
  title: string;
  rusTitle?: string;
  currentEpisode?: number;
  newEpisode?: number;
  score?: number;
  status?: string;
  genres?: string[];
  voiceovers?: string[];
  favoriteVoiceovers?: string[];
  customNote?: string;
  description?: string;
  quality?: string;
  cardStyle?: string;
  maxQuality?: string;
  availablePlayers?: string[];
  folderStatus?: 'watching' | 'planned';
}): string {
  const displayTitle = data.rusTitle || data.title;
  const originalTitle = data.rusTitle && data.title !== data.rusTitle ? ` <i>(${data.title})</i>` : '';
  const score = data.score ? `⭐ <b>${data.score.toFixed(1)}</b> / 10` : '⭐ <i>Без оценки</i>';
  const genres = data.genres && data.genres.length > 0 ? `🏷 <i>${data.genres.slice(0, 4).join(', ')}</i>` : '';
  const qualityBadge = data.quality ? ` <code>[${data.quality}]</code>` : '';

  const folderBadge = data.folderStatus === 'planned' ? '📌 <b>Список:</b> <i>Запланировано</i>' : '';
  const maxQualityText = data.maxQuality ? `💎 <b>Макс. качество:</b> ${escapeHtml(data.maxQuality)}` : '';
  const playersText =
    data.availablePlayers && data.availablePlayers.length > 0
      ? `🎮 <b>Плееры:</b> ${data.availablePlayers.slice(0, 3).map((p) => `<code>${escapeHtml(p)}</code>`).join(', ')}`
      : '';

  // Episode tracking status line
  let epText = '';
  if (data.newEpisode !== undefined && data.currentEpisode !== undefined) {
    if (data.newEpisode > data.currentEpisode) {
      epText = `🔔 <b>Новая серия:</b> <code>#${data.newEpisode}</code> (просмотрено: <code>#${data.currentEpisode}</code>)${qualityBadge}`;
    } else {
      epText = `📺 <b>Текущая серия:</b> <code>#${data.currentEpisode}</code>${qualityBadge}`;
    }
  } else if (data.newEpisode) {
    epText = `📺 <b>Вышла серия:</b> <code>#${data.newEpisode}</code>${qualityBadge}`;
  }

  // Highlight favorite voiceover studio
  let voiceoverText = '';
  if (data.voiceovers && data.voiceovers.length > 0) {
    const favorites = data.favoriteVoiceovers || [];
    const formattedStudios = data.voiceovers.map((studio) => {
      const isFav = favorites.some((f) => f.toLowerCase() === studio.toLowerCase());
      return isFav ? `🔥 <b>${escapeHtml(studio)}</b>` : escapeHtml(studio);
    });

    const hasFav = data.voiceovers.some((studio) =>
      favorites.some((f) => f.toLowerCase() === studio.toLowerCase())
    );

    const favIndicator = hasFav ? '✨ <i>Любимая озвучка уже доступна!</i>\n' : '';
    const sliceCount = 4;
    const remaining = formattedStudios.length > sliceCount ? ` <i>(+еще ${formattedStudios.length - sliceCount})</i>` : '';

    voiceoverText = `${favIndicator}🎙 <b>Озвучка:</b> ${formattedStudios.slice(0, sliceCount).join(', ')}${remaining}`;
  }

  // Custom User Note if added
  const noteText = data.customNote ? `\n📌 <b>Моя заметка:</b> <i>«${escapeHtml(data.customNote)}»</i>` : '';

  // Minimal card style
  if (data.cardStyle === 'minimal') {
    return [
      `🎬 <b>${escapeHtml(displayTitle)}</b>`,
      folderBadge,
      epText,
      maxQualityText,
      voiceoverText,
      noteText,
    ].filter(Boolean).join('\n');
  }

  // Compact card style
  if (data.cardStyle === 'compact') {
    return [
      `🎬 <b>${escapeHtml(displayTitle)}</b>${originalTitle}`,
      folderBadge,
      score,
      epText,
      maxQualityText,
      playersText,
      voiceoverText,
      noteText,
    ].filter(Boolean).join('\n');
  }

  // Full rich card style
  let desc = '';
  if (data.description) {
    const cleanDesc = stripBBCode(data.description);
    const truncated = cleanDesc.length > 220 ? `${cleanDesc.slice(0, 220)}...` : cleanDesc;
    desc = `\n📖 <i>${escapeHtml(truncated)}</i>`;
  }

  const lines = [
    `🎬 <b>${escapeHtml(displayTitle)}</b>${originalTitle}`,
    folderBadge,
    score,
    genres,
    epText,
    maxQualityText,
    playersText,
    voiceoverText,
    noteText,
    desc,
  ].filter(Boolean);

  return lines.join('\n');
}

/**
 * Builds interactive inline keyboard with smart direct links and actions
 */
export function buildAnimeCardKeyboard(item: {
  mediaId?: number;
  slugUrl?: string;
  shikiId?: number | string;
  title: string;
  currentEpisode?: number;
  newEpisode?: number;
  quality?: string;
}): InlineKeyboard {
  const kb = new InlineKeyboard();

  const animelibUrl = item.slugUrl
    ? `${ANIMELIB_WEB_URL}/ru/anime/${item.slugUrl}`
    : item.mediaId
      ? `${ANIMELIB_WEB_URL}/ru/anime/${item.mediaId}`
      : null;

  const shikimoriUrl = item.shikiId ? `https://shikimori.one/animes/${item.shikiId}` : null;
  const searchQuality = item.quality ? ` ${item.quality}` : '';
  const torrentQuery = encodeURIComponent(`${item.title}${searchQuality}`);
  const rutrackerUrl = `https://rutracker.org/forum/tracker.php?nm=${torrentQuery}`;

  // Row 1: Action Buttons (Скачать, Отметить, Настроить озвучку)
  if (item.mediaId) {
    const epToMark = item.newEpisode ?? ((item.currentEpisode || 0) + 1);
    kb.text('📥 Скачать', `dl:${item.mediaId}:${epToMark}`);
    kb.text(`👁 Отметить #${epToMark}`, `watch_${item.mediaId}_${epToMark}_${item.shikiId || 0}`);
    kb.row();
    kb.text('🎙 Настроить озвучку', `setup_vo:${item.mediaId}`);
    kb.row();
  }

  // Row 2: Direct media links (Открыть на сайте, Shikimori)
  if (animelibUrl) {
    kb.url('🌐 Открыть на сайте', animelibUrl);
  }
  if (shikimoriUrl) {
    kb.url('📊 Shikimori', shikimoriUrl);
  }

  // Row 3: Torrent search
  kb.row();
  kb.url('📥 RuTracker (1080p)', rutrackerUrl);

  // Row 4: Rating & Completed
  if (item.mediaId && item.shikiId) {
    kb.row();
    kb.text('⭐️ Оценить', `rate_menu:${item.shikiId}`);
    kb.text('🏁 Завершить', `mark_completed:${item.mediaId}:${item.shikiId}`);
  }

  return kb;
}

export function escapeHtml(str: string): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function stripBBCode(text: string): string {
  if (!text) return '';
  let str = text;
  // Unwrap tags that wrap meaningful text (repeating to support nested tags)
  for (let i = 0; i < 3; i++) {
    str = str.replace(/\[([a-zA-Z0-9_]+)(?:=[^\]]*)?\]([\s\S]*?)\[\/\1\]/gi, (_match, _tag, content) => content);
  }
  // Remove standalone or self-closing tags like [poster=123], [image=...], [/character]
  str = str.replace(/\[\/?[a-zA-Z0-9_]+(?:=[^\]]*)?\]/gi, '');
  // Remove any raw HTML tags
  str = str.replace(/<[^>]*>?/gm, '');
  // Normalize whitespace
  return str.replace(/\s+/g, ' ').trim();
}

// ==========================================
// Core Check & Sync Logic (with Preferences)
// ==========================================

export interface CheckUpdatesResult {
  success: boolean;
  checkedCount: number;
  updatesCount: number;
  updatedTitles: Array<{
    mediaId: number;
    title: string;
    rusTitle?: string;
    newEpisode: number;
    previousEpisode: number;
  }>;
  message?: string;
}

export async function checkAnimeUpdates(ctx?: Context, notifyIfEmpty: boolean = true): Promise<CheckUpdatesResult> {
  const userId = ctx?.from?.id ? String(ctx.from.id) : DEFAULT_CHAT_ID || 'default_user';
  const prefs = dbService.getUserPreferences(userId);

  // Parse favorite voiceovers
  let favoriteVoiceovers: string[] = ['AniLibria', 'Dream Cast'];
  try {
    favoriteVoiceovers = JSON.parse(prefs.favorite_voiceovers || '[]');
  } catch {}

  const send = async (text: string, options?: any) => {
    if (ctx) {
      await ctx.reply(text, options);
    } else if (DEFAULT_CHAT_ID && BOT_TOKEN) {
      // Check Quiet Hours before sending background messages
      if (prefs.quiet_hours_enabled) {
        const currentHour = new Date().getHours();
        const inQuiet =
          prefs.quiet_start_hour > prefs.quiet_end_hour
            ? currentHour >= prefs.quiet_start_hour || currentHour < prefs.quiet_end_hour
            : currentHour >= prefs.quiet_start_hour && currentHour < prefs.quiet_end_hour;

        if (inQuiet) {
          console.log('[Quiet Hours] Notification muted between', prefs.quiet_start_hour, 'and', prefs.quiet_end_hour);
          return;
        }
      }
      await bot.api.sendMessage(DEFAULT_CHAT_ID, text, options);
    }
  };

  const updatedTitles: Array<{
    mediaId: number;
    title: string;
    rusTitle?: string;
    newEpisode: number;
    previousEpisode: number;
  }> = [];

  try {
    await send('⏳ <i>Проверяю онгоинги из раздела «Смотрю» (AnimeLib)...</i>', {
      parse_mode: 'HTML',
    });

    // Проверяем ИСКЛЮЧИТЕЛЬНО онгоинги из раздела «Смотрю» (5 тайтлов)
    let trackedList = await animelibService.getAllWatching();
    if (!trackedList || trackedList.length === 0) {
      const cached = dbService.getAllSyncItems('watching');
      if (cached && cached.length > 0) {
        trackedList = cached.map((c) => ({
          media_id: c.media_id,
          slug_url: String(c.media_id),
          name: c.title,
          rus_name: c.rus_title,
          current_progress_number: c.last_tracked_episode,
          last_item_number: c.latest_episode || c.last_tracked_episode,
          folderStatus: 'watching',
        }));
      }
    }

    if (!trackedList || trackedList.length === 0) {
      dbService.saveCheckReport({
        timestamp: Date.now(),
        checked_count: 0,
        updates_count: 0,
        matched_count: 0,
        synced_count: 0,
        status: 'warning',
        message: 'Раздел «Смотрю» пуст или требуется обновление cookie',
      });

      if (notifyIfEmpty) {
        await send(
          '📭 В списке <b>«Смотрю»</b> пока нет онгоингов, либо нужно обновить куку в <code>ANIMELIB_COOKIE</code>.',
          { parse_mode: 'HTML' }
        );
      }
      return {
        success: true,
        checkedCount: 0,
        updatesCount: 0,
        updatedTitles: [],
        message: 'В разделе «Смотрю» пока нет тайтлов или требуется обновление cookie',
      };
    }

    let updatesCount = 0;

    for (const item of trackedList) {
      try {
        const mediaEpisodes = await animelibService.getMediaEpisodes(item.media_id, item.slug_url);
        const stored = dbService.getSyncItemByMediaId(item.media_id);

        const lastTracked = stored?.last_tracked_episode || item.current_progress_number || 0;
        const latestEpisode = mediaEpisodes.latestEpisode || item.last_item_number;

        // Try to match or retrieve Shikimori details
        let shikiId = stored?.shiki_id;
        let shikiAnime: ShikimoriAnime | null = null;

        if (!shikiId) {
          const norm = animelibService.constructor
            ? (animelibService as any).constructor.normalizeTitle(item.rus_name || item.name)
            : item.name;
          const cached = dbService.getCachedMatch(norm);

          if (cached) {
            shikiId = cached.shiki_id;
          } else {
            const searchResults = await shikimoriService.searchAnime(item.rus_name || item.name, 3);
            if (searchResults && searchResults.length > 0) {
              shikiAnime = searchResults[0];
              shikiId = Number(shikiAnime.id);
              dbService.setCachedMatch({
                normalized_title: norm,
                shiki_id: shikiId,
                shiki_title: shikiAnime.russian || shikiAnime.name,
              });
            }
          }
        }

        if (shikiId && !shikiAnime) {
          shikiAnime = await shikimoriService.getAnimeById(shikiId);
        }

        // Защита от спама при первичном добавлении / инициализации:
        // Если запись только создана или lastTracked === 0, не спамим уведомлениями,
        // а фиксируем текущую вышедшую серию в базе для отслеживания будущих релизов.
        if (lastTracked === 0) {
          if (latestEpisode > 0) {
            dbService.updateTrackedEpisode(item.media_id, latestEpisode);
          } else {
            dbService.updateLastChecked(item.media_id);
          }
          continue;
        }

        // Has a new episode been released?
        const hasNewEpisode = latestEpisode > lastTracked;

        if (hasNewEpisode) {
          // If notify_only_favorites is turned ON, verify favorite voiceover exists for the latest episode
          if (prefs.notify_only_favorites) {
            const targetVoiceovers = mediaEpisodes.latestVoiceovers?.length
              ? mediaEpisodes.latestVoiceovers
              : mediaEpisodes.voiceovers;

            const matchesFavorite = targetVoiceovers.some((vo) =>
              favoriteVoiceovers.some((fav) => fav.toLowerCase() === vo.toLowerCase())
            );
            if (!matchesFavorite) {
              dbService.updateLastChecked(item.media_id);
              // Skip notification until favorite studio is available
              continue;
            }
          }

          updatesCount++;
          updatedTitles.push({
            mediaId: item.media_id,
            title: item.name,
            rusTitle: item.rus_name || shikiAnime?.russian,
            newEpisode: latestEpisode,
            previousEpisode: lastTracked,
          });

          const cardText = formatAnimeCard({
            title: item.name,
            rusTitle: item.rus_name || shikiAnime?.russian,
            currentEpisode: lastTracked,
            newEpisode: latestEpisode,
            score: shikiAnime?.score,
            genres: shikiAnime?.genres?.map((g) => g.russian || g.name),
            voiceovers: mediaEpisodes.latestVoiceovers?.length ? mediaEpisodes.latestVoiceovers : mediaEpisodes.voiceovers,
            favoriteVoiceovers,
            customNote: stored?.custom_note || undefined,
            description: shikiAnime?.description,
            quality: prefs.preferred_quality || '1080p',
            cardStyle: prefs.card_style || 'full',
            maxQuality: mediaEpisodes.maxQuality,
            availablePlayers: mediaEpisodes.availablePlayers,
            folderStatus: item.folderStatus,
          });

          const kb = buildAnimeCardKeyboard({
            mediaId: item.media_id,
            slugUrl: item.slug_url,
            shikiId: shikiId || undefined,
            title: item.rus_name || item.name,
            currentEpisode: lastTracked,
            newEpisode: latestEpisode,
            quality: prefs.preferred_quality || '1080p',
          });

          if (prefs.card_style !== 'minimal' && shikiAnime?.poster?.mainUrl) {
            try {
              await (ctx?.replyWithPhoto
                ? ctx.replyWithPhoto(shikiAnime.poster.mainUrl, {
                    caption: cardText,
                    parse_mode: 'HTML',
                    reply_markup: kb,
                  })
                : bot.api.sendPhoto(DEFAULT_CHAT_ID!, shikiAnime.poster.mainUrl, {
                    caption: cardText,
                    parse_mode: 'HTML',
                    reply_markup: kb,
                  }));
            } catch {
              await send(cardText, { parse_mode: 'HTML', reply_markup: kb });
            }
          } else {
            await send(cardText, { parse_mode: 'HTML', reply_markup: kb });
          }

          // Save tracked episode in SQLite
          dbService.updateTrackedEpisode(item.media_id, latestEpisode);

          // Авто-загрузка по предпочтениям (если включён auto_download_enabled или флаг среды)
          const isAutoDownloadOn = Boolean(prefs.auto_download_enabled || process.env.AUTO_DOWNLOAD_ENABLED === 'true');
          if (isAutoDownloadOn && stored?.preferred_voiceover) {
            const availableVoiceovers = mediaEpisodes.latestVoiceovers?.length
              ? mediaEpisodes.latestVoiceovers
              : mediaEpisodes.voiceovers;

            const prefVoNorm = stored.preferred_voiceover.trim().toLowerCase();
            const isMatched = availableVoiceovers?.some((vo) =>
              vo.toLowerCase().includes(prefVoNorm) || prefVoNorm.includes(vo.toLowerCase())
            );

            if (isMatched) {
              console.log(`[AutoDownload] 📥 Авто-загрузка серии #${latestEpisode} для «${item.name}» (Озвучка: ${stored.preferred_voiceover})`);
              downloaderService.addToQueue(item.media_id, latestEpisode, stored.preferred_voiceover);
              downloaderService.processQueue().catch((err) => {
                console.error('[AutoDownload] Ошибка фоновой обработки очереди загрузок:', err);
              });
            }
          }
        } else {
          dbService.updateLastChecked(item.media_id);
        }
      } catch (err) {
        console.error(`Error processing title "${item.name}":`, err);
      }
    }

    if (updatesCount === 0 && notifyIfEmpty) {
      await send(
        `✨ <b>Все серии просмотрены!</b>\nПроверено <b>${trackedList.length}</b> онгоингов из раздела «Смотрю», свежих серий пока нет.`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('🔄 Проверить снова', 'check_updates'),
        }
      );
    }

    const matchedCount = trackedList.filter((item) => {
      const s = dbService.getSyncItemByMediaId(item.media_id);
      return !!s?.shiki_id;
    }).length;
    const syncedCount = trackedList.filter((item) => {
      const s = dbService.getSyncItemByMediaId(item.media_id);
      return s?.shiki_synced === 1;
    }).length;

    const reportMsg = updatesCount > 0 ? `Найдено новых серий: ${updatesCount}` : 'Все серии актуальны ✅';

    dbService.saveCheckReport({
      timestamp: Date.now(),
      checked_count: trackedList.length,
      updates_count: updatesCount,
      matched_count: matchedCount,
      synced_count: syncedCount,
      status: 'ok',
      message: reportMsg,
      details_json: JSON.stringify(updatedTitles),
    });

    return {
      success: true,
      checkedCount: trackedList.length,
      updatesCount,
      updatedTitles,
      message: updatesCount > 0 ? `Найдено новых серий: ${updatesCount}` : 'Свежих релизов пока нет',
    };
  } catch (err: any) {
    console.error('Check anime updates error:', err);
    dbService.saveCheckReport({
      timestamp: Date.now(),
      checked_count: 0,
      updates_count: 0,
      matched_count: 0,
      synced_count: 0,
      status: 'error',
      message: err.message || 'Ошибка проверки обновлений',
    });

    await send(`❌ <b>Ошибка при проверке:</b>\n<code>${escapeHtml(err.message)}</code>`, {
      parse_mode: 'HTML',
    });
    return {
      success: false,
      checkedCount: 0,
      updatesCount: 0,
      updatedTitles: [],
      message: err.message || 'Ошибка проверки обновлений',
    };
  }
}

// ==========================================
// Settings View & Interactive Menu
// ==========================================

export function renderSettingsKeyboard(userId: string): { text: string; keyboard: InlineKeyboard } {
  const prefs = dbService.getUserPreferences(userId);
  let favorites: string[] = [];
  try {
    favorites = JSON.parse(prefs.favorite_voiceovers || '[]');
  } catch {}

  const favList = favorites.length > 0 ? favorites.join(', ') : 'Не выбрано (по умолчанию)';
  const autoDlStatus = prefs.auto_download_enabled ? 'ВКЛЮЧЕНО ✅' : 'ВЫКЛЮЧЕНО ❌';
  const quietStatus = prefs.quiet_hours_enabled
    ? `Включен (${prefs.quiet_start_hour}:00 - ${prefs.quiet_end_hour}:00)`
    : 'Выключен';
  const favOnlyStatus = prefs.notify_only_favorites ? 'Только любимые студии' : 'Все релизы';

  const text = [
    '⚙️ <b>Панель настроек и студий озвучки</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    '<i>Управление любимой озвучкой, авто-загрузчиком серий и параметрами бота:</i>',
    '',
    `🎙 <b>Любимые студии озвучки:</b> 🔥 <code>${escapeHtml(favList)}</code>`,
    `⚡️ <b>Авто-скачивание новых серий:</b> <b>${autoDlStatus}</b>`,
    `🎯 <b>Фильтр релизов:</b> <code>${favOnlyStatus}</code>`,
    `📺 <b>Качество видео:</b> <code>${prefs.preferred_quality || '1080p'}</code>`,
    `🎨 <b>Стиль карточек:</b> <code>${prefs.card_style || 'full'}</code>`,
    `⏱ <b>Интервал проверки:</b> <code>каждые ${prefs.check_interval_min || 30} мин</code>`,
    `🔕 <b>Ночной тихий режим:</b> <code>${quietStatus}</code>`,
    '',
    '<i>Нажимайте кнопки ниже для моментального переключения параметров:</i>',
  ].join('\n');

  const kb = new InlineKeyboard();

  // Voiceovers selector buttons
  kb.text('🎙 Озвучки тайтлов («Смотрю»)', 'list_watching')
    .text('⭐ Глобальные озвучки', 'settings_voiceovers')
    .row();

  // Auto-download toggle
  const autoDlBtnText = prefs.auto_download_enabled ? '⚡️ Авто-загрузка: [ВКЛ ✅]' : '⚡️ Авто-загрузка: [ВЫКЛ ❌]';
  kb.text(autoDlBtnText, 'toggle_auto_download').row();

  // Quality & Card style
  kb.text(`📺 Качество: ${prefs.preferred_quality || '1080p'}`, 'toggle_quality')
    .text(`🎨 Стиль: ${prefs.card_style || 'full'}`, 'toggle_card_style')
    .row();

  // Filter & Quiet hours
  kb.text(`🎯 Фильтр: ${prefs.notify_only_favorites ? 'Только любимые' : 'Все озвучки'}`, 'toggle_fav_only')
    .row()
    .text(`🔕 Тихий режим: ${prefs.quiet_hours_enabled ? 'ВКЛ' : 'ВЫКЛ'}`, 'toggle_quiet_hours')
    .row();

  // Intervals
  kb.text('⏱ 15 мин', 'set_interval:15')
    .text('⏱ 30 мин', 'set_interval:30')
    .text('⏱ 1 час', 'set_interval:60')
    .row();

  // Close menu button
  kb.text('❌ Закрыть меню', 'close_menu');

  return { text, keyboard: kb };
}

// ==========================================
// Telegram Bot Command & Navigation Listeners
// ==========================================

export async function sendMainMenu(ctx: Context) {
  const welcomeText = [
    '🎛 <b>Панель управления Anime Tracker Hub</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    'Добро пожаловать! Вы можете полностью управлять ботом через нижнее постоянное меню:',
    '',
    '• 🔍 <b>Проверить обновления</b> — сканирование свежих серий на AnimeLib',
    '• 📥 <b>Скачать серию</b> — мастер выбора тайтла, серии и озвучки (HLS ➔ MP4)',
    '• 📋 <b>Мой список («Смотрю»)</b> — текущий прогресс, список онгоингов и отметки',
    '• ⏳ <b>Запланированное</b> — список тайтлов в планах и даты релизов',
    '• 📊 <b>Статистика медиатеки</b> — состояние базы и синхронизации с Shikimori',
    '• ⚙️ <b>Настройки и озвучки</b> — выбор студий дубляжа и авто-скачивание',
    '',
    '💡 <i>Постоянное меню закреплено внизу экрана:</i>',
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('🔍 Проверить обновления', 'check_updates')
    .text('📥 Скачать серию', 'dl_back_titles')
    .row()
    .text('📋 Мой список («Смотрю»)', 'list_watching')
    .text('⏳ Запланированное', 'list_planned')
    .row()
    .text('📊 Статистика медиатеки', 'show_stats')
    .text('⚙️ Настройки и озвучки', 'open_settings');

  await ctx.reply(welcomeText, {
    parse_mode: 'HTML',
    reply_markup: kb,
  });

  // Ensure persistent bottom reply keyboard is sent and restored
  await ctx.reply('👇 Клавиатура быстрого управления активна:', {
    reply_markup: getMainMenuKeyboard(),
  });
}

bot.command(['start', 'menu', 'help'], async (ctx) => {
  await sendMainMenu(ctx);
});

// System Slash Commands
bot.command('check', (ctx) => checkAnimeUpdates(ctx, true));
bot.command('download', (ctx) => showDownloadTitleSelection(ctx));
bot.command('watching', (ctx) => showWatchingList(ctx));
bot.command('planned', (ctx) => showPlannedList(ctx, 0, true));
bot.command('stats', (ctx) => showLibraryStats(ctx));
bot.command('profile', (ctx) => showLibraryStats(ctx));
bot.command('settings', (ctx) => openSettingsMenu(ctx));
bot.command('calendar', (ctx) => showAnimeCalendar(ctx));

// Text-based Persistent Reply Keyboard Listeners (bot.hears)
bot.hears('🔍 Проверить обновления', (ctx) => checkAnimeUpdates(ctx, true));
bot.hears('🔄 Проверить серии', (ctx) => checkAnimeUpdates(ctx, true));
bot.hears('📥 Скачать серию', (ctx) => showDownloadTitleSelection(ctx));
bot.hears('📥 Скачать', (ctx) => showDownloadTitleSelection(ctx));
bot.hears('📋 Мой список («Смотрю»)', (ctx) => showWatchingList(ctx));
bot.hears('📺 Мой список', (ctx) => showWatchingList(ctx));
bot.hears('⏳ Запланированное', (ctx) => showPlannedList(ctx, 0, true));
bot.hears('📊 Статистика медиатеки', (ctx) => showLibraryStats(ctx));
bot.hears('👤 Профиль', (ctx) => showLibraryStats(ctx));
bot.hears('⚙️ Настройки и озвучки', (ctx) => openSettingsMenu(ctx));
bot.hears('⚙️ Настройки', (ctx) => openSettingsMenu(ctx));
bot.hears('📅 Календарь', (ctx) => showAnimeCalendar(ctx));
bot.hears('🎲 Что глянуть?', (ctx) => showRandomRecommendation(ctx));

// ==========================================
// Navigation & Lists Handlers
// ==========================================

export async function showWatchingList(ctx: Context) {
  await ctx.reply('🔍 <i>Загружаю текущие тайтлы из раздела «Смотрю»...</i>', { parse_mode: 'HTML' });
  let list = await animelibService.getAllWatching();

  if (!list || list.length === 0) {
    const cached = dbService.getAllSyncItems('watching');
    if (cached && cached.length > 0) {
      list = cached.map((c) => ({
        media_id: c.media_id,
        slug_url: String(c.media_id),
        name: c.title,
        rus_name: c.rus_title,
        current_progress_number: c.last_tracked_episode,
        last_item_number: c.latest_episode || c.last_tracked_episode,
      }));
    }
  }

  if (!list || list.length === 0) {
    const emptyKb = new InlineKeyboard()
      .text('🔍 Проверить обновления', 'check_updates')
      .text('⏳ Запланированное', 'list_planned')
      .row()
      .text('❌ Закрыть меню', 'close_menu');
    return ctx.reply('📭 Список «Смотрю» пуст или сессия истекла. Обновите <code>ANIMELIB_COOKIE</code> в .env.', {
      parse_mode: 'HTML',
      reply_markup: emptyKb,
    });
  }

  // Актуализируем количество вышедших серий (устраняем рассинхроны вроде «8 из 7»)
  await Promise.allSettled(
    list.map(async (item) => {
      try {
        const eps = await animelibService.getAvailableEpisodes(item.media_id);
        if (eps.length > 0) {
          const actualMax = eps[eps.length - 1];
          if (actualMax > (item.last_item_number || 0)) {
            item.last_item_number = actualMax;
            dbService.updateLatestEpisode(item.media_id, actualMax);
          }
        }
      } catch {}
      const cur = item.current_progress_number || 0;
      if (cur > (item.last_item_number || 0)) {
        item.last_item_number = cur;
        dbService.updateLatestEpisode(item.media_id, cur);
      }
    })
  );

  const lines = list.map((item, idx) => {
    const curEp = item.current_progress_number || 0;
    const maxEp = item.last_item_number && item.last_item_number > 0 ? item.last_item_number : '?';
    const stored = dbService.getSyncItemByMediaId(item.media_id);
    const prefVo = dbService.getPreferredVoiceover(item.media_id) || stored?.preferred_voiceover;
    const voBadge = prefVo ? ` | 🎙 <b>${escapeHtml(prefVo)}</b>` : ' | 🎙 <i>(озвучка не выбрана)</i>';
    const note = stored?.custom_note ? `\n   📌 <i>«${escapeHtml(stored.custom_note)}»</i>` : '';
    return `${idx + 1}. <b>${escapeHtml(item.rus_name || item.name)}</b>\n   └ [Просмотрено: #${curEp} из #${maxEp} вышедших]${voBadge}${note}`;
  });

  const totalText = [
    `📋 <b>Мой список онгоингов («Смотрю»)</b> [${list.length} тайтлов]`,
    '━━━━━━━━━━━━━━━━━━━━',
    lines.join('\n\n'),
    '',
    '<i>Нажмите кнопку под тайтлом для настройки студии озвучки или скачивания:</i>',
  ].join('\n');

  const kb = new InlineKeyboard();

  // Individual buttons for each of the watching titles
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const name = it.rus_name || it.name;
    const shortName = name.length > 16 ? name.slice(0, 14) + '…' : name;
    const nextEp = (it.current_progress_number || 0) + 1;
    const stored = dbService.getSyncItemByMediaId(it.media_id);
    const prefVo = dbService.getPreferredVoiceover(it.media_id) || stored?.preferred_voiceover;
    const voLabel = prefVo ? `🎙 ${prefVo.slice(0, 12)}` : '🎙 Настроить';

    kb.text(`📥 #${nextEp} ${shortName}`, `dl_${it.media_id}_${nextEp}`)
      .text(voLabel, `setup_vo:${it.media_id}`)
      .row();
  }

  kb.text('📥 Выбрать другую серию', 'dl_back_titles').row()
    .text('🔍 Проверить обновления', 'check_updates')
    .text('⏳ Запланированное', 'list_planned')
    .row()
    .text('❌ Закрыть меню', 'close_menu');

  await ctx.reply(totalText, { parse_mode: 'HTML', reply_markup: kb });
}

export async function showPlannedList(
  ctx: Context,
  page: number = 0,
  filterBellOnly: boolean = true,
  isEdit: boolean = false
) {
  if (!isEdit) {
    await ctx.reply('⏳ <i>Загружаю тайтлы из списка «Запланированное» (AnimeLib)...</i>', { parse_mode: 'HTML' });
  }

  let plannedResult: { active: any[]; all?: any[]; totalPlanned: number } = { active: [], totalPlanned: 0 };
  try {
    plannedResult = await animelibService.getAllPlanned();
  } catch (err: any) {
    console.warn('[AnimeLib] Error fetching paginated planned titles:', err?.message);
  }

  let plannedItems = (plannedResult.all && plannedResult.all.length > 0)
    ? plannedResult.all
    : plannedResult.active;

  if (plannedItems.length === 0) {
    const plannedDb = dbService.getAllSyncItems('planned');
    if (plannedDb && plannedDb.length > 0) {
      plannedItems = plannedDb.map((p) => ({
        media_id: p.media_id,
        slug_url: String(p.media_id),
        name: p.title,
        rus_name: p.rus_title,
        current_progress_number: p.last_tracked_episode,
        last_item_number: p.latest_episode,
        is_subscribed: Boolean(p.is_subscribed),
        has_notifications: Boolean(p.is_subscribed),
        notify: Boolean(p.is_subscribed),
        subscription: Boolean(p.is_subscribed),
        notice: Boolean(p.is_subscribed),
      }));
    }
  }

  if (plannedItems.length === 0) {
    const emptyKb = new InlineKeyboard()
      .text('📋 Список «Смотрю»', 'list_watching')
      .text('🎲 Случайное', 'random_planned')
      .row()
      .text('❌ Закрыть меню', 'close_menu');

    return ctx.reply('📭 В списке <b>«Запланированное»</b> пока нет сохранённых тайтлов.', {
      parse_mode: 'HTML',
      reply_markup: emptyKb,
    });
  }

  // Фильтр тайтлов с активным колокольчиком уведомлений (с проверкой флагов и БД)
  const hasBellNotification = (item: any): boolean => {
    if (Boolean(item.has_notifications || item.notify || item.subscription || item.is_subscribed || item.notice)) {
      return true;
    }
    const dbRecord = dbService.getSyncItemByMediaId(item.media_id);
    return Boolean(dbRecord?.is_subscribed);
  };

  const bellItems = plannedItems.filter((item) => hasBellNotification(item));

  // Выбираем список для отображения: по умолчанию ТОЛЬКО подписанные тайтлы с колокольчиком
  let displayList: any[] = [];
  if (filterBellOnly) {
    displayList = bellItems;
  } else {
    // По умолчанию: сначала тайтлы с колокольчиком 🔔, затем с уже вышедшими сериями, затем анонсы
    displayList = [...plannedItems].sort((a, b) => {
      const aBell = hasBellNotification(a);
      const bBell = hasBellNotification(b);
      if (aBell && !bBell) return -1;
      if (!aBell && bBell) return 1;

      const aEp = a.last_item_number || 0;
      const bEp = b.last_item_number || 0;
      return bEp - aEp;
    });
  }

  if (filterBellOnly && displayList.length === 0) {
    const noBellKb = new InlineKeyboard()
      .text(`📂 Показать все запланированные (${plannedItems.length})`, 'list_planned_all')
      .row()
      .text('📋 Список «Смотрю»', 'list_watching')
      .text('❌ Закрыть', 'close_menu');

    const msg =
      '📭 В списке <b>«Запланированное»</b> нет тайтлов с активным колокольчиком 🔔.\n\n' +
      '💡 <i>Включите колокольчик 🔔 на сайте AnimeLib, чтобы бот мгновенно оповещал вас о новых сериях!</i>';

    if (isEdit && ctx.callbackQuery) {
      try {
        return await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: noBellKb });
      } catch {}
    }
    return ctx.reply(msg, { parse_mode: 'HTML', reply_markup: noBellKb });
  }

  // Постраничная навигация (по 10 тайтлов на страницу)
  const PAGE_SIZE = 10;
  const totalPages = Math.max(1, Math.ceil(displayList.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const pageItems = displayList.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const lines = pageItems.map((item, idx) => {
    const globalIdx = safePage * PAGE_SIZE + idx + 1;
    const title = escapeHtml(item.rus_name || item.name);
    const hasBell = Boolean(item.has_notifications || item.notify || item.subscription || item.is_subscribed || item.notice);
    const bellBadge = hasBell ? ' 🔔' : '';
    const latest = item.last_item_number && item.last_item_number > 0
      ? ` └ [Вышло серий: <code>#${item.last_item_number}</code>]`
      : ' └ <i>(анонс / серий ещё нет)</i>';
    return `${globalIdx}. <b>${title}</b>${bellBadge}\n${latest}`;
  });

  const headerTitle = filterBellOnly
    ? `🔔 <b>Запланированное с уведомлениями</b> [${displayList.length} из ${plannedItems.length}]`
    : `⏳ <b>Список «Запланированное»</b> [${plannedItems.length} тайтлов]`;

  const totalText = [
    headerTitle,
    '━━━━━━━━━━━━━━━━━━━━',
    lines.join('\n\n'),
    '',
    `📄 <i>Страница ${safePage + 1} из ${totalPages}</i>`,
  ].join('\n');

  const kb = new InlineKeyboard();

  // Навигация по страницам
  if (totalPages > 1) {
    if (safePage > 0) {
      kb.text('⬅️ Назад', `pl_p:${safePage - 1}:${filterBellOnly ? 1 : 0}`);
    }
    kb.text(`• ${safePage + 1}/${totalPages} •`, 'noop');
    if (safePage < totalPages - 1) {
      kb.text('Вперёд ➡️', `pl_p:${safePage + 1}:${filterBellOnly ? 1 : 0}`);
    }
    kb.row();
  }

  // Переключатель фильтра (Все / Только с колокольчиком)
  if (filterBellOnly) {
    kb.text(`📂 Показать все запланированные (${plannedItems.length})`, 'list_planned_all').row();
  } else if (bellItems.length > 0) {
    kb.text(`🔔 Только с колокольчиком (${bellItems.length})`, 'list_planned_bell').row();
  }

  kb.text('📥 Скачать серию из планов', 'dl_back_titles')
    .text('🎲 Случайное из планов', 'random_from_planned')
    .row()
    .text('📋 Мой список («Смотрю»)', 'list_watching')
    .text('🔍 Проверить обновления', 'check_updates')
    .row()
    .text('❌ Закрыть меню', 'close_menu');

  if (isEdit && ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(totalText, { parse_mode: 'HTML', reply_markup: kb });
    } catch {}
  }

  await ctx.reply(totalText, { parse_mode: 'HTML', reply_markup: kb });
}

function formatRelativeTime(targetDate: Date): string {
  const now = new Date();
  const diffMs = targetDate.getTime() - now.getTime();
  if (diffMs < 0) return 'уже вышло';
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 60) {
    return `через ${diffMinutes} мин`;
  }
  if (diffHours < 24) {
    const isToday = now.getDate() === targetDate.getDate();
    return isToday ? `сегодня (через ${diffHours} ч)` : `через ${diffHours} ч`;
  }
  if (diffDays === 1) {
    return 'завтра';
  }
  return `через ${diffDays} дн.`;
}

async function showAnimeCalendar(ctx: Context, isGlobal: boolean = false) {
  const promptMsg = isGlobal
    ? '🌐 <i>Загружаю общий график выхода онгоингов сезона...</i>'
    : '📅 <i>Загружаю график выхода серий для ваших тайтлов...</i>';
  await ctx.reply(promptMsg, { parse_mode: 'HTML' });

  try {
    const calendar = await shikimoriService.getCalendar();
    if (!calendar || calendar.length === 0) {
      return ctx.reply('📭 В официальном расписании на ближайшие дни релизы отсутствуют.');
    }

    if (isGlobal) {
      const items = calendar.slice(0, 10);
      const lines = items.map((c) => {
        const date = new Date(c.next_episode_at);
        const timeStr = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const dayStr = date.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
        const relStr = formatRelativeTime(date);
        return `• <b>${escapeHtml(c.anime.russian || c.anime.name)}</b> — Эпизод <code>#${c.next_episode}</code>\n  ⏰ <i>${dayStr} в ${timeStr}</i> (${relStr})`;
      });

      const kb = new InlineKeyboard()
        .text('📅 Только мои аниме', 'show_calendar')
        .text('📺 Мой список', 'list_watching');

      const text = `🌐 <b>Общий календарь онгоингов (Ближайшие релизы):</b>\n\n${lines.join('\n\n')}`;
      return await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }

    // Personal Calendar: Filter only anime the user is watching!
    const watchingDb = dbService.getAllSyncItems('watching');
    let watchingLib: any[] = [];
    try {
      watchingLib = await animelibService.getAllWatching();
    } catch {}

    const watchingShikiIds = new Set<number>();
    const watchingTitleKeywords = new Set<string>();

    for (const w of watchingDb) {
      if (w.shiki_id) watchingShikiIds.add(Number(w.shiki_id));
      if (w.title) watchingTitleKeywords.add(AnimeLibService.normalizeTitle(w.title).toLowerCase());
      if (w.rus_title) watchingTitleKeywords.add(AnimeLibService.normalizeTitle(w.rus_title).toLowerCase());
    }

    for (const a of watchingLib) {
      if (a.name) watchingTitleKeywords.add(AnimeLibService.normalizeTitle(a.name).toLowerCase());
      if (a.rus_name) watchingTitleKeywords.add(AnimeLibService.normalizeTitle(a.rus_name).toLowerCase());
    }

    const matchedEntries = calendar.filter((c) => {
      if (!c.anime) return false;
      const shikiId = Number(c.anime.id);
      if (shikiId && watchingShikiIds.has(shikiId)) return true;

      const cRus = AnimeLibService.normalizeTitle(c.anime.russian || '').toLowerCase();
      const cEng = AnimeLibService.normalizeTitle(c.anime.name || '').toLowerCase();

      for (const kw of watchingTitleKeywords) {
        if (!kw || kw.length < 3) continue;
        if ((cRus && (cRus.includes(kw) || kw.includes(cRus))) || (cEng && (cEng.includes(kw) || kw.includes(cEng)))) {
          return true;
        }
      }
      return false;
    });

    if (matchedEntries.length === 0) {
      const totalWatching = watchingDb.length || watchingLib.length;
      const emptyLines = [
        '📅 <b>Персональный календарь выхода серий</b>',
        '━━━━━━━━━━━━━━━━━━━━',
        `📭 <i>В расписании на ближайшие дни пока нет новых серий для аниме из вашего списка «Смотрю» (${totalWatching} тайтлов).</i>`,
        '',
        'Возможные причины:',
        '• Серии для ваших онгоингов уже вышли, либо',
        '• Точная дата следующего эпизода ещё не анонсирована телесетью.',
        '',
        '💡 <i>Вы можете открыть общее расписание всех релизов сезона:</i>',
      ];

      const kb = new InlineKeyboard()
        .text('🌐 Общий календарь всех аниме', 'show_global_calendar')
        .row()
        .text('📺 Мой список «Смотрю»', 'list_watching')
        .text('🔄 Проверить серии', 'check_updates');

      return await ctx.reply(emptyLines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
    }

    // Sort matched chronologically
    matchedEntries.sort((a, b) => new Date(a.next_episode_at).getTime() - new Date(b.next_episode_at).getTime());

    const lines = matchedEntries.map((c) => {
      const date = new Date(c.next_episode_at);
      const timeStr = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      const dayStr = date.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
      const relStr = formatRelativeTime(date);
      const title = escapeHtml(c.anime.russian || c.anime.name);
      return `📺 <b>${title}</b>\n  🔢 Серия <code>#${c.next_episode}</code>\n  ⏰ <b>${dayStr} в ${timeStr}</b> (${relStr})`;
    });

    const text = [
      '📅 <b>Календарь выхода серий ваших онгоингов:</b>',
      '<i>(Показывает только тайтлы из вашего списка «Смотрю»)</i>',
      '━━━━━━━━━━━━━━━━━━━━',
      lines.join('\n\n'),
    ].join('\n');

    const kb = new InlineKeyboard()
      .text('🌐 Общий календарь всех аниме', 'show_global_calendar')
      .row()
      .text('🔄 Обновить', 'show_calendar')
      .text('📺 Мой список', 'list_watching');

    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка загрузки календаря: ${err.message}`);
  }
}

const recentlyRecommendedIds = new Set<number>();

async function showRandomRecommendation(ctx: Context, category: 'all' | 'planned' | 'ongoing' = 'all') {
  let promptText = '🎲 <i>Ищу тайтл для сегодняшнего просмотра...</i>';
  if (category === 'planned') {
    promptText = '📌 <i>Выбираю тайтл из вашего списка «В планах» (Shikimori)...</i>';
  } else if (category === 'ongoing') {
    promptText = '🔥 <i>Подбираю популярный онгоинг сезона...</i>';
  }

  await ctx.reply(promptText, { parse_mode: 'HTML' });

  try {
    const result = await shikimoriService.getRandomRecommendation(
      category,
      Array.from(recentlyRecommendedIds)
    );

    if (!result || !result.anime) {
      return ctx.reply('Не удалось найти подходящий тайтл. Попробуйте нажать кнопку ещё раз.');
    }

    const { anime, source, isAlsoPlanned } = result;

    // Track recently shown to prevent repeats (keep last 40)
    recentlyRecommendedIds.add(Number(anime.id));
    if (recentlyRecommendedIds.size > 40) {
      const first = recentlyRecommendedIds.values().next().value;
      if (first !== undefined) recentlyRecommendedIds.delete(first);
    }

    const card = formatAnimeCard({
      title: anime.name,
      rusTitle: anime.russian,
      score: anime.score,
      genres: anime.genres?.map((g) => g.russian),
      description: anime.description,
      cardStyle: 'full',
    });

    let sourceHeader = '';
    if (source === 'planned') {
      sourceHeader = '📌 <b>Рекомендация из ваших «В планах» (Shikimori):</b>\n<i>(Тайтл из вашего списка ожидания, который вы ещё не начали)</i>';
    } else {
      sourceHeader = isAlsoPlanned
        ? '🔥 <b>Горячий онгоинг сезона:</b>\n<i>(💡 Этот онгоинг также есть в вашем списке «В планах»)</i>'
        : '🔥 <b>Горячий онгоинг сезона:</b>\n<i>(Свежий тайтл текущего сезона)</i>';
    }

    const cleanSearchQuery = encodeURIComponent(anime.russian || anime.name);
    const kb = new InlineKeyboard()
      .url('📊 На Shikimori', `https://shikimori.one/animes/${anime.id}`)
      .url('🌐 На AnimeLib', `${ANIMELIB_WEB_URL}/ru/anime?q=${cleanSearchQuery}`)
      .row()
      .text('🎲 Случайное', 'random_planned')
      .text('📌 Из «В планах»', 'random_from_planned')
      .text('🔥 Онгоинг', 'random_from_ongoing');

    const fullMessage = `${sourceHeader}\n\n${card}`;

    if (anime.poster?.mainUrl) {
      await ctx.replyWithPhoto(anime.poster.mainUrl, {
        caption: fullMessage,
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } else {
      await ctx.reply(fullMessage, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    }
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка подбора: ${err.message}`);
  }
}

export async function showLibraryStats(ctx: Context) {
  const userId = ctx.from?.id ? String(ctx.from.id) : DEFAULT_CHAT_ID || 'default_user';
  const profile = await shikimoriService.getUserProfile().catch(() => null);
  const libStats = await getLibraryComprehensiveStats(userId);

  const animelibUserId = process.env.ANIMELIB_USER_ID || 'Не указан';
  const shikiNick = profile?.nickname || 'Не привязан';
  const shikiId = profile?.id ? String(profile.id) : '—';

  let checkSection: string;
  if (libStats.lastCheck) {
    const statusIcon =
      libStats.lastCheck.status === 'ok'
        ? libStats.lastCheck.updatesCount > 0
          ? '🔔'
          : '✅'
        : libStats.lastCheck.status === 'warning'
        ? '⚠️'
        : '❌';

    checkSection = [
      '⏱ <b>Результат последней проверки:</b>',
      `  • 🕒 <b>Время проверки:</b> <code>${libStats.lastCheck.formattedTime}</code> (<i>${libStats.lastCheck.relativeTime}</i>)`,
      `  • ${statusIcon} <b>Статус:</b> <b>${escapeHtml(libStats.lastCheck.message)}</b>`,
      `  • 🔍 <b>Проверено тайтлов:</b> <code>${libStats.lastCheck.checkedCount}</code> онгоингов`,
      `  • 🎯 <b>Сверено с Shikimori:</b> <code>${libStats.lastCheck.matchedCount} из ${libStats.lastCheck.checkedCount}</code>`,
      `  • ⏰ <b>Следующая автопроверка:</b> <code>через ${libStats.lastCheck.nextCheckInMinutes} мин</code> (интервал: ${libStats.lastCheck.checkIntervalMinutes} мин)`,
    ].join('\n');
  } else {
    const prefs = dbService.getUserPreferences(userId);
    checkSection = [
      '⏱ <b>Результат последней проверки:</b>',
      '  • 🕒 <i>Ожидается первая проверка тайтлов...</i>',
      `  • ⏰ <b>Интервал автопроверки:</b> каждые <code>${prefs.check_interval_min || 30} мин</code>`,
      '  • 💡 <i>Нажмите «🔍 Проверить обновления», чтобы запустить немедленно.</i>',
    ].join('\n');
  }

  const lines = [
    '📊 <b>Статистика медиатеки & Синхронизация</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `🆔 <b>Telegram ID:</b> <code>${userId}</code>`,
    `🌐 <b>Shikimori:</b> <code>${escapeHtml(shikiNick)}</code> (ID: <code>${shikiId}</code>)`,
    `📚 <b>AnimeLib ID:</b> <code>${escapeHtml(animelibUserId)}</code>`,
    '',
    '📁 <b>Категории библиотеки:</b>',
    `  • 📺 <b>Смотрю сейчас:</b> <code>${libStats.watching}</code> онгоингов`,
    `  • ⏳ <b>Запланировано:</b> <code>${libStats.planned}</code> тайтлов`,
    `  • 🏁 <b>Просмотрено:</b> <code>${libStats.completed}</code> аниме`,
    `  • ❤️ <b>Любимые:</b> <code>${libStats.favorites}</code> тайтлов`,
    `  • 🔁 <b>Пересматриваю:</b> <code>${libStats.rewatching}</code>`,
    `  • ⏸️ <b>Отложено:</b> <code>${libStats.on_hold}</code> | 🚫 <b>Брошено:</b> <code>${libStats.dropped}</code>`,
    '  ──────────────────',
    `  📦 <b>Всего отслеживается:</b> <code>${libStats.totalTracked}</code> тайтлов`,
    '',
    '🔄 <b>Синхронизация & Миграция на Shikimori:</b>',
    `  • 🚀 <b>Перенесено на Shikimori:</b> <code>${libStats.shikiTransferredCount} / ${libStats.totalTracked}</code> (${libStats.shikiMatchRatePercent}%)`,
    `  • 🎯 <b>Проверено & сматчено:</b> <code>${libStats.shikiVerifiedCount}</code> тайтлов`,
    '  • 🔗 <b>Мост:</b> AnimeLib ➔ SQLite ➔ Shikimori [Активен ✅]',
    '',
    checkSection,
  ];

  const kb = new InlineKeyboard()
    .text('🔄 Синхронизировать всю библиотеку с AnimeLib', 'sync_full_library')
    .row()
    .text('🔍 Проверить обновления', 'check_updates')
    .text('📥 Скачать серию', 'dl_back_titles')
    .row()
    .text('📋 Мой список («Смотрю»)', 'list_watching')
    .text('⏳ Запланированное', 'list_planned')
    .row()
    .text('⚙️ Настройки и озвучки', 'open_settings')
    .text('❌ Закрыть меню', 'close_menu');

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
}

export const showUserProfile = showLibraryStats;

async function openSettingsMenu(ctx: Context) {
  const userId = ctx.from?.id ? String(ctx.from.id) : DEFAULT_CHAT_ID || 'default_user';
  const { text, keyboard } = renderSettingsKeyboard(userId);
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

// ==========================================
// Callback Queries (Interactive Buttons)
// ==========================================

bot.callbackQuery('sync_full_library', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Запуск полной синхронизации...' });
  const statusMsg = await ctx.reply(
    '🔄 <b>Запущена полная синхронизация библиотеки с AnimeLib...</b>\n\n' +
    '⏳ <i>Постраничный опрос закладок («Смотрю», «Запланировано», «Просмотрено», «Брошено»)...</i>',
    { parse_mode: 'HTML' }
  );

  try {
    const res = await animelibService.syncFullLibraryFromAnimeLib();
    const userId = ctx.from?.id ? String(ctx.from.id) : DEFAULT_CHAT_ID || 'default_user';
    const libStats = await getLibraryComprehensiveStats(userId);

    const text = [
      '✅ <b>Синхронизация с AnimeLib успешно завершена!</b>',
      '━━━━━━━━━━━━━━━━━━━━',
      `📺 <b>Смотрю:</b> <code>${res.watching}</code> тайтлов`,
      `⏳ <b>Запланировано:</b> <code>${res.planned}</code> тайтлов`,
      `🏁 <b>Просмотрено:</b> <code>${res.completed}</code> тайтлов`,
      `🚫 <b>Брошено:</b> <code>${res.dropped}</code> тайтлов`,
      `⏸️ <b>Отложено:</b> <code>${res.on_hold}</code> тайтлов`,
      '──────────────────',
      `📦 <b>Всего сохранено в локальной базе:</b> <code>${res.total}</code> тайтлов`,
      `🎯 <b>Сверено с Shikimori:</b> <code>${libStats.shikiTransferredCount} / ${libStats.totalTracked}</code> (${libStats.shikiMatchRatePercent}%)`,
    ].join('\n');

    const kb = new InlineKeyboard()
      .text('📋 Мой список («Смотрю»)', 'list_watching')
      .text('⏳ Запланированное', 'list_planned')
      .row()
      .text('📊 Полная статистика', 'show_stats')
      .text('❌ Закрыть', 'close_menu');

    if (statusMsg?.message_id && ctx.chat?.id) {
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, text, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  } catch (err: any) {
    console.error('[Bot] Error in sync_full_library:', err);
    await ctx.reply(`❌ <b>Ошибка при синхронизации:</b> ${escapeHtml(err?.message || 'Неизвестная ошибка')}`, {
      parse_mode: 'HTML',
    });
  }
});

bot.callbackQuery('check_updates', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Ищу свежие серии...' });
  await checkAnimeUpdates(ctx, true);
});

bot.callbackQuery('show_stats', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showLibraryStats(ctx);
});

bot.callbackQuery('list_watching', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showWatchingList(ctx);
});

bot.callbackQuery('list_planned', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showPlannedList(ctx, 0, true, false);
});

bot.callbackQuery('list_planned_all', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Все запланированные тайтлы' });
  await showPlannedList(ctx, 0, false, true);
});

bot.callbackQuery('list_planned_bell', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Только с колокольчиком' });
  await showPlannedList(ctx, 0, true, true);
});

bot.callbackQuery(/^pl_p:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match[1], 10) || 0;
  const bellOnly = ctx.match[2] === '1';
  await showPlannedList(ctx, page, bellOnly, true);
});

bot.callbackQuery('close_menu', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Меню закрыто' });
  try {
    await ctx.deleteMessage();
  } catch {
    try {
      await ctx.editMessageText('✖️ <b>Панель закрыта.</b>\nВоспользуйтесь нижним меню для дальнейшей навигации.', {
        parse_mode: 'HTML',
      });
    } catch {}
  }
});

bot.callbackQuery('show_calendar', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showAnimeCalendar(ctx, false);
});

bot.callbackQuery('show_global_calendar', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showAnimeCalendar(ctx, true);
});

bot.callbackQuery('random_planned', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Выбираю тайтл...' });
  await showRandomRecommendation(ctx, 'all');
});

bot.callbackQuery('random_from_planned', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Ищу в ваших «В планах»...' });
  await showRandomRecommendation(ctx, 'planned');
});

bot.callbackQuery('random_from_ongoing', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Подбираю онгоинг...' });
  await showRandomRecommendation(ctx, 'ongoing');
});

bot.callbackQuery('open_settings', async (ctx) => {
  await ctx.answerCallbackQuery();
  await openSettingsMenu(ctx);
});

// Rate Menu: Show 1-10 stars rating buttons
bot.callbackQuery(/^rate_menu:(\d+)$/, async (ctx) => {
  const shikiId = parseInt(ctx.match[1], 10);
  await ctx.answerCallbackQuery();

  const kb = new InlineKeyboard();
  for (let i = 1; i <= 5; i++) {
    kb.text(`${i} ⭐`, `set_rate:${shikiId}:${i}`);
  }
  kb.row();
  for (let i = 6; i <= 10; i++) {
    kb.text(`${i} ⭐`, `set_rate:${shikiId}:${i}`);
  }
  kb.row().text('🔙 Назад', 'cancel_rate');

  await ctx.reply('⭐️ <b>Выберите вашу оценку для Shikimori:</b>', {
    parse_mode: 'HTML',
    reply_markup: kb,
  });
});

bot.callbackQuery(/^set_rate:(\d+):(\d+)$/, async (ctx) => {
  const shikiId = parseInt(ctx.match[1], 10);
  const score = parseInt(ctx.match[2], 10);
  await ctx.answerCallbackQuery({ text: `Ставлю оценку ${score}...` });

  try {
    await shikimoriService.updateUserRate({
      target_id: shikiId,
      status: 'watching',
      score,
    });
    await ctx.reply(`⭐️ <b>Готово!</b> Вы поставили <b>${score}/10</b> на Shikimori.`, { parse_mode: 'HTML' });
  } catch (err: any) {
    await ctx.reply(`❌ Не удалось сохранить оценку: ${err.message}`);
  }
});

bot.callbackQuery('cancel_rate', (ctx) => ctx.deleteMessage());

bot.catch((err) => {
  console.error('❌ [GrammY Unhandled Error]:', err.error || err);
});

async function handleWatchEpisode(ctx: Context, mediaId: number, episode: number, initialShikiId: number = 0) {
  let shikiId = initialShikiId;

  if (!shikiId) {
    const syncItem = dbService.getSyncItemByMediaId(mediaId);
    if (syncItem?.shiki_id) {
      shikiId = syncItem.shiki_id;
    }
  }

  // 1. Quick user feedback
  await ctx.answerCallbackQuery({ text: `Серия #${episode} отмечена!` });

  // 2. Update local SQLite progress
  dbService.updateTrackedEpisode(mediaId, episode);

  // 3. Upsert / update user rate in Shikimori if shikiId exists
  if (shikiId > 0) {
    try {
      await shikimoriService.updateUserRate({
        target_id: shikiId,
        status: 'watching',
        episodes: episode,
      });
    } catch (e: any) {
      console.warn('[Telegram Bot] Could not sync user_rate with Shikimori:', e?.message || e);
    }
  }

  // 4. Update message inline (replacing action button with "Просмотрено" status)
  const updatedKb = new InlineKeyboard();
  const animelibUrl = `${ANIMELIB_WEB_URL}/ru/anime/${mediaId}`;
  updatedKb.url('🌐 AnimeLib', animelibUrl);
  if (shikiId > 0) {
    updatedKb.url('📊 Shikimori', `https://shikimori.one/animes/${shikiId}`);
    updatedKb.row();
    updatedKb.text('⭐️ Оценить', `rate_menu:${shikiId}`);
    updatedKb.text('🏁 Завершить', `mark_completed:${mediaId}:${shikiId}`);
  }
  updatedKb.row().text(`✅ Просмотрено (серия #${episode})`, 'noop');

  try {
    const originalText = ctx.msg?.text || ctx.msg?.caption || '';
    const note = `\n\n✅ <b>Просмотрено:</b> Серия <code>#${episode}</code> успешно отмечена!`;

    if (ctx.msg?.caption !== undefined) {
      await ctx.editMessageCaption({
        caption: originalText + note,
        parse_mode: 'HTML',
        reply_markup: updatedKb,
      });
    } else if (ctx.msg?.text !== undefined) {
      await ctx.editMessageText(originalText + note, {
        parse_mode: 'HTML',
        reply_markup: updatedKb,
      });
    } else {
      await ctx.editMessageReplyMarkup({ reply_markup: updatedKb });
    }
  } catch {
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: updatedKb });
    } catch {
      await ctx.reply(`✅ <b>Прогресс обновлен:</b> Серия <code>#${episode}</code> отмечена!`, {
        parse_mode: 'HTML',
      });
    }
  }
}

// Watch button callback (e.g. watch_1234_13.5 or watch_1234_14_5678)
bot.callbackQuery(/^(?:watch_|watch:)(\d+)[_:]([\d.]+)(?:[_:](\d+))?$/, async (ctx) => {
  const mediaId = parseInt(ctx.match[1], 10);
  const episode = parseFloat(ctx.match[2]);
  const shikiId = ctx.match[3] ? parseInt(ctx.match[3], 10) : 0;
  await handleWatchEpisode(ctx, mediaId, episode, shikiId);
});

// Increment Episode (+1 series) in one click
bot.callbackQuery(/^add_ep:(\d+):([\d.]+):(\d+)$/, async (ctx) => {
  const mediaId = parseInt(ctx.match[1], 10);
  const episode = parseFloat(ctx.match[2]);
  const shikiId = parseInt(ctx.match[3], 10);
  await handleWatchEpisode(ctx, mediaId, episode, shikiId);
});

bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery({ text: 'Серия уже отмечена как просмотренная!' }));

export async function queueAndStartDownload(
  ctx: Context,
  mediaId: number,
  episode: number,
  voiceover?: string,
  quality?: string,
  sourceName?: string
): Promise<void> {
  const stored = dbService.getSyncItemByMediaId(mediaId);
  const title = stored?.rus_title || stored?.title || `Тайтл #${mediaId}`;

  const qDisplay = quality === '2160p' ? '4K 2160p' : (quality || '1080p Full HD');
  const srcDisplay = sourceName === 'animelib'
    ? 'AnimeLib Native'
    : (sourceName === 'kodik' ? 'Kodik' : (sourceName || 'AnimeLib Native'));

  const text = [
    '📥 <b>Серия поставлена в очередь скачивания!</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `📺 <b>Тайтл:</b> ${escapeHtml(title)}`,
    `🎬 <b>Серия:</b> <code>#${episode}</code>`,
    `🎙 <b>Озвучка:</b> <code>${escapeHtml(voiceover || 'По умолчанию')}</code>`,
    `📡 <b>Источник:</b> [${escapeHtml(srcDisplay)}]`,
    `🎞 <b>Разрешение:</b> [${escapeHtml(qDisplay)}]`,
    '',
    '⏳ <i>Инициализация загрузки и обработка сегментов...</i>',
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('📺 Другая серия этого тайтла', `dl_t:${mediaId}`)
    .row()
    .text('📋 Выбрать другой тайтл', 'dl_back_titles')
    .text('📺 Мой список', 'list_watching');

  let sentMsg: any = null;
  try {
    sentMsg = await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch {
    sentMsg = await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }

  const chatId = ctx.chat?.id ? String(ctx.chat.id) : undefined;
  const messageId =
    sentMsg && typeof sentMsg === 'object' && 'message_id' in sentMsg
      ? (sentMsg.message_id as number)
      : undefined;

  downloaderService.addToQueue(mediaId, episode, voiceover, chatId, messageId);
  downloaderService.processQueue().catch((err: unknown) => {
    const errMessage = err instanceof Error ? err.message : String(err);
    console.error('[Downloader Bot] Ошибка фоновой обработки очереди:', errMessage);
  });
}

export async function handleDownloadStreamSelection(
  ctx: Context,
  mediaId: number,
  ep: number
): Promise<void> {
  const stored = dbService.getSyncItemByMediaId(mediaId);
  const title = stored?.rus_title || stored?.title || `Тайтл #${mediaId}`;
  const preferredVo = dbService.getPreferredVoiceover(mediaId) || stored?.preferred_voiceover;

  // Проверяем реальное количество серий в API и БД перед запросом
  let availableEps: number[] = [];
  try {
    availableEps = await animelibService.getAvailableEpisodes(mediaId);
  } catch {}

  const maxEp = availableEps.length > 0
    ? availableEps[availableEps.length - 1]
    : (stored?.latest_episode || 0);

  if (maxEp > 0 && ep > maxEp) {
    const notReleasedText = [
      `📺 <b>${escapeHtml(title)}</b>`,
      '━━━━━━━━━━━━━━━━━━━━',
      `⚠️ <b>Серия #${ep} еще не вышла или отсутствует в источнике.</b>`,
      `📦 Максимальная доступная серия: <b>#${maxEp}</b>.`,
      '',
      '<i>Пожалуйста, выберите вышедшую серию из списка:</i>',
    ].join('\n');

    const kb = new InlineKeyboard()
      .text('📺 К выбору серий', `dl_t:${mediaId}`)
      .row()
      .text('❌ Закрыть', 'close_menu');

    try {
      await ctx.editMessageText(notReleasedText, { parse_mode: 'HTML', reply_markup: kb });
    } catch {
      await ctx.reply(notReleasedText, { parse_mode: 'HTML', reply_markup: kb });
    }
    return;
  }

  let streams: StreamResult[] = [];
  try {
    streams = await sourceRegistry.getAllStreams({
      mediaId,
      episode: ep,
      voiceover: preferredVo || undefined,
    });
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    console.warn(`[Bot] Ошибка получения стримов для ${mediaId} ep ${ep}:`, errMessage);
  }

  // Если стримы не найдены
  if (!streams || streams.length === 0) {
    const emptyText = [
      `📺 <b>${escapeHtml(title)}</b>`,
      '━━━━━━━━━━━━━━━━━━━━',
      `⚠️ <b>Видеопотоки для серии #${ep} не найдены</b>`,
      ...(maxEp > 0 && ep > maxEp ? [`⚠️ <i>Серия #${ep} еще не вышла или отсутствует в источнике. Максимальная доступная серия: #${maxEp}.</i>`, ''] : []),
      '',
      '<i>Плееры AnimeLib и Kodik в данный момент не вернули рабочие стримы для этой серии. Попробуйте позже или выберите другую серию.</i>',
    ].join('\n');

    const emptyKb = new InlineKeyboard()
      .text('🔄 Попробовать снова', `dl:${mediaId}:${ep}`)
      .row()
      .text('📺 К выбору серий', `dl_t:${mediaId}`)
      .text('❌ Закрыть', 'close_menu');

    try {
      await ctx.editMessageText(emptyText, { parse_mode: 'HTML', reply_markup: emptyKb });
    } catch {
      await ctx.reply(emptyText, { parse_mode: 'HTML', reply_markup: emptyKb });
    }
    return;
  }

  // Если стрим ровно 1 — сразу запускаем скачивание
  if (streams.length === 1) {
    const stream = streams[0];
    await queueAndStartDownload(ctx, mediaId, ep, stream.voiceover, stream.quality, stream.source);
    return;
  }

  // Если настроена любимая озвучка, поднимаем совпадающий стрим наверх
  if (preferredVo && preferredVo.trim()) {
    const norm = preferredVo.trim().toLowerCase();
    streams.sort((a, b) => {
      const aMatch = a.voiceover && (a.voiceover.toLowerCase().includes(norm) || norm.includes(a.voiceover.toLowerCase()));
      const bMatch = b.voiceover && (b.voiceover.toLowerCase().includes(norm) || norm.includes(b.voiceover.toLowerCase()));
      if (aMatch && !bMatch) return -1;
      if (!aMatch && bMatch) return 1;
      return 0;
    });
  }

  // Сохраняем стримы в сессионный кэш для короткого callback_data (<64 байт)
  const key = `${mediaId}:${ep}`;
  episodeStreamsCache.set(key, streams);

  const kb = new InlineKeyboard();
  for (let i = 0; i < streams.length; i++) {
    const s = streams[i];
    const isPreferred = Boolean(
      preferredVo &&
      s.voiceover &&
      (s.voiceover.toLowerCase().includes(preferredVo.toLowerCase()) || preferredVo.toLowerCase().includes(s.voiceover.toLowerCase()))
    );
    const star = isPreferred ? '⭐️ ' : '';
    const qBadge = s.quality === '2160p' ? '4K' : (s.quality ? s.quality.replace('p', '') : 'Auto');
    const srcBadge = s.source === 'animelib' ? 'AnimeLib' : (s.source === 'kodik' ? 'Kodik' : (s.source || 'Native'));
    const voText = s.voiceover || 'Оригинал';
    const rawLabel = `${star}🎬 [${qBadge}] ${srcBadge} • ${voText}`;
    const label = rawLabel.length > 34 ? `${rawLabel.slice(0, 33)}…` : rawLabel;

    // callback_data ультракомпактный: dq:<mediaId>:<ep>:<index> (< 18 байт)
    kb.text(label, `dq:${mediaId}:${ep}:${i}`);
    kb.row();
  }

  kb.text('⬅️ К выбору серий', `dl_t:${mediaId}`)
    .text('❌ Закрыть', 'close_menu');

  const prefNotice = preferredVo ? `\n⭐️ <i>Ваша озвучка: <b>${escapeHtml(preferredVo)}</b></i>` : '';
  const text = [
    `📥 <b>Выбор видеопотока: Серия #${ep}</b>`,
    `📺 <b>${escapeHtml(title)}</b>`,
    '━━━━━━━━━━━━━━━━━━━━',
    `<i>Найдено доступных вариантов: <b>${streams.length}</b></i>${prefNotice}`,
    '',
    '<i>Выберите качество и плеер для запуска загрузки:</i>',
  ].join('\n');

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

// Download request callback: dl:<media_id>:<ep> or legacy dl_<media_id>_<ep>
bot.callbackQuery(/^(?:dl:|dl_|dl_e:|dl_ep:)(\d+)[:_]([\d.]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: '🔍 Поиск видеопотоков...' });
  const mediaId = parseInt(ctx.match[1], 10);
  const ep = parseFloat(ctx.match[2]);
  await handleDownloadStreamSelection(ctx, mediaId, ep);
});

// Download stream selection callback: dq:<media_id>:<ep>:<stream_index> (<64 байт)
bot.callbackQuery(/^(?:dq:|dq_)(\d+)[:_]([\d.]+)[:_](\d+)(?:[:_](\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: '📥 Постановка в очередь...' });
  const mediaId = parseInt(ctx.match[1], 10);
  const ep = parseFloat(ctx.match[2]);
  const streamIdx = parseInt(ctx.match[3], 10);

  const key = `${mediaId}:${ep}`;
  let streams = episodeStreamsCache.get(key);
  if (!streams || !streams[streamIdx]) {
    try {
      streams = await sourceRegistry.getAllStreams({ mediaId, episode: ep });
      episodeStreamsCache.set(key, streams);
    } catch {}
  }

  const selectedStream = streams?.[streamIdx];
  await queueAndStartDownload(
    ctx,
    mediaId,
    ep,
    selectedStream?.voiceover,
    selectedStream?.quality,
    selectedStream?.source
  );
});

bot.callbackQuery('noop_dl', (ctx) =>
  ctx.answerCallbackQuery({ text: 'Серия уже в очереди загрузки или скачивается!' })
);

// ==========================================
// Interactive Download Wizard (/download)
// ==========================================

export async function showDownloadTitleSelection(ctx: Context) {
  // Загружаем актуальный список из AnimeLib и локальной базы
  let watchingLib: any[] = [];
  try {
    watchingLib = await animelibService.getAllWatching();
  } catch {}

  const watchingDb = dbService.getAllSyncItems('watching') || [];

  // Объединяем оба источника, чтобы ни один из 5 тайтлов не пропал
  const watchingMap = new Map<number, {
    media_id: number;
    title: string;
    rus_title?: string;
    last_tracked_episode: number;
    latest_episode: number;
  }>();

  for (const item of watchingDb) {
    watchingMap.set(item.media_id, {
      media_id: item.media_id,
      title: item.title,
      rus_title: item.rus_title,
      last_tracked_episode: item.last_tracked_episode || 0,
      latest_episode: item.latest_episode || 0,
    });
  }

  for (const item of watchingLib) {
    const existing = watchingMap.get(item.media_id);
    const lastTracked = Math.max(existing?.last_tracked_episode || 0, item.current_progress_number || 0);
    const latestEp = Math.max(existing?.latest_episode || 0, item.last_item_number || 0);
    watchingMap.set(item.media_id, {
      media_id: item.media_id,
      title: item.name || existing?.title || String(item.media_id),
      rus_title: item.rus_name || existing?.rus_title,
      last_tracked_episode: lastTracked,
      latest_episode: latestEp,
    });

    // Гарантируем корректный статус 'watching' в базе данных
    try {
      dbService.upsertSyncItem({
        media_id: item.media_id,
        title: item.name,
        rus_title: item.rus_name,
        status: 'watching',
        last_tracked_episode: lastTracked,
        latest_episode: latestEp,
      });
    } catch {}
  }

  const watchingItems = Array.from(watchingMap.values());

  if (!watchingItems || watchingItems.length === 0) {
    const emptyMsg = [
      '📭 <b>Список «Смотрю» пуст.</b>',
      '',
      'Добавьте тайтлы в статус «Смотрю» на AnimeLib или настройте <code>ANIMELIB_COOKIE</code> в .env.',
    ].join('\n');

    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery();
      try {
        return await ctx.editMessageText(emptyMsg, { parse_mode: 'HTML' });
      } catch {
        return await ctx.reply(emptyMsg, { parse_mode: 'HTML' });
      }
    }
    return ctx.reply(emptyMsg, { parse_mode: 'HTML' });
  }

  // Актуализируем количество вышедших серий в реальном времени (фикс «8 из 7»)
  await Promise.allSettled(
    watchingItems.map(async (item) => {
      try {
        const eps = await animelibService.getAvailableEpisodes(item.media_id);
        if (eps.length > 0) {
          const actualMax = eps[eps.length - 1];
          if (actualMax > item.latest_episode) {
            item.latest_episode = actualMax;
            dbService.updateLatestEpisode(item.media_id, actualMax);
          }
        }
      } catch {}
      if (item.last_tracked_episode > item.latest_episode) {
        item.latest_episode = item.last_tracked_episode;
        dbService.updateLatestEpisode(item.media_id, item.latest_episode);
      }
    })
  );

  const lines = watchingItems.map((item, idx) => {
    const title = escapeHtml(item.rus_title || item.title);
    const x = item.last_tracked_episode || 0;
    const y = item.latest_episode && item.latest_episode > 0 ? item.latest_episode : '?';
    return `${idx + 1}. «<b>${title}</b>» [Просмотрено: #${x} из #${y} вышедших]`;
  });

  const text = [
    '📥 <b>Мастер скачивания: Выбор тайтла</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    '<i>Выберите аниме из вашего списка «Смотрю», чтобы перейти к выбору серии:</i>',
    '',
    ...lines,
    '',
    '<i>Нажмите кнопку с нужным тайтлом ниже:</i>',
  ].join('\n');

  const kb = new InlineKeyboard();
  for (let i = 0; i < watchingItems.length; i++) {
    const item = watchingItems[i];
    const name = item.rus_title || item.title;
    const shortTitle = name.length > 30 ? name.slice(0, 28) + '…' : name;
    kb.text(`${i + 1}. ${shortTitle}`, `dl_t:${item.media_id}`).row();
  }
  kb.text('❌ Закрыть меню', 'close_menu');

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

export async function showEpisodeSelection(ctx: Context, mediaId: number) {
  const stored = dbService.getSyncItemByMediaId(mediaId);
  const title = stored?.rus_title || stored?.title || `Тайтл #${mediaId}`;
  const lastTracked = stored?.last_tracked_episode || 0;

  let episodes = await animelibService.getAvailableEpisodes(mediaId);
  let latest = episodes.length > 0 ? episodes[episodes.length - 1] : (stored?.latest_episode || 0);

  // Если список серий пуст, проверяем локальную БД
  if (episodes.length === 0 && latest > 0) {
    episodes = Array.from({ length: latest }, (_, i) => i + 1);
  }

  const text = [
    `📺 <b>${escapeHtml(title)}</b>`,
    '━━━━━━━━━━━━━━━━━━━━',
    `👁 <b>Последняя просмотренная:</b> <code>#${lastTracked}</code>`,
    `📦 <b>Всего вышло:</b> <code>#${latest}</code>`,
    '',
    '<i>Выберите серию для скачивания:</i>',
  ].join('\n');

  const kb = new InlineKeyboard();
  let col = 0;
  for (const ep of episodes) {
    let badge = `#${ep}`;
    if (ep <= lastTracked) {
      badge = `👁 #${ep}`;
    } else if (ep === lastTracked + 1) {
      badge = `▶️ #${ep}`;
    }
    kb.text(badge, `dl:${mediaId}:${ep}`);
    col++;
    if (col % 4 === 0) {
      kb.row();
    }
  }
  if (col % 4 !== 0) {
    kb.row();
  }
  kb.text('⬅️ Назад', 'dl_back_titles')
    .text('❌ Закрыть меню', 'close_menu');

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

// Callback: Choose Title -> Show Episodes (or Back to Episodes)
bot.callbackQuery(/^(?:dl_t|dl_title|dl_back_eps):(\d+)$/, async (ctx) => {
  const mediaId = parseInt(ctx.match[1], 10);
  await ctx.answerCallbackQuery();
  await showEpisodeSelection(ctx, mediaId);
});

// Legacy voiceover selection callback: dl_r:<mediaId>:<ep>:<index>
bot.callbackQuery(/^(?:dl_r|dl_run):(\d+):([\d.]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: '📥 Постановка в очередь...' });
  const mediaId = parseInt(ctx.match[1], 10);
  const ep = parseFloat(ctx.match[2]);
  const rawVo = ctx.match[3].trim();

  let voiceover: string;
  if (/^\d+$/.test(rawVo)) {
    const idx = parseInt(rawVo, 10);
    const key = `${mediaId}:${ep}`;
    let studios = episodeVoiceoversCache.get(key);
    if (!studios || !studios[idx]) {
      studios = await animelibService.getEpisodeStudios(mediaId, ep);
      if (studios.length === 0) studios = await animelibService.getTitleVoiceovers(mediaId);
      if (studios.length === 0) studios = POPULAR_STUDIOS;
      episodeVoiceoversCache.set(key, studios);
    }
    voiceover = studios[idx] || POPULAR_STUDIOS[idx] || 'AniLibria';
  } else {
    voiceover = rawVo;
  }

  await queueAndStartDownload(ctx, mediaId, ep, voiceover);
});

// ==========================================
// Individual Voiceover Settings per Title
// ==========================================

// Setup Voiceover for Title: Fetch actual studios from AnimeLib
bot.callbackQuery(/^(?:setup_vo|svo_m):(\d+)$/, async (ctx) => {
  const mediaId = parseInt(ctx.match[1], 10);
  await ctx.answerCallbackQuery({ text: 'Запрашиваю студии озвучки на AnimeLib...' });

  const stored = dbService.getSyncItemByMediaId(mediaId);
  const title = stored?.rus_title || stored?.title || `Тайтл #${mediaId}`;
  const currentPref = dbService.getPreferredVoiceover(mediaId) || stored?.preferred_voiceover;

  let studios = await animelibService.getTitleVoiceovers(mediaId);
  if (!studios || studios.length === 0) {
    studios = await animelibService.getEpisodeStudios(mediaId, 1);
  }
  if (!studios || studios.length === 0) {
    studios = POPULAR_STUDIOS;
  }

  // Сохраняем в кэш для короткого callback_data (svo:mediaId:index) < 64 байт
  titleVoiceoversCache.set(mediaId, studios);

  const kb = new InlineKeyboard();
  for (let i = 0; i < studios.length; i++) {
    const s = studios[i];
    const isSelected = currentPref && (s.toLowerCase() === currentPref.toLowerCase());
    const label = `${isSelected ? '✅ ' : '▫️ '}${s}`;
    kb.text(label, `svo:${mediaId}:${i}`);
    if (i % 2 === 1) kb.row();
  }
  if (studios.length % 2 !== 0) kb.row();

  if (currentPref) {
    kb.text('🔄 Сбросить выбор озвучки', `rvo:${mediaId}`).row();
  }

  kb.text('⬅️ Назад в «Смотрю»', 'list_watching')
    .text('❌ Закрыть', 'close_menu');

  const currentDesc = currentPref
    ? `Текущая озвучка: 🔥 <b>${escapeHtml(currentPref)}</b>`
    : 'Текущая озвучка: <i>(не выбрана, скачивается по умолчанию)</i>';

  const text = [
    '🎙 <b>Настройка индивидуальной озвучки</b>',
    `📺 <b>${escapeHtml(title)}</b>`,
    '━━━━━━━━━━━━━━━━━━━━',
    currentDesc,
    '',
    '<i>Выберите студию из озвучивающих этот тайтл на AnimeLib:</i>\n' +
    '<i>(Эта студия будет автоматически подставляться при скачивании новых серий)</i>',
  ].join('\n');

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
});

// Save Selected Voiceover for Title: svo:<media_id>:<index>
bot.callbackQuery(/^(?:svo|set_vo):(\d+):(.+)$/, async (ctx) => {
  const mediaId = parseInt(ctx.match[1], 10);
  const param = ctx.match[2].trim();

  let studio: string;
  if (/^\d+$/.test(param)) {
    const studioIdx = parseInt(param, 10);
    let studios = titleVoiceoversCache.get(mediaId);
    if (!studios || !studios[studioIdx]) {
      studios = await animelibService.getTitleVoiceovers(mediaId);
      if (!studios || studios.length === 0) {
        studios = await animelibService.getEpisodeStudios(mediaId, 1);
      }
      if (!studios || studios.length === 0) {
        studios = POPULAR_STUDIOS;
      }
      titleVoiceoversCache.set(mediaId, studios);
    }
    studio = studios[studioIdx] || POPULAR_STUDIOS[studioIdx] || 'AniLibria';
  } else {
    studio = decodeURIComponent(param).trim();
  }

  dbService.setPreferredVoiceover(mediaId, studio);
  await ctx.answerCallbackQuery({ text: `✅ Озвучка сохранена: ${studio}` });

  const stored = dbService.getSyncItemByMediaId(mediaId);
  const title = stored?.rus_title || stored?.title || `Тайтл #${mediaId}`;

  const text = [
    '✅ <b>Озвучка успешно сохранена!</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `📺 <b>Тайтл:</b> ${escapeHtml(title)}`,
    `🎙 <b>Выбранная студия:</b> <code>${escapeHtml(studio)}</code>`,
    '',
    '✨ <i>При скачивании серий этого тайтла бот будет сразу выбирать данную озвучку без лишних подтверждений.</i>',
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('📥 Скачать серию', `dl_t:${mediaId}`)
    .text('🎙 Сменить озвучку', `setup_vo:${mediaId}`)
    .row()
    .text('📋 Мой список («Смотрю»)', 'list_watching')
    .text('❌ Закрыть', 'close_menu');

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
});

// Reset Voiceover for Title: rvo:<media_id>
bot.callbackQuery(/^(?:rvo|reset_vo):(\d+)$/, async (ctx) => {
  const mediaId = parseInt(ctx.match[1], 10);
  dbService.setPreferredVoiceover(mediaId, '');
  await ctx.answerCallbackQuery({ text: 'Озвучка сброшена' });

  const stored = dbService.getSyncItemByMediaId(mediaId);
  const title = stored?.rus_title || stored?.title || `Тайтл #${mediaId}`;

  let studios = await animelibService.getTitleVoiceovers(mediaId);
  if (!studios || studios.length === 0) studios = POPULAR_STUDIOS;
  titleVoiceoversCache.set(mediaId, studios);

  const kb = new InlineKeyboard();
  for (let i = 0; i < studios.length; i++) {
    const s = studios[i];
    kb.text(`▫️ ${s}`, `svo:${mediaId}:${i}`);
    if (i % 2 === 1) kb.row();
  }
  if (studios.length % 2 !== 0) kb.row();
  kb.text('⬅️ Назад в «Смотрю»', 'list_watching').text('❌ Закрыть', 'close_menu');

  const text = [
    '🎙 <b>Настройка индивидуальной озвучки</b>',
    `📺 <b>${escapeHtml(title)}</b>`,
    '━━━━━━━━━━━━━━━━━━━━',
    'Текущая озвучка: <i>Не выбрана (по умолчанию)</i>',
    '',
    '<i>Выберите студию из озвучивающих этот тайтл на AnimeLib:</i>',
  ].join('\n');

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
});

// Callback: Back to Titles
bot.callbackQuery('dl_back_titles', async (ctx) => {
  await showDownloadTitleSelection(ctx);
});

// Mark Completed
bot.callbackQuery(/^mark_completed:(\d+):(\d+)$/, async (ctx) => {
  const mediaId = parseInt(ctx.match[1], 10);
  const shikiId = parseInt(ctx.match[2], 10);
  await ctx.answerCallbackQuery({ text: 'Переношу в «Просмотрено»...' });

  try {
    await shikimoriService.updateUserRate({
      target_id: shikiId,
      status: 'completed',
    });

    dbService.markShikiSynced(mediaId, shikiId, 'completed');
    animelibService.invalidateWatchingCache();
    shikimoriService.invalidateExclusionCache();

    await ctx.reply(`🎉 <b>Поздравляем!</b> Тайтл успешно перенесён в <b>«Просмотрено»</b> на Shikimori.`, {
      parse_mode: 'HTML',
    });
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка обновления: <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
  }
});

// Settings: Toggle Voiceover list
bot.callbackQuery('settings_voiceovers', async (ctx) => {
  const userId = ctx.from?.id ? String(ctx.from.id) : DEFAULT_CHAT_ID || 'default_user';
  await ctx.answerCallbackQuery();

  const prefs = dbService.getUserPreferences(userId);
  let favorites: string[] = [];
  try {
    favorites = JSON.parse(prefs.favorite_voiceovers || '[]');
  } catch {}

  const kb = new InlineKeyboard();
  POPULAR_STUDIOS.forEach((studio, idx) => {
    const isSelected = favorites.includes(studio);
    const label = `${isSelected ? '✅' : '▫️'} ${studio}`;
    kb.text(label, `tvo:${idx}`);
    if (idx % 2 === 1) kb.row();
  });

  kb.row().text('⬅️ Назад', 'open_settings').text('❌ Закрыть меню', 'close_menu');

  await ctx.reply('🎙 <b>Выберите ваши любимые студии дубляжа:</b>\n<i>(Нажмите на студию для добавления / удаления)</i>', {
    parse_mode: 'HTML',
    reply_markup: kb,
  });
});

bot.callbackQuery(/^(?:tvo|toggle_voice):(.+)$/, async (ctx) => {
  const userId = ctx.from?.id ? String(ctx.from.id) : DEFAULT_CHAT_ID || 'default_user';
  const param = ctx.match[1];
  let studio: string;
  if (/^\d+$/.test(param)) {
    const idx = parseInt(param, 10);
    studio = POPULAR_STUDIOS[idx] || param;
  } else {
    studio = param;
  }

  dbService.toggleFavoriteVoiceover(userId, studio);
  await ctx.answerCallbackQuery({ text: `Обновлено: ${studio}` });

  // Re-render voiceover keyboard
  const prefs = dbService.getUserPreferences(userId);
  let favorites: string[] = [];
  try {
    favorites = JSON.parse(prefs.favorite_voiceovers || '[]');
  } catch {}

  const kb = new InlineKeyboard();
  POPULAR_STUDIOS.forEach((s, idx) => {
    const isSelected = favorites.includes(s);
    const label = `${isSelected ? '✅' : '▫️'} ${s}`;
    kb.text(label, `tvo:${idx}`);
    if (idx % 2 === 1) kb.row();
  });
  kb.row().text('⬅️ Назад', 'open_settings').text('❌ Закрыть меню', 'close_menu');

  try {
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
  } catch {}
});

// Settings: Toggle Auto-Download
bot.callbackQuery('toggle_auto_download', async (ctx) => {
  const userId = ctx.from?.id ? String(ctx.from.id) : DEFAULT_CHAT_ID || 'default_user';
  const prefs = dbService.getUserPreferences(userId);
  const nextVal = prefs.auto_download_enabled ? 0 : 1;

  dbService.updateUserPreferences(userId, { auto_download_enabled: nextVal });
  await ctx.answerCallbackQuery({ text: nextVal ? 'Авто-загрузка включена ✅' : 'Авто-загрузка выключена ❌' });

  const { text, keyboard } = renderSettingsKeyboard(userId);
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch {}
});

// Settings: Toggle Quality
bot.callbackQuery('toggle_quality', async (ctx) => {
  const userId = ctx.from?.id ? String(ctx.from.id) : DEFAULT_CHAT_ID || 'default_user';
  const prefs = dbService.getUserPreferences(userId);
  const nextQuality = prefs.preferred_quality === '1080p' ? '720p' : prefs.preferred_quality === '720p' ? '4k' : '1080p';

  dbService.updateUserPreferences(userId, { preferred_quality: nextQuality });
  await ctx.answerCallbackQuery({ text: `Качество: ${nextQuality}` });

  const { text, keyboard } = renderSettingsKeyboard(userId);
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch {}
});

// Settings: Toggle Card Style
bot.callbackQuery('toggle_card_style', async (ctx) => {
  const userId = ctx.from?.id ? String(ctx.from.id) : DEFAULT_CHAT_ID || 'default_user';
  const prefs = dbService.getUserPreferences(userId);
  const nextStyle = prefs.card_style === 'full' ? 'compact' : prefs.card_style === 'compact' ? 'minimal' : 'full';

  dbService.updateUserPreferences(userId, { card_style: nextStyle });
  await ctx.answerCallbackQuery({ text: `Стиль карточек: ${nextStyle}` });

  const { text, keyboard } = renderSettingsKeyboard(userId);
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch {}
});

// Settings: Toggle Favorites Filter
bot.callbackQuery('toggle_fav_only', async (ctx) => {
  const userId = ctx.from?.id ? String(ctx.from.id) : DEFAULT_CHAT_ID || 'default_user';
  const prefs = dbService.getUserPreferences(userId);
  const nextVal = prefs.notify_only_favorites ? 0 : 1;

  dbService.updateUserPreferences(userId, { notify_only_favorites: nextVal });
  await ctx.answerCallbackQuery({ text: nextVal ? 'Только любимые озвучки' : 'Все озвучки' });

  const { text, keyboard } = renderSettingsKeyboard(userId);
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch {}
});

// Settings: Toggle Quiet Hours
bot.callbackQuery('toggle_quiet_hours', async (ctx) => {
  const userId = ctx.from?.id ? String(ctx.from.id) : DEFAULT_CHAT_ID || 'default_user';
  const prefs = dbService.getUserPreferences(userId);
  const nextVal = prefs.quiet_hours_enabled ? 0 : 1;

  dbService.updateUserPreferences(userId, { quiet_hours_enabled: nextVal });
  await ctx.answerCallbackQuery({ text: nextVal ? 'Тихий режим включен' : 'Тихий режим выключен' });

  const { text, keyboard } = renderSettingsKeyboard(userId);
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch {}
});

// Settings: Change interval
bot.callbackQuery(/^set_interval:(\d+)$/, async (ctx) => {
  const userId = ctx.from?.id ? String(ctx.from.id) : DEFAULT_CHAT_ID || 'default_user';
  const interval = parseInt(ctx.match[1], 10);

  dbService.updateUserPreferences(userId, { check_interval_min: interval });
  restartScheduler(userId);
  await ctx.answerCallbackQuery({ text: `Интервал: ${interval} мин` });

  const { text, keyboard } = renderSettingsKeyboard(userId);
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch {}
});

// ==========================================
// Scheduler
// ==========================================
let schedulerIntervalId: NodeJS.Timeout | null = null;

export function restartScheduler(userId: string = DEFAULT_CHAT_ID || 'default_user') {
  if (schedulerIntervalId) {
    clearInterval(schedulerIntervalId);
    schedulerIntervalId = null;
  }
  const prefs = dbService.getUserPreferences(userId);
  const intervalMinutes = prefs.check_interval_min || 30;
  console.log(`⏱️ Scheduler initialized. Checking updates every ${intervalMinutes} minutes.`);
  const intervalMs = intervalMinutes * 60 * 1000;

  schedulerIntervalId = setInterval(async () => {
    console.log(`[Scheduler] Running automated background check (every ${intervalMinutes}m)...`);
    try {
      await checkAnimeUpdates(undefined, false);
    } catch (e) {
      console.error('[Scheduler Error]:', e);
    }
  }, intervalMs);
}

export function startScheduler(intervalMinutes: number = 30) {
  restartScheduler(DEFAULT_CHAT_ID || 'default_user');
}

// ==========================================
// Bot Launch
// ==========================================
let isBotRunning = false;

export async function startBot() {
  if (isBotRunning) return;
  if (!BOT_TOKEN) {
    console.warn('⚠️ Telegram bot token is missing. Skipping bot.start(). Set TELEGRAM_BOT_TOKEN in .env to run.');
    return;
  }

  isBotRunning = true;
  console.log('🤖 Starting Personalized Anime Tracker Bot with grammY...');
  startScheduler(30);

  try {
    await bot.api.setMyCommands([
      { command: 'menu', description: '🎛 Главное меню управления' },
      { command: 'check', description: '🔍 Проверить свежие серии' },
      { command: 'download', description: '📥 Скачать серию (мастер)' },
      { command: 'watching', description: '📋 Мой список («Смотрю»)' },
      { command: 'planned', description: '⏳ Запланированное' },
      { command: 'stats', description: '📊 Статистика медиатеки' },
      { command: 'settings', description: '⚙️ Настройки и озвучки' },
    ]);
    console.log('✅ Telegram bot menu commands registered successfully.');
  } catch (cmdErr) {
    console.warn('⚠️ Failed to register bot commands via setMyCommands:', cmdErr);
  }

  bot.start({
    onStart: (botInfo) => {
      console.log(`✅ Telegram bot @${botInfo.username} successfully started!`);
    },
  }).catch((err) => {
    console.error('❌ [Telegram bot.start error]:', err);
    isBotRunning = false;
  });
}


startBot();

