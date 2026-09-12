import React, { useState, useEffect } from 'react';
import { MigrationStats } from './types';
import { TrackerDashboard } from './components/TrackerDashboard';
import { DashboardOverview } from './components/DashboardOverview';
import { TitlesList } from './components/TitlesList';
import { MatchResolver } from './components/MatchResolver';
import { MigrationRunner } from './components/MigrationRunner';
import { InspectImporter } from './components/InspectImporter';
import { ConfigModal } from './components/ConfigModal';
import { 
  Compass, 
  Layers, 
  AlertTriangle, 
  PlayCircle, 
  FileText, 
  Settings, 
  CheckCircle2, 
  Sparkles,
  ExternalLink,
  Tv,
  RotateCw,
  AlertCircle
} from 'lucide-react';

const DEFAULT_STATS: MigrationStats = {
  total: 0,
  migrated: 0,
  pending: 0,
  ambiguous: 0,
  byStatus: {
    watching: 0,
    planned: 0,
    completed: 0,
    dropped: 0,
    fate: 0,
    hentai: 0,
    rewatching: 0,
    on_hold: 0,
  },
  tokenStatus: { hasToken: false, tokenType: 'Bearer', scope: '' },
  config: {
    userAgent: 'Anime Tracker Hub',
    minInterval: 0.8,
    shikimoriBase: 'https://shikimori.io',
    hasCredentials: false,
    telegramConfigured: false,
  },
};

export function App() {
  const [activeTab, setActiveTab] = useState<'tracker' | 'overview' | 'titles' | 'resolver' | 'simulate' | 'inspect'>('tracker');
  const [stats, setStats] = useState<MigrationStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  const fetchStats = async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const res = await fetch('/api/stats');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setStats(data);
    } catch (e: any) {
      console.warn('Failed to load migration stats, using fallback defaults', e);
      setStatsError(e.message);
      // Ensure we never stay stuck on a blank/spinner screen
      setStats(DEFAULT_STATS);
    } finally {
      setStatsLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* App Navigation Bar */}
      <header className="sticky top-0 z-40 bg-slate-950/90 backdrop-blur-md border-b border-slate-800/80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo and Brand */}
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-rose-500 flex items-center justify-center text-white font-bold shadow-lg shadow-indigo-500/20">
                <Tv className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-base sm:text-lg font-bold text-white tracking-tight font-display">
                    Anime Assistant Hub
                  </h1>
                  <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                    v2.0
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 hidden sm:block">
                  Трекер новых серий AnimeLib &middot; Telegram-бот &middot; Синхронизация Shikimori
                </p>
              </div>
            </div>

            {/* Quick Status and Actions */}
            <div className="flex items-center gap-3">
              {stats && stats.total > 0 && (
                <div className="hidden lg:flex items-center gap-3 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs">
                  <div className="flex items-center gap-1.5 text-emerald-400 font-medium">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>{stats.migrated} / {stats.total} перенесено</span>
                  </div>
                  <span className="text-slate-700">|</span>
                  <div className="text-slate-400">
                    Коллизий: <span className="text-amber-400 font-semibold">{stats.ambiguous}</span>
                  </div>
                </div>
              )}

              <a
                href="https://shikimori.io"
                target="_blank"
                rel="noreferrer"
                className="hidden sm:inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-850 text-xs font-medium text-slate-300 border border-slate-800 transition"
              >
                <span>Shikimori.io</span>
                <ExternalLink className="w-3 h-3 text-slate-500" />
              </a>

              <button
                onClick={() => setShowConfig(true)}
                className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white border border-slate-800 transition cursor-pointer"
                title="Настройки API"
              >
                <Settings className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar py-2 -mb-px">
            {[
              { id: 'tracker', label: '⚡ Трекер серий & Бот (SQLite)', icon: Tv, highlight: true },
              { id: 'overview', label: '📊 Обзор миграции', icon: Compass },
              { id: 'titles', label: '📚 База закладок', icon: Layers },
              { id: 'resolver', label: '⚠️ Коллизии', icon: AlertTriangle, badge: stats?.ambiguous },
              { id: 'simulate', label: '🚀 Симулятор переноса', icon: PlayCircle },
              { id: 'inspect', label: '🔍 Инспектор JSON/HAR', icon: FileText },
            ].map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as any)}
                  className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-medium whitespace-nowrap transition cursor-pointer ${
                    isActive
                      ? tab.highlight
                        ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/40 shadow-sm'
                        : 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60 border border-transparent'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${isActive ? (tab.highlight ? 'text-indigo-400' : 'text-rose-400') : 'text-slate-500'}`} />
                  <span>{tab.label}</span>
                  {tab.badge && tab.badge > 0 && (
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30">
                      {tab.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {/* Main Workspace Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {statsError && activeTab !== 'tracker' && (
          <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between text-xs text-amber-300">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>Миграционные файлы закладок не обнаружены или сервер перезапускается. Данные трекера доступны на вкладке «Трекер серий».</span>
            </div>
            <button
              onClick={fetchStats}
              className="px-3 py-1 bg-amber-500/20 hover:bg-amber-500/30 rounded-lg text-amber-200 font-medium transition cursor-pointer"
            >
              Повторить
            </button>
          </div>
        )}

        {activeTab === 'tracker' && (
          <TrackerDashboard />
        )}

        {activeTab === 'overview' && (
          <DashboardOverview stats={stats} onNavigate={(v) => setActiveTab(v as any)} />
        )}

        {activeTab === 'titles' && (
          <TitlesList />
        )}

        {activeTab === 'resolver' && (
          <MatchResolver
            onResolved={() => {
              fetchStats();
            }}
          />
        )}

        {activeTab === 'simulate' && (
          <MigrationRunner
            onCompleted={() => {
              fetchStats();
            }}
          />
        )}

        {activeTab === 'inspect' && (
          <InspectImporter />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-6 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>Anime Assistant v2.0 — Трекер релизов AnimeLib и Telegram-бот</span>
          <span className="text-slate-600">
            Для работы интерфейса запускайте <code className="text-indigo-400 font-mono">npm run dev</code>
          </span>
        </div>
      </footer>

      {showConfig && (
        <ConfigModal stats={stats} onClose={() => setShowConfig(false)} />
      )}
    </div>
  );
}

export default App;
