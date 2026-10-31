import { run } from './run.js';
import { SidecarError } from './errors.js';
import { probe } from './ffprobe.js';

export interface FfmpegOptions {
  expectedDurationSec?: number;
  timeoutMs?: number;
  onProgress?: (fraction: number) => void;
}

/** Runs ffmpeg with progress reporting. Callers pass everything except -progress/-nostats/-y. */
export async function runFfmpeg(args: string[], opts: FfmpegOptions = {}): Promise<void> {
  const expected = opts.expectedDurationSec ?? 0;
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-y', ...args], {
    timeoutMs: opts.timeoutMs,
    onStdoutLine: (line) => {
      if (!opts.onProgress) return;
      if (line.startsWith('out_time_us=')) {
        const us = Number(line.slice('out_time_us='.length));
        if (expected > 0 && Number.isFinite(us)) {
          opts.onProgress(Math.min(1, Math.max(0, us / 1e6 / expected)));
        }
      } else if (line === 'progress=end') {
        opts.onProgress(1);
      }
    },
  });
}

export type EncoderName = 'h264_videotoolbox' | 'h264_nvenc' | 'libx264';
export interface Encoder {
  name: EncoderName;
  extraArgs: string[];
}

const CANDIDATES: Encoder[] = [
  { name: 'h264_videotoolbox', extraArgs: ['-allow_sw', '1', '-profile:v', 'high'] },
  { name: 'h264_nvenc', extraArgs: ['-preset', 'p5', '-profile:v', 'high', '-bf', '2'] },
  { name: 'libx264', extraArgs: ['-preset', 'medium', '-profile:v', 'high', '-bf', '2', '-flags', '+cgop'] },
];

let encoderCache: Encoder | null = null;
export function _resetEncoderCache(): void {
  encoderCache = null;
}

/** Picks the first candidate that actually encodes on this machine (real 0.1 s test encode). */
export async function pickEncoder(): Promise<Encoder> {
  if (encoderCache) return encoderCache;
  const order = CANDIDATES.filter((c) =>
    c.name === 'libx264' ||
    (c.name === 'h264_videotoolbox' && process.platform === 'darwin') ||
    (c.name === 'h264_nvenc' && process.platform !== 'darwin'),
  );
  for (const cand of order) {
    try {
      await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=black:s=256x144:r=30:d=0.1',
        '-c:v', cand.name, ...cand.extraArgs, '-pix_fmt', 'yuv420p', '-f', 'null', '-',
      ], { timeoutMs: 30_000 });
      encoderCache = cand;
      return cand;
    } catch {
      // try the next candidate
    }
  }
  throw new SidecarError('ffmpeg', 'EXIT', 'No H.264 encoder works', 'Your FFmpeg build has no usable H.264 encoder. Reinstall FFmpeg with libx264.');
}

export async function makeProxy(
  src: string,
  out: string,
  opts: { height?: number; onProgress?: (f: number) => void; expectedDurationSec?: number } = {},
): Promise<void> {
  const h = opts.height ?? 540;
  await runFfmpeg([
    '-i', src,
    '-vf', `scale=-2:${h}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart',
    out,
  ], { onProgress: opts.onProgress, expectedDurationSec: opts.expectedDurationSec ?? (await probe(src)).durationSec });
}

export async function measureLoudness(file: string): Promise<{ integratedLufs: number; truePeakDb: number }> {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ], { timeoutMs: 5 * 60_000 });
  // Only the final "Summary:" block (not the per-frame progress lines, which
  // also contain "I: ... LUFS" text) has the values we want.
  const summaryIdx = stderr.lastIndexOf('Summary:');
  const summary = summaryIdx >= 0 ? stderr.slice(summaryIdx) : stderr;
  const i = /I:\s+(-?[\d.]+)\s+LUFS/.exec(summary);
  const p = /Peak:\s+(-?[\d.]+)\s+dBFS/.exec(summary);
  if (!i || !p) {
    throw new SidecarError('ffmpeg', 'PARSE', 'Could not read loudness from ebur128 output', 'The file may have no audio.', stderr);
  }
  return { integratedLufs: Number(i[1]), truePeakDb: Number(p[1]) };
}
