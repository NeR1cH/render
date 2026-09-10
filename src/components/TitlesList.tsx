import React, { useState, useEffect } from 'react';
import { AnimeItem } from '../types';
import { 
  Search, 
  ExternalLink, 
  CheckCircle2, 
  Clock, 
  XCircle, 
  PlayCircle, 
  CheckCheck, 
  FolderLock, 
  Sparkles,
  ChevronLeft,
  ChevronRight,
  Eye
} from 'lucide-react';

interface TitlesListProps {
  onSelectTitle?: (item: AnimeItem) => void;
}

export const TitlesList: React.FC<TitlesListProps> = () => {
  const [items, setItems] = useState<AnimeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [migratedFilter, setMigratedFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [selectedItem, setSelectedItem] = useState<AnimeItem | null>(null);

  const fetchTitles = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        migrated: migratedFilter,
        search: search,
        page: String(page),
        limit: '24',
      });
      const res = await fetch(`/api/titles?${params.toString()}`);
      const data = await res.json();
      setItems(data.items || []);
      setTotalPages(data.totalPages || 1);
      setTotalCount(data.totalCount || 0);
    } catch (e) {
      console.error('Failed to load titles', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchTitles();
    }, 200);
    return () => clearTimeout(timer);
  }, [search, statusFilter, migratedFilter, page]);

  const getStatusBadge = (item: AnimeItem) => {
    if (item.list_name === 'watching' || item.status === 21) {
      return (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-400 bg-sky-500/10 border border-sky-500/20 px-2 py-0.5 rounded-full">
          <PlayCircle className="w-3 h-3" />
          Смотрю
        </span>
      );
    }
    if (item.list_name === 'completed' || item.status === 24) {
      return (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
          <CheckCheck className="w-3 h-3" />
          Просмотрено
        </span>
      );
    }
    if (item.list_name === 'planned' || item.status === 22) {
      return (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full">
          <Clock className="w-3 h-3" />
          В планах
        </span>
      );
    }
    if (item.list_name === 'dropped' || item.status === 23) {
      return (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 rounded-full">
          <XCircle className="w-3 h-3" />
          Брошено
        </span>
      );
    }
    if (item.list_name === 'fate') {
      return (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-purple-400 bg-purple-500/10 border border-purple-500/20 px-2 py-0.5 rounded-full">
          <FolderLock className="w-3 h-3" />
          Fate
        </span>
      );
    }
    if (item.list_name === 'hentai') {
      return (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-pink-400 bg-pink-500/10 border border-pink-500/20 px-2 py-0.5 rounded-full">
          <FolderLock className="w-3 h-3" />
          hent
        </span>
      );
    }
    return (
      <span className="text-[11px] text-slate-400 bg-slate-800 px-2 py-0.5 rounded-full">
        {item.source_label || item.status}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-white font-display">
            База закладок AnimeLib
          </h2>
          <p className="text-xs sm:text-sm text-slate-400">
            Всего найдено: <span className="text-rose-400 font-semibold">{totalCount}</span> тайтлов
          </p>
        </div>

        {/* Search Input */}
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Поиск по названию или ID..."
            className="w-full pl-9 pr-4 py-2 bg-slate-900 border border-slate-800 rounded-xl text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500 transition"
          />
        </div>
      </div>

      {/* Filter Chips */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {[
            { id: 'all', label: 'Все категории' },
            { id: 'completed', label: 'Просмотрено' },
            { id: 'watching', label: 'Смотрю' },
            { id: 'planned', label: 'В планах' },
            { id: 'dropped', label: 'Брошено' },
            { id: 'fate', label: 'Fate франшиза' },
            { id: 'hentai', label: 'Кастом 18+' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                setStatusFilter(tab.id);
                setPage(1);
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                statusFilter === tab.id
                  ? 'bg-rose-500 text-white shadow-md shadow-rose-500/20'
                  : 'bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">Синхронизация:</span>
          <select
            value={migratedFilter}
            onChange={(e) => {
              setMigratedFilter(e.target.value);
              setPage(1);
            }}
            className="bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-300 py-1.5 px-3 focus:outline-none focus:border-rose-500 cursor-pointer"
          >
            <option value="all">Все (422)</option>
            <option value="yes">Синхронизировано (408)</option>
            <option value="no">Не перенесено (14)</option>
          </select>
        </div>
      </div>

      {/* Grid of Titles */}
      {loading ? (
        <div className="py-20 flex flex-col items-center justify-center text-slate-400 space-y-3">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-rose-500"></div>
          <span className="text-xs">Загрузка тайтлов...</span>
        </div>
      ) : items.length === 0 ? (
        <div className="py-16 text-center bg-slate-900/40 border border-slate-800 rounded-2xl p-6">
          <p className="text-slate-400 text-sm">Ничего не найдено по выбранным фильтрам.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {items.map((item) => (
            <div
              key={`${item.bookmark_id}-${item.media_id}`}
              onClick={() => setSelectedItem(item)}
              className="bg-slate-900/80 hover:bg-slate-850 border border-slate-800 hover:border-slate-700/80 rounded-xl p-4 flex flex-col justify-between transition cursor-pointer group shadow-sm hover:shadow-lg"
            >
              <div>
                <div className="flex items-start justify-between gap-2 mb-2">
                  {getStatusBadge(item)}
                  {item.is_migrated ? (
                    <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 flex items-center gap-1">
                      <CheckCircle2 className="w-2.5 h-2.5" />
                      Shikimori
                    </span>
                  ) : (
                    <span className="text-[10px] font-medium text-amber-400/80 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">
                      Ожидает
                    </span>
                  )}
                </div>

                <h3 className="text-sm font-bold text-white group-hover:text-rose-400 transition line-clamp-2 leading-snug">
                  {item.rus_name || item.name}
                </h3>

                {item.name && item.name !== item.rus_name && (
                  <p className="text-xs text-slate-500 line-clamp-1 mt-0.5 font-mono">
                    {item.name}
                  </p>
                )}
              </div>

              {/* Shikimori Match info */}
              <div className="mt-4 pt-3 border-t border-slate-800/80 text-xs">
                {item.matched_shiki_id ? (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-slate-400 text-[11px]">
                      <span className="flex items-center gap-1 text-slate-400">
                        <Sparkles className="w-3 h-3 text-amber-400" />
                        <span>Shikimori ID: {item.matched_shiki_id}</span>
                      </span>
                      {item.match_score && (
                        <span className="text-emerald-400 font-mono text-[10px]">
                          {Math.round(item.match_score * 100)}%
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-300 truncate">
                      {item.matched_shiki_name || item.rus_name}
                    </div>
                  </div>
                ) : (
                  <div className="text-[11px] text-amber-400/80 flex items-center gap-1">
                    <span>Требует ручного сопоставления</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-4 border-t border-slate-800 text-xs text-slate-400">
          <div>
            Страница <span className="text-white font-medium">{page}</span> из{' '}
            <span className="text-white font-medium">{totalPages}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="p-2 rounded-lg bg-slate-900 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="p-2 rounded-lg bg-slate-900 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Details Modal */}
      {selectedItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  {getStatusBadge(selectedItem)}
                  <span className="text-xs font-mono text-slate-500">ID: {selectedItem.media_id}</span>
                </div>
                <h3 className="text-lg font-bold text-white font-display leading-snug">
                  {selectedItem.rus_name || selectedItem.name}
                </h3>
              </div>
              <button
                onClick={() => setSelectedItem(null)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                &times;
              </button>
            </div>

            <div className="space-y-2 text-xs divide-y divide-slate-800 text-slate-300">
              <div className="py-1.5 flex justify-between">
                <span className="text-slate-500">Оригинальное имя (Romaji):</span>
                <span className="font-mono text-right">{selectedItem.name}</span>
              </div>
              {selectedItem.eng_name && (
                <div className="py-1.5 flex justify-between">
                  <span className="text-slate-500">Английское название:</span>
                  <span className="text-right">{selectedItem.eng_name}</span>
                </div>
              )}
              <div className="py-1.5 flex justify-between">
                <span className="text-slate-500">Код статуса AnimeLib:</span>
                <span className="font-mono">{selectedItem.source_status_code || selectedItem.status}</span>
              </div>
              <div className="py-1.5 flex justify-between">
                <span className="text-slate-500">Сопоставление Shikimori:</span>
                <span className="font-semibold text-emerald-400">
                  {selectedItem.matched_shiki_id ? `ID ${selectedItem.matched_shiki_id}` : 'Не сопоставлен'}
                </span>
              </div>
              {selectedItem.matched_shiki_name && (
                <div className="py-1.5 flex justify-between">
                  <span className="text-slate-500">Название на Shikimori:</span>
                  <span className="text-right text-slate-200">{selectedItem.matched_shiki_name}</span>
                </div>
              )}
              {selectedItem.anilist_id && (
                <div className="py-1.5 flex justify-between">
                  <span className="text-slate-500">AniList ID:</span>
                  <span className="font-mono">{selectedItem.anilist_id}</span>
                </div>
              )}
              <div className="py-1.5 flex justify-between">
                <span className="text-slate-500">Дата добавления в закладки:</span>
                <span>{selectedItem.created_at || 'Н/Д'}</span>
              </div>
            </div>

            <div className="pt-2 flex items-center justify-end gap-2">
              {selectedItem.matched_shiki_id && (
                <a
                  href={`https://shikimori.io/animes/${selectedItem.matched_shiki_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-850 hover:bg-slate-800 text-xs font-medium text-slate-200 border border-slate-700 transition"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Открыть на Shikimori</span>
                </a>
              )}
              <button
                onClick={() => setSelectedItem(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-white transition cursor-pointer"
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
