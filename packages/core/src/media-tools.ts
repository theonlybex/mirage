import type { ProbeInfo, Transcript } from '@wordedits/shared';
import * as s from '@wordedits/sidecars';

export type EncoderName = 'h264_videotoolbox' | 'h264_nvenc' | 'libx264';
export interface Encoder {
  name: EncoderName;
  extraArgs: string[];
}

export interface FfmpegRunOptions {
  expectedDurationSec?: number;
  timeoutMs?: number;
  onProgress?: (fraction: number) => void;
  cwd?: string;
  signal?: AbortSignal;
}

/** Everything core needs from the sidecars. Tests pass a stub; the app passes realMediaTools(). */
export interface MediaTools {
  probe(file: string): Promise<ProbeInfo>;
  runFfmpeg(args: string[], opts?: FfmpegRunOptions): Promise<void>;
  pickEncoder(): Promise<Encoder>;
  makeProxy(src: string, out: string, opts?: { height?: number; onProgress?: (f: number) => void }): Promise<void>;
  measureLoudness(file: string, opts?: { audioStream?: number; maxSec?: number }): Promise<{ integratedLufs: number; truePeakDb: number }>;
  extractWav(src: string, out: string, opts?: { timeoutMs?: number; audioStream?: number; signal?: AbortSignal }): Promise<void>;
  transcribe(audioPath: string, opts?: { locale?: string; timeoutMs?: number; signal?: AbortSignal; transcriber?: string }): Promise<Transcript>;
}

// A static import, not import(): the plugin's bundler turns a dynamic import into lazily started modules, and that breaks the
// order the MCP SDK's schemas need. Loading the sidecars costs little: they start no process and read no file until used.
export async function realMediaTools(): Promise<MediaTools> {
  return {
    probe: s.probe,
    runFfmpeg: s.runFfmpeg,
    pickEncoder: s.pickEncoder,
    makeProxy: s.makeProxy,
    measureLoudness: (file, opts) => s.measureLoudness(file, opts),
    extractWav: (src, out, opts) => s.extractWav(src, out, opts),
    transcribe: (audio, opts) => s.transcribeAudio(audio, opts),
  };
}
