import { describe, expect, it } from 'vitest';
import { CatalogSchema } from './catalog.js';
import { EpisodeSchema } from './episode.js';
import { MusicLibrarySchema } from './library.js';

const item = { id: 'i1', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 2 } };
const base = { version: 2, number: 1, title: 'Weather app, part 1', output: { width: 1920, height: 1080, fps: 30 }, items: [item] };

describe('EpisodeSchema', () => {
  it('fills defaults', () => {
    const ep = EpisodeSchema.parse(base);
    expect(ep.items[0]).toMatchObject({ speed: 1, audio: 'mute', zoom: 1, hold: 0, quiet: false, onBeat: false });
    expect(ep).toMatchObject({ overlays: [], music: [], slots: [], voiceover: null, loudnessLufs: -14 });
  });
  it('rejects src.out <= src.in, naming the item', () => {
    const r = EpisodeSchema.safeParse({ ...base, items: [{ ...item, src: { in: 2, out: 2 } }] });
    expect(JSON.stringify(r.error?.issues)).toContain('item i1');
  });
  it('rejects duplicate item and slot ids', () => {
    expect(EpisodeSchema.safeParse({ ...base, items: [item, item] }).success).toBe(false);
    const slot = { id: 'n1', start: 0, end: 3, maxWords: 7 };
    expect(EpisodeSchema.safeParse({ ...base, slots: [slot, slot] }).success).toBe(false);
  });
  it('rejects overlays and cues that end before they start, and odd output sizes', () => {
    expect(EpisodeSchema.safeParse({ ...base, overlays: [{ kind: 'callout', text: '3 DAYS', start: 2, end: 1 }] }).success).toBe(false);
    expect(EpisodeSchema.safeParse({ ...base, music: [{ track: 'a.mp3', start: 5, end: 5 }] }).success).toBe(false);
    expect(EpisodeSchema.safeParse({ ...base, output: { width: 1921, height: 1080, fps: 30 } }).success).toBe(false);
  });
});

describe('CatalogSchema and MusicLibrarySchema', () => {
  it('parse minimal documents', () => {
    expect(CatalogSchema.parse({ version: 1, clips: [] }).clips).toEqual([]);
    const lib = MusicLibrarySchema.parse({ version: 1, tracks: [{ file: 'a.mp3', mood: 'upbeat' }] });
    expect(lib.tracks[0]).toMatchObject({ licence: '', bpm: null, beatOffset: null, durationSec: null });
  });
});
