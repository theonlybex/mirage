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
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  color_transfer?: string;
  start_time?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}
interface RawProbe {
  format?: { duration?: string; start_time?: string };
  streams?: RawStream[];
}

const num = (s: string | undefined): number | null => {
  const n = s === undefined ? NaN : Number(s);
  return Number.isFinite(n) ? n : null;
};
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Where each stream's packets really end (last timestamp + duration) and how many there are, read by demuxing the
 * whole file (no decoding, so fast): headers can promise more than a cut-short file holds, or nothing at all (a
 * streamed WebM). Null when the scan fails; probe then trusts the headers.
 */
async function scanPackets(file: string): Promise<Map<number, { end: number; count: number }> | null> {
  let stdout: string;
  try {
    // csv prints packet fields in ffprobe's own order: stream_index, pts_time, dts_time, duration_time.
    ({ stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'packet=stream_index,pts_time,dts_time,duration_time', '-of', 'csv=p=0', file], { timeoutMs: 10 * 60_000 }));
  } catch {
    return null;
  }
  const out = new Map<number, { end: number; count: number }>();
  for (const line of stdout.split('\n')) {
    const [idx, pts, dts, dur] = line.split(',');
    const i = num(idx);
    const t = num(pts) ?? num(dts);
    if (i === null || t === null) continue;
    const s = out.get(i) ?? { end: -Infinity, count: 0 };
    s.end = Math.max(s.end, t + (num(dur) ?? 0));
    s.count++;
    out.set(i, s);
  }
  return out;
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

  // Cover art in an audio file is a one-picture "video" stream: not footage.
  const v = raw.streams?.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = raw.streams?.find((s) => s.codec_type === 'audio');
  const audioStreams = raw.streams?.filter((s) => s.codec_type === 'audio').length ?? 0;
  const packets = await scanPackets(file);
  // Times are measured from the container's start, the zero ffmpeg seeks from (-ss) when rendering.
  const start = num(raw.format?.start_time) ?? 0;
  const headerEnd = (s: RawStream) => {
    const d = num(s.duration);
    return d === null ? null : (num(s.start_time) ?? start) + d;
  };
  const end = (s: RawStream | undefined): number | null => {
    if (!s) return null;
    const scanned = packets?.get(s.index ?? -1);
    if (scanned && scanned.count > 0) return scanned.end;
    return packets && packets.size > 0 ? null : headerEnd(s);
  };
  const videoEnd = end(v);
  const audioEnd = end(a);
  const ends = [videoEnd, audioEnd].filter((e): e is number => e !== null);
  const durationSec = ends.length ? Math.max(...ends) - start : (num(raw.format?.duration) ?? 0);
  // A header that promises noticeably more than the packets hold: the copy or recording was cut short.
  const truncated = [v, a].some((s) => {
    const promised = s ? headerEnd(s) : null;
    const real = end(s);
    return promised !== null && real !== null && promised - real > Math.max(0.5, 0.05 * promised);
  });
  // A stream with no packets at all has nothing to show.
  const hasVideo = Boolean(v) && (!packets || packets.size === 0 || videoEnd !== null);

  const rotation = v ? (v.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? num(v.tags?.rotate) ?? 0) : 0;
  const sideways = Math.abs(rotation) % 180 === 90;
  const [w, h] = [v?.width ?? 0, v?.height ?? 0];
  const info = {
    durationSec: r3(Math.max(0, durationSec)),
    width: hasVideo ? (sideways ? h : w) : 0,
    height: hasVideo ? (sideways ? w : h) : 0,
    fps: hasVideo && v ? parseFps(v.avg_frame_rate ?? v.r_frame_rate ?? '0/0') : 0,
    hasVideo,
    hasAudio: Boolean(a),
    videoCodec: hasVideo ? (v?.codec_name ?? null) : null,
    audioCodec: a?.codec_name ?? null,
    colorTransfer: hasVideo ? (v?.color_transfer ?? null) : null,
    ...(hasVideo && videoEnd !== null ? { videoDurationSec: r3(Math.max(0, videoEnd - start)) } : {}),
    ...(truncated ? { truncated } : {}),
    ...(audioStreams > 1 ? { audioStreams } : {}),
  };
  return ProbeInfoSchema.parse(info);
}
