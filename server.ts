import express from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import { dbService } from './src/db/database';
import { animelibService } from './src/services/animelib';

interface ShikiMatch {
  id: number;
  name: string;
  score: number;
}

interface Item {
  bookmark_id: number;
  media_id: number;
  status: number;
  progress: string | null;
  created_at: string;
  updated_at: string;
  name: string;
  rus_name: string;
  eng_name?: string;
  slug_url: string;
  anilist_id?: number | null;
  source_label?: string;
  source_status_code?: number;
  extra_flag?: string | null;
  is_custom_list?: boolean;
  list_name?: string;
  matched_shiki_id?: number | null;
  matched_shiki_name?: string | null;
  match_score?: number | null;
  is_migrated?: boolean;
}

interface Ambiguity {
  id: string;
  original_title: string;
  score: number;
  candidates: Array<{ id: number; name: string }>;
  resolved_id?: number | null;
  resolved_name?: string | null;
}

// In-memory database state
let titlesList: Item[] = [];
let matchCache: Record<string, ShikiMatch> = {};
let migrationProgress: Record<string, boolean> = {};
let ambiguities: Ambiguity[] = [];
let shikimoriToken: any = null;

const STATUS_MAP_NUMERIC: Record<number, { slug: string; label: string; shikimori_status: string; extra_flag: string | null }> = {
  21: { slug: 'watching', label: 'Смотрю', shikimori_status: 'watching', extra_flag: null },
  22: { slug: 'planned', label: 'Запланировано', shikimori_status: 'planned', extra_flag: null },
  23: { slug: 'dropped', label: 'Брошено', shikimori_status: 'dropped', extra_flag: null },
  24: { slug: 'completed', label: 'Просмотрено', shikimori_status: 'completed', extra_flag: null },
  25: { slug: 'favorites', label: 'Любимое', shikimori_status: 'completed', extra_flag: 'favorite' },
  26: { slug: 'rewatching', label: 'Пересматриваю', shikimori_status: 'rewatching', extra_flag: null },
  27: { slug: 'on_hold', label: 'Отложено', shikimori_status: 'on_hold', extra_flag: null },
  2280926: { slug: 'fate', label: 'FATE (пользовательский список)', shikimori_status: 'completed', extra_flag: 'fate' },
  2643707: { slug: 'hentai', label: 'hent (пользовательский список)', shikimori_status: 'completed', extra_flag: 'hentai' },
};

function normalizeTitle(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[«»"'`]/g, '')
    .replace(/[^a-zа-я0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadInitialData() {
  const root = process.cwd();

  // Load match cache
  const cachePath = path.join(root, '.shiki_match_cache.json');
  if (fs.existsSync(cachePath)) {
    try {
      matchCache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    } catch (e) {
      console.warn('Failed to parse .shiki_match_cache.json', e);
    }
  }

  // Load migration progress
  const progressPath = path.join(root, '.migration_progress.json');
  if (fs.existsSync(progressPath)) {
    try {
      migrationProgress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
    } catch (e) {
      console.warn('Failed to parse .migration_progress.json', e);
    }
  }

  // Load shikimori token
  const tokenPath = path.join(root, '.shikimori_token.json');
  if (fs.existsSync(tokenPath)) {
    try {
      shikimoriToken = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    } catch (e) {
      console.warn('Failed to parse .shikimori_token.json', e);
    }
  }

  // Load titles from categories
  const fileSources = [
    { file: 'shikimori_watching.json', listName: 'watching', isCustom: false },
    { file: 'shikimori_completed.json', listName: 'completed', isCustom: false },
    { file: 'shikimori_planned.json', listName: 'planned', isCustom: false },
    { file: 'shikimori_dropped.json', listName: 'dropped', isCustom: false },
    { file: 'animelib_custom_fate.json', listName: 'fate', isCustom: true },
    { file: 'animelib_custom_hentai.json', listName: 'hentai', isCustom: true },
  ];

  const seenMediaIds = new Set<number>();
  titlesList = [];

  for (const src of fileSources) {
    const fullPath = path.join(root, src.file);
    if (!fs.existsSync(fullPath)) continue;

    try {
      const content = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
      const items: any[] = content.items || [];

      for (const item of items) {
        if (seenMediaIds.has(item.media_id)) continue;
        seenMediaIds.add(item.media_id);

        const normRus = normalizeTitle(item.rus_name);
        const normName = normalizeTitle(item.name);
        const normEng = normalizeTitle(item.eng_name || '');

        let match = matchCache[normRus] || matchCache[normName] || matchCache[normEng];

        if (!match) {
          // Check partial or fuzzy key
          for (const key of Object.keys(matchCache)) {
            if (normRus && (key.includes(normRus) || normRus.includes(key))) {
              match = matchCache[key];
              break;
            }
          }
        }

        const isMigrated = match ? !!migrationProgress[String(match.id)] : false;

        titlesList.push({
          bookmark_id: item.bookmark_id,
          media_id: item.media_id,
          status: item.status,
          progress: item.progress || null,
          created_at: item.created_at,
          updated_at: item.updated_at,
          name: item.name,
          rus_name: item.rus_name,
          eng_name: item.eng_name || '',
          slug_url: item.slug_url,
          anilist_id: item.anilist_id || null,
          source_label: item.source_label || STATUS_MAP_NUMERIC[item.status]?.label || 'Неизвестно',
          source_status_code: item.source_status_code || item.status,
          extra_flag: item.extra_flag || STATUS_MAP_NUMERIC[item.status]?.extra_flag || null,
          is_custom_list: src.isCustom,
          list_name: src.listName,
          matched_shiki_id: match?.id || null,
          matched_shiki_name: match?.name || null,
          match_score: match?.score || null,
          is_migrated: isMigrated,
        });
      }
    } catch (err) {
      console.warn(`Error reading ${src.file}`, err);
    }
  }

  // Load ambiguities from errors.txt
  const errorsPath = path.join(root, 'errors.txt');
  ambiguities = [];
  if (fs.existsSync(errorsPath)) {
    const lines = fs.readFileSync(errorsPath, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const titleMatch = line.match(/«([^»]+)»/);
      const scoreMatch = line.match(/score=([0-9.]+)/);
      const candidatesPart = line.split(/score=[0-9.]+\):\s*/)[1] || '';

      const candidates: Array<{ id: number; name: string }> = [];
      const candMatches = candidatesPart.matchAll(/([^,()]+)\s*\(id=(\d+)\)/g);
      for (const m of candMatches) {
        candidates.push({
          name: m[1].trim(),
          id: parseInt(m[2], 10),
        });
      }

      if (titleMatch) {
        const origTitle = titleMatch[1].trim();
        const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0.8;
        const norm = normalizeTitle(origTitle);
        const resolved = matchCache[norm];

        ambiguities.push({
          id: `amb-${i + 1}`,
          original_title: origTitle,
          score,
          candidates,
          resolved_id: resolved?.id || null,
          resolved_name: resolved?.name || null,
        });
      }
    }
  }
}

async function startServer() {
  loadInitialData();

  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json({ limit: '20mb' }));

  // API Routes
  app.get('/api/stats', (req, res) => {
    const total = titlesList.length;
    const migrated = titlesList.filter((t) => t.is_migrated).length;
    const pending = total - migrated;

    const byStatus = {
      watching: titlesList.filter((t) => t.list_name === 'watching').length,
      planned: titlesList.filter((t) => t.list_name === 'planned').length,
      completed: titlesList.filter((t) => t.list_name === 'completed').length,
      dropped: titlesList.filter((t) => t.list_name === 'dropped').length,
      fate: titlesList.filter((t) => t.list_name === 'fate').length,
      hentai: titlesList.filter((t) => t.list_name === 'hentai').length,
      rewatching: titlesList.filter((t) => t.status === 26).length,
      on_hold: titlesList.filter((t) => t.status === 27).length,
    };

    res.json({
      total,
      migrated,
      pending,
      ambiguous: ambiguities.length,
      byStatus,
      tokenStatus: {
        hasToken: !!shikimoriToken,
        expiresIn: shikimoriToken?.expires_in,
        tokenType: shikimoriToken?.token_type || 'Bearer',
        scope: shikimoriToken?.scope || 'user_rates',
      },
      config: {
        userAgent: process.env.SHIKIMORI_USER_AGENT || 'ANIME ASSISTANT v2.0 (contact: boykonik2@gmail.com)',
        minInterval: 0.8,
        shikimoriBase: 'https://shikimori.io',
        hasCredentials: !!process.env.SHIKIMORI_CLIENT_ID,
        telegramConfigured: !!process.env.TELEGRAM_BOT_TOKEN,
      },
      statusRules: Object.entries(STATUS_MAP_NUMERIC).map(([code, val]) => ({
        code: parseInt(code, 10),
        ...val,
      })),
    });
  });

  app.get('/api/titles', (req, res) => {
    const { status, search, migrated, page = '1', limit = '24' } = req.query as Record<string, string>;

    let filtered = titlesList;

    if (status && status !== 'all') {
      if (status === 'fate' || status === 'hentai') {
        filtered = filtered.filter((t) => t.list_name === status);
      } else {
        filtered = filtered.filter((t) => t.list_name === status || STATUS_MAP_NUMERIC[t.status]?.slug === status);
      }
    }

    if (migrated === 'yes') {
      filtered = filtered.filter((t) => t.is_migrated);
    } else if (migrated === 'no') {
      filtered = filtered.filter((t) => !t.is_migrated);
    }

    if (search && search.trim()) {
      const query = normalizeTitle(search);
      filtered = filtered.filter(
        (t) =>
          normalizeTitle(t.rus_name).includes(query) ||
          normalizeTitle(t.name).includes(query) ||
          normalizeTitle(t.eng_name || '').includes(query) ||
          normalizeTitle(t.matched_shiki_name || '').includes(query) ||
          String(t.media_id).includes(query) ||
          String(t.matched_shiki_id || '').includes(query)
      );
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const pageSize = Math.max(1, Math.min(100, parseInt(limit, 10)));
    const totalCount = filtered.length;
    const startIndex = (pageNum - 1) * pageSize;
    const paginatedItems = filtered.slice(startIndex, startIndex + pageSize);

    res.json({
      items: paginatedItems,
      totalCount,
      page: pageNum,
      pageSize,
      totalPages: Math.ceil(totalCount / pageSize),
    });
  });

  app.get('/api/titles/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const item = titlesList.find((t) => t.media_id === id || t.bookmark_id === id);
    if (!item) {
      return res.status(404).json({ error: 'Title not found' });
    }
    res.json(item);
  });

  app.get('/api/ambiguities', (req, res) => {
    res.json(ambiguities);
  });

  app.post('/api/ambiguities/:id/resolve', (req, res) => {
    const { id } = req.params;
    const { shiki_id, name } = req.body;

    const amb = ambiguities.find((a) => a.id === id);
    if (!amb) {
      return res.status(404).json({ error: 'Ambiguity entry not found' });
    }

    amb.resolved_id = shiki_id;
    amb.resolved_name = name;

    const norm = normalizeTitle(amb.original_title);
    matchCache[norm] = {
      id: shiki_id,
      name: name,
      score: 1.0,
    };

    // Update affected title items in titlesList
    for (const title of titlesList) {
      const rus = normalizeTitle(title.rus_name);
      const rom = normalizeTitle(title.name);
      if (rus.includes(norm) || norm.includes(rus) || rom.includes(norm)) {
        title.matched_shiki_id = shiki_id;
        title.matched_shiki_name = name;
        title.match_score = 1.0;
        title.is_migrated = !!migrationProgress[String(shiki_id)];
      }
    }

    res.json({ success: true, ambiguity: amb });
  });

  app.post('/api/simulate-migration', (req, res) => {
    const { targetStatus = 'all' } = req.body;

    let targetTitles = titlesList;
    if (targetStatus !== 'all') {
      targetTitles = targetTitles.filter((t) => t.list_name === targetStatus);
    }

    const results = targetTitles.map((t) => {
      const shikiStatus = STATUS_MAP_NUMERIC[t.status]?.shikimori_status || 'completed';
      const hasMatch = !!t.matched_shiki_id;
      const isAlreadyMigrated = !!t.is_migrated;

      return {
        media_id: t.media_id,
        rus_name: t.rus_name,
        target_shiki_id: t.matched_shiki_id,
        target_status: shikiStatus,
        extra_flag: t.extra_flag,
        status: isAlreadyMigrated ? 'already_synced' : hasMatch ? 'ready_to_sync' : 'needs_match',
        score: t.match_score || 0,
      };
    });

    const readyCount = results.filter((r) => r.status === 'ready_to_sync').length;
    const syncedCount = results.filter((r) => r.status === 'already_synced').length;
    const missingCount = results.filter((r) => r.status === 'needs_match').length;

    res.json({
      total: results.length,
      readyCount,
      syncedCount,
      missingCount,
      estimatedTimeSeconds: Math.round(readyCount * 0.8),
      results: results.slice(0, 50),
    });
  });

  app.post('/api/execute-migration', (req, res) => {
    const { mediaIds } = req.body;

    let updatedCount = 0;
    const idsToUpdate = Array.isArray(mediaIds) ? mediaIds : titlesList.map((t) => t.media_id);

    for (const title of titlesList) {
      if (idsToUpdate.includes(title.media_id) && title.matched_shiki_id) {
        if (!title.is_migrated) {
          title.is_migrated = true;
          migrationProgress[String(title.matched_shiki_id)] = true;
          updatedCount++;
        }
      }
    }

    res.json({
      success: true,
      updatedCount,
      totalMigrated: titlesList.filter((t) => t.is_migrated).length,
    });
  });

  app.post('/api/inspect-file', (req, res) => {
    try {
      const { content } = req.body;
      let parsed: any;
      if (typeof content === 'string') {
        parsed = JSON.parse(content);
      } else {
        parsed = content;
      }

      // Check if HAR format
      let entries: any[] = [];
      let isHar = false;
      if (parsed?.log?.entries) {
        isHar = true;
        for (const entry of parsed.log.entries) {
          if (entry.request?.url?.includes('/api/bookmarks')) {
            const respText = entry.response?.content?.text;
            if (respText) {
              try {
                const bData = JSON.parse(respText);
                if (Array.isArray(bData.data)) entries.push(...bData.data);
              } catch (_) {}
            }
          }
        }
      } else if (Array.isArray(parsed?.data)) {
        entries = parsed.data;
      } else if (Array.isArray(parsed?.items)) {
        entries = parsed.items;
      } else if (Array.isArray(parsed)) {
        entries = parsed;
      }

      const statusCounts: Record<string, number> = {};
      const unknownStatuses: number[] = [];

      for (const e of entries) {
        const st = e.status ?? e.user_status ?? e.list_status;
        const key = String(st);
        statusCounts[key] = (statusCounts[key] || 0) + 1;

        if (typeof st === 'number' && !STATUS_MAP_NUMERIC[st]) {
          if (!unknownStatuses.includes(st)) unknownStatuses.push(st);
        }
      }

      res.json({
        success: true,
        isHar,
        totalItems: entries.length,
        statusCounts,
        unknownStatuses,
        sampleTitles: entries.slice(0, 5).map((e) => e.media?.name || e.name || e.rus_name || 'Неизвестно'),
      });
    } catch (err: any) {
      res.status(400).json({ error: 'Failed to parse JSON file: ' + err.message });
    }
  });

  // --- SYNC & BOT BRIDGE ENDPOINTS ---
  app.get('/api/bot/status', (req, res) => {
    const prefs = dbService.getUserPreferences(process.env.TELEGRAM_DEFAULT_CHAT_ID || 'default_user');
    res.json({
      configured: {
        telegramBotToken: !!process.env.TELEGRAM_BOT_TOKEN,
        telegramChatId: !!(process.env.TELEGRAM_DEFAULT_CHAT_ID || process.env.TELEGRAM_CHAT_ID),
        animelibCookie: !!process.env.ANIMELIB_COOKIE,
        animelibUserId: !!process.env.ANIMELIB_USER_ID,
        shikimoriToken: !!process.env.SHIKIMORI_ACCESS_TOKEN || fs.existsSync(path.join(process.cwd(), '.shikimori_token.json')),
      },
      preferences: {
        check_interval_min: prefs.check_interval_min,
        notify_only_favorites: !!prefs.notify_only_favorites,
        favorite_voiceovers: JSON.parse(prefs.favorite_voiceovers || '[]'),
        preferred_quality: prefs.preferred_quality,
        card_style: prefs.card_style,
        quiet_hours_enabled: !!prefs.quiet_hours_enabled,
        quiet_start_hour: prefs.quiet_start_hour,
        quiet_end_hour: prefs.quiet_end_hour,
      },
      serverTime: new Date().toISOString(),
    });
  });

  app.get('/api/sync/diagnostics', async (req, res) => {
    try {
      const dbItems = dbService.getAllSyncItems();

      let exportItems: any[] = [];
      const exportPath = path.join(process.cwd(), 'animelib_export.json');
      if (fs.existsSync(exportPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(exportPath, 'utf-8'));
          exportItems = Array.isArray(raw.data) ? raw.data : (Array.isArray(raw) ? raw : []);
        } catch (_) {}
      }

      const diagnostics = dbItems.map((dbRecord) => {
        const exportMatch = exportItems.find((e) => (e.media_id || e.media?.id) === dbRecord.media_id);
        const media = exportMatch?.media || exportMatch?.anime || {};

        const rawProgress = exportMatch?.meta?.item_number ?? exportMatch?.item?.number ?? exportMatch?.current_progress_number ?? 0;
        const progressNum = parseFloat(String(rawProgress)) || dbRecord.last_tracked_episode || 0;

        const lastItemMeta = media.metadata?.last_item;
        const rawLatest = lastItemMeta?.number ?? media.items_count?.uploaded ?? media.last_item_number ?? 0;
        const latestNum = parseFloat(String(rawLatest)) || 0;

        const voiceovers: string[] = [];
        if (Array.isArray(lastItemMeta?.players)) {
          for (const pl of lastItemMeta.players) {
            if (pl.team?.name && !voiceovers.includes(pl.team.name)) {
              voiceovers.push(pl.team.name);
            }
          }
        }

        const hasNewEpisode = latestNum > (dbRecord.last_tracked_episode || 0);

        let diagnosis = 'Все серии просмотрены';
        if (latestNum === 0 && (dbRecord.last_tracked_episode || 0) === 0) {
          diagnosis = 'Нет данных о релизах';
        } else if (hasNewEpisode) {
          diagnosis = `⚡ Новая серия #${latestNum} доступна! (В БД отслежено: #${dbRecord.last_tracked_episode || 0})`;
        } else if (latestNum > 0 && latestNum === dbRecord.last_tracked_episode) {
          diagnosis = `✅ Актуально (серия #${latestNum} отслежена)`;
        }

        return {
          media_id: dbRecord.media_id,
          title: dbRecord.title,
          rus_title: dbRecord.rus_title,
          status: dbRecord.status,
          db_tracked_episode: dbRecord.last_tracked_episode || 0,
          export_progress: progressNum,
          site_latest_episode: latestNum,
          has_new_episode: hasNewEpisode,
          voiceovers,
          diagnosis,
          last_checked_at: dbRecord.last_checked_at ? new Date(dbRecord.last_checked_at).toISOString() : null,
        };
      });

      res.json({
        success: true,
        totalInDb: dbItems.length,
        totalInExport: exportItems.length,
        diagnostics,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/sync/check', async (req, res) => {
    try {
      const logs: string[] = [];
      logs.push(`[${new Date().toLocaleTimeString()}] Начинаю проверку обновлений AnimeLib...`);

      let watchingList: any[] = [];
      if (process.env.ANIMELIB_COOKIE) {
        logs.push('[AnimeLib] Запрос к API hapi.hentaicdn.org...');
        watchingList = await animelibService.getAllWatching();
        logs.push(`[AnimeLib] Получено ${watchingList.length} тайтлов из списка «Смотрю»`);
      } else {
        logs.push('[AnimeLib] ANIMELIB_COOKIE не задан в .env, загружаю список из локального animelib_export.json...');
        const exportPath = path.join(process.cwd(), 'animelib_export.json');
        if (fs.existsSync(exportPath)) {
          const raw = JSON.parse(fs.readFileSync(exportPath, 'utf-8'));
          const rawItems = Array.isArray(raw.data) ? raw.data : (Array.isArray(raw) ? raw : []);

          for (const item of rawItems) {
            const media = item.media || item.anime || item;
            const mediaId = media.id || item.media_id;
            if (!mediaId) continue;

            const rawProg = item.meta?.item_number ?? item.item?.number ?? item.current_progress_number ?? 0;
            const progNum = parseFloat(String(rawProg)) || 0;

            const lastItem = media.metadata?.last_item;
            const rawLat = lastItem?.number ?? media.items_count?.uploaded ?? 0;
            const latNum = parseFloat(String(rawLat)) || 0;

            const studios: string[] = [];
            if (Array.isArray(lastItem?.players)) {
              for (const pl of lastItem.players) {
                if (pl.team?.name && !studios.includes(pl.team.name)) studios.push(pl.team.name);
              }
            }

            watchingList.push({
              media_id: mediaId,
              slug_url: media.slug_url || String(mediaId),
              name: media.name || '',
              rus_name: media.rus_name || '',
              current_progress_number: progNum,
              last_item_number: latNum,
              voiceovers: studios,
            });

            dbService.upsertSyncItem({
              media_id: mediaId,
              title: media.name || '',
              rus_title: media.rus_name || '',
              status: 'watching',
              last_tracked_episode: progNum,
            });
          }
          logs.push(`[Local] Загружено ${watchingList.length} тайтлов из экспорта в базу SQLite`);
        }
      }

      const updates: any[] = [];
      for (const item of watchingList) {
        const stored = dbService.getSyncItemByMediaId(item.media_id);
        const lastTracked = stored?.last_tracked_episode ?? item.current_progress_number ?? 0;
        const latestEp = item.last_item_number || 0;
        const isNew = latestEp > lastTracked;

        logs.push(`🔍 "${item.rus_name || item.name}": отслеживается ${lastTracked} сер., вышло ${latestEp} сер. -> ${isNew ? '🔥 НОВАЯ СЕРИЯ!' : 'актуально'}`);

        if (isNew) {
          updates.push({
            media_id: item.media_id,
            title: item.name,
            rus_title: item.rus_name,
            old_episode: lastTracked,
            new_episode: latestEp,
            voiceovers: item.voiceovers || [],
          });
          dbService.updateTrackedEpisode(item.media_id, latestEp);
          logs.push(`💾 Сохранено в SQLite: для "${item.rus_name || item.name}" установлена отслеживаемая серия #${latestEp}`);
        }
      }

      logs.push(`[${new Date().toLocaleTimeString()}] Проверка завершена! Найдено обновлений: ${updates.length}`);

      res.json({
        success: true,
        updatesCount: updates.length,
        updates,
        logs,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/bot/preferences', (req, res) => {
    try {
      const userId = process.env.TELEGRAM_DEFAULT_CHAT_ID || 'default_user';
      const updates = { ...req.body };
      if (Array.isArray(updates.favorite_voiceovers)) {
        updates.favorite_voiceovers = JSON.stringify(updates.favorite_voiceovers);
      }
      dbService.updateUserPreferences(userId, updates);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/sync/update-episode', (req, res) => {
    try {
      const { mediaId, episode } = req.body;
      if (!mediaId || episode === undefined) {
        return res.status(400).json({ success: false, error: 'mediaId and episode are required' });
      }
      dbService.updateTrackedEpisode(Number(mediaId), Number(episode));
      res.json({ success: true, mediaId, episode: Number(episode) });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Vite middleware in dev or static files in prod
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Anime Assistant Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
