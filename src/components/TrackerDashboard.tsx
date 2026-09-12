import React, { useState, useEffect } from 'react';
import { 
  Play, 
  RotateCw, 
  Tv, 
  CheckCircle2, 
  AlertCircle, 
  Bell, 
  BellOff, 
  ExternalLink, 
  Sliders, 
  Terminal, 
  Sparkles, 
  Volume2, 
  Layers, 
  Clock, 
  Shield, 
  ChevronRight,
  Database,
  Send,
  Zap,
  Info
} from 'lucide-react';

interface DiagnosticItem {
  media_id: number;
  title: string;
  rus_title: string;
  status: string;
  db_tracked_episode: number;
  export_progress: number;
  site_latest_episode: number;
  has_new_episode: boolean;
  voiceovers: string[];
  diagnosis: string;
  last_checked_at: string | null;
}

interface BotStatus {
  configured: {
    telegramBotToken: boolean;
    telegramChatId: boolean;
    animelibCookie: boolean;
    animelibUserId: boolean;
    shikimoriToken: boolean;
  };
  preferences: {
    check_interval_min: number;
    notify_only_favorites: boolean;
    favorite_voiceovers: string[];
    preferred_quality: string;
    card_style: string;
    quiet_hours_enabled: boolean;
    quiet_start_hour: number;
    quiet_end_hour: number;
  };
  serverTime: string;
}

const AVAILABLE_STUDIOS = [
  'AniLibria',
  'AniLibria.TV',
  'Dream Cast',
  'Studio Band',
  'Дубляжная',
  'DEEP',
  'Crunchyroll.Subtitles',
  'AniLiberty (AniLibria)',
  'SHIZA Project',
  'AniDUB',
  'YumekoStudio',
  "Zane's Project",
  'КОМНАТА ДИДИ',
  'Red Head Sound',
];

export const TrackerDashboard: React.FC = () => {
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[]>([]);
  const [botStatus, setBotStatus] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkLogs, setCheckLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [filter, setFilter] = useState<'all' | 'new' | 'current'>('all');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [tempEpisode, setTempEpisode] = useState<number>(0);

  const loadData = async () => {
    setLoading(true);
    try {
      const [diagRes, statusRes] = await Promise.all([
        fetch('/api/sync/diagnostics').catch(() => null),
        fetch('/api/bot/status').catch(() => null),
      ]);

      if (diagRes && diagRes.ok) {
        const dData = await diagRes.json();
        setDiagnostics(dData.diagnostics || []);
      }
      if (statusRes && statusRes.ok) {
        const sData = await statusRes.json();
        setBotStatus(sData);
      }
    } catch (err) {
      console.error('Failed to load tracker data', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleRunCheck = async () => {
    setChecking(true);
    setShowLogs(true);
    setCheckLogs(['[Запуск] Инициализация проверки релизов...']);

    try {
      const res = await fetch('/api/sync/check', { method: 'POST' });
      const data = await res.json();

      if (data.logs) {
        setCheckLogs(data.logs);
      } else {
        setCheckLogs((prev) => [...prev, `Проверка завершена. Найдено обновлений: ${data.updatesCount || 0}`]);
      }

      await loadData();
    } catch (e: any) {
      setCheckLogs((prev) => [...prev, `[Ошибка сети]: ${e.message}`]);
    } finally {
      setChecking(false);
    }
  };

  const handleUpdateEpisode = async (mediaId: number, ep: number) => {
    try {
      const res = await fetch('/api/sync/update-episode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaId, episode: ep }),
      });
      if (res.ok) {
        setDiagnostics((prev) =>
          prev.map((item) =>
            item.media_id === mediaId
              ? {
                  ...item,
                  db_tracked_episode: ep,
                  has_new_episode: item.site_latest_episode > ep,
                  diagnosis:
                    item.site_latest_episode > ep
                      ? `⚡ Новая серия #${item.site_latest_episode} доступна! (В БД отслежено: #${ep})`
                      : `✅ Актуально (серия #${ep} отслежена)`,
                }
              : item
          )
        );
        setEditingId(null);
      }
    } catch (err) {
      console.error('Failed to update episode', err);
    }
  };

  const toggleFavoriteStudio = async (studio: string) => {
    if (!botStatus) return;
    const current = botStatus.preferences.favorite_voiceovers || [];
    const exists = current.some((s) => s.toLowerCase() === studio.toLowerCase());
    const updated = exists
      ? current.filter((s) => s.toLowerCase() !== studio.toLowerCase())
      : [...current, studio];

    setBotStatus({
      ...botStatus,
      preferences: {
        ...botStatus.preferences,
        favorite_voiceovers: updated,
      },
    });

    setSavingPrefs(true);
    try {
      await fetch('/api/bot/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite_voiceovers: updated }),
      });
    } catch (e) {
      console.error('Failed to save preferences', e);
    } finally {
      setSavingPrefs(false);
    }
  };

  const toggleNotifyOnlyFavorites = async () => {
    if (!botStatus) return;
    const nextVal = !botStatus.preferences.notify_only_favorites;

    setBotStatus({
      ...botStatus,
      preferences: {
        ...botStatus.preferences,
        notify_only_favorites: nextVal,
      },
    });

    setSavingPrefs(true);
    try {
      await fetch('/api/bot/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notify_only_favorites: nextVal ? 1 : 0 }),
      });
    } catch (e) {
      console.error('Failed to save preference', e);
    } finally {
      setSavingPrefs(false);
    }
  };

  const handleIntervalChange = async (minutes: number) => {
    if (!botStatus) return;
    setBotStatus({
      ...botStatus,
      preferences: {
        ...botStatus.preferences,
        check_interval_min: minutes,
      },
    });

    setSavingPrefs(true);
    try {
      await fetch('/api/bot/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ check_interval_min: minutes }),
      });
    } catch (e) {
      console.error('Failed to save interval', e);
    } finally {
      setSavingPrefs(false);
    }
  };

  const filteredItems = diagnostics.filter((item) => {
    if (filter === 'new') return item.has_new_episode;
    if (filter === 'current') return !item.has_new_episode;
    return true;
  });

  const totalNew = diagnostics.filter((d) => d.has_new_episode).length;

  return (
    <div className="space-y-8">
      {/* Top Banner with Quick Actions */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 border border-indigo-500/20 p-6 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <Zap className="w-3.5 h-3.5" />
              <span>Anime Assistant & SQLite Tracker</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-display">
              Отслеживание серий и Telegram-бот
            </h2>
            <p className="text-sm text-slate-300 max-w-xl">
              Автоматическая сверка вышедших серий на AnimeLib с вашей локальной базой SQLite и отправка уведомлений с кнопками быстрых действий.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleRunCheck}
              disabled={checking}
              className={`inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl font-medium text-sm text-white shadow-lg transition cursor-pointer ${
                checking
                  ? 'bg-indigo-700/60 cursor-not-allowed opacity-80'
                  : 'bg-indigo-600 hover:bg-indigo-500 shadow-indigo-600/30 active:scale-95'
              }`}
            >
              <RotateCw className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} />
              <span>{checking ? 'Проверка...' : 'Проверить новые серии'}</span>
            </button>
            <button
              onClick={() => setShowLogs(!showLogs)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-sm font-medium transition cursor-pointer"
            >
              <Terminal className="w-4 h-4 text-indigo-400" />
              <span>Логи</span>
            </button>
          </div>
        </div>

        {/* Integration Status Badges */}
        <div className="mt-6 pt-5 border-t border-slate-800/80 flex flex-wrap items-center gap-4 text-xs">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900/90 border border-slate-800">
            <span className="text-slate-400">Telegram:</span>
            {botStatus?.configured.telegramBotToken ? (
              <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" /> Подключен
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-amber-400 font-medium">
                <AlertCircle className="w-3.5 h-3.5" /> Токен не задан в .env
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900/90 border border-slate-800">
            <span className="text-slate-400">AnimeLib:</span>
            {botStatus?.configured.animelibCookie ? (
              <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" /> Авторизован (Куки)
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-sky-400 font-medium">
                <Info className="w-3.5 h-3.5" /> Экспорт animelib_export.json
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900/90 border border-slate-800">
            <span className="text-slate-400">База SQLite:</span>
            <span className="text-white font-semibold">{diagnostics.length} тайтлов</span>
          </div>

          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900/90 border border-slate-800">
            <span className="text-slate-400">Новых серий готово:</span>
            <span className={`font-semibold ${totalNew > 0 ? 'text-amber-400 animate-pulse' : 'text-slate-300'}`}>
              {totalNew}
            </span>
          </div>
        </div>
      </div>

      {/* Live Check Logs Console */}
      {showLogs && (
        <div className="rounded-xl bg-slate-950 border border-slate-800 overflow-hidden shadow-2xl">
          <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-800 text-xs text-slate-300 font-mono">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-indigo-400" />
              <span>Консоль проверки серий (Live Output)</span>
            </div>
            <button
              onClick={() => setShowLogs(false)}
              className="text-slate-500 hover:text-slate-300 text-xs"
            >
              Свернуть
            </button>
          </div>
          <div className="p-4 font-mono text-xs max-h-60 overflow-y-auto space-y-1.5 bg-slate-950/90 text-slate-300 select-text">
            {checkLogs.length === 0 ? (
              <p className="text-slate-600 italic">Нажмите «Проверить новые серии», чтобы запустить процесс...</p>
            ) : (
              checkLogs.map((log, idx) => {
                const isSuccess = log.includes('🔥') || log.includes('НОВАЯ');
                const isSave = log.includes('💾');
                const isErr = log.includes('Ошибка') || log.includes('Error');
                return (
                  <div
                    key={idx}
                    className={`${
                      isSuccess
                        ? 'text-amber-300 font-semibold'
                        : isSave
                        ? 'text-emerald-400'
                        : isErr
                        ? 'text-rose-400'
                        : 'text-slate-300'
                    }`}
                  >
                    {log}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Main Content Layout: Titles List + Settings Sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Titles Column (2 cols) */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Tv className="w-5 h-5 text-indigo-400" />
              <h3 className="text-lg font-bold text-white font-display">Отслеживаемые аниме в SQLite</h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
                {diagnostics.length}
              </span>
            </div>

            {/* Filter tabs */}
            <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-xl border border-slate-800 text-xs">
              <button
                onClick={() => setFilter('all')}
                className={`px-3 py-1 rounded-lg font-medium transition cursor-pointer ${
                  filter === 'all' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Все ({diagnostics.length})
              </button>
              <button
                onClick={() => setFilter('new')}
                className={`px-3 py-1 rounded-lg font-medium transition cursor-pointer ${
                  filter === 'new' ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Новые серии ({totalNew})
              </button>
              <button
                onClick={() => setFilter('current')}
                className={`px-3 py-1 rounded-lg font-medium transition cursor-pointer ${
                  filter === 'current' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Актуальные
              </button>
            </div>
          </div>

          {loading ? (
            <div className="py-16 text-center text-slate-500 text-sm">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500 mx-auto mb-3"></div>
              Загрузка списка из базы данных...
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="p-8 rounded-2xl bg-slate-900/60 border border-slate-800 text-center text-slate-400 text-sm">
              Нет тайтлов в выбранном фильтре.
            </div>
          ) : (
            <div className="space-y-3">
              {filteredItems.map((item) => {
                const isEditing = editingId === item.media_id;
                return (
                  <div
                    key={item.media_id}
                    className={`rounded-xl p-4 transition border ${
                      item.has_new_episode
                        ? 'bg-gradient-to-r from-amber-500/10 via-slate-900 to-slate-900 border-amber-500/40 shadow-lg shadow-amber-500/5'
                        : 'bg-slate-900/80 hover:bg-slate-900 border-slate-800'
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      {/* Title Info */}
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="text-base font-semibold text-white truncate">
                            {item.rus_title || item.title}
                          </h4>
                          <span className="text-[10px] font-mono text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">
                            ID: {item.media_id}
                          </span>
                        </div>
                        {item.title && item.title !== item.rus_title && (
                          <p className="text-xs text-slate-400 truncate">{item.title}</p>
                        )}

                        {/* Studios in release */}
                        {item.voiceovers && item.voiceovers.length > 0 && (
                          <div className="flex items-center gap-1.5 flex-wrap pt-1">
                            <span className="text-[10px] text-slate-500">Озвучки:</span>
                            {item.voiceovers.slice(0, 4).map((vo, vIdx) => {
                              const isFav = botStatus?.preferences.favorite_voiceovers.some(
                                (f) => f.toLowerCase() === vo.toLowerCase()
                              );
                              return (
                                <span
                                  key={vIdx}
                                  className={`text-[10px] px-2 py-0.5 rounded-md border ${
                                    isFav
                                      ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 font-medium'
                                      : 'bg-slate-800 text-slate-400 border-slate-700'
                                  }`}
                                >
                                  {vo}
                                </span>
                              );
                            })}
                            {item.voiceovers.length > 4 && (
                              <span className="text-[10px] text-slate-500">
                                +{item.voiceovers.length - 4} ещё
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Episode Counter & Action */}
                      <div className="flex items-center gap-4 shrink-0">
                        <div className="text-right">
                          <div className="text-xs text-slate-400">Просмотрено / Вышло</div>
                          <div className="flex items-center gap-2 mt-0.5">
                            {isEditing ? (
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  value={tempEpisode}
                                  onChange={(e) => setTempEpisode(Number(e.target.value))}
                                  className="w-16 px-2 py-1 bg-slate-950 border border-indigo-500 rounded text-sm text-center text-white"
                                  min={0}
                                />
                                <button
                                  onClick={() => handleUpdateEpisode(item.media_id, tempEpisode)}
                                  className="px-2 py-1 bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold rounded text-white"
                                >
                                  OK
                                </button>
                                <button
                                  onClick={() => setEditingId(null)}
                                  className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-xs rounded text-slate-400"
                                >
                                  Отмена
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => {
                                  setEditingId(item.media_id);
                                  setTempEpisode(item.db_tracked_episode);
                                }}
                                className="group flex items-baseline gap-1.5 hover:opacity-80 transition cursor-pointer"
                                title="Нажмите, чтобы изменить просмотренную серию"
                              >
                                <span className="text-lg font-bold text-white group-hover:text-indigo-400">
                                  {item.db_tracked_episode}
                                </span>
                                <span className="text-sm text-slate-500">/</span>
                                <span className="text-lg font-bold text-indigo-400">
                                  {item.site_latest_episode}
                                </span>
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Status Badge */}
                        <div className="min-w-[110px] text-right">
                          {item.has_new_episode ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 animate-pulse">
                              ⚡ +{item.site_latest_episode - item.db_tracked_episode} сер.
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              <CheckCircle2 className="w-3.5 h-3.5" /> Актуально
                            </span>
                          )}
                        </div>

                        {/* Mark As Watched Quick Button */}
                        {item.has_new_episode && (
                          <button
                            onClick={() => handleUpdateEpisode(item.media_id, item.site_latest_episode)}
                            className="p-2 rounded-xl bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30 transition text-xs font-medium cursor-pointer"
                            title="Отметить все вышедшие серии просмотренными"
                          >
                            Отметить
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Settings & Voiceover Preferences (1 col) */}
        <div className="space-y-6">
          {/* Notification Rules Card */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-indigo-400" />
                <h4 className="text-sm font-bold text-white">Фильтр уведомлений</h4>
              </div>
              {savingPrefs && (
                <span className="text-[10px] text-indigo-400 animate-pulse">Сохранение...</span>
              )}
            </div>

            {/* Favorite Voiceover Toggle */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-300">Только любимые озвучки</span>
                <button
                  onClick={toggleNotifyOnlyFavorites}
                  className={`w-10 h-6 flex items-center rounded-full p-1 transition cursor-pointer ${
                    botStatus?.preferences.notify_only_favorites
                      ? 'bg-rose-600 justify-end'
                      : 'bg-slate-800 justify-start'
                  }`}
                >
                  <div className="w-4 h-4 rounded-full bg-white shadow-md" />
                </button>
              </div>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Если включено, бот пришлёт уведомление только тогда, когда серия выйдет в одной из выбранных ниже студий.
              </p>
            </div>

            {/* Interval Selection */}
            <div className="space-y-2 pt-3 border-t border-slate-800">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-300 font-medium">Интервал авто-проверки</span>
                <span className="text-indigo-400 font-bold">
                  {botStatus?.preferences.check_interval_min || 30} мин.
                </span>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {[10, 30, 60, 120].map((mins) => (
                  <button
                    key={mins}
                    onClick={() => handleIntervalChange(mins)}
                    className={`py-1.5 rounded-lg text-xs font-medium transition cursor-pointer border ${
                      botStatus?.preferences.check_interval_min === mins
                        ? 'bg-indigo-600 text-white border-indigo-500'
                        : 'bg-slate-800/80 text-slate-400 hover:text-white border-slate-700'
                    }`}
                  >
                    {mins}м
                  </button>
                ))}
              </div>
            </div>

            {/* Studios Checklist */}
            <div className="space-y-2.5 pt-3 border-t border-slate-800">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-300">Любимые релиз-группы:</span>
                <span className="text-[10px] text-rose-400 font-medium">
                  {botStatus?.preferences.favorite_voiceovers.length || 0} выбрано
                </span>
              </div>
              <div className="grid grid-cols-1 gap-1.5 max-h-56 overflow-y-auto pr-1">
                {AVAILABLE_STUDIOS.map((studio) => {
                  const isSelected = botStatus?.preferences.favorite_voiceovers.some(
                    (s) => s.toLowerCase() === studio.toLowerCase()
                  );
                  return (
                    <button
                      key={studio}
                      onClick={() => toggleFavoriteStudio(studio)}
                      className={`flex items-center justify-between px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer border text-left ${
                        isSelected
                          ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                          : 'bg-slate-800/60 text-slate-400 hover:bg-slate-800 border-slate-800'
                      }`}
                    >
                      <span>{studio}</span>
                      <span
                        className={`w-3.5 h-3.5 rounded flex items-center justify-center text-[10px] border ${
                          isSelected
                            ? 'bg-rose-500 text-white border-rose-400'
                            : 'border-slate-600'
                        }`}
                      >
                        {isSelected ? '✓' : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* How to run locally Card */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-3">
            <div className="flex items-center gap-2 text-indigo-400">
              <Info className="w-4 h-4" />
              <h4 className="text-xs font-bold text-white">Запуск на компьютере</h4>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Чтобы веб-интерфейс открывался в браузере по адресу <code className="text-indigo-300 font-mono">http://localhost:3000</code>, в терминале должна быть запущена команда:
            </p>
            <div className="bg-slate-950 p-2.5 rounded-lg font-mono text-xs text-emerald-400 border border-slate-800 select-all">
              npm run dev
            </div>
            <p className="text-[11px] text-slate-500">
              Если запускать только <code className="text-slate-400 font-mono">npm run bot</code>, веб-сервер не стартует, и браузер не сможет загрузить страницу.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
