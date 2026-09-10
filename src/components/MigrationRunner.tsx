import React, { useState } from 'react';
import { 
  PlayCircle, 
  CheckCircle2, 
  Clock, 
  AlertCircle, 
  RefreshCw, 
  ShieldCheck, 
  Cpu,
  Layers,
  ArrowRight
} from 'lucide-react';

interface MigrationRunnerProps {
  onCompleted?: () => void;
}

export const MigrationRunner: React.FC<MigrationRunnerProps> = ({ onCompleted }) => {
  const [targetCategory, setTargetCategory] = useState('all');
  const [simulating, setSimulating] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [simulationResult, setSimulationResult] = useState<any | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [syncSuccess, setSyncSuccess] = useState<string | null>(null);

  const runSimulation = async () => {
    setSimulating(true);
    setLogs([]);
    setSyncSuccess(null);

    try {
      setLogs((prev) => [...prev, `[ИНФО] Запуск симулятора (--dry-run) для категории: ${targetCategory}...`]);
      setLogs((prev) => [...prev, `[СЕТЬ] Лимит запросов: 0.8 сек/запрос (~75 req/min), User-Agent: ANIME ASSISTANT v2.0`]);

      const res = await fetch('/api/simulate-migration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetStatus: targetCategory }),
      });
      const data = await res.json();
      setSimulationResult(data);

      setLogs((prev) => [
        ...prev,
        `[ИТОГ] Проверено записей: ${data.total}`,
        `[ИТОГ] Уже перенесено ранее: ${data.syncedCount}`,
        `[ИТОГ] Готово к отправке на Shikimori: ${data.readyCount}`,
        `[ИТОГ] Без сопоставленного ID: ${data.missingCount}`,
        `[ИТОГ] Расчётное время безопасной миграции: ~${data.estimatedTimeSeconds} сек`,
      ]);
    } catch (e: any) {
      setLogs((prev) => [...prev, `[ОШИБКА] Сбой при симуляции: ${e.message}`]);
    } finally {
      setSimulating(false);
    }
  };

  const runExecution = async () => {
    setExecuting(true);
    setSyncSuccess(null);
    try {
      setLogs((prev) => [...prev, `[СИНХРОНИЗАЦИЯ] Применение миграции для готовых тайтлов...`]);
      const res = await fetch('/api/execute-migration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.success) {
        setSyncSuccess(`Миграция успешно обновлена! Синхронизировано новых: ${data.updatedCount}. Всего на Shikimori: ${data.totalMigrated}`);
        setLogs((prev) => [
          ...prev,
          `[УСПЕХ] Записи сохранены в .migration_progress.json (Всего: ${data.totalMigrated})`,
        ]);
        if (onCompleted) onCompleted();
      }
    } catch (e: any) {
      setLogs((prev) => [...prev, `[ОШИБКА] Сбой синхронизации: ${e.message}`]);
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-white font-display">
            Симулятор и запуск миграции
          </h2>
          <p className="text-xs sm:text-sm text-slate-400">
            Безопасная проверка соответствия статусов и запуск синхронизации с защитой от лимитов Shikimori REST API v1/v2.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <select
            value={targetCategory}
            onChange={(e) => setTargetCategory(e.target.value)}
            className="bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-200 py-2 px-3 focus:outline-none focus:border-rose-500 cursor-pointer"
          >
            <option value="all">Все категории (422 тайтла)</option>
            <option value="watching">Смотрю (5)</option>
            <option value="completed">Просмотрено (334)</option>
            <option value="planned">В планах (43)</option>
            <option value="dropped">Брошено (16)</option>
            <option value="fate">Fate папка (21)</option>
            <option value="hentai">hent папка (3)</option>
          </select>

          <button
            onClick={runSimulation}
            disabled={simulating}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold border border-slate-700 transition cursor-pointer disabled:opacity-50"
          >
            {simulating ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Cpu className="w-3.5 h-3.5 text-amber-400" />}
            <span>Dry-Run (Симуляция)</span>
          </button>

          <button
            onClick={runExecution}
            disabled={executing}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold shadow-lg shadow-rose-600/25 transition cursor-pointer disabled:opacity-50"
          >
            {executing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}
            <span>Синхронизировать</span>
          </button>
        </div>
      </div>

      {syncSuccess && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs sm:text-sm flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{syncSuccess}</span>
        </div>
      )}

      {/* Stats Cards from Simulation */}
      {simulationResult && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="text-xs text-slate-400">Проверено</div>
            <div className="text-2xl font-bold text-white mt-1">{simulationResult.total}</div>
            <div className="text-[11px] text-slate-500">В целевой выборке</div>
          </div>
          <div className="bg-slate-900 border border-emerald-500/20 rounded-xl p-4">
            <div className="text-xs text-emerald-400">Уже на Shikimori</div>
            <div className="text-2xl font-bold text-emerald-400 mt-1">{simulationResult.syncedCount}</div>
            <div className="text-[11px] text-slate-500">Повторный запрос не требуется</div>
          </div>
          <div className="bg-slate-900 border border-amber-500/20 rounded-xl p-4">
            <div className="text-xs text-amber-400">Готово к синхронизации</div>
            <div className="text-2xl font-bold text-amber-400 mt-1">{simulationResult.readyCount}</div>
            <div className="text-[11px] text-slate-500">Сопоставленный ID валиден</div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="text-xs text-slate-400">Время выполнения</div>
            <div className="text-2xl font-bold text-slate-200 mt-1">~{simulationResult.estimatedTimeSeconds}с</div>
            <div className="text-[11px] text-slate-500">С интервалом 0.8 сек</div>
          </div>
        </div>
      )}

      {/* Terminal / Log Output */}
      <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4 font-mono text-xs text-slate-300 space-y-2 shadow-inner">
        <div className="flex items-center justify-between pb-2 border-b border-slate-800 text-[11px] text-slate-500">
          <span>Журнал миграции (CLI Logger Stream)</span>
          <span className="flex items-center gap-1 text-emerald-400">
            <ShieldCheck className="w-3.5 h-3.5" />
            Идемпотентный режим
          </span>
        </div>
        <div className="max-h-60 overflow-y-auto space-y-1 py-1">
          {logs.length === 0 ? (
            <div className="text-slate-600 py-6 text-center">
              Нажмите «Dry-Run (Симуляция)» для предварительной проверки сопоставления.
            </div>
          ) : (
            logs.map((log, index) => (
              <div
                key={index}
                className={
                  log.includes('[ОШИБКА]')
                    ? 'text-rose-400'
                    : log.includes('[УСПЕХ]')
                    ? 'text-emerald-400'
                    : log.includes('[ИТОГ]')
                    ? 'text-amber-300'
                    : 'text-slate-300'
                }
              >
                {log}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Sample matched items table */}
      {simulationResult?.results && simulationResult.results.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white font-display flex items-center gap-2">
              <Layers className="w-4 h-4 text-rose-400" />
              <span>Предпросмотр очереди переноса (первые 50 тайтлов)</span>
            </h3>
            <span className="text-xs text-slate-500">Маппинг статусов</span>
          </div>

          <div className="max-h-80 overflow-y-auto divide-y divide-slate-800/80 text-xs">
            {simulationResult.results.map((r: any) => (
              <div key={r.media_id} className="py-2.5 flex items-center justify-between gap-4">
                <div className="truncate">
                  <div className="font-medium text-white truncate">{r.rus_name}</div>
                  <div className="text-[11px] text-slate-500 font-mono">
                    AnimeLib ID: {r.media_id} &rarr; Shikimori ID: {r.target_shiki_id || 'нет'}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                    &rarr; {r.target_status}
                  </span>
                  {r.status === 'already_synced' ? (
                    <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded font-medium flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" />
                      Синхронизирован
                    </span>
                  ) : r.status === 'ready_to_sync' ? (
                    <span className="text-[10px] text-sky-400 bg-sky-500/10 px-2 py-0.5 rounded font-medium flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      Готов
                    </span>
                  ) : (
                    <span className="text-[10px] text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded font-medium flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      Нужен ID
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
