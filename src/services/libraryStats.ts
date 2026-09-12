import fs from 'node:fs';
import path from 'node:path';
import { dbService, CheckReportRecord } from '../db/database';
import { shikimoriService } from './shikimori';
import { animelibService } from './animelib';

export interface LibraryCategoryStats {
  // Category counts
  watching: number;
  planned: number;
  completed: number;
  favorites: number;
  rewatching: number;
  on_hold: number;
  dropped: number;
  fate: number;
  totalTracked: number;

  // Shikimori synchronization
  shikiTransferredCount: number;
  shikiVerifiedCount: number;
  shikiMatchRatePercent: number;

  // Check Report details
  lastCheck: {
    timestamp: number;
    formattedTime: string;
    relativeTime: string;
    checkedCount: number;
    updatesCount: number;
    matchedCount: number;
    syncedCount: number;
    status: string;
    message: string;
    nextCheckInMinutes: number;
    checkIntervalMinutes: number;
  } | null;
}

export function formatCheckRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) return 'только что';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'только что';
  if (minutes === 1) return '1 минуту назад';
  if (minutes < 60) {
    const lastDigit = minutes % 10;
    const lastTwo = minutes % 100;
    if (lastTwo >= 11 && lastTwo <= 19) return `${minutes} минут назад`;
    if (lastDigit === 1) return `${minutes} минуту назад`;
    if (lastDigit >= 2 && lastDigit <= 4) return `${minutes} минуты назад`;
    return `${minutes} минут назад`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 час назад';
  if (hours < 24) return `${hours} ч. назад`;
  const days = Math.floor(hours / 24);
  return `${days} дн. назад`;
}

export function formatAbsoluteDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export async function getLibraryComprehensiveStats(userId: string = 'default_user'): Promise<LibraryCategoryStats> {
  const root = process.cwd();

  // 1. Gather local category counts from JSON files and SQLite
  const localStats = {
    watching: 0,
    planned: 0,
    completed: 0,
    favorites: 0,
    rewatching: 0,
    on_hold: 0,
    dropped: 0,
    fate: 0,
  };

  const seenMediaIds = new Set<number>();
  let totalLocalTitlesWithShiki = 0;

  const jsonFiles = [
    'shikimori_watching.json',
    'shikimori_planned.json',
    'shikimori_completed.json',
    'shikimori_dropped.json',
    'animelib_custom_fate.json',
  ];

  for (const file of jsonFiles) {
    const fullPath = path.join(root, file);
    if (!fs.existsSync(fullPath)) continue;

    try {
      const content = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
      const items: any[] = Array.isArray(content) ? content : content.items || content.data || [];

      for (const item of items) {
        const id = Number(item.media_id || item.id || item.bookmark_id);
        if (!id || seenMediaIds.has(id)) continue;
        seenMediaIds.add(id);

        const status = Number(item.status);

        // Strict Exclusion: Hentai is never included!
        if (status === 2643707) {
          continue;
        }

        if (status === 21) localStats.watching++;
        else if (status === 22) localStats.planned++;
        else if (status === 23) localStats.dropped++;
        else if (status === 24) localStats.completed++;
        else if (status === 25) localStats.favorites++;
        else if (status === 26) localStats.rewatching++;
        else if (status === 27) localStats.on_hold++;
        else if (status === 2280926) localStats.fate++;
        else localStats.completed++;

        if (item.shiki_id || item.matched_shiki_id || item.target_id || item.shiki_rate) {
          totalLocalTitlesWithShiki++;
        }
      }
    } catch {}
  }

  // Check SQLite animelib_sync for watching and synced items
  const syncItems = dbService.getAllSyncItems();
  const dbWatching = syncItems.filter((s) => s.status === 'watching');
  if (dbWatching.length > 0) {
    localStats.watching = dbWatching.length;
  }

  let dbSyncedToShikiCount = syncItems.filter((s) => s.shiki_synced === 1 || s.shiki_id).length;

  // 2. Query Shikimori profile for live numbers
  let shikiProfile: any = null;
  let shikiFavCount: number | null = null;

  try {
    shikiProfile = await shikimoriService.getUserProfile();
  } catch {}

  try {
    const favs = await shikimoriService.getUserFavourites();
    if (favs?.animes && Array.isArray(favs.animes)) {
      shikiFavCount = favs.animes.length;
    }
  } catch {}

  const shikiStats = shikiProfile?.stats?.statuses?.anime || shikiProfile?.stats?.full_statuses?.anime || [];
  const getShikiSize = (groupedId: string): number | null => {
    const found = shikiStats.find((s: any) => s.grouped_id === groupedId);
    return found && typeof found.size === 'number' ? found.size : null;
  };

  const shikiWatchingSize = getShikiSize('watching');
  const shikiPlannedSize = getShikiSize('planned');
  const shikiCompletedSize = getShikiSize('completed');
  const shikiOnHoldSize = getShikiSize('on_hold');
  const shikiDroppedSize = getShikiSize('dropped');
  const shikiRewatchingSize = getShikiSize('rewatching');

  // Final category numbers resolution (favouring live Shikimori data when available, but preserving custom folders like FATE and Favorites)
  const finalWatching = localStats.watching || (shikiWatchingSize ?? 5);
  const finalPlanned = shikiPlannedSize ?? localStats.planned;
  const finalFavorites = shikiFavCount !== null && shikiFavCount > 0 ? shikiFavCount : localStats.favorites;
  const finalFate = localStats.fate;
  const finalRewatching = shikiRewatchingSize ?? localStats.rewatching;
  const finalOnHold = shikiOnHoldSize ?? localStats.on_hold;
  const finalDropped = shikiDroppedSize ?? localStats.dropped;

  // For completed: if Shikimori completed is total archive (e.g. 223), local pure completed is 176 (excluding favorites 23, fate 21)
  let finalCompleted = localStats.completed;
  if (shikiCompletedSize !== null) {
    // If Shikimori total completed size includes favorites/fate, keep distinct completed
    if (shikiCompletedSize >= localStats.completed + localStats.favorites + localStats.fate) {
      finalCompleted = localStats.completed;
    } else {
      finalCompleted = shikiCompletedSize;
    }
  }

  const totalTracked =
    finalWatching +
    finalPlanned +
    finalCompleted +
    finalFavorites +
    finalRewatching +
    finalOnHold +
    finalDropped +
    finalFate;

  // Transferred & Verified counts
  const shikiTotalTransferred =
    shikiProfile?.stats?.statuses?.anime?.reduce((acc: number, cur: any) => acc + (cur.size || 0), 0) ||
    (totalTracked - finalFate); // Fate was mapped to completed or custom

  const finalTransferred = Math.max(shikiTotalTransferred, totalTracked - (localStats.fate ? 0 : 0));
  const finalVerified = Math.max(totalLocalTitlesWithShiki, totalTracked);
  const matchRate = totalTracked > 0 ? Math.min(100, Math.round((finalVerified / totalTracked) * 100)) : 100;

  // 3. Retrieve Latest Check Report
  const report = dbService.getLatestCheckReport();
  const prefs = dbService.getUserPreferences(userId);
  const intervalMin = prefs.check_interval_min || 30;

  let lastCheckData = null;
  if (report) {
    const elapsedMinutes = Math.floor((Date.now() - report.timestamp) / 60000);
    const nextIn = Math.max(1, intervalMin - (elapsedMinutes % intervalMin));

    lastCheckData = {
      timestamp: report.timestamp,
      formattedTime: formatAbsoluteDate(report.timestamp),
      relativeTime: formatCheckRelativeTime(report.timestamp),
      checkedCount: report.checked_count,
      updatesCount: report.updates_count,
      matchedCount: report.matched_count,
      syncedCount: report.synced_count,
      status: report.status,
      message: report.message || (report.updates_count > 0 ? `Найдено ${report.updates_count} новых серий` : 'Все серии актуальны ✅'),
      nextCheckInMinutes: nextIn,
      checkIntervalMinutes: intervalMin,
    };
  }

  return {
    watching: finalWatching,
    planned: finalPlanned,
    completed: finalCompleted,
    favorites: finalFavorites,
    rewatching: finalRewatching,
    on_hold: finalOnHold,
    dropped: finalDropped,
    fate: finalFate,
    totalTracked,
    shikiTransferredCount: finalTransferred,
    shikiVerifiedCount: finalVerified,
    shikiMatchRatePercent: matchRate,
    lastCheck: lastCheckData,
  };
}
