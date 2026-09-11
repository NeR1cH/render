import { Bot, InlineKeyboard, Context, session, SessionFlavor } from 'grammy';
import dotenv from 'dotenv';
import { animelibService, AnimeLibBookmarkItem } from '../services/animelib';
import { shikimoriService, ShikimoriAnime } from '../services/shikimori';
import { dbService, AnimeLibSyncRecord } from '../db/database';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) {
  console.warn('⚠️ TELEGRAM_BOT_TOKEN is not defined in .env. Bot will not connect to Telegram until token is set.');
}

export const bot = new Bot(BOT_TOKEN);

// ==========================================
// Formatting Helpers (Cards & Templates)
// ==========================================

/**
 * Formats an anime release card with emojis, ratings, episode info, and voiceovers.
 */
export function formatAnimeCard(data: {
  title: string;
  rusTitle?: string;
  currentEpisode?: number;
  newEpisode?: number;
  score?: number;
  status?: string;
  genres?: string[];
  voiceovers?: string[];
  description?: string;
}): string {
  const displayTitle = data.rusTitle || data.title;
  const originalTitle = data.rusTitle && data.title !== data.rusTitle ? ` (${data.title})` : '';
  const score = data.score ? `⭐ ${data.score.toFixed(1)} / 10` : '⭐ Без оценки';
  const genres = data.genres && data.genres.length > 0 ? `🏷 <i>${data.genres.slice(0, 4).join(', ')}</i>` : '';

  let epText = '';
  if (data.newEpisode && data.currentEpisode !== undefined) {
    if (data.newEpisode > data.currentEpisode) {
      epText = `🔔 <b>Новая серия:</b> <code>${data.newEpisode}</code> (просмотрено: ${data.currentEpisode})`;
    } else {
      epText = `📺 <b>Серия:</b> <code>${data.currentEpisode}</code>`;
    }
  } else if (data.newEpisode) {
    epText = `📺 <b>Вышла серия:</b> <code>${data.newEpisode}</code>`;
  }

  const voiceoverText =
    data.voiceovers && data.voiceovers.length > 0
      ? `🎙 <b>Озвучка:</b> ${data.voiceovers.slice(0, 3).join(', ')}${data.voiceovers.length > 3 ? ` <i>(+еще ${data.voiceovers.length - 3})</i>` : ''}`
      : '';

  let desc = '';
  if (data.description) {
    // Strip HTML and truncate to 220 characters
    const cleanDesc = data.description.replace(/<[^>]*>?/gm, '').trim();
    desc = cleanDesc.length > 220 ? `${cleanDesc.slice(0, 220)}...` : cleanDesc;
    desc = `\n📖 <i>${desc}</i>\n`;
  }

  const lines = [
    `🎬 <b>${escapeHtml(displayTitle)}</b>${escapeHtml(originalTitle)}`,
    score,
    genres,
    epText,
    voiceoverText,
    desc,
  ].filter(Boolean);

  return lines.join('\n');
}

/**
 * Helper to build interactive inline keyboard with AnimeLib, Shikimori, and Torrent buttons
 */
export function buildAnimeCardKeyboard(item: {
  mediaId?: number;
  slugUrl?: string;
  shikiId?: number | string;
  title: string;
}): InlineKeyboard {
  const kb = new InlineKeyboard();

  const animelibUrl = item.slugUrl
    ? `https://animelib.me/ru/anime/${item.slugUrl}`
    : item.mediaId
      ? `https://animelib.me/ru/anime/${item.mediaId}`
      : null;

  const shikimoriUrl = item.shikiId ? `https://shikimori.one/animes/${item.shikiId}` : null;
  const torrentQuery = encodeURIComponent(item.title);
  const rutrackerUrl = `https://rutracker.org/forum/tracker.php?nm=${torrentQuery}`;

  if (animelibUrl) {
    kb.url('🌐 AnimeLib', animelibUrl);
  }
  if (shikimoriUrl) {
    kb.url('📊 Shikimori', shikimoriUrl);
  }
  kb.row();
  kb.url('📥 Скачать (RuTracker)', rutrackerUrl);

  if (item.mediaId && item.shikiId) {
    kb.text('✅ В "Просмотрено"', `mark_completed:${item.mediaId}:${item.shikiId}`);
  }

  return kb;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==========================================
// Check & Sync Core Logic
// ==========================================

export async function checkAnimeUpdates(ctx?: Context, notifyIfEmpty: boolean = true) {
  const send = async (text: string, options?: any) => {
    if (ctx) {
      await ctx.reply(text, options);
    } else if (DEFAULT_CHAT_ID && BOT_TOKEN) {
      await bot.api.sendMessage(DEFAULT_CHAT_ID, text, options);
    } else {
      console.log('[Anime Tracker]:', text);
    }
  };

  try {
    await send('⏳ <i>Проверяю закладки AnimeLib и выходы новых серий...</i>', {
      parse_mode: 'HTML',
    });

    const watchingList = await animelibService.getAllWatching();

    if (!watchingList || watchingList.length === 0) {
      if (notifyIfEmpty) {
        await send(
          '📭 В списке <b>«Смотрю»</b> пока нет активных тайтлов, либо требуется обновить куку в <code>ANIMELIB_COOKIE</code>.',
          { parse_mode: 'HTML' }
        );
      }
      return;
    }

    let updatesCount = 0;

    for (const item of watchingList) {
      try {
        // Fetch current episodes and voiceovers
        const mediaEpisodes = await animelibService.getMediaEpisodes(item.media_id, item.slug_url);
        const stored = dbService.getSyncItemByMediaId(item.media_id);

        const lastTracked = stored?.last_tracked_episode || item.current_progress_number || 0;
        const latestEpisode = mediaEpisodes.latestEpisode || item.last_item_number;

        // Try to match or retrieve Shikimori details
        let shikiId = stored?.shiki_id;
        let shikiAnime: ShikimoriAnime | null = null;

        if (!shikiId) {
          const norm = animelibService.constructor ? (animelibService as any).constructor.normalizeTitle(item.rus_name || item.name) : item.name;
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

        // Check if a new episode appeared
        const hasNewEpisode = latestEpisode > lastTracked;

        if (hasNewEpisode) {
          updatesCount++;
          const cardText = formatAnimeCard({
            title: item.name,
            rusTitle: item.rus_name || shikiAnime?.russian,
            currentEpisode: lastTracked,
            newEpisode: latestEpisode,
            score: shikiAnime?.score,
            genres: shikiAnime?.genres?.map((g) => g.russian || g.name),
            voiceovers: mediaEpisodes.voiceovers,
            description: shikiAnime?.description,
          });

          const kb = buildAnimeCardKeyboard({
            mediaId: item.media_id,
            slugUrl: item.slug_url,
            shikiId: shikiId || undefined,
            title: item.rus_name || item.name,
          });

          if (shikiAnime?.poster?.mainUrl) {
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

          // Update tracked episode in local DB
          dbService.updateTrackedEpisode(item.media_id, latestEpisode);
        }
      } catch (err) {
        console.error(`Error processing title "${item.name}":`, err);
      }
    }

    if (updatesCount === 0 && notifyIfEmpty) {
      await send(
        `✨ <b>Все серии просмотрены!</b>\nПроверено <b>${watchingList.length}</b> тайтлов из списка «Смотрю», новых серий пока нет.`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('🔄 Проверить снова', 'check_updates'),
        }
      );
    }
  } catch (err: any) {
    console.error('Check anime updates error:', err);
    await send(`❌ <b>Ошибка при проверке обновлений:</b>\n<code>${escapeHtml(err.message)}</code>`, {
      parse_mode: 'HTML',
    });
  }
}

// ==========================================
// Bot Handlers & Commands
// ==========================================

bot.command('start', async (ctx) => {
  const welcomeText = [
    '👋 <b>Привет! Я твой локальный Anime Tracker Bot.</b>',
    '',
    'Я слежу за выходом новых серий на <b>AnimeLib</b> в нужной озвучке и синхронизирую просмотренное с <b>Shikimori</b>.',
    '',
    '📌 <b>Быстрые действия:</b>',
    '• /check — проверить обновления серий',
    '• /watching — список того, что сейчас смотрю',
    '• /top — топ аниме по рейтингу Shikimori',
    '• /ongoings — текущие онгоинги сезона',
    '• /status — статус авторизации и БД',
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('🔄 Проверить обновления', 'check_updates')
    .row()
    .text('📺 Мой список «Смотрю»', 'list_watching')
    .text('🔥 Онгоинги', 'list_ongoings');

  await ctx.reply(welcomeText, { parse_mode: 'HTML', reply_markup: kb });
});

bot.command('check', async (ctx) => {
  await checkAnimeUpdates(ctx, true);
});

bot.callbackQuery('check_updates', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Ищу новые серии...' });
  await checkAnimeUpdates(ctx, true);
});

bot.command('watching', async (ctx) => {
  await ctx.reply('🔍 <i>Загружаю текущие тайтлы из списка «Смотрю»...</i>', { parse_mode: 'HTML' });
  const list = await animelibService.getAllWatching();

  if (!list || list.length === 0) {
    return ctx.reply('📭 Список «Смотрю» пуст или сессия истекла.');
  }

  const lines = list.slice(0, 15).map((item, idx) => {
    const progress = item.current_progress_number ? ` (серия ${item.current_progress_number})` : '';
    return `${idx + 1}. <b>${escapeHtml(item.rus_name || item.name)}</b>${progress}`;
  });

  const totalText = `📺 <b>Сейчас смотрите (${list.length} тайтлов):</b>\n\n${lines.join('\n')}${
    list.length > 15 ? `\n<i>...и еще ${list.length - 15}</i>` : ''
  }`;

  const kb = new InlineKeyboard().text('🔄 Проверить серии', 'check_updates');
  await ctx.reply(totalText, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery('list_watching', async (ctx) => {
  await ctx.answerCallbackQuery();
  const list = await animelibService.getAllWatching();

  if (!list || list.length === 0) {
    return ctx.reply('📭 Список «Смотрю» пуст.');
  }

  const lines = list.slice(0, 15).map((item, idx) => {
    const progress = item.current_progress_number ? ` (серия ${item.current_progress_number})` : '';
    return `${idx + 1}. <b>${escapeHtml(item.rus_name || item.name)}</b>${progress}`;
  });

  await ctx.reply(`📺 <b>Список «Смотрю» (${list.length}):</b>\n\n${lines.join('\n')}`, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('🔄 Проверить серии', 'check_updates'),
  });
});

bot.command('ongoings', async (ctx) => {
  await ctx.reply('🔥 <i>Запрашиваю онгоинги с Shikimori GraphQL...</i>', { parse_mode: 'HTML' });
  try {
    const ongoings = await shikimoriService.getOngoingAnime(8);
    for (const anime of ongoings) {
      const card = formatAnimeCard({
        title: anime.name,
        rusTitle: anime.russian,
        score: anime.score,
        genres: anime.genres?.map((g) => g.russian),
        status: anime.status,
      });
      const kb = new InlineKeyboard().url('📊 Shikimori', `https://shikimori.one/animes/${anime.id}`);
      await ctx.reply(card, { parse_mode: 'HTML', reply_markup: kb });
    }
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка получения онгоингов: ${err.message}`);
  }
});

bot.callbackQuery('list_ongoings', async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    const ongoings = await shikimoriService.getOngoingAnime(6);
    for (const anime of ongoings) {
      const card = formatAnimeCard({
        title: anime.name,
        rusTitle: anime.russian,
        score: anime.score,
        genres: anime.genres?.map((g) => g.russian),
      });
      const kb = new InlineKeyboard().url('📊 Shikimori', `https://shikimori.one/animes/${anime.id}`);
      await ctx.reply(card, { parse_mode: 'HTML', reply_markup: kb });
    }
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

bot.command('top', async (ctx) => {
  await ctx.reply('🏆 <i>Запрашиваю Топ Аниме с Shikimori...</i>', { parse_mode: 'HTML' });
  try {
    const top = await shikimoriService.getTopAnime(10);
    const lines = top.map((a, i) => `${i + 1}. <b>${escapeHtml(a.russian || a.name)}</b> — ⭐ ${a.score || '—'}`);
    await ctx.reply(`🏆 <b>Топ аниме по рейтингу Shikimori:</b>\n\n${lines.join('\n')}`, {
      parse_mode: 'HTML',
    });
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

// Action: Mark completed on Shikimori
bot.callbackQuery(/^mark_completed:(\d+):(\d+)$/, async (ctx) => {
  const mediaId = parseInt(ctx.match[1], 10);
  const shikiId = parseInt(ctx.match[2], 10);

  await ctx.answerCallbackQuery({ text: 'Синхронизирую с Shikimori...' });

  try {
    await shikimoriService.updateUserRate({
      target_id: shikiId,
      status: 'completed',
    });

    dbService.markShikiSynced(mediaId, shikiId);

    await ctx.reply(`🎉 <b>Успешно!</b> Тайтл перенесён в <b>«Просмотрено»</b> на Shikimori.`, {
      parse_mode: 'HTML',
    });
  } catch (err: any) {
    await ctx.reply(`❌ Не удалось обновить Shikimori: <code>${escapeHtml(err.message)}</code>`, {
      parse_mode: 'HTML',
    });
  }
});

// ==========================================
// Scheduler Setup (Periodic Check Interval)
// ==========================================
export function startScheduler(intervalMinutes: number = 30) {
  console.log(`⏱️ Scheduler initialized. Checking updates every ${intervalMinutes} minutes.`);
  const intervalMs = intervalMinutes * 60 * 1000;

  setInterval(async () => {
    console.log('[Scheduler] Running automated anime update check...');
    try {
      await checkAnimeUpdates(undefined, false);
    } catch (e) {
      console.error('[Scheduler Error]:', e);
    }
  }, intervalMs);
}

// ==========================================
// Bootstrap Function
// ==========================================
export async function startBot() {
  if (!BOT_TOKEN) {
    console.warn('⚠️ Telegram bot token is missing. Skipping bot.start(). Set TELEGRAM_BOT_TOKEN in .env to run.');
    return;
  }

  console.log('🤖 Starting Telegram bot via grammY long polling...');
  // Start periodic background updates checker
  startScheduler(30);

  bot.start({
    onStart: (botInfo) => {
      console.log(`✅ Telegram bot @${botInfo.username} successfully started!`);
    },
  });
}

// Standalone execution if launched directly via `pnpm bot` or `tsx src/bot/index.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  startBot();
}
