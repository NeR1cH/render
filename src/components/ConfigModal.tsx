import React from 'react';
import { MigrationStats } from '../types';
import { 
  Settings, 
  ShieldCheck, 
  Key, 
  Bot, 
  Database, 
  ExternalLink,
  Info
} from 'lucide-react';

interface ConfigModalProps {
  stats: MigrationStats | null;
  onClose: () => void;
}

export const ConfigModal: React.FC<ConfigModalProps> = ({ stats, onClose }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-xl w-full p-6 shadow-2xl space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-rose-400" />
            <h3 className="text-lg font-bold text-white font-display">
              Настройки окружения & Shikimori API
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 cursor-pointer text-lg leading-none"
          >
            &times;
          </button>
        </div>

        <div className="space-y-4 text-xs">
          {/* User Agent Security */}
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                User-Agent защита (DDoS-GUARD)
              </span>
              <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                Активен
              </span>
            </div>
            <div className="p-2.5 bg-slate-900 rounded font-mono text-[11px] text-slate-300 break-all border border-slate-800">
              {stats?.config.userAgent || 'ANIME ASSISTANT v2.0 (contact: boykonik2@gmail.com)'}
            </div>
            <p className="text-slate-500 text-[11px] leading-relaxed">
              Shikimori банит дефолтные User-Agent вроде python-requests или AppName/1.0. Строка содержит контакт для верификации администраторами Shikimori.
            </p>
          </div>

          {/* OAuth Token state */}
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                <Key className="w-4 h-4 text-amber-400" />
                OAuth 2.0 Токен пользователя
              </span>
              <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                {stats?.tokenStatus.hasToken ? 'Файл .shikimori_token.json подключен' : 'Не найден'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-slate-400">
              <div>
                Тип токена: <span className="text-white font-mono">{stats?.tokenStatus.tokenType || 'Bearer'}</span>
              </div>
              <div>
                Права: <span className="text-white font-mono">{stats?.tokenStatus.scope || 'user_rates'}</span>
              </div>
            </div>
          </div>

          {/* Telegram / n8n */}
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                <Bot className="w-4 h-4 text-sky-400" />
                Telegram & n8n Автоматизация (Фаза 2)
              </span>
              <span className="text-[10px] text-sky-400 bg-sky-500/10 px-2 py-0.5 rounded border border-sky-500/20">
                Blueprint
              </span>
            </div>
            <p className="text-slate-400 text-[11px] leading-relaxed">
              В репозитории подготовлены сценарии n8n для поиска релизов через AniLiberty API v1 и отправки торрентов в qBittorrent Web API через Telegram-бота.
            </p>
          </div>
        </div>

        <div className="pt-2 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white transition cursor-pointer"
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
};
