import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type Catalog, type MusicLibrary } from '@wordedits/shared';
import { run } from '@wordedits/sidecars';
import { describe, expect, it } from 'vitest';
import { realMediaTools } from '../media-tools.js';
import { analyzeLibrary, snapToBeats } from './music.js';
import { layoutTimeline } from './timeline.js';

const lib = (bpm: number, beatOffset: number): MusicLibrary => ({ version: 1, tracks: [{ file: 'beat.wav', mood: 'upbeat', licence: '', bpm, beatOffset, durationSec: 60 }] });
const catalog = (dur: number): Catalog => ({
  version: 1,
  clips: [{ id: 'c001', path: '/x.mp4', sha256: 'a'.repeat(64), probe: { durationSec: dur, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: false, videoCodec: 'h264', audioCodec: null }, kind: 'screen', transcript: null, frames: [], notes: '', moments: [] }],
});
const episode = (items: object[], extra: object = {}) =>
  EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items, music: [{ track: 'beat.wav', start: 0, end: 20 }], ...extra });

describe('snapToBeats', () => {
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
});
