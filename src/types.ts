export interface AnimeItem {
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

export interface MigrationStats {
  total: number;
  migrated: number;
  pending: number;
  ambiguous: number;
  byStatus: {
    watching: number;
    planned: number;
    completed: number;
    favorites: number;
    dropped: number;
    fate: number;
    hentai: number;
    rewatching: number;
    on_hold: number;
  };
  tokenStatus: {
    hasToken: boolean;
    expiresIn?: number;
    tokenType?: string;
    scope?: string;
  };
  config: {
    userAgent: string;
    minInterval: number;
    shikimoriBase: string;
    hasCredentials: boolean;
    telegramConfigured: boolean;
  };
}

export interface AmbiguityItem {
  id: string;
  original_title: string;
  score: number;
  candidates: Array<{
    id: number;
    name: string;
  }>;
  resolved_id?: number | null;
  resolved_name?: string | null;
  raw_log?: string;
}

export interface StatusMappingRule {
  code: number;
  slug: string;
  label: string;
  shikimori_status: string;
  extra_flag: string | null;
  confirmed_via: string;
}
