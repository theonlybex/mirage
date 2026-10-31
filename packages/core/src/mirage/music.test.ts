import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type Catalog, type MusicLibrary } from '@wordedits/shared';
import { run } from '@wordedits/sidecars';
import { describe, expect, it } from 'vitest';
import { realMediaTools } from '../media-tools.js';
import { acquireLock, LOCK_FILE } from './lock.js';
import { analyzeLibrary, snapToBeats } from './music.js';
import { layoutTimeline } from './timeline.js';

const lib = (bpm: number, beatOffset: number): MusicLibrary => ({ version: 1, tracks: [{ file: 'beat.wav', mood: 'upbeat', licence: '', bpm, beatOffset, durationSec: 60 }] });
const catalog = (dur: number): Catalog => ({
  version: 1,
  clips: [{ id: 'c001', path: '/x.mp4', sha256: 'a'.repeat(64), probe: { durationSec: dur, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: false, videoCodec: 'h264', audioCodec: null, colorTransfer: null }, kind: 'screen', transcript: null, frames: [], notes: '', moments: [] }],
});
const episode = (items: object[], extra: object = {}) =>
  EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items, music: [{ track: 'beat.wav', start: 0, end: 20 }], ...extra });

describe('snapToBeats', () => {
  it('leaves an episode with a fitted voice-over alone, so the holds and splits of the fit stay in step', () => {
    const ep = episode([{ id: 'a', beat: 'montage', clip: 'c001', src: { in: 0, out: 1.3 }, onBeat: true }], { voiceover: { recording: 'vo.m4a', lines: [] } });
    expect(snapToBeats(ep, catalog(60), lib(120, 0.1))).toBe(ep);
  });

  it('starts each cue on a beat and gives onBeat items whole-beat lengths, shifting what follows', () => {
    const ep = episode(
      [
        { id: 'a', beat: 'montage', clip: 'c001', src: { in: 0, out: 1.3 }, onBeat: true },
        { id: 'b', beat: 'montage', clip: 'c001', src: { in: 2, out: 2.2 }, onBeat: true },
        { id: 'c', beat: 'truth', clip: 'c001', src: { in: 3, out: 6 } },
      ],
      { overlays: [{ kind: 'callout', text: 'x', start: 5, end: 6 }] },
    );
    const s = snapToBeats(ep, catalog(60), lib(120, 0.1));
    expect(s.music[0].offset).toBeCloseTo(0.1);
    expect(layoutTimeline(s).map((l) => l.end - l.start)).toEqual([1.5, 0.5, 3]);
    expect(s.overlays[0].start).toBeCloseTo(5.5);
  });

  it('slows an item down when the clip has no more footage', () => {
    const ep = episode([{ id: 'a', beat: 'montage', clip: 'c001', src: { in: 0.2, out: 1.2 }, onBeat: true }]);
    const s = snapToBeats(ep, catalog(1.2), lib(100, 0));
    expect(s.items[0].speed).toBeCloseTo(1 / 1.2, 3);
    expect(layoutTimeline(s)[0].frames).toBe(36);
  });

  it('is idempotent at a non-terminating beat length', () => {
    const ep = episode(
      [
        { id: 'a', beat: 'montage', clip: 'c001', src: { in: 0, out: 1.3 }, onBeat: true },
        { id: 'b', beat: 'montage', clip: 'c001', src: { in: 2, out: 2.9 }, onBeat: true },
        { id: 'c', beat: 'truth', clip: 'c001', src: { in: 3, out: 6 } },
      ],
      { music: [{ track: 'beat.wav', start: 0, end: 20, offset: 0.2 }], overlays: [{ kind: 'callout', text: 'x', start: 5, end: 6 }] },
    );
    const once = snapToBeats(ep, catalog(60), lib(139.5, 0.07));
    expect(snapToBeats(once, catalog(60), lib(139.5, 0.07))).toEqual(once);
  });

  it('skips an onBeat item with no source footage left', () => {
    const ep = episode([{ id: 'a', beat: 'montage', clip: 'c001', src: { in: 1.2, out: 1.3 }, onBeat: true }]);
    const s = snapToBeats(ep, catalog(1.2), lib(120, 0));
    expect(s.items[0]).toEqual(ep.items[0]);
  });

  it('leaves an item alone when slowing it would go below the minimum speed', () => {
    const ep = episode([{ id: 'a', beat: 'montage', clip: 'c001', src: { in: 1, out: 1.5 }, onBeat: true }]);
    // 0.2 s of footage left, one 60 BPM beat (1 s) wanted: speed would be 0.2 < 0.25.
    const s = snapToBeats(ep, catalog(1.2), lib(60, 0));
    expect(s.items).toEqual(ep.items);
  });

  it('is idempotent when an item is slowed to fit the footage left', () => {
    const ep = episode([{ id: 'a', beat: 'montage', clip: 'c001', src: { in: 0, out: 3 }, onBeat: true }]);
    const once = snapToBeats(ep, catalog(1), lib(60, 0));
    expect(once.items[0].src.out).toBe(1);
    expect(snapToBeats(once, catalog(1), lib(60, 0))).toEqual(once);
  });

  it('keeps cut points on the beat grid with no accumulated drift', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, beat: 'montage', clip: 'c001', src: { in: i, out: i + 0.5 }, onBeat: true }));
    const ep = episode(items, { music: [{ track: 'beat.wav', start: 0, end: 60 }] });
    const beat = 60 / 126;
    const laid = layoutTimeline(snapToBeats(ep, catalog(60), lib(126, 0)));
    for (const l of laid) {
      const k = Math.round(l.end / beat);
      expect(Math.abs(l.end - k * beat)).toBeLessThanOrEqual(0.5 / 30 + 1e-9);
    }
    const last = laid[laid.length - 1].end;
    expect(Math.abs(last - Math.round(last / beat) * beat)).toBeLessThanOrEqual(0.5 / 30 + 1e-9);
  });

  it('is idempotent with a cue at a non-beat offset and several onBeat items', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, beat: 'montage', clip: 'c001', src: { in: i * 2, out: i * 2 + 0.7 + i * 0.1 }, onBeat: true }));
    const ep = episode(items, { music: [{ track: 'beat.wav', start: 0.3, end: 30, offset: 1.234567 }], overlays: [{ kind: 'callout', text: 'x', start: 4, end: 5 }] });
    const l = lib(127.3, 0.0613);
    const once = snapToBeats(ep, catalog(60), l);
    expect(snapToBeats(once, catalog(60), l)).toEqual(once);
  });

  it('leaves items alone when no cue with a known tempo plays under them', () => {
    const ep = episode([{ id: 'a', beat: 'montage', clip: 'c001', src: { in: 0, out: 1.3 }, onBeat: true }], { music: [] });
    expect(snapToBeats(ep, catalog(60), lib(120, 0))).toEqual(ep);
  });
});

describe('analyzeLibrary', () => {
  it('adds unlisted tracks and detects their tempo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we music '));
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*880*t)*exp(-40*mod(t-0.1,0.5))*gte(mod(t-0.1,0.5),0)':s=44100:d=20", join(dir, 'beat.wav')]);
    const out = await analyzeLibrary(dir, await realMediaTools());
    expect(out.tracks).toHaveLength(1);
    expect(out.tracks[0].file).toBe('beat.wav');
    expect(Math.abs(out.tracks[0].bpm! - 120)).toBeLessThanOrEqual(1.5);
    expect(out.tracks[0].durationSec).toBeCloseTo(20, 0);
    expect(JSON.parse(await readFile(join(dir, 'library.json'), 'utf8')).tracks[0].mood).toBe('upbeat');
  });

  it('leaves tempo unset for a silent track but still fills the duration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we music '));
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '5', join(dir, 'quiet.wav')]);
    const out = await analyzeLibrary(dir, await realMediaTools());
    expect(out.tracks[0]).toMatchObject({ file: 'quiet.wav', bpm: null, beatOffset: null });
    expect(out.tracks[0].durationSec).toBeCloseTo(5, 0);
  });

  it('clears decode files left by a killed run, and refuses while another music run holds the folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we music '));
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '2', join(dir, 'quiet.wav')]);
    await writeFile(join(dir, '.tmp-0f8fad5b-d9cb-469f-a165-70867728950e.f32'), 'x');
    await writeFile(join(dir, LOCK_FILE), JSON.stringify({ pid: 4_194_305, command: 'music', startedAt: new Date().toISOString(), token: 'dead' }));
    await analyzeLibrary(dir, await realMediaTools());
    expect((await readdir(dir)).sort()).toEqual(['library.json', 'quiet.wav']);
    const lock = await acquireLock(dir, 'music', 'the music folder');
    try {
      await expect(analyzeLibrary(dir, await realMediaTools())).rejects.toMatchObject({ code: 'BUSY' });
    } finally {
      await lock.release();
    }
  });
});
