import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Database file location
const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), 'local.db');

export interface AuthTokenRecord {
  id?: number;
  service: string;
  access_token: string;
  refresh_token?: string | null;
  user_id?: string | null;
  expires_at?: number | null;
  created_at?: string;
  updated_at?: string;
}

export interface AnimeMatchRecord {
  id?: number;
  normalized_title: string;
  shiki_id: number;
  shiki_title?: string | null;
  score?: number;
  matched_at?: string;
}

export interface AnimeLibSyncRecord {
  id?: number;
  media_id: number;
  title: string;
  rus_title?: string | null;
  status: string; // 'watching' | 'completed' | 'planned' | 'dropped' | 'fate' | 'hentai'
  last_tracked_episode: number;
  preferred_voiceover?: string | null;
  shiki_id?: number | null;
  shiki_synced: number; // 0 or 1
  last_checked_at?: string | null;
  updated_at?: string;
}

// Ensure database directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let dbInstance: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!dbInstance) {
    dbInstance = new Database(DB_PATH);
    
    // Performance optimizations for SQLite
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('synchronous = NORMAL');
    dbInstance.pragma('foreign_keys = ON');

    initTables(dbInstance);
  }
  return dbInstance;
}

function initTables(db: Database.Database) {
  // 1. auth_tokens: Stores access_token, refresh_token, and user_id for Shikimori
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL UNIQUE,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      user_id TEXT,
      expires_at INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2. anime_match_cache: Caches mappings from normalized AnimeLib titles to Shikimori IDs
  db.exec(`
    CREATE TABLE IF NOT EXISTS anime_match_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      normalized_title TEXT NOT NULL UNIQUE,
      shiki_id INTEGER NOT NULL,
      shiki_title TEXT,
      score REAL DEFAULT 1.0,
      matched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_match_normalized_title ON anime_match_cache (normalized_title);
  `);

  // 3. animelib_sync: Tracks bookmarks and the latest tracked episodes/voiceover
  db.exec(`
    CREATE TABLE IF NOT EXISTS animelib_sync (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id INTEGER NOT NULL UNIQUE,
      title TEXT NOT NULL,
      rus_title TEXT,
      status TEXT NOT NULL,
      last_tracked_episode INTEGER DEFAULT 0,
      preferred_voiceover TEXT,
      shiki_id INTEGER,
      shiki_synced INTEGER DEFAULT 0,
      last_checked_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_animelib_media_id ON animelib_sync (media_id);
    CREATE INDEX IF NOT EXISTS idx_animelib_status ON animelib_sync (status);
  `);
}

// ==========================================
// Database Helper Methods
// ==========================================

export const dbService = {
  // --- Auth Tokens ---
  saveAuthTokens(tokens: {
    service: string;
    access_token: string;
    refresh_token?: string | null;
    user_id?: string | null;
    expires_at?: number | null;
  }) {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO auth_tokens (service, access_token, refresh_token, user_id, expires_at, updated_at)
      VALUES (@service, @access_token, @refresh_token, @user_id, @expires_at, CURRENT_TIMESTAMP)
      ON CONFLICT(service) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        user_id = excluded.user_id,
        expires_at = excluded.expires_at,
        updated_at = CURRENT_TIMESTAMP
    `);
    return stmt.run(tokens);
  },

  getAuthTokens(service: string = 'shikimori'): AuthTokenRecord | undefined {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM auth_tokens WHERE service = ?');
    return stmt.get(service) as AuthTokenRecord | undefined;
  },

  // --- Anime Match Cache ---
  getCachedMatch(normalizedTitle: string): AnimeMatchRecord | undefined {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM anime_match_cache WHERE normalized_title = ?');
    return stmt.get(normalizedTitle) as AnimeMatchRecord | undefined;
  },

  setCachedMatch(match: {
    normalized_title: string;
    shiki_id: number;
    shiki_title?: string | null;
    score?: number;
  }) {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO anime_match_cache (normalized_title, shiki_id, shiki_title, score, matched_at)
      VALUES (@normalized_title, @shiki_id, @shiki_title, @score, CURRENT_TIMESTAMP)
      ON CONFLICT(normalized_title) DO UPDATE SET
        shiki_id = excluded.shiki_id,
        shiki_title = excluded.shiki_title,
        score = excluded.score,
        matched_at = CURRENT_TIMESTAMP
    `);
    return stmt.run(match);
  },

  // --- AnimeLib Sync State ---
  getSyncItemByMediaId(mediaId: number): AnimeLibSyncRecord | undefined {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM animelib_sync WHERE media_id = ?');
    return stmt.get(mediaId) as AnimeLibSyncRecord | undefined;
  },

  getAllSyncItems(status?: string): AnimeLibSyncRecord[] {
    const db = getDatabase();
    if (status) {
      const stmt = db.prepare('SELECT * FROM animelib_sync WHERE status = ? ORDER BY id DESC');
      return stmt.all(status) as AnimeLibSyncRecord[];
    }
    const stmt = db.prepare('SELECT * FROM animelib_sync ORDER BY id DESC');
    return stmt.all() as AnimeLibSyncRecord[];
  },

  upsertSyncItem(item: {
    media_id: number;
    title: string;
    rus_title?: string | null;
    status: string;
    last_tracked_episode?: number;
    preferred_voiceover?: string | null;
    shiki_id?: number | null;
    shiki_synced?: number;
  }) {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO animelib_sync (
        media_id, title, rus_title, status, last_tracked_episode, preferred_voiceover, shiki_id, shiki_synced, last_checked_at, updated_at
      ) VALUES (
        @media_id, @title, @rus_title, @status, @last_tracked_episode, @preferred_voiceover, @shiki_id, @shiki_synced, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT(media_id) DO UPDATE SET
        title = excluded.title,
        rus_title = excluded.rus_title,
        status = excluded.status,
        last_tracked_episode = CASE WHEN excluded.last_tracked_episode > animelib_sync.last_tracked_episode THEN excluded.last_tracked_episode ELSE animelib_sync.last_tracked_episode END,
        preferred_voiceover = COALESCE(excluded.preferred_voiceover, animelib_sync.preferred_voiceover),
        shiki_id = COALESCE(excluded.shiki_id, animelib_sync.shiki_id),
        shiki_synced = CASE WHEN excluded.shiki_synced IS NOT NULL THEN excluded.shiki_synced ELSE animelib_sync.shiki_synced END,
        last_checked_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `);
    return stmt.run({
      media_id: item.media_id,
      title: item.title,
      rus_title: item.rus_title || null,
      status: item.status,
      last_tracked_episode: item.last_tracked_episode ?? 0,
      preferred_voiceover: item.preferred_voiceover || null,
      shiki_id: item.shiki_id || null,
      shiki_synced: item.shiki_synced ?? 0,
    });
  },

  updateTrackedEpisode(mediaId: number, episode: number) {
    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE animelib_sync
      SET last_tracked_episode = ?, updated_at = CURRENT_TIMESTAMP
      WHERE media_id = ?
    `);
    return stmt.run(episode, mediaId);
  },

  markShikiSynced(mediaId: number, shikiId: number) {
    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE animelib_sync
      SET shiki_synced = 1, shiki_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE media_id = ?
    `);
    return stmt.run(shikiId, mediaId);
  }
};
