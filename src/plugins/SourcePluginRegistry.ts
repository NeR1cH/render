import { EpisodeQuery, ISourcePlugin, StreamResult } from './types.js';
import { AnimelibPlugin } from './adapters/AnimelibPlugin.js';
import { KodikPlugin } from './adapters/KodikPlugin.js';

export class SourcePluginRegistry {
  private plugins: ISourcePlugin[] = [];

  constructor() {
    this.registerDefaultPlugins();
  }

  registerPlugin(plugin: ISourcePlugin): void {
    const existingIndex = this.plugins.findIndex((p) => p.id === plugin.id);
    if (existingIndex >= 0) {
      this.plugins[existingIndex] = plugin;
    } else {
      this.plugins.push(plugin);
    }
    // Сортировка по приоритету (наивысший приоритет первым)
    this.plugins.sort((a, b) => b.priority - a.priority);
  }

  getPlugins(): readonly ISourcePlugin[] {
    return this.plugins;
  }

  getPlugin(id: string): ISourcePlugin | undefined {
    return this.plugins.find((p) => p.id === id);
  }

  /**
   * Разрешает стрим с плавным переключением (fallback):
   * 1. Сначала опрашивает нативные плееры AnimelibPlugin с сохранением качества и озвучки.
   * 2. Если нативные потоки не найдены — переключается на KodikPlugin.
   */
  async resolveStreamWithFallback(query: EpisodeQuery): Promise<StreamResult | null> {
    for (const plugin of this.plugins) {
      try {
        const stream = await plugin.resolveStream(query);
        if (stream && stream.url) {
          return stream;
        }
      } catch (err) {
        console.warn(`[SourcePluginRegistry] Ошибка в плагине ${plugin.id}:`, err);
      }
    }
    return null;
  }

  /**
   * Получает все доступные стримы со всех зарегистрированных плагинов.
   */
  async getAllStreams(query: EpisodeQuery): Promise<StreamResult[]> {
    const all: StreamResult[] = [];
    for (const plugin of this.plugins) {
      try {
        const streams = await plugin.getStreams(query);
        all.push(...streams);
      } catch (err) {
        console.warn(`[SourcePluginRegistry] Не удалось получить стримы из ${plugin.id}:`, err);
      }
    }
    return all;
  }

  private registerDefaultPlugins(): void {
    this.registerPlugin(new AnimelibPlugin());
    this.registerPlugin(new KodikPlugin());
  }
}

export const sourceRegistry = new SourcePluginRegistry();
