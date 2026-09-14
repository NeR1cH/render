export type StreamQuality = '360p' | '480p' | '720p' | '1080p' | '2160p' | 'auto';

export type StreamFormat = 'mp4' | 'm3u8';

export interface StreamResult {
  url: string;
  quality: StreamQuality;
  format: StreamFormat;
  headers?: Record<string, string>;
  voiceover?: string;
  source: string;
}

export interface EpisodeQuery {
  mediaId: number;
  episode: number;
  voiceover?: string;
  preferredQuality?: string;
}

export interface ISourcePlugin {
  readonly id: string;
  readonly name: string;
  readonly priority: number;

  getStreams(query: EpisodeQuery): Promise<StreamResult[]>;
  resolveStream(query: EpisodeQuery): Promise<StreamResult | null>;
}
