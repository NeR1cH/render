import { Bot, InlineKeyboard, Keyboard, Context } from 'grammy';
import dotenv from 'dotenv';
import { animelibService } from '../services/animelib';
import { shikimoriService, ShikimoriAnime } from '../services/shikimori';
import { dbService, AnimeLibSyncRecord, UserPreferencesRecord } from '../db/database';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) {
  console.warn('⚠️ TELEGRAM_BOT_TOKEN is not defined in .env. Bot will not connect to Telegram until token is set.');
}

export const bot = new Bot(BOT_TOKEN);

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
    const cleanDesc = data.description.replace(/<[^>]*>?/gm, '').trim();
    const truncated = cleanDesc.length > 200 ? `${cleanDesc.slice(0, 200)}...` : cleanDesc;
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
  quality?: string;
}): InlineKeyboard {
  const kb = new InlineKeyboard();

  const animelibUrl = item.slugUrl
    ? `https://animelib.me/ru/anime/${item.slugUrl}`
    : item.mediaId
      ? `https://animelib.me/ru/anime/${item.mediaId}`
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
    const nextEp = (item.currentEpisode || 0) + 1;
    kb.text(`➕ Серия #${nextEp}`, `add_ep:${item.mediaId}:${nextEp}:${item.shikiId || 0}`);
    if (item.shikiId) {
      kb.text('⭐️ Оценить', `rate_menu:${item.shikiId}`);
      kb.text('✅ Завершить', `mark_completed:${item.mediaId}:${item.shikiId}`);
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

// ==========================================
// Core Check & Sync Logic (with Preferences)
// ==========================================

export async function checkAnimeUpdates(ctx?: Context, notifyIfEmpty: boolean = true) {
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
      return;
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

        // Has a new episode been released?
        const hasNewEpisode = latestEpisode > lastTracked;

        if (hasNewEpisode) {
          // If notify_only_favorites is turned ON, verify favorite voiceover exists
          if (prefs.notify_only_favorites) {
            const matchesFavorite = mediaEpisodes.voiceovers.some((vo) =>
              favoriteVoiceovers.some((fav) => fav.toLowerCase() === vo.toLowerCase())
            );
            if (!matchesFavorite) {
              // Skip notification until favorite studio is available
              continue;
            }
          }

          updatesCount++;

          const cardText = formatAnimeCard({
            title: item.name,
            rusTitle: item.rus_name || shikiAnime?.russian,
            currentEpisode: lastTracked,
            newEpisode: latestEpisode,
            score: shikiAnime?.score,
            genres: shikiAnime?.genres?.map((g) => g.russian || g.name),
            voiceovers: mediaEpisodes.voiceovers,
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
  } catch (err: any) {
    console.error('Check anime updates error:', err);
    await send(`❌ <b>Ошибка при проверке:</b>\n<code>${escapeHtml(err.message)}</code>`, {
      parse_mode: 'HTML',
    });
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
    '⚙️ <b>Центр персональных настроек</b>',
    '',
    `🎙 <b>Любимые озвучки:</b> 🔥 <code>${escapeHtml(favList)}</code>`,
    `🎯 <b>Уведомления:</b> <code>${favOnlyStatus}</code>`,
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

async function showAnimeCalendar(ctx: Context) {
  await ctx.reply('📅 <i>Загружаю персональный график выхода серий...</i>', { parse_mode: 'HTML' });
  try {
    const calendar = await shikimoriService.getCalendar();
    if (!calendar || calendar.length === 0) {
      return ctx.reply('📭 На ближайшие дни расписание серий отсутствует.');
    }

    // Sort or filter up to 8 closest releases
    const items = calendar.slice(0, 8);
    const lines = items.map((c) => {
      const date = new Date(c.next_episode_at);
      const timeStr = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      const dayStr = date.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
      return `• <b>${escapeHtml(c.anime.russian || c.anime.name)}</b> — Эпизод <code>#${c.next_episode}</code>\n  ⏰ <i>${dayStr} в ${timeStr}</i>`;
    });

    const text = `📅 <b>Ближайшие релизы аниме (Расписание):</b>\n\n${lines.join('\n\n')}`;
    await ctx.reply(text, { parse_mode: 'HTML' });
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка загрузки календаря: ${err.message}`);
  }
}

async function showRandomRecommendation(ctx: Context) {
  await ctx.reply('🎲 <i>Ищу интересный тайтл для сегодняшнего просмотра...</i>', { parse_mode: 'HTML' });
  try {
    const anime = await shikimoriService.getRandomPlannedAnime();
    if (!anime) {
      return ctx.reply('Не удалось найти подходящий тайтл. Попробуйте позже.');
    }

    const card = formatAnimeCard({
      title: anime.name,
      rusTitle: anime.russian,
      score: anime.score,
      genres: anime.genres?.map((g) => g.russian),
      description: anime.description,
      cardStyle: 'full',
    });

    const kb = new InlineKeyboard()
      .url('📊 Открыть на Shikimori', `https://shikimori.one/animes/${anime.id}`)
      .row()
      .text('🎲 Другой вариант', 'random_planned');

    if (anime.poster?.mainUrl) {
      await ctx.replyWithPhoto(anime.poster.mainUrl, {
        caption: `🎲 <b>Случайная рекомендация:</b>\n\n${card}`,
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } else {
      await ctx.reply(`🎲 <b>Случайная рекомендация:</b>\n\n${card}`, {
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
  const prefs = dbService.getUserPreferences(userId);
  const profile = await shikimoriService.getUserProfile();
  const watchingCount = dbService.getAllSyncItems('watching').length;

  let favorites: string[] = [];
  try {
    favorites = JSON.parse(prefs.favorite_voiceovers || '[]');
  } catch {}

  const lines = [
    '👤 <b>Ваш персональный профиль:</b>',
    '',
    `🆔 <b>Telegram ID:</b> <code>${userId}</code>`,
    profile?.nickname ? `🌐 <b>Shikimori:</b> <code>${profile.nickname}</code> (ID: ${profile.id})` : '🌐 <b>Shikimori:</b> <i>Не привязан (заполните SHIKIMORI_USER_ID)</i>',
    `📺 <b>Отслеживается тайтлов:</b> <code>${watchingCount}</code>`,
    `🎙 <b>Любимые озвучки:</b> 🔥 <code>${favorites.join(', ') || 'Все'}</code>`,
    `🎨 <b>Стиль интерфейса:</b> <code>${prefs.card_style}</code> | <b>Качество:</b> <code>${prefs.preferred_quality}</code>`,
  ];

  const kb = new InlineKeyboard()
    .text('⚙️ Настроить профиль', 'open_settings')
    .text('🔄 Проверить серии', 'check_updates');

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
  await showAnimeCalendar(ctx);
});

bot.callbackQuery('random_planned', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Выбираю тайтл...' });
  await showRandomRecommendation(ctx);
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

// Increment Episode (+1 series) in one click
bot.callbackQuery(/^add_ep:(\d+):(\d+):(\d+)$/, async (ctx) => {
  const mediaId = parseInt(ctx.match[1], 10);
  const episode = parseInt(ctx.match[2], 10);
  const shikiId = parseInt(ctx.match[3], 10);

  await ctx.answerCallbackQuery({ text: `Отмечаю серию #${episode}...` });

  dbService.updateTrackedEpisode(mediaId, episode);

  if (shikiId > 0) {
    try {
      await shikimoriService.updateUserRate({
        target_id: shikiId,
        status: 'watching',
        episodes: episode,
      });
    } catch (e) {
      console.warn('Could not sync episode count with Shikimori:', e);
    }
  }

  await ctx.reply(`✅ <b>Прогресс обновлен:</b> Серия <code>#${episode}</code> отмечена!`, {
    parse_mode: 'HTML',
  });
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
export async function startBot() {
  if (!BOT_TOKEN) {
    console.warn('⚠️ Telegram bot token is missing. Skipping bot.start(). Set TELEGRAM_BOT_TOKEN in .env to run.');
    return;
  }

  console.log('🤖 Starting Personalized Anime Tracker Bot with grammY...');
  startScheduler(30);

  bot.start({
    onStart: (botInfo) => {
      console.log(`✅ Telegram bot @${botInfo.username} successfully started!`);
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startBot();
}
