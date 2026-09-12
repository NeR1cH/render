import { Bot, InlineKeyboard, Keyboard, Context } from 'grammy';
import dotenv from 'dotenv';
import { animelibService, AnimeLibService, ANIMELIB_WEB_URL } from '../services/animelib';
import { shikimoriService, ShikimoriAnime } from '../services/shikimori';
import { dbService, AnimeLibSyncRecord, UserPreferencesRecord } from '../db/database';

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
    .text('📅 Календарь')
    .text('🎲 Что глянуть?')
    .row()
    .text('👤 Профиль')
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
}): string {
  const displayTitle = data.rusTitle || data.title;
  const originalTitle = data.rusTitle && data.title !== data.rusTitle ? ` <i>(${data.title})</i>` : '';
  const score = data.score ? `⭐ <b>${data.score.toFixed(1)}</b> / 10` : '⭐ <i>Без оценки</i>';
  const genres = data.genres && data.genres.length > 0 ? `🏷 <i>${data.genres.slice(0, 4).join(', ')}</i>` : '';
  const qualityBadge = data.quality ? ` <code>[${data.quality}]</code>` : '';

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
      epText,
      voiceoverText,
      noteText,
    ].filter(Boolean).join('\n');
  }

  // Compact card style
  if (data.cardStyle === 'compact') {
    return [
      `🎬 <b>${escapeHtml(displayTitle)}</b>${originalTitle}`,
      score,
      epText,
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
    score,
    genres,
    epText,
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
    kb.text(`👁 Отметить серию #${epToMark} просмотренной`, `watch_${item.mediaId}_${epToMark}_${item.shikiId || 0}`);
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

    const watchingList = await animelibService.getAllWatching();

    if (!watchingList || watchingList.length === 0) {
      if (notifyIfEmpty) {
        await send(
          '📭 В списке <b>«Смотрю»</b> пока нет тайтлов, либо нужно обновить куку в <code>ANIMELIB_COOKIE</code>.',
          { parse_mode: 'HTML' }
        );
      }
      return {
        success: true,
        checkedCount: 0,
        updatesCount: 0,
        updatedTitles: [],
        message: 'В списке «Смотрю» пока нет тайтлов или требуется обновление cookie',
      };
    }

    let updatesCount = 0;

    for (const item of watchingList) {
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
        } else {
          dbService.updateLastChecked(item.media_id);
        }
      } catch (err) {
        console.error(`Error processing title "${item.name}":`, err);
      }
    }

    if (updatesCount === 0 && notifyIfEmpty) {
      await send(
        `✨ <b>Все серии просмотрены!</b>\nПроверено <b>${watchingList.length}</b> тайтлов из списка «Смотрю», свежих серий пока нет.`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('🔄 Проверить снова', 'check_updates'),
        }
      );
    }

    return {
      success: true,
      checkedCount: watchingList.length,
      updatesCount,
      updatedTitles,
      message: updatesCount > 0 ? `Найдено новых серий: ${updatesCount}` : 'Свежих релизов пока нет',
    };
  } catch (err: any) {
    console.error('Check anime updates error:', err);
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
    .text('📅 Календарь', 'show_calendar')
    .text('🎲 Что глянуть?', 'random_planned')
    .row()
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
bot.hears('📅 Календарь', (ctx) => showAnimeCalendar(ctx));
bot.hears('🎲 Что глянуть?', (ctx) => showRandomRecommendation(ctx));
bot.hears('👤 Профиль', (ctx) => showUserProfile(ctx));
bot.hears('⚙️ Настройки', (ctx) => openSettingsMenu(ctx));

bot.command('check', (ctx) => checkAnimeUpdates(ctx, true));
bot.command('watching', (ctx) => showWatchingList(ctx));
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

    const { anime, source } = result;

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

    const sourceHeader =
      source === 'planned'
        ? '📌 <b>Рекомендация из ваших «В планах» (Shikimori):</b>'
        : '🔥 <b>Горячий онгоинг сезона:</b>';

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

  const allSync = dbService.getAllSyncItems();
  const watchingCount = allSync.filter((s) => s.status === 'watching').length;
  const completedCount = allSync.filter((s) => s.status === 'completed').length;

  const shikiStats = profile?.stats?.statuses?.anime || profile?.stats?.full_statuses?.anime || [];
  const shikiPlanned = shikiStats.find((s: any) => s.grouped_id === 'planned')?.size ?? '—';
  const shikiCompleted = shikiStats.find((s: any) => s.grouped_id === 'completed')?.size ?? '—';
  const shikiWatching = shikiStats.find((s: any) => s.grouped_id === 'watching,rewatching' || s.grouped_id === 'watching')?.size ?? 0;

  const animelibUserId = process.env.ANIMELIB_USER_ID || 'Не указан';
  const shikiNick = profile?.nickname || 'Не привязан';
  const shikiId = profile?.id ? String(profile.id) : '—';

  const lines = [
    '👤 <b>Карточка профиля & Статистика</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `🆔 <b>Telegram ID:</b> <code>${userId}</code>`,
    `🌐 <b>Shikimori:</b> <code>${shikiNick}</code> (ID: <code>${shikiId}</code>)`,
    `📚 <b>AnimeLib ID:</b> <code>${animelibUserId}</code>`,
    '',
    '📊 <b>Ваша аниме-библиотека:</b>',
    `  • 📺 <b>Смотрю сейчас:</b> <code>${watchingCount || shikiWatching}</code> тайтлов`,
    `  • 📌 <b>В планах (Shikimori):</b> <code>${shikiPlanned}</code> тайтлов`,
    `  • 🏁 <b>Просмотрено:</b> <code>${shikiCompleted || completedCount}</code> аниме`,
    `  • 💾 <b>В локальной базе:</b> <code>${allSync.length}</code> сохраненных записей`,
    '',
    '🔄 <b>Синхронизация аккаунтов:</b>',
    '  • AnimeLib ➔ SQLite ➔ Shikimori: <b>Активна ✅</b>',
    '  • Отметка серий прямо в Telegram: <b>Включена ✅</b>',
  ];

  const kb = new InlineKeyboard()
    .text('🔄 Синхронизировать', 'check_updates')
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

    dbService.markShikiSynced(mediaId, shikiId);

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
  await ctx.answerCallbackQuery({ text: `Интервал: ${interval} мин` });

  const { text, keyboard } = renderSettingsKeyboard(userId);
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch {}
});

// ==========================================
// Scheduler
// ==========================================
export function startScheduler(intervalMinutes: number = 30) {
  console.log(`⏱️ Scheduler initialized. Checking updates every ${intervalMinutes} minutes.`);
  const intervalMs = intervalMinutes * 60 * 1000;

  setInterval(async () => {
    console.log('[Scheduler] Running automated background check...');
    try {
      await checkAnimeUpdates(undefined, false);
    } catch (e) {
      console.error('[Scheduler Error]:', e);
    }
  }, intervalMs);
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

