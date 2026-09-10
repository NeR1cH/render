import React from 'react';
import { MigrationStats } from '../types';
import { 
  CheckCircle2, 
  Clock, 
  AlertTriangle, 
  Layers, 
  PlayCircle, 
  Bookmark, 
  CheckCheck, 
  XCircle, 
  FolderLock, 
  ShieldCheck, 
  Zap, 
  Bot, 
  ArrowRight,
  Database
} from 'lucide-react';

interface DashboardOverviewProps {
  stats: MigrationStats | null;
  onNavigate: (view: string) => void;
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({ stats, onNavigate }) => {
  if (!stats) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-rose-500 mr-3"></div>
        Загрузка статистики миграции...
      </div>
    );
  }

  const completionPercent = stats.total > 0 ? Math.round((stats.migrated / stats.total) * 100) : 0;

  return (
    <div className="space-y-8">
      {/* Top Banner with Progress */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 border border-slate-700/60 p-6 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20">
              <Zap className="w-3.5 h-3.5" />
              <span>Миграция AnimeLib &rarr; Shikimori v2.0</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-display">
              Синхронизация закладок и списков
            </h2>
            <p className="text-sm text-slate-400 max-w-xl">
              Пакетный перенос с авто-сопоставлением названий, кэшированием ID, разрешением коллизий и кастомных списков (Fate, 18+).
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <button
              onClick={() => onNavigate('resolver')}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 text-sm font-medium transition cursor-pointer"
            >
              <AlertTriangle className="w-4 h-4" />
              <span>Конфликты ({stats.ambiguous})</span>
            </button>
            <button
              onClick={() => onNavigate('simulate')}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-sm font-medium shadow-lg shadow-rose-600/25 transition cursor-pointer"
            >
              <PlayCircle className="w-4 h-4" />
              <span>Запуск симулятора</span>
            </button>
          </div>
        </div>

        {/* Big Progress Bar */}
        <div className="mt-6 pt-6 border-t border-slate-700/50">
          <div className="flex items-center justify-between text-xs sm:text-sm font-medium text-slate-300 mb-2">
            <span>Прогресс миграции на Shikimori</span>
            <span className="text-rose-400 font-semibold">{completionPercent}% ({stats.migrated} / {stats.total} тайтлов)</span>
          </div>
          <div className="w-full bg-slate-800 rounded-full h-3 overflow-hidden p-0.5 border border-slate-700">
            <div
              className="bg-gradient-to-r from-rose-500 to-amber-500 h-2 rounded-full transition-all duration-500"
              style={{ width: `${completionPercent}%` }}
            />
          </div>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-2">
            <span>Всего закладок</span>
            <Layers className="w-4 h-4 text-slate-400" />
          </div>
          <div className="text-2xl sm:text-3xl font-bold text-white">{stats.total}</div>
          <div className="text-xs text-slate-500 mt-1">Все категории экспорта</div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition">
          <div className="flex items-center justify-between text-emerald-400 text-xs font-medium mb-2">
            <span>Перенесено</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl sm:text-3xl font-bold text-emerald-400">{stats.migrated}</div>
          <div className="text-xs text-slate-500 mt-1">Идемпотентно подтверждено</div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition">
          <div className="flex items-center justify-between text-amber-400 text-xs font-medium mb-2">
            <span>Ожидает переноса</span>
            <Clock className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl sm:text-3xl font-bold text-amber-400">{stats.pending}</div>
          <div className="text-xs text-slate-500 mt-1">Готовы к отправке</div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition">
          <div className="flex items-center justify-between text-rose-400 text-xs font-medium mb-2">
            <span>Спорные совпадения</span>
            <AlertTriangle className="w-4 h-4 text-rose-400" />
          </div>
          <div className="text-2xl sm:text-3xl font-bold text-rose-400">{stats.ambiguous}</div>
          <div className="text-xs text-slate-500 mt-1">Требуют ручной сверки</div>
        </div>
      </div>

      {/* Category Breakdown */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-white font-display flex items-center gap-2">
            <Bookmark className="w-5 h-5 text-rose-400" />
            <span>Категории и списки AnimeLib</span>
          </h3>
          <button
            onClick={() => onNavigate('titles')}
            className="text-xs font-medium text-rose-400 hover:text-rose-300 flex items-center gap-1 cursor-pointer"
          >
            <span>Посмотреть все</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4">
            <div className="flex items-center gap-2 text-xs text-emerald-400 font-medium mb-1">
              <CheckCheck className="w-4 h-4" />
              <span>Просмотрено</span>
            </div>
            <div className="text-xl font-bold text-white">{stats.byStatus.completed}</div>
            <div className="text-[11px] text-slate-500">Код: 24 (completed)</div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4">
            <div className="flex items-center gap-2 text-xs text-sky-400 font-medium mb-1">
              <PlayCircle className="w-4 h-4" />
              <span>Смотрю</span>
            </div>
            <div className="text-xl font-bold text-white">{stats.byStatus.watching}</div>
            <div className="text-[11px] text-slate-500">Код: 21 (watching)</div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4">
            <div className="flex items-center gap-2 text-xs text-amber-400 font-medium mb-1">
              <Clock className="w-4 h-4" />
              <span>Запланировано</span>
            </div>
            <div className="text-xl font-bold text-white">{stats.byStatus.planned}</div>
            <div className="text-[11px] text-slate-500">Код: 22 (planned)</div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4">
            <div className="flex items-center gap-2 text-xs text-rose-400 font-medium mb-1">
              <XCircle className="w-4 h-4" />
              <span>Брошено</span>
            </div>
            <div className="text-xl font-bold text-white">{stats.byStatus.dropped}</div>
            <div className="text-[11px] text-slate-500">Код: 23 (dropped)</div>
          </div>

          <div className="bg-slate-900/60 border border-purple-500/20 rounded-xl p-4">
            <div className="flex items-center gap-2 text-xs text-purple-400 font-medium mb-1">
              <FolderLock className="w-4 h-4" />
              <span>Fate (Кастом)</span>
            </div>
            <div className="text-xl font-bold text-white">{stats.byStatus.fate}</div>
            <div className="text-[11px] text-slate-500">Код: 2280926</div>
          </div>

          <div className="bg-slate-900/60 border border-pink-500/20 rounded-xl p-4">
            <div className="flex items-center gap-2 text-xs text-pink-400 font-medium mb-1">
              <FolderLock className="w-4 h-4" />
              <span>hent (Кастом)</span>
            </div>
            <div className="text-xl font-bold text-white">{stats.byStatus.hentai}</div>
            <div className="text-[11px] text-slate-500">Код: 2643707</div>
          </div>
        </div>
      </div>

      {/* Two columns: Status Confirmation Map & Phase 2 Pipeline */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Status Mapping Protocol */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-white font-display flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Карта статусов AnimeLib &rarr; Shikimori</span>
            </h3>
            <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
              Верифицировано кликами в UI
            </span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Коды 21–27 получены из прямых HTTP-запросов AnimeLib (<code className="text-slate-300">status=N</code>). Кастомные папки Никиты сохраняются со статусом <code className="text-slate-300">completed</code> и тегом категории.
          </p>

          <div className="divide-y divide-slate-800/80 text-xs">
            <div className="py-2 flex items-center justify-between">
              <span className="text-slate-300 font-mono">21 &rarr; Смотрю</span>
              <span className="text-sky-400 font-semibold">watching</span>
            </div>
            <div className="py-2 flex items-center justify-between">
              <span className="text-slate-300 font-mono">22 &rarr; Запланировано</span>
              <span className="text-amber-400 font-semibold">planned</span>
            </div>
            <div className="py-2 flex items-center justify-between">
              <span className="text-slate-300 font-mono">23 &rarr; Брошено</span>
              <span className="text-rose-400 font-semibold">dropped</span>
            </div>
            <div className="py-2 flex items-center justify-between">
              <span className="text-slate-300 font-mono">24 &rarr; Просмотрено</span>
              <span className="text-emerald-400 font-semibold">completed</span>
            </div>
            <div className="py-2 flex items-center justify-between">
              <span className="text-slate-300 font-mono">25 &rarr; Любимое</span>
              <span className="text-pink-400 font-semibold">completed + favorite</span>
            </div>
            <div className="py-2 flex items-center justify-between">
              <span className="text-slate-300 font-mono">2280926 &rarr; Папка Fate (21 тайтл)</span>
              <span className="text-purple-400 font-semibold">completed + tag:fate</span>
            </div>
          </div>
        </div>

        {/* Integrations & Shikimori API Protocol */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-white font-display flex items-center gap-2">
              <Database className="w-4 h-4 text-rose-400" />
              <span>Шлюз Shikimori API & Окружение</span>
            </h3>
            <span className="text-xs text-slate-400 bg-slate-800 px-2 py-0.5 rounded-full">
              Защита от блокировок
            </span>
          </div>

          <div className="space-y-3 text-xs">
            <div className="bg-slate-950/60 p-3 rounded-lg border border-slate-800 space-y-1">
              <div className="text-slate-300 font-medium flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                <span>User-Agent для Shikimori:</span>
              </div>
              <div className="text-[11px] font-mono text-slate-400 break-all">
                {stats.config.userAgent}
              </div>
              <div className="text-[11px] text-slate-500">
                Уникальный заголовок с контактом предотвращает бан DDoS-GUARD.
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="bg-slate-950/60 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-400">Лимит запросов:</div>
                <div className="text-sm font-bold text-white mt-0.5">0.8 сек (~75/мин)</div>
                <div className="text-[10px] text-slate-500">Безопасный интервал</div>
              </div>
              <div className="bg-slate-950/60 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-400">OAuth токен:</div>
                <div className="text-sm font-bold text-emerald-400 mt-0.5 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{stats.tokenStatus.hasToken ? 'Загружен' : 'Не настроен'}</span>
                </div>
                <div className="text-[10px] text-slate-500">scope: user_rates</div>
              </div>
            </div>

            <div className="bg-slate-950/60 p-3 rounded-lg border border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4 text-sky-400" />
                <div>
                  <div className="text-slate-300 font-medium">Telegram & n8n Оркестрация</div>
                  <div className="text-[11px] text-slate-500">Фаза 2: автоматизация qBittorrent & AniLiberty</div>
                </div>
              </div>
              <span className="text-[10px] text-sky-400 bg-sky-500/10 px-2 py-0.5 rounded border border-sky-500/20">
                Blueprint Готов
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
