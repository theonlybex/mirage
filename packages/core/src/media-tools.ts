import type { ProbeInfo, Transcript } from '@wordedits/shared';

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
}

/** Everything core needs from the sidecars. Tests pass a stub; the app passes realMediaTools(). */
export interface MediaTools {
  probe(file: string): Promise<ProbeInfo>;
  runFfmpeg(args: string[], opts?: FfmpegRunOptions): Promise<void>;
  pickEncoder(): Promise<Encoder>;
  makeProxy(src: string, out: string, opts?: { height?: number; onProgress?: (f: number) => void }): Promise<void>;
  measureLoudness(file: string): Promise<{ integratedLufs: number; truePeakDb: number }>;
  extractWav(src: string, out: string): Promise<void>;
  transcribe(audioPath: string, opts?: { locale?: string }): Promise<Transcript>;
}

export async function realMediaTools(): Promise<MediaTools> {
  const s = await import('@wordedits/sidecars');
  return {
    probe: s.probe,
    runFfmpeg: s.runFfmpeg,
    pickEncoder: s.pickEncoder,
    makeProxy: s.makeProxy,
    measureLoudness: s.measureLoudness,
    extractWav: (src, out) => s.extractWav(src, out),
    transcribe: (audio, opts) => s.transcribeAudio(audio, opts),
  };
}
