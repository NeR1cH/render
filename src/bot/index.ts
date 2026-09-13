import { Bot, InlineKeyboard, Keyboard, Context } from 'grammy';
import dotenv from 'dotenv';
import { animelibService, AnimeLibService, ANIMELIB_WEB_URL, AnimeLibBookmarkItem } from '../services/animelib';
import { shikimoriService, ShikimoriAnime } from '../services/shikimori';
import { dbService, AnimeLibSyncRecord, UserPreferencesRecord } from '../db/database';
import { getLibraryComprehensiveStats } from '../services/libraryStats';
import { downloaderService } from '../services/downloader';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) {
  console.warn('⚠️ TELEGRAM_BOT_TOKEN is not defined in .env. Bot will not connect to Telegram until token is set.');
}

export const bot = new Bot(BOT_TOKEN || '000000000:AAFakeTokenForOfflineMode');

// Top standard popular anime voiceover studios
export const POPULAR_STUDIOS = [
  'AniLibria',
  'Dream Cast',
  'Studio Band',
  'DEEP',
  'Дубляжная',
  'SHIZA Project',
  'AniDUB',
  'Red Head Sound',
  'Flarrow Films',
];

// ==========================================
// Persistent Bottom Menu (Reply Keyboard)
// ==========================================
export function getMainMenuKeyboard(): Keyboard {
  return new Keyboard()
    .text('🔄 Проверить серии')
    .text('📺 Мой список')
    .row()
    .text('📥 Скачать')
    .text('📅 Календарь')
    .row()
    .text('🎲 Что глянуть?')
    .text('👤 Профиль')
    .row()
    .text('⚙️ Настройки')
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

  // Row 1: Direct media portals
  if (animelibUrl) kb.url('🌐 AnimeLib', animelibUrl);
  if (shikimoriUrl) kb.url('📊 Shikimori', shikimoriUrl);

  // Row 2: One-click Torrent search
  kb.row();
  kb.url('📥 RuTracker (1080p)', rutrackerUrl);

  // Row 3: Action Buttons (Progress & Mark Completed)
  if (item.mediaId) {
    kb.row();
    const epToMark = item.newEpisode ?? ((item.currentEpisode || 0) + 1);
    kb.text(`👁 Отметить #${epToMark}`, `watch_${item.mediaId}_${epToMark}_${item.shikiId || 0}`);
    kb.text('📥 Скачать серию', `dl_${item.mediaId}_${epToMark}`);
    if (item.shikiId) {
      kb.row();
      kb.text('⭐️ Оценить', `rate_menu:${item.shikiId}`);
      kb.text('🏁 Завершить', `mark_completed:${item.mediaId}:${item.shikiId}`);
    }
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
    await send('⏳ <i>Проверяю ваши закладки AnimeLib и новые серии...</i>', {
      parse_mode: 'HTML',
    });

    const trackedList = await animelibService.getAllTrackedBookmarks();

    if (!trackedList || trackedList.length === 0) {
      dbService.saveCheckReport({
        timestamp: Date.now(),
        checked_count: 0,
        updates_count: 0,
        matched_count: 0,
        synced_count: 0,
        status: 'warning',
        message: 'Списки «Смотрю» и «Запланировано» пусты или требуется обновление cookie',
      });

      if (notifyIfEmpty) {
        await send(
          '📭 В списках <b>«Смотрю»</b> и <b>«Запланировано»</b> пока нет тайтлов, либо нужно обновить куку в <code>ANIMELIB_COOKIE</code>.',
          { parse_mode: 'HTML' }
        );
      }
      return {
        success: true,
        checkedCount: 0,
        updatesCount: 0,
        updatedTitles: [],
        message: 'В отслеживаемых списках пока нет тайтлов или требуется обновление cookie',
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
        `✨ <b>Все серии просмотрены!</b>\nПроверено <b>${trackedList.length}</b> тайтлов из списков «Смотрю» и «Запланировано», свежих серий пока нет.`,
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

  const favList = favorites.length > 0 ? favorites.join(', ') : 'Не выбрано';
  const quietStatus = prefs.quiet_hours_enabled
    ? `Включен (${prefs.quiet_start_hour}:00 - ${prefs.quiet_end_hour}:00)`
    : 'Выключен';
  const favOnlyStatus = prefs.notify_only_favorites ? 'Да (только в моих студиях)' : 'Нет (любые релизы)';

  const text = [
    '⚙️ <b>Панель настроек бота и уведомлений</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    '<i>Управление фильтрами озвучки, качеством и интервалами:</i>',
    '',
    `🎙 <b>Любимые озвучки:</b> 🔥 <code>${escapeHtml(favList)}</code>`,
    `🎯 <b>Фильтр релизов:</b> <code>${favOnlyStatus}</code>`,
    `📺 <b>Качество торрентов:</b> <code>${prefs.preferred_quality || '1080p'}</code>`,
    `🎨 <b>Стиль карточек:</b> <code>${prefs.card_style || 'full'}</code>`,
    `⏱ <b>Интервал проверки:</b> <code>каждые ${prefs.check_interval_min || 30} мин</code>`,
    `🔕 <b>Ночной тихий режим:</b> <code>${quietStatus}</code>`,
    '',
    '<i>Нажимайте кнопки ниже, чтобы моментально переключать параметры:</i>',
  ].join('\n');

  const kb = new InlineKeyboard();

  // Voiceovers selector button
  kb.text('🎙 Настроить озвучки', 'settings_voiceovers').row();

  // Quality toggle (1080p / 720p / 4k)
  kb.text(`Качество: ${prefs.preferred_quality}`, 'toggle_quality')
    .text(`Стиль: ${prefs.card_style}`, 'toggle_card_style')
    .row();

  // Notifications filter & Quiet mode
  kb.text(`Фильтр озвучек: ${prefs.notify_only_favorites ? 'ВКЛ' : 'ВЫКЛ'}`, 'toggle_fav_only')
    .row()
    .text(`Тихий режим: ${prefs.quiet_hours_enabled ? 'ВКЛ' : 'ВЫКЛ'}`, 'toggle_quiet_hours')
    .row();

  // Interval toggles
  kb.text('⏱ 15 мин', 'set_interval:15')
    .text('⏱ 30 мин', 'set_interval:30')
    .text('⏱ 1 час', 'set_interval:60');

  return { text, keyboard: kb };
}

// ==========================================
// Telegram Bot Command Listeners
// ==========================================

bot.command('start', async (ctx) => {
  const welcomeText = [
    '👋 <b>Добро пожаловать в персональный Anime Tracker Hub!</b>',
    '',
    'Я помогаю отслеживать выход серий на <b>AnimeLib</b> в вашей любимой озвучке, синхронизирую статус с <b>Shikimori</b> и предоставляю быстрый поиск раздач на <b>RuTracker</b>.',
    '',
    '💡 Пользуйтесь удобным меню внизу экрана или быстрыми кнопками ниже.',
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('🔄 Проверить серии', 'check_updates')
    .text('📺 Мой список', 'list_watching')
    .row()
    .text('📥 Скачать серию', 'dl_back_titles')
    .text('📅 Календарь', 'show_calendar')
    .row()
    .text('🎲 Что глянуть?', 'random_planned')
    .text('⚙️ Настройки', 'open_settings');

  await ctx.reply(welcomeText, {
    parse_mode: 'HTML',
    reply_markup: kb,
  });

  // Also send bottom persistent reply keyboard
  await ctx.reply('🎛 Главное меню готово к работе:', {
    reply_markup: getMainMenuKeyboard(),
  });
});

// Text-based Reply Keyboard listeners
bot.hears('🔄 Проверить серии', (ctx) => checkAnimeUpdates(ctx, true));
bot.hears('📺 Мой список', (ctx) => showWatchingList(ctx));
bot.hears('📥 Скачать', (ctx) => showDownloadTitleSelection(ctx));
bot.hears('📅 Календарь', (ctx) => showAnimeCalendar(ctx));
bot.hears('🎲 Что глянуть?', (ctx) => showRandomRecommendation(ctx));
bot.hears('👤 Профиль', (ctx) => showUserProfile(ctx));
bot.hears('⚙️ Настройки', (ctx) => openSettingsMenu(ctx));

bot.command('check', (ctx) => checkAnimeUpdates(ctx, true));
bot.command('watching', (ctx) => showWatchingList(ctx));
bot.command('download', (ctx) => showDownloadTitleSelection(ctx));
bot.command('calendar', (ctx) => showAnimeCalendar(ctx));
bot.command('settings', (ctx) => openSettingsMenu(ctx));
bot.command('profile', (ctx) => showUserProfile(ctx));

// ==========================================
// Helper Handlers
// ==========================================

async function showWatchingList(ctx: Context) {
  await ctx.reply('🔍 <i>Загружаю текущие тайтлы из раздела «Смотрю»...</i>', { parse_mode: 'HTML' });
  const list = await animelibService.getAllWatching();

  if (!list || list.length === 0) {
    return ctx.reply('📭 Список «Смотрю» пуст или сессия истекла. Обновите <code>ANIMELIB_COOKIE</code> в .env.', {
      parse_mode: 'HTML',
    });
  }

  const lines = list.slice(0, 15).map((item, idx) => {
    const progress = item.current_progress_number ? ` (серия <code>#${item.current_progress_number}</code>)` : '';
    const stored = dbService.getSyncItemByMediaId(item.media_id);
    const note = stored?.custom_note ? ` — <i>«${escapeHtml(stored.custom_note)}»</i>` : '';
    return `${idx + 1}. <b>${escapeHtml(item.rus_name || item.name)}</b>${progress}${note}`;
  });

  const totalText = `📺 <b>Ваш текущий список просмотра (${list.length} тайтлов):</b>\n\n${lines.join('\n')}${
    list.length > 15 ? `\n<i>...и еще ${list.length - 15}</i>` : ''
  }`;

  const kb = new InlineKeyboard()
    .text('🔄 Проверить серии', 'check_updates')
    .text('🎲 Случайный тайтл', 'random_planned');

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

async function showUserProfile(ctx: Context) {
  const userId = ctx.from?.id ? String(ctx.from.id) : DEFAULT_CHAT_ID || 'default_user';
  const profile = await shikimoriService.getUserProfile();
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
      '  • 💡 <i>Нажмите «🔄 Проверить серии», чтобы запустить немедленно.</i>',
    ].join('\n');
  }

  const lines = [
    '👤 <b>Карточка профиля & Статистика библиотеки</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `🆔 <b>Telegram ID:</b> <code>${userId}</code>`,
    `🌐 <b>Shikimori:</b> <code>${escapeHtml(shikiNick)}</code> (ID: <code>${shikiId}</code>)`,
    `📚 <b>AnimeLib ID:</b> <code>${escapeHtml(animelibUserId)}</code>`,
    '',
    '📊 <b>Категории аниме (Все вкладки):</b>',
    `  • 📺 <b>Смотрю сейчас:</b> <code>${libStats.watching}</code> тайтлов`,
    `  • 📌 <b>В планах:</b> <code>${libStats.planned}</code> тайтлов`,
    `  • 🏁 <b>Просмотрено:</b> <code>${libStats.completed}</code> аниме`,
    `  • ❤️ <b>Любимые:</b> <code>${libStats.favorites}</code> тайтлов`,
    `  • 🔁 <b>Пересматриваю:</b> <code>${libStats.rewatching}</code>`,
    `  • ⏸️ <b>Отложено:</b> <code>${libStats.on_hold}</code>`,
    `  • 🚫 <b>Брошено:</b> <code>${libStats.dropped}</code> тайтлов`,
    `  • ⚔️ <b>FATE (коллекция):</b> <code>${libStats.fate}</code> тайтлов`,
    '  ──────────────────',
    `  📦 <b>Всего в библиотеке:</b> <code>${libStats.totalTracked}</code> тайтлов`,
    '',
    '🔄 <b>Синхронизация & Перенос на Shikimori:</b>',
    `  • 🚀 <b>Перенесено на Shikimori:</b> <code>${libStats.shikiTransferredCount} / ${libStats.totalTracked}</code> (${libStats.shikiMatchRatePercent}%)`,
    `  • 🎯 <b>Проверено & сматчено:</b> <code>${libStats.shikiVerifiedCount}</code> тайтлов`,
    '  • 🔗 <b>Мост синхронизации:</b> AnimeLib ➔ SQLite ➔ Shikimori [Активен ✅]',
    '',
    checkSection,
  ];

  const kb = new InlineKeyboard()
    .text('🔄 Проверить серии', 'check_updates')
    .text('📺 Мой список', 'list_watching')
    .row();

  if (profile?.id) {
    kb.url('📊 Профиль Shikimori', `https://shikimori.one/${profile.nickname || profile.id}`);
  }
  if (process.env.ANIMELIB_USER_ID) {
    kb.url('🌐 Закладки AnimeLib', `${ANIMELIB_WEB_URL}/ru/user/${process.env.ANIMELIB_USER_ID}/bookmarks`);
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
}

async function openSettingsMenu(ctx: Context) {
  const userId = ctx.from?.id ? String(ctx.from.id) : DEFAULT_CHAT_ID || 'default_user';
  const { text, keyboard } = renderSettingsKeyboard(userId);
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

// ==========================================
// Callback Queries (Interactive Buttons)
// ==========================================

bot.callbackQuery('check_updates', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Ищу свежие серии...' });
  await checkAnimeUpdates(ctx, true);
});

bot.callbackQuery('list_watching', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showWatchingList(ctx);
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

// Download button callback: dl_<media_id>_<ep>
bot.callbackQuery(/^dl_(\d+)_([\d.]+)$/, async (ctx) => {
  const mediaId = parseInt(ctx.match[1], 10);
  const episode = parseFloat(ctx.match[2]);

  // 1. Быстрый ответ пользователю
  await ctx.answerCallbackQuery({ text: '⏳ Серия добавлена в очередь загрузки!' });

  // 2. Определение предпочтительной озвучки (из тайтла или из общих настроек)
  const stored = dbService.getSyncItemByMediaId(mediaId);
  let targetVoiceover = stored?.preferred_voiceover;
  if (!targetVoiceover) {
    const userId = ctx.from?.id ? String(ctx.from.id) : DEFAULT_CHAT_ID || 'default_user';
    const prefs = dbService.getUserPreferences(userId);
    try {
      const favs: string[] = JSON.parse(prefs.favorite_voiceovers || '[]');
      if (favs.length > 0) targetVoiceover = favs[0];
    } catch {}
  }

  // 3. Постановка задачи в очередь загрузки
  downloaderService.addToQueue(mediaId, episode, targetVoiceover || undefined);

  // 4. Фоновый запуск обработки очереди
  downloaderService.processQueue().catch((err) => {
    console.error('[Downloader Bot] Ошибка фоновой обработки очереди:', err);
  });

  // 5. Обновление inline-кнопок: заменяем кнопку скачивания на "⏳ В очереди загрузки"
  if (ctx.msg?.reply_markup?.inline_keyboard) {
    const targetCallback = `dl_${mediaId}_${episode}`;
    const updatedRows = ctx.msg.reply_markup.inline_keyboard.map((row) =>
      row.map((btn) => {
        if ('callback_data' in btn && (btn.callback_data === targetCallback || btn.callback_data.startsWith(`dl_${mediaId}_`))) {
          return { text: '⏳ В очереди загрузки', callback_data: 'noop_dl' };
        }
        return btn;
      })
    );

    try {
      await ctx.editMessageReplyMarkup({
        reply_markup: { inline_keyboard: updatedRows },
      });
    } catch {
      // Игнорируем ошибку, если сообщение не изменилось
    }
  }
});

bot.callbackQuery('noop_dl', (ctx) =>
  ctx.answerCallbackQuery({ text: 'Серия уже в очереди загрузки или скачивается!' })
);

// ==========================================
// Interactive Download Wizard (/download)
// ==========================================

export async function showDownloadTitleSelection(ctx: Context) {
  let watchingItems = dbService.getAllSyncItems('watching');

  // If local DB is empty or missing titles, attempt to fetch from AnimeLib
  if (watchingItems.length === 0) {
    try {
      const bookmarks = await animelibService.getAllWatching();
      if (bookmarks && bookmarks.length > 0) {
        watchingItems = dbService.getAllSyncItems('watching');
      }
    } catch {}
  }

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

  const lines = watchingItems.map((item, idx) => {
    const title = escapeHtml(item.rus_title || item.title);
    const x = item.last_tracked_episode || 0;
    const y = item.latest_episode && item.latest_episode > 0 ? item.latest_episode : '?';
    return `${idx + 1}. «<b>${title}</b>» [Просмотрено: #${x} из #${y}]`;
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
    kb.text(`${i + 1}. ${shortTitle}`, `dl_title:${item.media_id}`).row();
  }

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
  let latest = episodes.length > 0 ? episodes[episodes.length - 1] : (stored?.latest_episode || lastTracked || 0);

  // Fallback: If no episodes were fetched from API, generate 1..max range
  if (episodes.length === 0) {
    const maxCount = Math.max(latest, lastTracked + 1, 12);
    episodes = Array.from({ length: maxCount }, (_, i) => i + 1);
    latest = episodes[episodes.length - 1];
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
    kb.text(badge, `dl_ep:${mediaId}:${ep}`);
    col++;
    if (col % 4 === 0) {
      kb.row();
    }
  }
  if (col % 4 !== 0) {
    kb.row();
  }
  kb.text('⬅️ Назад к тайтлам', 'dl_back_titles');

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

export async function showVoiceoverSelection(ctx: Context, mediaId: number, ep: number) {
  const stored = dbService.getSyncItemByMediaId(mediaId);
  const title = stored?.rus_title || stored?.title || `Тайтл #${mediaId}`;
  const preferredVo = stored?.preferred_voiceover?.trim() || '';

  let studios = await animelibService.getEpisodeStudios(mediaId, ep);
  if (studios.length === 0) {
    studios = POPULAR_STUDIOS.slice(0, 6);
  }

  const kb = new InlineKeyboard();
  for (let i = 0; i < studios.length; i++) {
    const studio = studios[i];
    const isPreferred = Boolean(
      preferredVo &&
      (studio.toLowerCase().includes(preferredVo.toLowerCase()) || preferredVo.toLowerCase().includes(studio.toLowerCase()))
    );
    const label = isPreferred ? `⭐️ ${studio}` : studio;
    const safeStudio = studio.length > 35 ? studio.slice(0, 35) : studio;
    kb.text(label, `dl_run:${mediaId}:${ep}:${safeStudio}`);
    if (i % 2 === 1) {
      kb.row();
    }
  }
  if (studios.length % 2 !== 0) {
    kb.row();
  }
  kb.text('⬅️ Назад к выбору серий', `dl_back_eps:${mediaId}`);

  const prefNotice = preferredVo ? `\n⭐️ <i>Предпочитаемая озвучка: <b>${escapeHtml(preferredVo)}</b></i>` : '';
  const text = [
    `🎙 <b>Выбор озвучки: Серия #${ep}</b>`,
    `📺 <b>${escapeHtml(title)}</b>`,
    '━━━━━━━━━━━━━━━━━━━━',
    `<i>Доступные студии озвучки для серии #${ep}:</i>${prefNotice}`,
    '',
    '<i>Нажмите на студию для запуска скачивания:</i>',
  ].join('\n');

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

// Callback: Choose Title -> Show Episodes (or Back to Episodes)
bot.callbackQuery(/^(?:dl_title|dl_back_eps):(\d+)$/, async (ctx) => {
  const mediaId = parseInt(ctx.match[1], 10);
  await ctx.answerCallbackQuery();
  await showEpisodeSelection(ctx, mediaId);
});

// Callback: Choose Episode -> Show Voiceovers
bot.callbackQuery(/^dl_ep:(\d+):([\d.]+)$/, async (ctx) => {
  const mediaId = parseInt(ctx.match[1], 10);
  const ep = parseFloat(ctx.match[2]);
  await ctx.answerCallbackQuery({ text: `Ищу доступные озвучки для серии #${ep}...` });
  await showVoiceoverSelection(ctx, mediaId, ep);
});

// Callback: Choose Voiceover -> Run Download
bot.callbackQuery(/^dl_run:(\d+):([\d.]+):(.+)$/, async (ctx) => {
  const mediaId = parseInt(ctx.match[1], 10);
  const ep = parseFloat(ctx.match[2]);
  const voiceover = ctx.match[3].trim();

  await ctx.answerCallbackQuery({ text: `📥 Серия #${ep} поставлена в очередь!` });

  const stored = dbService.getSyncItemByMediaId(mediaId);
  const title = stored?.rus_title || stored?.title || `Тайтл #${mediaId}`;

  const text = [
    '📥 <b>Серия поставлена в очередь скачивания!</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `📺 <b>Тайтл:</b> ${escapeHtml(title)}`,
    `🎬 <b>Серия:</b> <code>#${ep}</code>`,
    `🎙 <b>Озвучка:</b> <code>${escapeHtml(voiceover)}</code>`,
    '',
    '⏳ <i>Инициализация видеопотока и запуск FFmpeg...</i>',
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('📺 Другая серия этого тайтла', `dl_title:${mediaId}`)
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
  const messageId = sentMsg && typeof sentMsg === 'object' && 'message_id' in sentMsg ? sentMsg.message_id : undefined;

  downloaderService.addToQueue(mediaId, ep, voiceover, chatId, messageId);
  downloaderService.processQueue().catch((err) => {
    console.error('[Downloader Bot] Ошибка фоновой обработки очереди:', err);
  });
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
    kb.text(label, `toggle_voice:${studio}`);
    if (idx % 2 === 1) kb.row();
  });

  kb.row().text('🔙 Сохранить и вернуться', 'open_settings');

  await ctx.reply('🎙 <b>Выберите ваши любимые студии дубляжа:</b>\n<i>(Нажмите на студию для добавления / удаления)</i>', {
    parse_mode: 'HTML',
    reply_markup: kb,
  });
});

bot.callbackQuery(/^toggle_voice:(.+)$/, async (ctx) => {
  const userId = ctx.from?.id ? String(ctx.from.id) : DEFAULT_CHAT_ID || 'default_user';
  const studio = ctx.match[1];
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
    kb.text(label, `toggle_voice:${s}`);
    if (idx % 2 === 1) kb.row();
  });
  kb.row().text('🔙 Сохранить и вернуться', 'open_settings');

  try {
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
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

