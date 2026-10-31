import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema } from '@wordedits/shared';
import { run } from '@wordedits/sidecars';
import { beforeAll, describe, expect, it } from 'vitest';
import { realMediaTools, type MediaTools } from '../media-tools.js';
import { itemChunkArgs, type ClipSource } from './render-episode.js';
import { layoutTimeline } from './timeline.js';

// Every source frame is a flat grey whose level encodes its frame number (10 fps): Y = 16 + 3N, so a rendered frame
// says which source frame it shows.
const NUMBERED = (d: number) => `color=black:s=64x36:r=10:d=${d},format=gray,geq=lum='16+3*N',format=yuv420p`;
const gen = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/** The source frame number shown by each listed output frame of `file`. */
async function framesShown(file: string, frames: number[]): Promise<number[]> {
  const select = frames.map((n) => `eq(n\\,${n})`).join('+');
  const raw = `${file}.gray`;
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', `select='${select}',scale=1:1:flags=area,format=gray`, '-fps_mode', 'passthrough', '-f', 'rawvideo', raw]);
  return [...(await readFile(raw))].map((y) => Math.round((y - 16) / 3));
}

/** RMS level (dB) of the first audio stream of `file` between `ss` and `ss + t`. */
async function rmsDb(file: string, ss: number, t: number): Promise<number> {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(ss), '-t', String(t), '-i', file, '-map', '0:a:0', '-af', 'astats=metadata=0', '-f', 'null', '-']);
  const m = /Overall[\s\S]*?RMS level dB:\s+(-?[\d.]+|-inf)/.exec(stderr);
  return m && m[1] !== '-inf' ? Number(m[1]) : -Infinity;
}

/** 30 fps frames whose grey level rises with the frame number (one distinct level per frame for 5 s). */
const NUMBERED30 = (d: number) => `color=black:s=64x36:r=30:d=${d},format=gray,geq=lum='16+1.5*N',format=yuv420p`;

/** The grey level of every frame of `file`, in order. */
async function levels(file: string): Promise<Buffer> {
  const raw = `${file}.levels`;
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0:v', '-vf', 'scale=1:1:flags=area,format=gray', '-fps_mode', 'passthrough', '-f', 'rawvideo', raw]);
  return readFile(raw);
}

const ep = (items: object[], fps = 10) => EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 64, height: 36, fps }, items });

describe('item timing against the source clock (real ffmpeg)', () => {
  let tools: MediaTools;
  let dir: string;
  beforeAll(async () => {
    tools = await realMediaTools();
    dir = await mkdtemp(join(tmpdir(), 'we-sync-'));
    // A screen recording that wrote no frames while the screen was still: frames 0–19 (0–1.9 s), then 51–59 (5.1–5.9 s).
    await gen(['-f', 'lavfi', '-i', `${NUMBERED(6)},select='not(between(t\\,2\\,5))'`, '-c:v', 'libx264', '-qp', '0', '-g', '600', '-fps_mode', 'vfr', join(dir, 'gap.mp4')]);
    // Video that starts 1.5 s after the container (its audio) starts.
    await gen(['-f', 'lavfi', '-i', NUMBERED(4), '-c:v', 'libx264', '-qp', '0', join(dir, 'v.mp4')]);
    await gen(['-itsoffset', '1.5', '-i', join(dir, 'v.mp4'), '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=6', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', join(dir, 'video-late.mp4')]);
    // Audio that starts 1.5 s after the video (and the container).
    await gen(['-f', 'lavfi', '-i', NUMBERED(6), '-c:v', 'libx264', '-qp', '0', join(dir, 'v6.mp4')]);
    await gen(['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=4', '-c:a', 'aac', join(dir, 'tone.m4a')]);
    await gen(['-i', join(dir, 'v6.mp4'), '-itsoffset', '1.5', '-i', join(dir, 'tone.m4a'), '-map', '0:v', '-map', '1:a', '-c', 'copy', join(dir, 'audio-late.mp4')]);
  }, 60_000);

  const render = async (name: string, items: object[], sources: Map<string, ClipSource>) => {
    const out = join(dir, `${name}.mov`);
    await tools.runFfmpeg(itemChunkArgs(layoutTimeline(ep(items)), { width: 64, height: 36, fps: 10 }, sources, out));
    return out;
  };

  it('holds the last frame across a gap in a VFR recording instead of jumping ahead, at any speed', async () => {
    const sources = new Map([['c001', { path: join(dir, 'gap.mp4'), hasAudio: false, durationSec: 6 }]]);
    const out = await render('gap', [
      // 3.0–5.5 s: still screen until 5.1 s.
      { id: 'a', beat: 'problem', clip: 'c001', src: { in: 3, out: 5.5 } },
      // 1.0–5.6 s at 2x: output frame k shows source 1 + 0.2k.
      { id: 'b', beat: 'montage', clip: 'c001', src: { in: 1, out: 5.6 }, speed: 2 },
    ], sources);
    // Item a: frames 0–20 are source 3.0–5.0 s, all showing frame 19 (1.9 s); frame 21 is 5.1 s.
    expect(await framesShown(out, [0, 5, 20, 21, 24])).toEqual([19, 19, 19, 51, 54]);
    // Item b starts at output frame 25.
    expect(await framesShown(out, [25, 29, 30, 45, 46])).toEqual([10, 18, 19, 19, 52]);
  }, 60_000);

  it('shows a video stream that starts after the container at its own time, not early', async () => {
    const sources = new Map([['c001', { path: join(dir, 'video-late.mp4'), hasAudio: true, durationSec: 6 }]]);
    const out = await render('video-late', [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 3 }, audio: 'keep' }], sources);
    // Video frame N is at 1.5 + N/10 s: before 1.5 s the first frame waits; output frame 20 (2.0 s) is frame 5.
    expect(await framesShown(out, [0, 14, 15, 20, 29])).toEqual([0, 0, 0, 5, 14]);
  }, 60_000);

  it('keeps audio that starts after the video in sync: silence first, never shifted earlier', async () => {
    const sources = new Map([['c001', { path: join(dir, 'audio-late.mp4'), hasAudio: true, durationSec: 6 }]]);
    const out = await render('audio-late', [
      { id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 3 }, audio: 'keep' },
      { id: 'b', beat: 'problem', clip: 'c001', src: { in: 1, out: 3 }, audio: 'keep' },
    ], sources);
    expect(await rmsDb(out, 0, 1.4)).toBeLessThan(-80);
    expect(await rmsDb(out, 1.6, 1.3)).toBeGreaterThan(-30);
    // Item b (output 3–5 s) starts at source 1 s: half a second of silence, then the tone.
    expect(await rmsDb(out, 3.05, 0.4)).toBeLessThan(-80);
    expect(await rmsDb(out, 3.6, 1.3)).toBeGreaterThan(-30);
    expect(await framesShown(out, [0, 29, 30])).toEqual([0, 29, 10]);
  }, 60_000);

  it('shows every frame once of MKV and WebM footage, whose timestamps are rounded to the millisecond', async () => {
    // 30 fps frame N is stored at N/30 rounded to the ms: frame 2 at 0.067 s, a little after its true 0.0667 s.
    await gen(['-f', 'lavfi', '-i', NUMBERED30(3.5), '-c:v', 'libx264', '-qp', '0', join(dir, 'v30.mkv')]);
    await gen(['-f', 'lavfi', '-i', NUMBERED30(5), '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=5', '-c:v', 'libvpx-vp9', '-lossless', '1', '-c:a', 'libopus', join(dir, 'v30.webm')]);
    const sources = new Map([
      ['c001', { path: join(dir, 'v30.mkv'), hasAudio: false, durationSec: 3.5 }],
      ['c002', { path: join(dir, 'v30.webm'), hasAudio: true, durationSec: 5 }],
    ]);
    const out = join(dir, 'ms.mov');
    const items = [
      { id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 3 } },
      { id: 'b', beat: 'problem', clip: 'c002', src: { in: 2.5, out: 4.5 }, audio: 'keep' },
    ];
    await tools.runFfmpeg(itemChunkArgs(layoutTimeline(ep(items, 30)), { width: 64, height: 36, fps: 30 }, sources, out));
    // Output frame k of item a is source frame k, and of item b source frame 75 + k: no frame doubled, none dropped.
    const [mkv, webm, rendered] = await Promise.all([levels(join(dir, 'v30.mkv')), levels(join(dir, 'v30.webm')), levels(out)]);
    expect(rendered.subarray(0, 90)).toEqual(mkv.subarray(0, 90));
    expect(rendered.subarray(90, 150)).toEqual(webm.subarray(75, 135));
  }, 60_000);

  it('keeps the audio stream the catalog chose', async () => {
    const f = join(dir, 'tracks.mov');
    await gen(['-f', 'lavfi', '-i', NUMBERED(3), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=3',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-c:a', 'aac', '-t', '3', f]);
    const item = [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 2 }, audio: 'keep' }];
    expect(await rmsDb(await render('track-1', item, new Map([['c001', { path: f, hasAudio: true, durationSec: 3 }]])), 0.2, 1.5)).toBeLessThan(-80);
    expect(await rmsDb(await render('track-2', item, new Map([['c001', { path: f, hasAudio: true, durationSec: 3, audioStream: 1 }]])), 0.2, 1.5)).toBeGreaterThan(-30);
  }, 60_000);
});
