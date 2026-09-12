import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const dbPath = path.resolve(process.cwd(), 'local.db');
export const db = new DatabaseSync(dbPath);

// PRAGMA настройки
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Инициализация таблиц
db.exec('CREATE TABLE IF NOT EXISTS auth_tokens (' +
  'service TEXT PRIMARY KEY, ' +
  'access_token TEXT NOT NULL, ' +
  'refresh_token TEXT, ' +
  'user_id TEXT, ' +
  'expires_at INTEGER, ' +
  'updated_at INTEGER' +
');');

db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    service TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec('CREATE TABLE IF NOT EXISTS anime_match_cache (' +
  'normalized_title TEXT PRIMARY KEY, ' +
  'shiki_id INTEGER, ' +
  'shiki_title TEXT, ' +
  'score REAL, ' +
  'matched_at INTEGER' +
');');

db.exec('CREATE TABLE IF NOT EXISTS animelib_sync (' +
  'media_id INTEGER PRIMARY KEY, ' +
  'title TEXT NOT NULL, ' +
  'rus_title TEXT, ' +
  'status TEXT, ' +
  'last_tracked_episode INTEGER DEFAULT 0, ' +
  'preferred_voiceover TEXT, ' +
  'shiki_id INTEGER, ' +
  'shiki_synced INTEGER DEFAULT 0, ' +
  'custom_note TEXT, ' +
  'last_checked_at INTEGER' +
');');

try {
  db.exec('ALTER TABLE animelib_sync ADD COLUMN custom_note TEXT');
} catch {
}

db.exec('CREATE TABLE IF NOT EXISTS user_preferences (' +
  'user_id TEXT PRIMARY KEY, ' +
  'favorite_voiceovers TEXT DEFAULT "[]", ' +
  'notify_only_favorites INTEGER DEFAULT 0, ' +
  'preferred_quality TEXT DEFAULT "1080p", ' +
  'card_style TEXT DEFAULT "full", ' +
  'check_interval_min INTEGER DEFAULT 30, ' +
  'quiet_hours_enabled INTEGER DEFAULT 0, ' +
  'quiet_start_hour INTEGER DEFAULT 23, ' +
  'quiet_end_hour INTEGER DEFAULT 8' +
');');

db.exec('CREATE TABLE IF NOT EXISTS check_reports (' +
  'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
  'timestamp INTEGER NOT NULL, ' +
  'checked_count INTEGER NOT NULL, ' +
  'updates_count INTEGER NOT NULL, ' +
  'matched_count INTEGER NOT NULL, ' +
  'synced_count INTEGER NOT NULL, ' +
  'status TEXT NOT NULL, ' +
  'message TEXT, ' +
  'details_json TEXT' +
');');

export interface CheckReportRecord {
  id: number;
  timestamp: number;
  checked_count: number;
  updates_count: number;
  matched_count: number;
  synced_count: number;
  status: string;
  message?: string;
  details_json?: string;
}

export interface AnimeLibSyncRecord {
  media_id: number;
  title: string;
  rus_title?: string;
  status?: string;
  last_tracked_episode: number;
  preferred_voiceover?: string;
  shiki_id?: number;
  shiki_synced: number;
  custom_note?: string;
  last_checked_at?: number;
}

export interface UserPreferencesRecord {
  user_id: string;
  favorite_voiceovers: string;
  notify_only_favorites: number;
  preferred_quality: string;
  card_style: string;
  check_interval_min: number;
  quiet_hours_enabled: number;
  quiet_start_hour: number;
  quiet_end_hour: number;
}

export interface OAuthTokenRecord {
  service: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export function saveTokens(service: string, accessToken: string, refreshToken: string, expiresIn: number): void {
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  db.prepare(`
    INSERT INTO oauth_tokens (service, access_token, refresh_token, expires_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(service) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      updated_at = datetime('now')
  `).run(service, accessToken, refreshToken, expiresAt);
}

export function getTokens(service: string): OAuthTokenRecord | undefined {
  return db.prepare('SELECT * FROM oauth_tokens WHERE service = ?').get(service) as unknown as OAuthTokenRecord | undefined;
}

export const dbService = {
  transaction<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },

  saveAuthTokens(service: string, tokens: { access_token: string; refresh_token?: string; user_id?: string; expires_at?: number }) {
    const query = 'INSERT INTO auth_tokens (service, access_token, refresh_token, user_id, expires_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(service) DO UPDATE SET ' +
      'access_token = excluded.access_token, ' +
      'refresh_token = excluded.refresh_token, ' +
      'user_id = excluded.user_id, ' +
      'expires_at = excluded.expires_at, ' +
      'updated_at = excluded.updated_at';
    const stmt = db.prepare(query);
    stmt.run(service, tokens.access_token, tokens.refresh_token || null, tokens.user_id || null, tokens.expires_at || null, Date.now());
  },

  getAuthTokens(service: string) {
    const stmt = db.prepare('SELECT * FROM auth_tokens WHERE service = ?');
    return stmt.get(service) as any;
  },

  getCachedMatch(normalizedTitle: string) {
    const stmt = db.prepare('SELECT * FROM anime_match_cache WHERE normalized_title = ?');
    return stmt.get(normalizedTitle) as any;
  },

  setCachedMatch(data: { normalized_title: string; shiki_id: number; shiki_title: string; score?: number }) {
    const query = 'INSERT INTO anime_match_cache (normalized_title, shiki_id, shiki_title, score, matched_at) ' +
      'VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(normalized_title) DO UPDATE SET ' +
      'shiki_id = excluded.shiki_id, ' +
      'shiki_title = excluded.shiki_title, ' +
      'score = excluded.score, ' +
      'matched_at = excluded.matched_at';
    const stmt = db.prepare(query);
    stmt.run(data.normalized_title, data.shiki_id, data.shiki_title, data.score || null, Date.now());
  },

  getAllSyncItems(status?: string): AnimeLibSyncRecord[] {
    if (status) {
      const stmt = db.prepare('SELECT * FROM animelib_sync WHERE status = ?');
      return stmt.all(status) as unknown as AnimeLibSyncRecord[];
    }
    const stmt = db.prepare('SELECT * FROM animelib_sync');
    return stmt.all() as unknown as AnimeLibSyncRecord[];
  },

  getSyncItemByMediaId(mediaId: number): AnimeLibSyncRecord | undefined {
    const stmt = db.prepare('SELECT * FROM animelib_sync WHERE media_id = ?');
    return stmt.get(mediaId) as unknown as AnimeLibSyncRecord | undefined;
  },

  upsertSyncItem(item: Partial<AnimeLibSyncRecord> & { media_id: number; title: string }) {
    const query = 'INSERT INTO animelib_sync (media_id, title, rus_title, status, last_tracked_episode, preferred_voiceover, shiki_id, shiki_synced, custom_note, last_checked_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(media_id) DO UPDATE SET ' +
      'title = excluded.title, ' +
      'rus_title = excluded.rus_title, ' +
      'status = excluded.status, ' +
      'last_tracked_episode = MAX(COALESCE(animelib_sync.last_tracked_episode, 0), COALESCE(excluded.last_tracked_episode, 0)), ' +
      'preferred_voiceover = COALESCE(excluded.preferred_voiceover, animelib_sync.preferred_voiceover), ' +
      'shiki_id = COALESCE(excluded.shiki_id, animelib_sync.shiki_id), ' +
      'shiki_synced = COALESCE(excluded.shiki_synced, animelib_sync.shiki_synced), ' +
      'custom_note = COALESCE(excluded.custom_note, animelib_sync.custom_note), ' +
      'last_checked_at = excluded.last_checked_at';
    const stmt = db.prepare(query);
    stmt.run(
      item.media_id,
      item.title,
      item.rus_title || null,
      item.status || null,
      item.last_tracked_episode || 0,
      item.preferred_voiceover || null,
      item.shiki_id || null,
      item.shiki_synced || 0,
      item.custom_note || null,
      Date.now()
    );
  },

  batchUpsertSyncItems(items: Array<Partial<AnimeLibSyncRecord> & { media_id: number; title: string }>) {
    if (!items || items.length === 0) return;
    const query = 'INSERT INTO animelib_sync (media_id, title, rus_title, status, last_tracked_episode, preferred_voiceover, shiki_id, shiki_synced, custom_note, last_checked_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(media_id) DO UPDATE SET ' +
      'title = excluded.title, ' +
      'rus_title = excluded.rus_title, ' +
      'status = excluded.status, ' +
      'last_tracked_episode = MAX(COALESCE(animelib_sync.last_tracked_episode, 0), COALESCE(excluded.last_tracked_episode, 0)), ' +
      'preferred_voiceover = COALESCE(excluded.preferred_voiceover, animelib_sync.preferred_voiceover), ' +
      'shiki_id = COALESCE(excluded.shiki_id, animelib_sync.shiki_id), ' +
      'shiki_synced = COALESCE(excluded.shiki_synced, animelib_sync.shiki_synced), ' +
      'custom_note = COALESCE(excluded.custom_note, animelib_sync.custom_note), ' +
      'last_checked_at = excluded.last_checked_at';

    this.transaction(() => {
      const stmt = db.prepare(query);
      const now = Date.now();
      for (const item of items) {
        stmt.run(
          item.media_id,
          item.title,
          item.rus_title || null,
          item.status || null,
          item.last_tracked_episode || 0,
          item.preferred_voiceover || null,
          item.shiki_id || null,
          item.shiki_synced || 0,
          item.custom_note || null,
          now
        );
      }
    });
  },

  updateTrackedEpisode(mediaId: number, episode: number) {
    const stmt = db.prepare('UPDATE animelib_sync SET last_tracked_episode = MAX(COALESCE(last_tracked_episode, 0), ?), last_checked_at = ? WHERE media_id = ?');
    stmt.run(episode, Date.now(), mediaId);
  },

  updateLastChecked(mediaId: number) {
    const stmt = db.prepare('UPDATE animelib_sync SET last_checked_at = ? WHERE media_id = ?');
    stmt.run(Date.now(), mediaId);
  },

  markShikiSynced(mediaId: number, shikiId: number, status?: string) {
    if (status) {
      const stmt = db.prepare('UPDATE animelib_sync SET shiki_id = ?, shiki_synced = 1, status = ? WHERE media_id = ?');
      stmt.run(shikiId, status, mediaId);
    } else {
      const stmt = db.prepare('UPDATE animelib_sync SET shiki_id = ?, shiki_synced = 1 WHERE media_id = ?');
      stmt.run(shikiId, mediaId);
    }
  },

  getUserPreferences(userId: string): UserPreferencesRecord {
    const stmt = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?');
    let row = stmt.get(userId) as unknown as UserPreferencesRecord | undefined;
    if (!row) {
      const insert = db.prepare('INSERT INTO user_preferences (user_id) VALUES (?)');
      insert.run(userId);
      row = stmt.get(userId) as unknown as UserPreferencesRecord;
    }
    return row;
  },

  updateUserPreferences(userId: string, update: Partial<UserPreferencesRecord>) {
    this.getUserPreferences(userId);
    const keys = Object.keys(update);
    if (keys.length === 0) return;

    const setClauses = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => (update as any)[k]);
    const stmt = db.prepare(`UPDATE user_preferences SET ${setClauses} WHERE user_id = ?`);
    stmt.run(...values, userId);
  },

  toggleFavoriteVoiceover(userId: string, studio: string) {
    const prefs = this.getUserPreferences(userId);
    let list: string[] = [];
    try {
      list = JSON.parse(prefs.favorite_voiceovers || '[]');
    } catch {}

    const index = list.findIndex((s) => s.toLowerCase() === studio.toLowerCase());
    if (index >= 0) {
      list.splice(index, 1);
    } else {
      list.push(studio);
    }

    this.updateUserPreferences(userId, { favorite_voiceovers: JSON.stringify(list) });
  },

  saveCheckReport(report: {
    timestamp?: number;
    checked_count: number;
    updates_count: number;
    matched_count: number;
    synced_count: number;
    status: string;
    message?: string;
    details_json?: string;
  }) {
    const stmt = db.prepare(
      'INSERT INTO check_reports (timestamp, checked_count, updates_count, matched_count, synced_count, status, message, details_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    stmt.run(
      report.timestamp || Date.now(),
      report.checked_count,
      report.updates_count,
      report.matched_count,
      report.synced_count,
      report.status,
      report.message || '',
      report.details_json || '[]'
    );
  },

  getLatestCheckReport(): CheckReportRecord | null {
    try {
      const stmt = db.prepare('SELECT * FROM check_reports ORDER BY timestamp DESC LIMIT 1');
      const row = stmt.get() as unknown as CheckReportRecord | undefined;
      return row || null;
    } catch {
      return null;
    }
  },
};