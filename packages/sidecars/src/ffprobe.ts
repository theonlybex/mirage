import { ProbeInfoSchema, type ProbeInfo } from '@wordedits/shared';
import { SidecarError } from './errors.js';
import { run } from './run.js';

export function parseFps(rate: string): number {
  const m = /^(\d+)\/(\d+)$/.exec(rate.trim());
  if (!m) return 0;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!den || !num) return 0;
  return Math.round((num / den) * 1000) / 1000;
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  color_transfer?: string;
}
interface RawProbe {
  format?: { duration?: string };
  streams?: RawStream[];
}

export async function probe(file: string): Promise<ProbeInfo> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], { timeoutMs: 60_000 });

  let raw: RawProbe;
  try {
    raw = JSON.parse(stdout) as RawProbe;
  } catch {
    throw new SidecarError('ffprobe', 'PARSE', 'ffprobe returned invalid JSON', 'The file may be corrupt.', stdout);
  }

  const v = raw.streams?.find((s) => s.codec_type === 'video');
  const a = raw.streams?.find((s) => s.codec_type === 'audio');
  const info = {
    durationSec: Number(raw.format?.duration ?? 0),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps: v ? parseFps(v.avg_frame_rate ?? v.r_frame_rate ?? '0/0') : 0,
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    colorTransfer: v?.color_transfer ?? null,
  };
  return ProbeInfoSchema.parse(info);
}
