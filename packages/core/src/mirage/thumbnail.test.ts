// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type Catalog } from '@wordedits/shared';
import { run } from '@wordedits/sidecars';
import { beforeAll, describe, expect, it } from 'vitest';
import { realMediaTools, type MediaTools } from '../media-tools.js';
import { saveCatalog } from './ingest.js';
import { saveEpisode } from './render-episode.js';
import { candidatesReport, cutLoudness, formatThumbTime, thumbCandidates, writeCandidates } from './thumbnail.js';

const clip = (id: string, moments: { t: number; label: string }[] = []): Catalog['clips'][number] => ({
  id, path: `/x/${id}.mp4`, sha256: 'a'.repeat(64), kind: 'screen', transcript: null, frames: [], notes: '', moments,
  probe: { durationSec: 120, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', colorTransfer: null },
});
const catalog = (...clips: Catalog['clips']): Catalog => ({ version: 1, clips });
const ep = (items: object[]) => EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items });
const item = (id: string, src: [number, number], extra: object = {}) => ({ id, beat: 'problem', clip: 'c001', src: { in: src[0], out: src[1] }, ...extra });
const card = (id: string, sec: number, extra: object = {}) => ({ id, beat: 'title', card: { text: 'hi', style: 'bold', sec }, ...extra });
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
      { t: 2, reason: 'moment: laughs' },
      { t: 6, reason: 'loudest moment of item a' },
      { t: 15, reason: 'truth beat (item b)' },
      { t: 3.75, reason: 'even spacing' },
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
      { t: 10, reason: 'moment: m' },
      { t: 11, reason: 'loudest moment of item a' },
      { t: 15, reason: 'reveal beat (item a)' },
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
    expect(moments.map((c) => c.t)).toEqual([8, 21]);
    expect(r.some((c) => c.reason === 'moment: elsewhere')).toBe(false);
  });

  it('maps a moment of a clip that appears twice, each counted against the cap', () => {
    const e = ep([item('a', [0, 10]), item('b', [0, 10]), item('c', [0, 10])]);
    const r = thumbCandidates(e, catalog(clip('c001', [{ t: 5, label: 'x' }])), [], 2);
    expect(r).toEqual([{ t: 5, reason: 'moment: x' }, { t: 15, reason: 'moment: x' }]);
  });

  it('leaves out a moment at or after the end of the piece, and one before its start', () => {
    const e = ep([item('a', [5, 10])]);
    const r = thumbCandidates(e, catalog(clip('c001', [{ t: 4.99, label: 'before' }, { t: 10, label: 'end' }, { t: 5, label: 'start' }])), [], 1);
    expect(r).toEqual([{ t: 0, reason: 'moment: start' }]);
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
    expect(r).toEqual([{ t: 3.5, reason: 'loudest moment of item a' }, { t: 30, reason: 'loudest moment of item d' }]);
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
      { t: 7, reason: 'truth beat (item b)' },
      { t: 11, reason: 'headline beat (item c)' },
      { t: 14, reason: 'payoff beat (item d)' },
      { t: 18, reason: 'twist beat (item e)' },
      { t: 22, reason: 'reveal beat (item f)' },
    ]);
  });

  it('spaces the rest evenly over the video, and gives fewer than 12 for a short one', () => {
    const e = ep([item('a', [0, 24])]);
    const r = thumbCandidates(e, catalog(clip('c001')), []);
    expect(r.map((c) => c.t)).toEqual(Array.from({ length: 12 }, (_, i) => 1 + 2 * i));
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
    expect(r[0]).toEqual({ t: 1.5, reason: 'moment: m' });
    for (const a of r) for (const b of r) if (a !== b) expect(Math.abs(a.t - b.t)).toBeGreaterThanOrEqual(1 - 1e-9);
  });

  it('gives beats and even spacing for a video of only cards', () => {
    const e = ep([card('a', 6), card('b', 6, { beat: 'reveal' }), card('c', 6)]);
    const r = thumbCandidates(e, catalog(), []);
    expect(r[0]).toEqual({ t: 9, reason: 'reveal beat (item b)' });
    expect(r.slice(1).every((c) => c.reason === 'even spacing')).toBe(true);
    expect(r).toHaveLength(12);
  });

  it('gives candidates for a video without sound, and for clips missing from the catalog', () => {
    const e = ep([item('a', [0, 10], { audio: 'keep' }), item('b', [0, 10], { beat: 'twist', clip: 'c404' })]);
    const r = thumbCandidates(e, catalog(), []);
    expect(r[0]).toEqual({ t: 15, reason: 'twist beat (item b)' });
    expect(r).toHaveLength(12);
  });
});

describe('formatThumbTime', () => {
  it('writes m:ss.s, rounding the whole value', () => {
    expect([0, 1.74, 9.96, 59.96, 61.5, 600].map(formatThumbTime)).toEqual(['0:00.0', '0:01.7', '0:10.0', '1:00.0', '1:01.5', '10:00.0']);
  });
});

describe('candidatesReport', () => {
  it('names the cut and lists a line per frame', () => {
    const frames = [{ t: 1.74, reason: 'moment: x', file: 'cand-01.jpg' }, { t: 65, reason: 'even spacing', file: 'cand-02.jpg' }];
    expect(candidatesReport(2, { source: 'rough.mp4', timelineChanged: false, frames })).toEqual([
      'wrote 2 candidate frames to episodes/2/thumbs/ (from rough.mp4)',
      'cand-01.jpg  0:01.7  moment: x',
      'cand-02.jpg  1:05.0  even spacing',
    ]);
  });
  it('ends with a warning when the timeline changed after the cut', () => {
    expect(candidatesReport(2, { source: 'final.mp4', timelineChanged: true, frames: [{ t: 1, reason: 'even spacing', file: 'cand-01.jpg' }] }).slice(1)).toEqual([
      'cand-01.jpg  0:01.0  even spacing',
      '⚠ the timeline changed after final.mp4 was made — run cut again for frames that match',
    ]);
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
      { t: 0.95, reason: 'moment: one', file: 'cand-01.jpg' },
      { t: 2.05, reason: 'moment: two', file: 'cand-02.jpg' },
      { t: 4.5, reason: 'moment: three', file: 'cand-03.jpg' },
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
    expect(beat.t).toBe(6);
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
    // One frame more (a hold of 1/30 s) is within the cut's own rounding; a second more is a different cut.
    await saveEpisode(dir, edited({ hold: 0.034 }));
    expect((await writeCandidates(dir, 1, tools)).timelineChanged).toBe(false);
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
});
