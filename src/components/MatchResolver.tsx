import React, { useState, useEffect } from 'react';
import { AmbiguityItem } from '../types';
import { 
  AlertTriangle, 
  CheckCircle2, 
  ExternalLink, 
  Check, 
  Sparkles, 
  HelpCircle,
  Search
} from 'lucide-react';

interface MatchResolverProps {
  onResolved?: () => void;
}

export const MatchResolver: React.FC<MatchResolverProps> = ({ onResolved }) => {
  const [ambiguities, setAmbiguities] = useState<AmbiguityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [customInputs, setCustomInputs] = useState<Record<string, { id: string; name: string }>>({});
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const fetchAmbiguities = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ambiguities');
      const data = await res.json();
      setAmbiguities(data || []);
    } catch (e) {
      console.error('Failed to load ambiguities', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAmbiguities();
  }, []);

  const handleResolve = async (amb: AmbiguityItem, shikiId: number, shikiName: string) => {
    setResolvingId(amb.id);
    try {
      const res = await fetch(`/api/ambiguities/${amb.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shiki_id: shikiId, name: shikiName }),
      });
      const data = await res.json();
      if (data.success) {
        setSuccessMessage(`Успешно сопоставлено: «${amb.original_title}» → «${shikiName}» (ID: ${shikiId})`);
        setTimeout(() => setSuccessMessage(null), 4000);
        await fetchAmbiguities();
        if (onResolved) onResolved();
      }
    } catch (e) {
      console.error('Resolution failed', e);
    } finally {
      setResolvingId(null);
    }
  };

  const handleCustomResolve = (amb: AmbiguityItem) => {
    const input = customInputs[amb.id];
    if (!input || !input.id) return;
    const parsedId = parseInt(input.id, 10);
    if (isNaN(parsedId)) return;
    handleResolve(amb, parsedId, input.name || amb.original_title);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 mb-1">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>Неуверенные совпадения из errors.txt</span>
          </div>
          <h2 className="text-xl sm:text-2xl font-bold text-white font-display">
            Разрешение спорных тайтлов
          </h2>
          <p className="text-xs sm:text-sm text-slate-400">
            Скрипт автоматически выявил неоднозначные названия со схожестью ниже порога (score &lt; 0.90). Выберите верный вариант на Shikimori:
          </p>
        </div>
      </div>

      {successMessage && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs sm:text-sm flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {loading ? (
        <div className="py-20 flex justify-center text-slate-400 text-xs">
          Загрузка записей ошибок...
        </div>
      ) : ambiguities.length === 0 ? (
        <div className="py-16 text-center bg-slate-900/40 border border-slate-800 rounded-2xl p-6">
          <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
          <p className="text-slate-300 font-medium text-sm">Все спорные тайтлы сопоставлены!</p>
          <p className="text-slate-500 text-xs mt-1">Ошибок в errors.txt больше не осталось.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {ambiguities.map((amb) => {
            const isResolved = !!amb.resolved_id;
            return (
              <div
                key={amb.id}
                className={`bg-slate-900 border rounded-2xl p-5 space-y-4 transition ${
                  isResolved ? 'border-emerald-500/30 bg-emerald-950/10' : 'border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-slate-500">{amb.id}</span>
                      <span className="text-xs font-medium text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded">
                        score: {amb.score.toFixed(2)}
                      </span>
                      {isResolved && (
                        <span className="text-xs font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" />
                          Сопоставлено
                        </span>
                      )}
                    </div>
                    <h3 className="text-base font-bold text-white">
                      «{amb.original_title}»
                    </h3>
                  </div>

                  {isResolved && (
                    <div className="text-right text-xs">
                      <div className="text-slate-400">Текущий выбор:</div>
                      <div className="text-emerald-400 font-semibold">{amb.resolved_name} (ID: {amb.resolved_id})</div>
                    </div>
                  )}
                </div>

                {/* Candidates selection */}
                <div>
                  <div className="text-xs font-medium text-slate-400 mb-2 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                    <span>Предложенные совпадения из базы Shikimori:</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {amb.candidates.map((cand) => {
                      const isSelected = amb.resolved_id === cand.id;
                      return (
                        <button
                          key={cand.id}
                          disabled={resolvingId === amb.id}
                          onClick={() => handleResolve(amb, cand.id, cand.name)}
                          className={`flex items-center justify-between p-3 rounded-xl text-left border text-xs transition cursor-pointer ${
                            isSelected
                              ? 'bg-emerald-500/15 border-emerald-500 text-emerald-300 font-medium'
                              : 'bg-slate-950/60 hover:bg-slate-800 border-slate-800 text-slate-300'
                          }`}
                        >
                          <div className="truncate pr-2">
                            <div className="font-medium truncate">{cand.name}</div>
                            <div className="text-[10px] text-slate-500 font-mono">Shikimori ID: {cand.id}</div>
                          </div>
                          {isSelected ? (
                            <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                          ) : (
                            <a
                              href={`https://shikimori.io/animes/${cand.id}`}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="p-1 text-slate-500 hover:text-slate-300"
                              title="Открыть страницу на Shikimori"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Custom ID manual override */}
                <div className="pt-2 border-t border-slate-800/80 flex flex-col sm:flex-row items-stretch sm:items-center gap-2 text-xs">
                  <span className="text-slate-400 shrink-0">Или задать вручную:</span>
                  <input
                    type="number"
                    placeholder="Shikimori ID (напр. 59062)"
                    value={customInputs[amb.id]?.id || ''}
                    onChange={(e) =>
                      setCustomInputs({
                        ...customInputs,
                        [amb.id]: { ...(customInputs[amb.id] || { name: '' }), id: e.target.value },
                      })
                    }
                    className="w-44 px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-rose-500"
                  />
                  <input
                    type="text"
                    placeholder="Название (опционально)"
                    value={customInputs[amb.id]?.name || ''}
                    onChange={(e) =>
                      setCustomInputs({
                        ...customInputs,
                        [amb.id]: { ...(customInputs[amb.id] || { id: '' }), name: e.target.value },
                      })
                    }
                    className="flex-1 px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-rose-500"
                  />
                  <button
                    onClick={() => handleCustomResolve(amb)}
                    disabled={!customInputs[amb.id]?.id || resolvingId === amb.id}
                    className="px-4 py-1.5 bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded-lg transition cursor-pointer shrink-0"
                  >
                    Применить ID
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
