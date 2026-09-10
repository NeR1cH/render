import React, { useState } from 'react';
import { 
  FileText, 
  UploadCloud, 
  Search, 
  AlertCircle, 
  CheckCircle2, 
  Layers, 
  Code,
  Sparkles
} from 'lucide-react';

export const InspectImporter: React.FC = () => {
  const [jsonInput, setJsonInput] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleInspect = async (payload?: any) => {
    setAnalyzing(true);
    setError(null);
    try {
      const content = payload || jsonInput;
      const res = await fetch('/api/inspect-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to inspect file');
      setResult(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      setJsonInput(content);
      handleInspect(content);
    };
    reader.readAsText(file);
  };

  const loadSample = (type: string) => {
    if (type === 'watching') {
      const sample = {
        data: [
          { id: 1, media_id: 27063, status: 21, media: { name: "Devil May Cry 2", rus_name: "Дьявол может плакать 2" } },
          { id: 2, media_id: 26494, status: 21, media: { name: "Grand Blue Season 3", rus_name: "Необъятный океан 3" } },
          { id: 3, media_id: 22908, status: 21, media: { name: "Class de 2-banme ni Kawaii Onnanoko", rus_name: "Я подружился со второй самой симпатичной" } }
        ]
      };
      setJsonInput(JSON.stringify(sample, null, 2));
      handleInspect(sample);
    } else if (type === 'custom_fate') {
      const sample = {
        status_code: 2280926,
        label: "FATE (пользовательский список)",
        is_custom_list: true,
        count: 3,
        items: [
          { bookmark_id: 21069021, media_id: 9677, status: 2280926, name: "Fate/stay night: Unlimited Blade Works 2", rus_name: "Судьба/Ночь схватки" },
          { bookmark_id: 21069022, media_id: 11061, status: 2280926, name: "Fate/Zero", rus_name: "Судьба/Начало" }
        ]
      };
      setJsonInput(JSON.stringify(sample, null, 2));
      handleInspect(sample);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20 mb-1">
            <FileText className="w-3.5 h-3.5" />
            <span>Аналог команды: python migrate.py --inspect</span>
          </div>
          <h2 className="text-xl sm:text-2xl font-bold text-white font-display">
            Инспектор структуры файлов AnimeLib (.json / .har)
          </h2>
          <p className="text-xs sm:text-sm text-slate-400">
            Проверка экспорта на предмет скрытых кодов статусов, кастомных папок и структуры закладок перед импортом.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white border border-slate-700 transition cursor-pointer">
            <UploadCloud className="w-4 h-4 text-rose-400" />
            <span>Загрузить .json или .har</span>
            <input
              type="file"
              accept=".json,.har"
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>
        </div>
      </div>

      {/* Quick Samples Bar */}
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <span>Быстрые примеры:</span>
        <button
          onClick={() => loadSample('watching')}
          className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800 hover:text-white transition cursor-pointer"
        >
          Пример AnimeLib API (status: 21)
        </button>
        <button
          onClick={() => loadSample('custom_fate')}
          className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800 hover:text-white transition cursor-pointer"
        >
          Пример Fate папки (status: 2280926)
        </button>
      </div>

      {/* Input Textarea */}
      <div className="space-y-2">
        <textarea
          value={jsonInput}
          onChange={(e) => setJsonInput(e.target.value)}
          placeholder="Вставьте сюда сырой JSON ответа AnimeLib или drag-and-drop файл выше..."
          rows={6}
          className="w-full p-4 bg-slate-950 border border-slate-800 rounded-xl font-mono text-xs text-slate-300 placeholder:text-slate-600 focus:outline-none focus:border-rose-500"
        />

        <div className="flex justify-end">
          <button
            onClick={() => handleInspect()}
            disabled={!jsonInput.trim() || analyzing}
            className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-semibold transition cursor-pointer"
          >
            {analyzing ? 'Анализ...' : 'Проверить структуру'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <h3 className="text-base font-bold text-white font-display flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              <span>Результат инспекции</span>
            </h3>
            <span className="text-xs font-mono px-2.5 py-0.5 rounded bg-slate-800 text-slate-300">
              Формат: {result.isHar ? 'HAR Network Archive' : 'JSON Export'}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
              <div className="text-xs text-slate-400">Найдено записей</div>
              <div className="text-2xl font-bold text-white mt-1">{result.totalItems}</div>
            </div>

            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
              <div className="text-xs text-slate-400">Уникальных кодов статуса</div>
              <div className="text-2xl font-bold text-amber-400 mt-1">
                {Object.keys(result.statusCounts || {}).length}
              </div>
            </div>

            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
              <div className="text-xs text-slate-400">Неизвестных кодов</div>
              <div className="text-2xl font-bold text-rose-400 mt-1">
                {result.unknownStatuses?.length || 0}
              </div>
            </div>
          </div>

          {/* Status Breakdown Table */}
          <div>
            <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
              Распределение кодов статусов
            </h4>
            <div className="divide-y divide-slate-800 border border-slate-800 rounded-xl overflow-hidden bg-slate-950 text-xs">
              {Object.entries(result.statusCounts || {}).map(([code, count]: [string, any]) => (
                <div key={code} className="p-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-rose-400 font-semibold">status = {code}</span>
                    {code === '21' && <span className="text-sky-400">(Смотрю / watching)</span>}
                    {code === '22' && <span className="text-amber-400">(В планах / planned)</span>}
                    {code === '23' && <span className="text-rose-400">(Брошено / dropped)</span>}
                    {code === '24' && <span className="text-emerald-400">(Просмотрено / completed)</span>}
                    {code === '25' && <span className="text-pink-400">(Любимое / favorite)</span>}
                    {code === '2280926' && <span className="text-purple-400">(Кастомная папка Fate)</span>}
                    {code === '2643707' && <span className="text-pink-400">(Кастомная папка hent)</span>}
                  </div>
                  <span className="font-bold text-white font-mono">{count} тайтлов</span>
                </div>
              ))}
            </div>
          </div>

          {/* Sample Titles */}
          {result.sampleTitles && result.sampleTitles.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                Примеры тайтлов из файла
              </h4>
              <ul className="list-disc list-inside text-xs text-slate-400 space-y-1 bg-slate-950 p-4 rounded-xl border border-slate-800">
                {result.sampleTitles.map((title: string, idx: number) => (
                  <li key={idx} className="truncate text-slate-300">{title}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
