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

  // 1. Gather SQL category counts from SQLite sync_items / animelib_sync
  let sqlStats = dbService.getLibraryStats();

  // If SQLite is completely empty, seed it from local JSON files
  if (sqlStats.total === 0) {
    animelibService.seedFromLocalJsonFiles();
    sqlStats = dbService.getLibraryStats();
  }

  const localStats = {
    watching: sqlStats.watching,
    planned: sqlStats.planned,
    completed: sqlStats.completed,
    favorites: sqlStats.favorites,
    rewatching: sqlStats.rewatching,
    on_hold: sqlStats.on_hold,
    dropped: sqlStats.dropped,
    fate: 0,
  };

  // Fallback for custom Fate list if exists
  const fatePath = path.join(root, 'animelib_custom_fate.json');
  if (fs.existsSync(fatePath)) {
    try {
      const content = JSON.parse(fs.readFileSync(fatePath, 'utf-8'));
      const items = Array.isArray(content) ? content : (content.items || content.data || []);
      localStats.fate = items.length;
    } catch {}
  }

  // 2. Query Shikimori profile for live numbers
  let shikiProfile: any = null;
  let shikiFavCount: number | null = null;
  const isShikiConnected = shikimoriService.isAuthorized();

  if (isShikiConnected) {
    try {
      shikiProfile = await shikimoriService.getUserProfile();
    } catch {}

    try {
      const favs = await shikimoriService.getUserFavourites();
      if (favs?.animes && Array.isArray(favs.animes)) {
        shikiFavCount = favs.animes.length;
      }
    } catch {}
  }

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

  // Category numbers resolution
  const finalWatching = localStats.watching || (shikiWatchingSize ?? 5);
  const finalPlanned = localStats.planned || (shikiPlannedSize ?? 0);
  const finalFavorites = shikiFavCount !== null && shikiFavCount > 0 ? shikiFavCount : localStats.favorites;
  const finalFate = localStats.fate;
  const finalRewatching = localStats.rewatching || (shikiRewatchingSize ?? 0);
  const finalOnHold = localStats.on_hold || (shikiOnHoldSize ?? 0);
  const finalDropped = localStats.dropped || (shikiDroppedSize ?? 0);
  const finalCompleted = localStats.completed || (shikiCompletedSize ?? 0);

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
  let finalTransferred = 0;
  let finalVerified = 0;
  let matchRate = 0;

  if (isShikiConnected && shikiProfile) {
    const shikiTotalTransferred =
      shikiProfile?.stats?.statuses?.anime?.reduce((acc: number, cur: any) => acc + (cur.size || 0), 0) || 0;
    finalTransferred = shikiTotalTransferred;
    finalVerified = Math.max(sqlStats.shiki_synced, shikiTotalTransferred);
    matchRate = totalTracked > 0 ? Math.min(100, Math.round((finalTransferred / totalTracked) * 100)) : 0;
  } else {
    // If Shikimori is not connected, reflect accurately: 0 transferred / not synced
    finalTransferred = 0;
    finalVerified = sqlStats.shiki_synced;
    matchRate = 0;
  }

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
