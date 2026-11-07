// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type Catalog } from '@wordedits/shared';
import { run } from '@wordedits/sidecars';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { realMediaTools, type MediaTools } from '../media-tools.js';
import { saveCatalog } from './ingest.js';
import { bundledFontsDir } from './fonts.js';
import { renderEpisode, saveEpisode } from './render-episode.js';
import {
  candidatesReport, cutLoudness, formatThumbTime, thumbCandidates, thumbnailAss, thumbnailReport, thumbSize, thumbSource, thumbWordCount, writeCandidates, writeThumbnail,
} from './thumbnail.js';

// Renames and removals go through as usual; a test makes one fail as a file held open by another app would.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});

const clip = (id: string, moments: { t: number; label: string }[] = []): Catalog['clips'][number] => ({
  id, path: `/x/${id}.mp4`, sha256: 'a'.repeat(64), kind: 'screen', transcript: null, frames: [], notes: '', moments,
  probe: { durationSec: 120, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', colorTransfer: null },
});
const catalog = (...clips: Catalog['clips']): Catalog => ({ version: 1, clips });
const ep = (items: object[]) => EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items });
const item = (id: string, src: [number, number], extra: object = {}) => ({ id, beat: 'problem', clip: 'c001', src: { in: src[0], out: src[1] }, ...extra });
const card = (id: string, sec: number, extra: object = {}) => ({ id, beat: 'title', card: { text: 'hi', style: 'bold', sec }, ...extra });
/** The middle of the 30 fps output frame showing `t`: where a candidate at `t` is given. */
const fc = (t: number) => (Math.floor(t * 30 + 1e-6) + 0.5) / 30;
const flat = (from: number, to: number, lufs = -40) => Array.from({ length: Math.round((to - from) / 0.1) }, (_, i) => ({ t: from + i * 0.1, lufs }));

describe('thumbCandidates', () => {
  it('goes moments, then loudest moments, then beats, then even spacing', () => {
    const e = ep([
      item('a', [10, 20], { audio: 'keep' }),
      item('b', [0, 10], { beat: 'truth' }),
      item('c', [30, 40]),
    ]);
    const cat = catalog(clip('c001', [{ t: 12, label: 'laughs' }]));
    const loud = [...flat(0, 10), { t: 6, lufs: -12 }];
    const r = thumbCandidates(e, cat, loud);
    expect(r.slice(0, 4)).toEqual([
      { t: fc(2), reason: 'moment: laughs' },
      { t: fc(6), reason: 'loudest moment of item a' },
      { t: fc(15), reason: 'truth beat (item b)' },
      { t: fc(3.75), reason: 'even spacing' },
    ]);
    expect(r).toHaveLength(12);
    expect(r.slice(3).every((c) => c.reason === 'even spacing')).toBe(true);
  });

  it('drops a pick within 1.0 s of an earlier one and keeps one exactly 1.0 s away', () => {
    const e = ep([item('a', [0, 30], { audio: 'keep', beat: 'reveal' })]);
    const cat = catalog(clip('c001', [{ t: 10, label: 'm' }]));
    // The loudest point is 0.5 s from the moment: dropped. The middle (15 s) is far.
    const near = thumbCandidates(e, cat, [{ t: 10.5, lufs: -10 }], 3);
    expect(near.map((c) => c.reason)).toEqual(['moment: m', 'reveal beat (item a)', 'even spacing']);
    const apart = thumbCandidates(e, cat, [{ t: 11, lufs: -10 }], 3);
    expect(apart).toEqual([
      { t: fc(10), reason: 'moment: m' },
      { t: fc(11), reason: 'loudest moment of item a' },
      { t: fc(15), reason: 'reveal beat (item a)' },
    ]);
  });

  it('never gives more than 12, or than max', () => {
    const moments = Array.from({ length: 30 }, (_, i) => ({ t: i * 2 + 1, label: `m${i}` }));
    const e = ep([item('a', [0, 60])]);
    const r = thumbCandidates(e, catalog(clip('c001', moments)), []);
    expect(r).toHaveLength(12);
    expect(r.every((c) => c.reason.startsWith('moment: '))).toBe(true);
    expect(thumbCandidates(e, catalog(clip('c001', moments)), [], 5)).toHaveLength(5);
  });

  it('maps a moment to every output time that shows it, through the item speed', () => {
    const e = ep([
      item('a', [0, 20]),
      item('b', [4, 24], { speed: 4 }),
      item('c', [100, 110]),
      item('d', [5, 8]),
    ]);
    // a: 20 s; b: 5 s (starts at 20); c is a window of the clip without the moment; d starts at 35.
    const r = thumbCandidates(e, catalog(clip('c001', [{ t: 8, label: 'oops' }, { t: 90, label: 'elsewhere' }])), []);
    const moments = r.filter((c) => c.reason === 'moment: oops');
    expect(moments.map((c) => c.t)).toEqual([fc(8), fc(21)]);
    expect(r.some((c) => c.reason === 'moment: elsewhere')).toBe(false);
  });

  it('maps a moment of a clip that appears twice, each counted against the cap', () => {
    const e = ep([item('a', [0, 10]), item('b', [0, 10]), item('c', [0, 10])]);
    const r = thumbCandidates(e, catalog(clip('c001', [{ t: 5, label: 'x' }])), [], 2);
    expect(r).toEqual([{ t: fc(5), reason: 'moment: x' }, { t: fc(15), reason: 'moment: x' }]);
  });

  it('leaves out a moment at or after the end of the piece, and one before its start', () => {
    const e = ep([item('a', [5, 10])]);
    const r = thumbCandidates(e, catalog(clip('c001', [{ t: 4.99, label: 'before' }, { t: 10, label: 'end' }, { t: 5, label: 'start' }])), [], 1);
    expect(r).toEqual([{ t: fc(0), reason: 'moment: start' }]);
  });

  it('gives each time as the middle of the output frame showing it, so a moment on an item\'s first frame stays on that item', () => {
    // a is 37 frames (1.2333… s, not a whole millisecond); b starts on frame 37 and shows its moment there.
    const e = ep([item('a', [0, 37 / 30]), item('b', [50, 52], { clip: 'c002' })]);
    const [m] = thumbCandidates(e, catalog(clip('c001'), clip('c002', [{ t: 50, label: 'start' }])), [], 1);
    expect(m).toEqual({ t: 37.5 / 30, reason: 'moment: start' });
    // Rounded to the millisecond as the reply writes it, it is still frame 37: item b's first frame.
    const shown = thumbSource(e, Math.round(m!.t * 1000) / 1000);
    expect([shown.laid.item.id, 'src' in shown && shown.src]).toEqual(['b', 50]);
    // Every pick is a frame's middle.
    for (const c of thumbCandidates(e, catalog(clip('c001')), [{ t: 0.4567, lufs: -10 }])) expect(c.t * 30 - Math.floor(c.t * 30)).toBeCloseTo(0.5, 6);
  });

  it('picks the loudest reading inside each item with its own sound at real time, and only there', () => {
    const e = ep([
      item('a', [0, 10], { audio: 'keep' }),
      item('b', [0, 10], { audio: 'keep', speed: 2 }),
      item('c', [0, 10], { audio: 'mute' }),
      item('d', [0, 10], { audio: 'keep' }),
    ]);
    // a: 0–10, b: 10–15, c: 15–25, d: 25–35. Loud readings in b and c are ignored; a gets 3.5, d gets 30.
    const loud = [...flat(0, 35), { t: 3.5, lufs: -15 }, { t: 12, lufs: -5 }, { t: 20, lufs: -5 }, { t: 30, lufs: -20 }, { t: 9.95, lufs: -16 }];
    const r = thumbCandidates(e, catalog(clip('c001')), loud, 2);
    expect(r).toEqual([{ t: fc(3.5), reason: 'loudest moment of item a' }, { t: fc(30), reason: 'loudest moment of item d' }]);
  });

  it('ignores silent readings, and a reading outside the picture of an item (its held frames)', () => {
    const e = ep([item('a', [0, 2], { audio: 'keep', hold: 3 })]);
    const silent = thumbCandidates(e, catalog(clip('c001')), flat(0, 2, -90).concat([{ t: 1, lufs: -80 }]), 1);
    expect(silent[0]!.reason).toBe('even spacing');
    const held = thumbCandidates(e, catalog(clip('c001')), [{ t: 3, lufs: -10 }], 1);
    expect(held[0]!.reason).toBe('even spacing');
  });

  it('takes the middle of the beats that make the point, held frames included, cards too', () => {
    const e = ep([
      item('a', [0, 4], { beat: 'problem' }),
      item('b', [0, 4], { beat: 'truth', hold: 2 }),
      card('c', 2, { beat: 'headline' }),
      item('d', [0, 4], { beat: 'payoff' }),
      item('e', [0, 4], { beat: 'twist' }),
      item('f', [0, 4], { beat: 'reveal' }),
      item('g', [0, 4], { beat: 'montage' }),
    ]);
    const r = thumbCandidates(e, catalog(clip('c001')), [], 5);
    expect(r).toEqual([
      { t: fc(7), reason: 'truth beat (item b)' },
      { t: fc(11), reason: 'headline beat (item c)' },
      { t: fc(14), reason: 'payoff beat (item d)' },
      { t: fc(18), reason: 'twist beat (item e)' },
      { t: fc(22), reason: 'reveal beat (item f)' },
    ]);
  });

  it('spaces the rest evenly over the video, and gives fewer than 12 for a short one', () => {
    const e = ep([item('a', [0, 24])]);
    const r = thumbCandidates(e, catalog(clip('c001')), []);
    expect(r.map((c) => c.t)).toEqual(Array.from({ length: 12 }, (_, i) => fc(1 + 2 * i)));
    expect(r.every((c) => c.reason === 'even spacing')).toBe(true);
    const short = thumbCandidates(ep([item('a', [0, 5])]), catalog(clip('c001')), []);
    expect(short).toHaveLength(5);
    expect(short.every((c) => c.t > 0 && c.t < 5)).toBe(true);
    for (const a of short) for (const b of short) if (a !== b) expect(Math.abs(a.t - b.t)).toBeGreaterThanOrEqual(1 - 1e-9);
  });

  it('fills with even spacing around the picks already made', () => {
    const e = ep([item('a', [0, 24])]);
    const r = thumbCandidates(e, catalog(clip('c001', [{ t: 1.5, label: 'm' }])), []);
    expect(r).toHaveLength(12);
    expect(r[0]).toEqual({ t: fc(1.5), reason: 'moment: m' });
    for (const a of r) for (const b of r) if (a !== b) expect(Math.abs(a.t - b.t)).toBeGreaterThanOrEqual(1 - 1e-9);
  });

  it('gives beats and even spacing for a video of only cards', () => {
    const e = ep([card('a', 6), card('b', 6, { beat: 'reveal' }), card('c', 6)]);
    const r = thumbCandidates(e, catalog(), []);
    expect(r[0]).toEqual({ t: fc(9), reason: 'reveal beat (item b)' });
    expect(r.slice(1).every((c) => c.reason === 'even spacing')).toBe(true);
    expect(r).toHaveLength(12);
  });

  it('gives candidates for a video without sound, and for clips missing from the catalog', () => {
    const e = ep([item('a', [0, 10], { audio: 'keep' }), item('b', [0, 10], { beat: 'twist', clip: 'c404' })]);
    const r = thumbCandidates(e, catalog(), []);
    expect(r[0]).toEqual({ t: fc(15), reason: 'twist beat (item b)' });
    expect(r).toHaveLength(12);
  });
});

describe('formatThumbTime', () => {
  it('writes m:ss.s, rounding the whole value', () => {
    expect([0, 1.74, 9.96, 59.96, 61.5, 600].map(formatThumbTime)).toEqual(['0:00.0', '0:01.7', '0:10.0', '1:00.0', '1:01.5', '10:00.0']);
  });
});

describe('candidatesReport', () => {
  it('names the cut and lists a line per frame: its time, the at that writes it, and why', () => {
    const frames = [{ t: 1.74, reason: 'moment: x', file: 'cand-01.jpg' }, { t: 65, reason: 'even spacing', file: 'cand-02.jpg' }, { t: 371.5 / 30, reason: 'moment: y', file: 'cand-03.jpg' }];
    expect(candidatesReport(2, { source: 'rough.mp4', timelineChanged: false, frames })).toEqual([
      'wrote 3 candidate frames to episodes/2/thumbs/ (from rough.mp4)',
      'cand-01.jpg  0:01.7  at 1.74  moment: x',
      'cand-02.jpg  1:05.0  at 65  even spacing',
      'cand-03.jpg  0:12.4  at 12.383  moment: y',
    ]);
  });
  it('ends with a warning when the timeline changed after the cut', () => {
    expect(candidatesReport(2, { source: 'final.mp4', timelineChanged: true, frames: [{ t: 1, reason: 'even spacing', file: 'cand-01.jpg' }] }).slice(1)).toEqual([
      'cand-01.jpg  0:01.0  at 1  even spacing',
      '⚠ the timeline changed after final.mp4 was made — run cut again for frames that match',
    ]);
  });
});

describe('thumbSize', () => {
  it('is 1280×720 for a video wider than tall, else the 1080×1920 cover', () => {
    expect([[1920, 1080], [3840, 2160], [320, 180], [1080, 1920], [1080, 1080], [180, 320]].map(([width, height]) => thumbSize({ width: width!, height: height! }))).toEqual([
      { width: 1280, height: 720 }, { width: 1280, height: 720 }, { width: 1280, height: 720 }, { width: 1080, height: 1920 }, { width: 1080, height: 1920 }, { width: 1080, height: 1920 },
    ]);
  });
});

describe('thumbSource', () => {
  // a 0–4 s; b 4–7 s (12 s of clip at 4×); c 7–9.5 s (1.5 s, then held 1 s); d a card 9.5–11.5 s; e 11.5–13.5 s with a move.
  const e = ep([
    item('a', [0, 4]),
    item('b', [0, 12], { speed: 4 }),
    item('c', [0, 1.5], { hold: 1 }),
    card('d', 2),
    item('e', [3, 5], { move: { zoom: 2, focus: { x: 0 } } }),
  ]);
  const where = (at: number, x = e) => {
    const r = thumbSource(x, at);
    return 'src' in r ? { id: r.laid.item.id, src: Math.round(r.src * 1e6) / 1e6 } : { id: r.laid.item.id, card: true };
  };

  it('finds the clip time an output time shows, through speed, on the frame showing it', () => {
    expect(where(0)).toEqual({ id: 'a', src: 0 });
    expect(where(1.01)).toEqual({ id: 'a', src: 1 });
    expect(where(3.999)).toEqual({ id: 'a', src: 3.966667 });
    expect(where(4)).toEqual({ id: 'b', src: 0 });
    expect(where(4.6)).toEqual({ id: 'b', src: 2.4 });
    expect(where(6.99)).toEqual({ id: 'b', src: 11.866667 });
    expect(where(8)).toEqual({ id: 'c', src: 1 });
  });

  it('gives the held frame during a hold, a card as a card, and the source frame under a move', () => {
    expect(where(8.5)).toEqual({ id: 'c', src: 1.5 });
    expect(where(9)).toEqual({ id: 'c', src: 1.5 });
    expect(where(9.49)).toEqual({ id: 'c', src: 1.5 });
    expect(where(9.5)).toEqual({ id: 'd', card: true });
    expect(where(11.4)).toEqual({ id: 'd', card: true });
    expect(where(12)).toEqual({ id: 'e', src: 3.5 });
    expect(where(13.49)).toEqual({ id: 'e', src: 4.966667 });
  });

  it('holds the frame the render holds when the shot\'s frames round past src.out', () => {
    // 2.02 s is 61 frames at 30 fps: the render clones its frame 61, 2.033 s into the clip (the last there is, if the clip ends before).
    expect(where(2.5, ep([item('f', [0, 2.02], { hold: 1 })]))).toEqual({ id: 'f', src: 2.033333 });
  });

  it('refuses a time outside the video', () => {
    for (const at of [13.5, 20, -0.01, Number.NaN]) {
      expect(() => thumbSource(e, at)).toThrow(expect.objectContaining({ name: 'MirageError', message: `${at} s is outside the video (0–13.5 s)`, hint: '' }));
    }
  });
});

describe('thumbWordCount', () => {
  it('counts words, not emoji or dashes', () => {
    expect(['one two three four', '  a  b ', '🚀 🔥', 'Fix it — fast', 'big {win} 🚀 now', "it's 100% real"].map(thumbWordCount)).toEqual([4, 2, 0, 3, 3, 3]);
  });
});

describe('thumbnailAss', () => {
  it('writes the text in capitals, white with a black outline in the bundled face: in the lower third, or at 60% on a vertical cover', () => {
    const ass = thumbnailAss(1280, 720, 'Big {win} 🚀 now\\');
    expect(ass).toContain('PlayResX: 1280\nPlayResY: 720\n');
    // Size px(150) and outline px(10) for a 720-px short side (k = 2/3): 100 and 7.
    expect(ass).toContain('Style: Thumb,Montserrat ExtraBold,100,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,7,0,5,64,64,0,1\n');
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:10.00,Thumb,,0,0,0,,{\\pos(640,600)}BIG (WIN) NOW/\n');
    const tall = thumbnailAss(1080, 1920, 'Wow');
    expect(tall).toContain('Style: Thumb,Montserrat ExtraBold,150,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,10,0,5,54,54,0,1\n');
    // Clear of the bottom 20% the Shorts and Reels buttons cover.
    expect(tall).toContain(',{\\pos(540,1152)}WOW\n');
  });
});

describe('thumbnailReport', () => {
  it('says where it came from', () => {
    expect(thumbnailReport(2, { file: '/p/episodes/2/thumbnail.jpg', width: 1280, height: 720, from: { clip: 'c001', src: 2.4 } })).toBe('wrote episodes/2/thumbnail.jpg (1280×720, from c001 at 2.4 s)');
    expect(thumbnailReport(2, { file: '/p/episodes/2/thumbnail.jpg', width: 1080, height: 1920, from: { clip: 'c002', src: 11.866667 } })).toBe('wrote episodes/2/thumbnail.jpg (1080×1920, from c002 at 11.87 s)');
    expect(thumbnailReport(3, { file: '/p/episodes/3/thumbnail.jpg', width: 1080, height: 1920, from: 'card' })).toBe('wrote episodes/3/thumbnail.jpg (1080×1920, from the card)');
  });
});

describe('writeCandidates and cutLoudness (real ffmpeg)', () => {
  let tools: MediaTools;
  let root: string;
  const ff = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  /** Colour changes every second: red, green, blue, red … and a loud tone from 3.0 to 3.4 s only. */
  const cutArgs = (out: string, o: { audio?: boolean; w?: number; h?: number; sec?: number } = {}) => [
    '-f', 'lavfi', '-i', `nullsrc=s=${o.w ?? 320}x${o.h ?? 180}:r=30:d=${o.sec ?? 8},geq=r='255*eq(mod(floor(T),3),0)':g='255*eq(mod(floor(T),3),1)':b='255*eq(mod(floor(T),3),2)',format=yuv420p`,
    ...(o.audio === false ? [] : ['-f', 'lavfi', '-i', `aevalsrc='0.01*sin(2*PI*220*t)+0.5*sin(2*PI*440*t)*between(t,3.0,3.4)':s=48000:d=${o.sec ?? 8}`, '-c:a', 'aac']),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '1000', out,
  ];
  /** The average colour of a picture as [r, g, b]. */
  async function colour(file: string): Promise<number[]> {
    const raw = join(root, `px-${Math.random().toString(36).slice(2)}.rgb`);
    await ff(['-i', file, '-vf', 'scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]).catch((e) => { throw new Error(`${e.hint} ${e.stderr ?? ''}`); });
    const b = await readFile(raw);
    return [...b];
  }
  const near = (c: number[], want: 'red' | 'green' | 'blue') => {
    const i = { red: 0, green: 1, blue: 2 }[want];
    return c[i]! > 200 && c.every((v, j) => j === i || v < 60);
  };
  const size = async (file: string) => {
    const p = await tools.probe(file);
    return [p.width, p.height];
  };
  const episode = (extraItems: object[] = []) =>
    EpisodeSchema.parse({
      version: 2, number: 1, title: 't', output: { width: 320, height: 180, fps: 30 },
      items: [item('a', [0, 4], { audio: 'keep' }), item('b', [4, 8], { beat: 'truth' }), ...extraItems],
    });
  async function project(name = 'proj', opts: { cut?: 'final' | 'rough' | 'both' | 'none'; audio?: boolean; moments?: { t: number; label: string }[]; w?: number; h?: number } = {}) {
    const dir = join(root, name);
    await mkdir(join(dir, 'episodes', '1'), { recursive: true });
    await writeFile(join(dir, 'mirage.json'), JSON.stringify({ version: 1, title: 'p', createdAt: new Date().toISOString() }));
    await saveCatalog(dir, catalog(clip('c001', opts.moments ?? [])));
    await saveEpisode(dir, episode());
    const cut = opts.cut ?? 'rough';
    if (cut === 'rough' || cut === 'both') await ff(cutArgs(join(dir, 'episodes', '1', 'rough.mp4'), { audio: opts.audio, w: opts.w, h: opts.h }));
    if (cut === 'final' || cut === 'both') await ff(cutArgs(join(dir, 'episodes', '1', 'final.mp4'), { audio: opts.audio, w: opts.w, h: opts.h }));
    return dir;
  }

  beforeAll(async () => {
    tools = await realMediaTools();
    root = await mkdtemp(join(tmpdir(), "mirage thumb 'q' "));
  });

  it('measures the cut loudness every 100 ms, a reading at the middle of the 400 ms it covers', async () => {
    const dir = await project('loud');
    const l = await cutLoudness(join(dir, 'episodes', '1', 'rough.mp4'), tools);
    expect(l.length).toBeGreaterThanOrEqual(79);
    expect(l[5]!.t - l[4]!.t).toBeCloseTo(0.1, 6);
    const loudest = l.reduce((a, b) => (b.lufs > a.lufs ? b : a));
    expect(loudest.t).toBeGreaterThan(3.0);
    expect(loudest.t).toBeLessThan(3.5);
    expect(l.find((r) => r.t > 6)!.lufs).toBeLessThan(loudest.lufs - 20);
  });

  it('writes the frames at the cut size, the exact frame of each time, and says where they came from', async () => {
    // Moments at 0.95 s (red), 2.05 s (blue) and 4.5 s (green): a seek that stopped at the keyframe would give red every time.
    const dir = await project('frames', { moments: [{ t: 0.95, label: 'one' }, { t: 2.05, label: 'two' }, { t: 4.5, label: 'three' }] });
    const r = await writeCandidates(dir, 1, tools);
    expect(r.source).toBe('rough.mp4');
    expect(r.timelineChanged).toBe(false);
    expect(r.frames.slice(0, 3)).toEqual([
      { t: fc(0.95), reason: 'moment: one', file: 'cand-01.jpg' },
      { t: fc(2.05), reason: 'moment: two', file: 'cand-02.jpg' },
      { t: fc(4.5), reason: 'moment: three', file: 'cand-03.jpg' },
    ]);
    expect(r.frames[3]!.reason).toBe('loudest moment of item a');
    expect(r.frames[3]!.t).toBeGreaterThan(3.0);
    expect(r.frames[3]!.t).toBeLessThan(3.5);
    const thumbs = join(dir, 'episodes', '1', 'thumbs');
    expect(r.frames.map((f) => f.file)).toEqual((await readdir(thumbs)).sort());
    expect(await size(join(thumbs, 'cand-01.jpg'))).toEqual([320, 180]);
    expect(near(await colour(join(thumbs, 'cand-01.jpg')), 'red')).toBe(true);
    expect(near(await colour(join(thumbs, 'cand-02.jpg')), 'blue')).toBe(true);
    expect(near(await colour(join(thumbs, 'cand-03.jpg')), 'green')).toBe(true);
    // The truth beat's middle (6 s) is red again.
    const beat = r.frames.find((f) => f.reason === 'truth beat (item b)')!;
    expect(beat.t).toBe(fc(6));
    expect(near(await colour(join(thumbs, beat.file)), 'red')).toBe(true);
  });

  it('writes at 1080p-shaped and portrait sizes as the cut is', async () => {
    const dir = await project('portrait', { w: 180, h: 320 });
    const r = await writeCandidates(dir, 1, tools);
    expect(await size(join(dir, 'episodes', '1', 'thumbs', r.frames[0]!.file))).toEqual([180, 320]);
  });

  it('uses the newer of final.mp4 and rough.mp4, final on a tie, and the one there is', async () => {
    const dir = await project('both', { cut: 'both' });
    const ep1 = join(dir, 'episodes', '1');
    const at = (f: string, ago: number) => utimes(join(ep1, f), new Date(Date.now() - ago), new Date(Date.now() - ago));
    await at('final.mp4', 60_000);
    await at('rough.mp4', 1000);
    expect((await writeCandidates(dir, 1, tools)).source).toBe('rough.mp4');
    await at('final.mp4', 1000);
    await at('rough.mp4', 60_000);
    expect((await writeCandidates(dir, 1, tools)).source).toBe('final.mp4');
    const t = new Date(Date.now() - 5000);
    await utimes(join(ep1, 'final.mp4'), t, t);
    await utimes(join(ep1, 'rough.mp4'), t, t);
    expect((await writeCandidates(dir, 1, tools)).source).toBe('final.mp4');
    const only = await project('finalonly', { cut: 'final' });
    expect((await writeCandidates(only, 1, tools)).source).toBe('final.mp4');
  });

  it('says the timeline changed when the cut is more than a frame off the timeline, and not otherwise', async () => {
    const dir = await project('moved');
    expect((await writeCandidates(dir, 1, tools)).timelineChanged).toBe(false);
    const edited = (patch: object) => EpisodeSchema.parse({ ...episode(), items: [item('a', [0, 4], { audio: 'keep' }), item('b', [4, 8], { beat: 'truth', ...patch })] });
    // Within the render's own tolerance (max(0.1 s, a frame): a hold of 3 frames is 0.1 s) it is the same cut; a frame past it is not.
    await saveEpisode(dir, edited({ hold: 0.1 }));
    expect((await writeCandidates(dir, 1, tools)).timelineChanged).toBe(false);
    await saveEpisode(dir, edited({ hold: 0.134 }));
    expect((await writeCandidates(dir, 1, tools)).timelineChanged).toBe(true);
    // A timeline longer than the cut: frames only from what the cut has.
    await saveEpisode(dir, edited({ src: { in: 4, out: 9 } }));
    const longer = await writeCandidates(dir, 1, tools);
    expect(longer.timelineChanged).toBe(true);
    expect(longer.frames.length).toBeGreaterThan(0);
    expect(longer.frames.every((f) => f.t < 8)).toBe(true);
    await saveEpisode(dir, edited({ src: { in: 4, out: 7 } }));
    expect((await writeCandidates(dir, 1, tools)).timelineChanged).toBe(true);
  });

  it('removes the earlier candidates first, and nothing else', async () => {
    const dir = await project('again');
    const thumbs = join(dir, 'episodes', '1', 'thumbs');
    await mkdir(thumbs, { recursive: true });
    for (const f of ['cand-01.jpg', 'cand-14.jpg', 'cand-99.jpg', 'mine.jpg', 'cand-01.png']) await writeFile(join(thumbs, f), 'old');
    await writeFile(join(dir, 'episodes', '1', 'thumbnail.jpg'), 'keep');
    const r = await writeCandidates(dir, 1, tools);
    const names = await readdir(thumbs);
    expect(names).not.toContain('cand-14.jpg');
    expect(names).not.toContain('cand-99.jpg');
    expect(names).toEqual(expect.arrayContaining(['mine.jpg', 'cand-01.png']));
    expect(names.filter((f) => /^cand-\d+\.jpg$/.test(f))).toEqual(r.frames.map((f) => f.file));
    expect((await readFile(join(thumbs, 'cand-01.jpg'))).length).toBeGreaterThan(100);
    expect(await readFile(join(dir, 'episodes', '1', 'thumbnail.jpg'), 'utf8')).toBe('keep');
  });

  it('leaves the earlier candidates as they were when it fails or is stopped part way, with no folder of its own left', async () => {
    const dir = await project('swap');
    const ep1 = join(dir, 'episodes', '1');
    const thumbs = join(ep1, 'thumbs');
    await mkdir(thumbs, { recursive: true });
    for (const f of ['cand-01.jpg', 'cand-02.jpg', 'mine.jpg']) await writeFile(join(thumbs, f), 'old');
    const before = (await readdir(ep1)).sort();
    let calls = 0;
    const failing: MediaTools = {
      ...tools,
      runFfmpeg: async (args, opts) => {
        if (++calls === 3) throw new Error('ffmpeg broke');
        return tools.runFfmpeg(args, opts);
      },
    };
    await expect(writeCandidates(dir, 1, failing)).rejects.toThrow('ffmpeg broke');
    expect((await readdir(ep1)).sort()).toEqual(before);
    expect((await readdir(thumbs)).sort()).toEqual(['cand-01.jpg', 'cand-02.jpg', 'mine.jpg']);
    expect(await readFile(join(thumbs, 'cand-02.jpg'), 'utf8')).toBe('old');

    const stop = new AbortController();
    calls = 0;
    const stopping: MediaTools = {
      ...tools,
      runFfmpeg: async (args, opts) => {
        if (++calls === 2) stop.abort();
        opts?.signal?.throwIfAborted();
        return tools.runFfmpeg(args, opts);
      },
    };
    await expect(writeCandidates(dir, 1, stopping, { signal: stop.signal })).rejects.toThrow();
    expect((await readdir(ep1)).sort()).toEqual(before);
    expect(await readFile(join(thumbs, 'cand-01.jpg'), 'utf8')).toBe('old');

    // Done: the new frames replace the old ones, the other files stay.
    const r = await writeCandidates(dir, 1, tools);
    expect((await readdir(ep1)).sort()).toEqual(before);
    expect((await readdir(thumbs)).sort()).toEqual([...r.frames.map((f) => f.file), 'mine.jpg'].sort());
  });

  it('gives candidates for a cut without sound', async () => {
    const dir = await project('silent', { audio: false });
    const r = await writeCandidates(dir, 1, tools);
    expect(r.frames.some((f) => f.reason.startsWith('loudest'))).toBe(false);
    expect(r.frames[0]!.reason).toBe('truth beat (item b)');
    expect(r.frames.length).toBeGreaterThanOrEqual(5);
  });

  it('stops without a cut, writing nothing', async () => {
    const dir = await project('nocut', { cut: 'none' });
    await expect(writeCandidates(dir, 1, tools)).rejects.toMatchObject({ name: 'MirageError', message: 'video 1 has no cut yet', hint: 'Run cut (or render) first.' });
    expect(existsSync(join(dir, 'episodes', '1', 'thumbs'))).toBe(false);
  });

  it('stops when the video has no timeline', async () => {
    const dir = await project('noepisode');
    await rm(join(dir, 'episodes', '1', 'episode.json'));
    await expect(writeCandidates(dir, 1, tools)).rejects.toMatchObject({ code: 'NO_EPISODE' });
  });

  describe('writeThumbnail', () => {
    let footage: string;
    const W = 640;
    const H = 360;
    // c001: the colour changes every second (red, green, blue …), one keyframe; c002: left half red, right half blue;
    // c003: portrait, top half red, bottom half blue; c004: 4K green.
    const clips: Record<string, { file: string; args: string; w: number; h: number; sec: number; fps?: number; out?: string[] }> = {
      c001: { file: "clip 'one'.mp4", w: W, h: H, sec: 12, args: `geq=r='255*eq(mod(floor(T),3),0)':g='255*eq(mod(floor(T),3),1)':b='255*eq(mod(floor(T),3),2)'` },
      c002: { file: "halves 'two'.mp4", w: W, h: H, sec: 2, args: `geq=r='255*lt(X,W/2)':g=0:b='255*gte(X,W/2)'` },
      c003: { file: 'tall.mp4', w: 360, h: 640, sec: 2, args: `geq=r='255*lt(Y,H/2)':g=0:b='255*gte(Y,H/2)'` },
      c004: { file: 'green 4k.mp4', w: 3840, h: 2160, sec: 1, args: `geq=r=0:g=255:b=0` },
      // 10 frames a second, each a colour: red, green, blue …
      c005: { file: 'ten fps.mp4', w: W, h: H, sec: 2, fps: 10, args: `geq=r='255*eq(mod(N,3),0)':g='255*eq(mod(N,3),1)':b='255*eq(mod(N,3),2)'` },
      // Red right of a quarter of the width, green below a quarter of the height: where the edges land shows the framing.
      c006: { file: 'edges.mp4', w: W, h: H, sec: 2, args: `geq=r='255*gte(X,W/4)':g='255*gte(Y,H/4)':b=0` },
      // One skin colour all over, stored as cameras and Mirage's cuts store it: BT.709 at limited range, tagged so.
      c007: { file: 'skin 709.mp4', w: 320, h: 180, sec: 1, args: `geq=r=208:g=128:b=96,scale=out_color_matrix=bt709:out_range=tv`, out: ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'] },
    };
    const realClip = (id: string): Catalog['clips'][number] => {
      const c = clips[id]!;
      return { ...clip(id), path: join(footage, c.file), probe: { ...clip(id).probe, durationSec: c.sec, width: c.w, height: c.h, hasAudio: false, audioCodec: null } };
    };
    // a 0–4 s; b 4–7 s (12 s at 4×); c 7–9.5 s (held from 8.5); d a card 9.5–11.5 s; e 11.5–13.5 s, moved to the left half at once.
    const mapped = [
      item('a', [0, 4]),
      item('b', [0, 12], { speed: 4 }),
      item('c', [0, 1.5], { hold: 1 }),
      card('d', 2),
      item('e', [0, 2], { clip: 'c002', move: { zoom: 2, focus: { x: 0 }, start: 0, end: 0.1 } }),
    ];
    async function thumbProject(name: string, items: object[], o: { output?: { width: number; height: number }; cut?: boolean } = {}) {
      const dir = join(root, name);
      await mkdir(join(dir, 'episodes', '1'), { recursive: true });
      await writeFile(join(dir, 'mirage.json'), JSON.stringify({ version: 1, title: 'p', createdAt: new Date().toISOString() }));
      await saveCatalog(dir, catalog(...Object.keys(clips).map(realClip)));
      const output = o.output ?? { width: 320, height: 180 };
      await saveEpisode(dir, EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { ...output, fps: 30 }, items }));
      // The cut: black, yellow while the card shows (9.5–11.5 s).
      if (o.cut) {
        await ff(['-f', 'lavfi', '-i', `nullsrc=s=320x180:r=30:d=13.5,geq=r='255*between(T,9.5,11.5)':g='255*between(T,9.5,11.5)':b=0,format=yuv420p`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'episodes', '1', 'rough.mp4')]);
      }
      return dir;
    }
    /** The picture as rows of RGB. */
    async function pixels(file: string): Promise<{ w: number; h: number; at: (x: number, y: number) => number[]; avg: (x0: number, y0: number, x1: number, y1: number) => number[] }> {
      const [w, h] = await size(file);
      const raw = join(root, `px-${Math.random().toString(36).slice(2)}.rgb`);
      await ff(['-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
      const b = await readFile(raw);
      const at = (x: number, y: number) => [...b.subarray((y * w! + x) * 3, (y * w! + x) * 3 + 3)];
      const avg = (x0: number, y0: number, x1: number, y1: number) => {
        const sum = [0, 0, 0];
        let n = 0;
        for (let y = y0; y < y1; y += 4) for (let x = x0; x < x1; x += 4) { const p = at(x, y); for (let i = 0; i < 3; i++) sum[i]! += p[i]!; n++; }
        return sum.map((v) => v / n);
      };
      return { w: w!, h: h!, at, avg };
    }
    const thumbFile = (dir: string) => join(dir, 'episodes', '1', 'thumbnail.jpg');

    beforeAll(async () => {
      footage = join(root, "footage 'q'");
      await mkdir(footage, { recursive: true });
      for (const c of Object.values(clips)) {
        await ff(['-f', 'lavfi', '-i', `nullsrc=s=${c.w}x${c.h}:r=${c.fps ?? 30}:d=${c.sec},${c.args},format=yuv420p`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '1000', ...(c.out ?? []), join(footage, c.file)]);
      }
    });

    it('takes the clip frame an output time shows, exactly: through speed, the held frame, a card drawn, framed as the move frames it', async () => {
      const dir = await thumbProject('mapped', mapped, { cut: true });
      const r = await writeThumbnail(dir, 1, { at: 4.6 }, tools);
      expect(r).toEqual({ file: thumbFile(dir), width: 1280, height: 720, from: { clip: 'c001', src: 2.4 } });
      expect(await size(thumbFile(dir))).toEqual([1280, 720]);
      // 2.4 s into the clip is blue; a seek that stopped at the keyframe would give red.
      expect(near(await colour(thumbFile(dir)), 'blue')).toBe(true);
      // Held from 8.5 s: the frame at 1.5 s (green), not 2.0 s into the clip (blue).
      expect((await writeThumbnail(dir, 1, { at: 9 }, tools)).from).toEqual({ clip: 'c001', src: 1.5 });
      expect(near(await colour(thumbFile(dir)), 'green')).toBe(true);
      // The card: drawn at the thumbnail's size (black, its text in white), not its frame from the cut (yellow there).
      expect(await writeThumbnail(dir, 1, { at: 10 }, tools)).toEqual({ file: thumbFile(dir), width: 1280, height: 720, from: 'card' });
      const drawn = await pixels(thumbFile(dir));
      expect(Math.max(...drawn.at(2, 2), ...drawn.at(1277, 717))).toBeLessThan(40);
      let lit = 0;
      for (let y = 300; y < 420; y += 2) for (let x = 400; x < 880; x += 2) if (Math.min(...drawn.at(x, y)) > 200) lit++;
      expect(lit).toBeGreaterThan(100);
      // Under the move (by then at zoom 2 on the left edge: the red half): the source frame, framed as the video shows it.
      expect((await writeThumbnail(dir, 1, { at: 12 }, tools)).from).toEqual({ clip: 'c002', src: 0.5 });
      const px = await pixels(thumbFile(dir));
      expect(near(px.avg(0, 0, 1280, 720), 'red')).toBe(true);
    });

    it('freezes on a clip\'s last frame, and shows the last frame of a shot that runs past the video', async () => {
      // c001 is 12 s: 11–12 s is blue. A hold with src.out at the clip's end looks for a frame at 12 s, which isn't there.
      const dir = await thumbProject('lastframe', [item('a', [10, 12], { hold: 1 }), item('b', [11, 12.05]), item('c', [11.5, 12.05], { hold: 1 })]);
      expect((await writeThumbnail(dir, 1, { at: 2.5 }, tools)).from).toEqual({ clip: 'c001', src: 12 });
      expect(near(await colour(thumbFile(dir)), 'blue')).toBe(true);
      // b: 32 frames from 3 s; its last is 11 + 31/30 s into the clip, past the last frame (11.967 s).
      expect((await writeThumbnail(dir, 1, { at: 3 + 31 / 30 }, tools)).from).toEqual({ clip: 'c001', src: 12.033 });
      expect(near(await colour(thumbFile(dir)), 'blue')).toBe(true);
      // c (from 4.067 s): held, past the end too.
      expect((await writeThumbnail(dir, 1, { at: 5.5 }, tools)).from).toEqual({ clip: 'c001', src: 12.067 });
      expect(near(await colour(thumbFile(dir)), 'blue')).toBe(true);
    });

    it('sweeps what a stopped run left in the episode folder', async () => {
      const dir = await thumbProject('sweep', [item('a', [0, 4])]);
      const ep1 = join(dir, 'episodes', '1');
      await mkdir(join(ep1, '.thumbs-old1'));
      await writeFile(join(ep1, '.thumbs-old1', 'cand-01.jpg'), 'x');
      await writeFile(join(ep1, '.thumbnail-old2.jpg'), 'x');
      await writeThumbnail(dir, 1, { at: 1 }, tools);
      expect((await readdir(ep1)).filter((f) => f.startsWith('.thumbnail-'))).toEqual([]);
      await ff(cutArgs(join(ep1, 'rough.mp4'), { sec: 4 }));
      await writeCandidates(dir, 1, tools);
      expect((await readdir(ep1)).filter((f) => f.startsWith('.thumbs-'))).toEqual([]);
    });

    it('shows the clip frame the video shows: the latest at or before the time, as the render does', async () => {
      // At 0.15 s the 30 fps video shows its frame 4 (0.133 s): the clip's frame at 0.1 s (green); the next, at 0.2 s, is blue.
      const dir = await thumbProject('tenfps', [item('s', [0, 2], { clip: 'c005' })]);
      expect((await writeThumbnail(dir, 1, { at: 0.15 }, tools)).from).toEqual({ clip: 'c005', src: 0.133 });
      expect(near(await colour(thumbFile(dir)), 'green')).toBe(true);
      await writeThumbnail(dir, 1, { at: 0.2 }, tools);
      expect(near(await colour(thumbFile(dir)), 'blue')).toBe(true);
    });

    it('crops around the focus (the item’s own, or the one given), covering the frame', async () => {
      // A 1080×1920 cover from a landscape picture: only a third of its width fits.
      const dir = await thumbProject('focus', [item('h', [0, 2], { clip: 'c002', frame: 'fill', focus: { x: 1, y: 0.5 } })], { output: { width: 1080, height: 1920 } });
      const own = await writeThumbnail(dir, 1, { at: 0.5 }, tools);
      expect([own.width, own.height]).toEqual([1080, 1920]);
      expect(await size(thumbFile(dir))).toEqual([1080, 1920]);
      expect(near(await colour(thumbFile(dir)), 'blue')).toBe(true);
      await writeThumbnail(dir, 1, { at: 0.5, focus: { x: 0, y: 0.5 } }, tools);
      expect(near(await colour(thumbFile(dir)), 'red')).toBe(true);
      await writeThumbnail(dir, 1, { at: 0.5, focus: { x: 0.5, y: 0.5 } }, tools);
      const mid = await pixels(thumbFile(dir));
      expect(near(mid.avg(0, 0, 500, 1920), 'red')).toBe(true);
      expect(near(mid.avg(580, 0, 1080, 1920), 'blue')).toBe(true);
      for (const [x, y] of [[2, 2], [1077, 2], [2, 1917], [1077, 1917]] as const) expect(Math.max(...mid.at(x, y))).toBeGreaterThan(150);

      // A 1280×720 thumbnail from a portrait picture: top or bottom.
      const tall = await thumbProject('tallsrc', [item('t', [0, 2], { clip: 'c003' })]);
      await writeThumbnail(tall, 1, { at: 1, focus: { x: 0.5, y: 0 } }, tools);
      expect(await size(thumbFile(tall))).toEqual([1280, 720]);
      expect(near(await colour(thumbFile(tall)), 'red')).toBe(true);
      await writeThumbnail(tall, 1, { at: 1, focus: { x: 0.5, y: 1 } }, tools);
      expect(near(await colour(thumbFile(tall)), 'blue')).toBe(true);
    });

    it('covers the frame with no black bars from a 4K picture too', async () => {
      const dir = await thumbProject('4k', [item('k', [0, 1], { clip: 'c004' })]);
      await writeThumbnail(dir, 1, { at: 0.5 }, tools);
      const px = await pixels(thumbFile(dir));
      expect([px.w, px.h]).toEqual([1280, 720]);
      for (const [x, y] of [[1, 1], [1278, 1], [1, 718], [1278, 718]] as const) expect(px.at(x, y)[1]).toBeGreaterThan(200);
    });

    it('draws up to 4 words in the bundled face, outlined, in the lower third; braces and emoji as other text', async () => {
      const dir = await thumbProject('text', [item('a', [0, 4])]);
      const logs: string[] = [];
      const scripts: string[] = [];
      const verbose: MediaTools = {
        ...tools,
        runFfmpeg: async (args, opts) => {
          const graph = args[args.indexOf('-vf') + 1] ?? '';
          if (!graph.includes('ass=')) return tools.runFfmpeg(args, opts);
          scripts.push(await readFile(join(opts!.cwd!, 'thumbnail.ass'), 'utf8'));
          expect(graph).toContain(`ass=thumbnail.ass:fontsdir=`);
          logs.push((await run('ffmpeg', ['-hide_banner', '-v', 'verbose', '-nostats', '-y', ...args], { cwd: opts?.cwd })).stderr);
        },
      };
      // 1.5 s into c001 is green all over.
      await writeThumbnail(dir, 1, { at: 1.5, text: 'Big {win} 🚀 now' }, verbose);
      expect(logs[0]).toMatch(/fontselect: \(Montserrat ExtraBold, \d+, \d+\) -> Montserrat-ExtraBold\b/);
      expect(scripts[0]).toContain('BIG (WIN) NOW');
      expect(bundledFontsDir()).toBeTruthy();
      const px = await pixels(thumbFile(dir));
      const count = (y0: number, y1: number, test: (p: number[]) => boolean) => {
        let n = 0;
        for (let y = y0; y < y1; y += 2) for (let x = 0; x < px.w; x += 2) if (test(px.at(x, y))) n++;
        return n;
      };
      const black = (p: number[]) => Math.max(...p) < 50;
      const white = (p: number[]) => Math.min(...p) > 210;
      expect(count(480, 720, black)).toBeGreaterThan(500);
      expect(count(480, 720, white)).toBeGreaterThan(500);
      expect(count(0, 440, black) + count(0, 440, white)).toBe(0);
    });

    it('refuses more than 4 words, and a time outside the video, writing nothing', async () => {
      const dir = await thumbProject('refuse', mapped, { cut: true });
      await expect(writeThumbnail(dir, 1, { at: 1, text: 'one two three four five' }, tools)).rejects.toMatchObject({ message: 'thumbnail text is 5 words — keep it to 4 or fewer', hint: '' });
      await expect(writeThumbnail(dir, 1, { at: 13.5 }, tools)).rejects.toMatchObject({ message: '13.5 s is outside the video (0–13.5 s)', hint: '' });
      await expect(writeThumbnail(dir, 1, { at: -1 }, tools)).rejects.toMatchObject({ message: '-1 s is outside the video (0–13.5 s)' });
      await expect(writeThumbnail(dir, 1, { at: 1, focus: { x: 1.5, y: 0 } }, tools)).rejects.toMatchObject({ code: 'BAD_INPUT' });
      expect(existsSync(thumbFile(dir))).toBe(false);
    });

    it('needs no cut, for a card or a clip', async () => {
      const dir = await thumbProject('nocut', mapped);
      expect((await writeThumbnail(dir, 1, { at: 10 }, tools)).from).toBe('card');
      expect((await writeThumbnail(dir, 1, { at: 1 }, tools)).from).toEqual({ clip: 'c001', src: 1 });
    });

    it('draws a card at the thumbnail size: its background (a picture covers the frame) and its text in the card styles and bundled fonts', async () => {
      const cards = [
        { id: 'm', beat: 'title', card: { text: 'npm run build', style: 'mono', sec: 2 } },
        { id: 'p', beat: 'title', card: { text: 'Tokyo', style: 'image', image: "pics/green 'pic'.png", sec: 2 } },
      ];
      for (const output of [{ width: 320, height: 180 }, { width: 180, height: 320 }]) {
        const dir = await thumbProject(`cards-${output.width}`, cards, { output });
        await mkdir(join(dir, 'pics'));
        // A landscape green picture: a portrait cover crops it, a landscape one scales it.
        await ff(['-f', 'lavfi', '-i', 'color=c=0x00C800:s=800x600:d=1', '-frames:v', '1', join(dir, 'pics', "green 'pic'.png")]);
        const logs: string[] = [];
        const verbose: MediaTools = {
          ...tools,
          runFfmpeg: async (args, opts) => {
            const graph = args[args.indexOf('-vf') + 1] ?? '';
            if (!graph.includes('ass=')) return tools.runFfmpeg(args, opts);
            expect(graph).toContain(`:fontsdir=`);
            logs.push((await run('ffmpeg', ['-hide_banner', '-v', 'verbose', '-nostats', '-y', ...args], { cwd: opts?.cwd })).stderr);
          },
        };
        const [w, h] = output.width > output.height ? [1280, 720] : [1080, 1920];
        const white = (p: number[]) => Math.min(...p) > 200;
        const black = (p: number[]) => Math.max(...p) < 50;
        const count = (px: Awaited<ReturnType<typeof pixels>>, y0: number, y1: number, test: (p: number[]) => boolean) => {
          let n = 0;
          for (let y = Math.round(y0); y < y1; y += 2) for (let x = 0; x < px.w; x += 2) if (test(px.at(x, y))) n++;
          return n;
        };

        // Mono: white JetBrains Mono on black, centred.
        expect(await writeThumbnail(dir, 1, { at: 1 }, verbose)).toEqual({ file: thumbFile(dir), width: w, height: h, from: 'card' });
        expect(logs[0]).toMatch(/fontselect: \(JetBrains Mono, 400, 0\) -> JetBrainsMono-Regular\b/);
        const mono = await pixels(thumbFile(dir));
        expect([mono.w, mono.h]).toEqual([w, h]);
        expect(count(mono, h * 0.4, h * 0.6, white)).toBeGreaterThan(200);
        expect(count(mono, 0, h * 0.3, (p) => !black(p)) + count(mono, h * 0.7, h, (p) => !black(p))).toBe(0);

        // Picture: it covers the frame, its text white with a black outline in Montserrat ExtraBold in the middle; the
        // thumbnail's own text in the lower third, or on a vertical cover at 60%, none in the bottom 20%.
        await writeThumbnail(dir, 1, { at: 3, text: 'Go' }, verbose);
        expect(logs[1]).toMatch(/fontselect: \(Montserrat ExtraBold, \d+, \d+\) -> Montserrat-ExtraBold\b/);
        const pic = await pixels(thumbFile(dir));
        expect([pic.w, pic.h]).toEqual([w, h]);
        for (const [x, y] of [[2, 2], [w - 3, 2], [2, h - 3], [w - 3, h - 3]] as const) {
          const c = pic.at(x, y);
          expect(c[1]).toBeGreaterThan(150);
          expect(Math.max(c[0]!, c[2]!)).toBeLessThan(80);
        }
        expect(count(pic, h * 0.4, h * 0.6, white)).toBeGreaterThan(200);
        expect(count(pic, h * 0.4, h * 0.6, black)).toBeGreaterThan(100);
        if (w > h) expect(count(pic, h * 0.75, h * 0.92, white)).toBeGreaterThan(200);
        else {
          expect(count(pic, h * 0.58, h * 0.64, white)).toBeGreaterThan(200);
          expect(count(pic, h * 0.8, h, (p) => white(p) || black(p))).toBe(0);
        }
        expect(count(pic, 0, h * 0.3, (p) => white(p) || black(p))).toBe(0);
      }
    });

    it('replaces an earlier thumbnail, keeps it when it fails, and touches nothing else', async () => {
      const dir = await thumbProject('replace', mapped);
      const ep1 = join(dir, 'episodes', '1');
      await writeFile(thumbFile(dir), 'old');
      await mkdir(join(ep1, 'thumbs'));
      await writeFile(join(ep1, 'thumbs', 'cand-01.jpg'), 'cand');
      const before = (await readdir(ep1)).sort();
      const failing: MediaTools = { ...tools, runFfmpeg: async () => { throw new Error('ffmpeg broke'); } };
      await expect(writeThumbnail(dir, 1, { at: 1 }, failing)).rejects.toThrow('ffmpeg broke');
      expect(await readFile(thumbFile(dir), 'utf8')).toBe('old');
      expect((await readdir(ep1)).sort()).toEqual(before);
      await writeThumbnail(dir, 1, { at: 1 }, tools);
      expect((await readFile(thumbFile(dir))).length).toBeGreaterThan(1000);
      expect((await readdir(ep1)).sort()).toEqual(before);
      expect(await readFile(join(ep1, 'thumbs', 'cand-01.jpg'), 'utf8')).toBe('cand');
      expect((await readdir(footage)).sort()).toEqual(Object.values(clips).map((c) => c.file).sort());
    });

    it('writes the frame a candidate shows when given the at its line names, also on an item\'s first frame', async () => {
      // a: 37 frames of c001 from 0.1 s (red, then green from 1.0 s); b starts on frame 37 (1.2333… s) at c001's
      // moment at 2.0 s (blue).
      const dir = await thumbProject('first frame', [item('a', [0.1, 0.1 + 37 / 30]), item('b', [2, 3])]);
      await saveCatalog(dir, catalog(...Object.keys(clips).map((id) => (id === 'c001' ? { ...realClip(id), moments: [{ t: 2, label: 'blue' }] } : realClip(id)))));
      await renderEpisode({ project: dir, episode: 1, mode: 'rough', tools });
      const lines = candidatesReport(1, await writeCandidates(dir, 1, tools));
      expect(lines[1]).toBe('cand-01.jpg  0:01.3  at 1.25  moment: blue');
      const at = Number(/  at (\S+)  /.exec(lines[1]!)![1]);
      expect((await writeThumbnail(dir, 1, { at }, tools)).from).toEqual({ clip: 'c001', src: 2 });
      const cand = await colour(join(dir, 'episodes', '1', 'thumbs', 'cand-01.jpg'));
      const thumb = await colour(thumbFile(dir));
      expect(near(cand, 'blue')).toBe(true);
      expect(near(thumb, 'blue')).toBe(true);
      // 1.2 s, the moment's own time (1.233 s) to a tenth, as the reply gave it before, is item a's last frame: green.
      await writeThumbnail(dir, 1, { at: 1.2 }, tools);
      expect(near(await colour(thumbFile(dir)), 'green')).toBe(true);
    });

    it('keeps the colours: a BT.709 clip or cut comes out of the JPEG as it decodes', async () => {
      const src = join(footage, clips.c007!.file);
      // The clip decoded on its own matrix and range, and through the thumbnail's sharpening and brightening.
      const decode = (file: string, look = '') => {
        const raw = join(root, `px-${Math.random().toString(36).slice(2)}.rgb`);
        return ff(['-i', file, '-vf', `${look}scale=in_color_matrix=bt709:in_range=tv,format=rgb24,scale=1:1:flags=area`, '-frames:v', '1', '-f', 'rawvideo', raw]).then(async () => [...(await readFile(raw))]);
      };
      const plain = await decode(src);
      expect(Math.abs(plain[0]! - 208) + Math.abs(plain[1]! - 128) + Math.abs(plain[2]! - 96)).toBeLessThan(12);
      const within = (got: number[], want: number[]) => got.forEach((v, i) => expect(Math.abs(v - want[i]!), `channel ${i}: ${got} against ${want}`).toBeLessThanOrEqual(3));

      // A candidate frame: the cut's own colour.
      const dir = await thumbProject('colour', [item('s', [0, 1], { clip: 'c007' })]);
      await copyFile(src, join(dir, 'episodes', '1', 'rough.mp4'));
      const r = await writeCandidates(dir, 1, tools);
      within(await colour(join(dir, 'episodes', '1', 'thumbs', r.frames[0]!.file)), plain);
      // The thumbnail: the clip's colour, sharpened and brightened as every thumbnail is.
      await writeThumbnail(dir, 1, { at: 0.5 }, tools);
      within(await colour(thumbFile(dir)), await decode(src, 'unsharp=5:5:0.6:5:5:0.0,eq=brightness=0.03:saturation=1.08,'));
    });

    /** Where c006's edges land in a picture, as fractions of its width and height (0 when the edge is out of view). */
    async function edges(file: string): Promise<{ x: number; y: number }> {
      const px = await pixels(file);
      let x = 0;
      while (x < px.w && px.at(x, px.h >> 1)[0]! < 128) x++;
      let y = 0;
      while (y < px.h && px.at(px.w >> 1, y)[1]! < 128) y++;
      return { x: x / px.w, y: y / px.h };
    }
    /** Within `px` pixels of the source, for a window `w`×`h` source pixels (a crop lands on whole, even pixels). */
    const closeTo = (got: { x: number; y: number }, want: { x: number; y: number }, w = 427, h = 240, px = 2.5) => {
      expect(Math.abs(got.x - want.x) * w, `x ${got.x} against ${want.x}`).toBeLessThan(px);
      expect(Math.abs(got.y - want.y) * h, `y ${got.y} against ${want.y}`).toBeLessThan(px);
    };

    it('frames the picture as the video does: a zoom punches in around the focus, and a focus given moves it', async () => {
      // z: zoom 1.5, 0–1 s; o: zoom 1, 1–2 s. Both the thumbnail's shape (640×360 for 1280×720).
      const dir = await thumbProject('zoom', [item('z', [0, 1], { clip: 'c006', zoom: 1.5 }), item('o', [0, 1], { clip: 'c006' })]);
      // 1.5× around the centre: x 106.7–533.3 of 640, y 60–300 of 360; the edges at 160 and 90 land an eighth in.
      await writeThumbnail(dir, 1, { at: 0.5 }, tools);
      closeTo(await edges(thumbFile(dir)), { x: (160 - 320 / 3) / (1280 / 3), y: (90 - 60) / 240 });
      // The focus given moves the window: at the top left corner, x 0–426.7 and y 0–240.
      await writeThumbnail(dir, 1, { at: 0.5, focus: { x: 0, y: 0 } }, tools);
      closeTo(await edges(thumbFile(dir)), { x: 160 / (1280 / 3), y: 90 / 240 });
      // At zoom 1, footage the thumbnail's shape is shown whole: the focus has no room to move it.
      for (const focus of [undefined, { x: 0, y: 0 }, { x: 1, y: 1 }]) {
        await writeThumbnail(dir, 1, { at: 1.5, focus }, tools);
        closeTo(await edges(thumbFile(dir)), { x: 0.25, y: 0.25 }, 640, 360);
      }

      // A vertical video, fill at 1.5× around x 0.2: the 9:16 window (202.5×360) over 1.5 is 135×240, at x (640−135)·0.2.
      const tall = await thumbProject('zoom tall', [item('f', [0, 1], { clip: 'c006', frame: 'fill', zoom: 1.5, focus: { x: 0.2, y: 0.5 } })], { output: { width: 1080, height: 1920 } });
      await writeThumbnail(tall, 1, { at: 0.5 }, tools);
      closeTo(await edges(thumbFile(tall)), { x: (160 - 505 * 0.2) / 135, y: (90 - 60) / 240 }, 135, 240);
    });

    it('frames the picture as a move has it on that frame', async () => {
      // From zoom 1 at the centre to zoom 2 at the top left corner, linearly over the first second (frames 0–29).
      const dir = await thumbProject('move', [item('m', [0, 2], { clip: 'c006', move: { zoom: 2, focus: { x: 0, y: 0 }, ease: 'linear', start: 0, end: 1 } })]);
      const expected = (i: number) => {
        const p = Math.min(1, i / 29);
        const z = 2 ** p;
        const f = 0.5 * (1 - p);
        const [w, h] = [640 / z, 360 / z];
        return { x: (160 - (640 - w) * f) / w, y: (90 - (360 - h) * f) / h };
      };
      for (const i of [15, 45]) {
        await writeThumbnail(dir, 1, { at: (i + 0.5) / 30 }, tools);
        closeTo(await edges(thumbFile(dir)), expected(i), 640 / 2 ** Math.min(1, i / 29), 360 / 2 ** Math.min(1, i / 29));
      }
    });

    it('says a thumbnail.jpg or candidate frame open in another app is open there, and passes other errors on', async () => {
      const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const held = (code: string, test: (path: string) => boolean) => (path: unknown) => {
        if (test(String(path))) throw Object.assign(new Error(`${code}: held open`), { code });
      };
      const dir = await thumbProject('busy', [item('a', [0, 4])]);
      const ep1 = join(dir, 'episodes', '1');
      const isThumb = (p: string) => p.endsWith('thumbnail.jpg');
      try {
        vi.mocked(rename).mockImplementation(async (from, to) => { held('EBUSY', isThumb)(to); return fs.rename(from, to); });
        await expect(writeThumbnail(dir, 1, { at: 1 }, tools)).rejects.toMatchObject({ name: 'MirageError', code: 'BUSY', message: 'episodes/1/thumbnail.jpg is open in another app', hint: 'Close it there, then run thumbnail again.' });
        expect((await readdir(ep1)).filter((f) => f.startsWith('.thumbnail-'))).toEqual([]);
        vi.mocked(rename).mockImplementation(async (from, to) => { held('EPERM', isThumb)(to); return fs.rename(from, to); });
        await expect(writeThumbnail(dir, 1, { at: 1 }, tools)).rejects.toMatchObject({ code: 'BUSY', message: 'episodes/1/thumbnail.jpg is open in another app' });
        vi.mocked(rename).mockImplementation(async (from, to) => { held('ENOSPC', isThumb)(to); return fs.rename(from, to); });
        await expect(writeThumbnail(dir, 1, { at: 1 }, tools)).rejects.toMatchObject({ code: 'ENOSPC' });
        vi.mocked(rename).mockImplementation(fs.rename);

        await ff(cutArgs(join(ep1, 'rough.mp4'), { sec: 4 }));
        vi.mocked(rename).mockImplementation(async (from, to) => { held('EPERM', (p) => p.endsWith('cand-02.jpg'))(to); return fs.rename(from, to); });
        await expect(writeCandidates(dir, 1, tools)).rejects.toMatchObject({ code: 'BUSY', message: 'episodes/1/thumbs/cand-02.jpg is open in another app', hint: 'Close it there, then run thumbnail again.' });
        vi.mocked(rename).mockImplementation(fs.rename);
        await writeCandidates(dir, 1, tools);
        // An earlier candidate held open when the old ones are removed.
        vi.mocked(rm).mockImplementation(async (path, o) => { held('EBUSY', (p) => p.endsWith(join('thumbs', 'cand-01.jpg')))(path); return fs.rm(path, o); });
        await expect(writeCandidates(dir, 1, tools)).rejects.toMatchObject({ code: 'BUSY', message: 'episodes/1/thumbs/cand-01.jpg is open in another app' });
        expect((await readdir(ep1)).filter((f) => f.startsWith('.thumbs-'))).toEqual([]);
      } finally {
        vi.mocked(rename).mockImplementation(fs.rename);
        vi.mocked(rm).mockImplementation(fs.rm);
      }
    });
  });

  it('extracts each candidate\'s own frame exactly, for every frame', async () => {
    // Each frame a colour in turn: red, green, blue …, so a frame early or late is the wrong colour.
    const dir = join(root, 'every frame');
    await mkdir(join(dir, 'episodes', '1'), { recursive: true });
    await writeFile(join(dir, 'mirage.json'), JSON.stringify({ version: 1, title: 'p', createdAt: new Date().toISOString() }));
    await saveCatalog(dir, catalog(clip('c001', [{ t: 37 / 30, label: 'on frame 37' }, { t: 3.034, label: 'just past frame 91' }])));
    await saveEpisode(dir, episode());
    await ff(['-f', 'lavfi', '-i', `nullsrc=s=320x180:r=30:d=8,geq=r='255*eq(mod(N,3),0)':g='255*eq(mod(N,3),1)':b='255*eq(mod(N,3),2)',format=yuv420p`, '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', '-g', '1000', join(dir, 'episodes', '1', 'rough.mp4')]);
    const r = await writeCandidates(dir, 1, tools);
    expect(r.frames.slice(0, 2).map((f) => Math.floor(f.t * 30))).toEqual([37, 91]);
    for (const f of r.frames) {
      const want = (['red', 'green', 'blue'] as const)[Math.floor(f.t * 30) % 3]!;
      expect(near(await colour(join(dir, 'episodes', '1', 'thumbs', f.file)), want), `${f.file} at ${f.t}`).toBe(true);
    }
  });
});
