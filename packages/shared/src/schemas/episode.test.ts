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

const firstIssue = (r: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) => r.error && { path: r.error.issues[0].path, message: r.error.issues[0].message };

describe('EpisodeSchema unknown keys', () => {
  it('rejects a misspelled key anywhere, naming it and the valid keys', () => {
    expect(firstIssue(EpisodeSchema.safeParse({ ...base, items: [item, { ...item, id: 'i2', speeed: 2 }] }))).toEqual({
      path: ['items', 1],
      message: 'unknown key "speeed" (valid keys: id, beat, clip, src, speed, audio, zoom, hold, quiet, onBeat)',
    });
    expect(firstIssue(EpisodeSchema.safeParse({ ...base, extra: 1 }))?.message).toMatch(/^unknown key "extra" \(valid keys: version, number, title, /);
    expect(firstIssue(EpisodeSchema.safeParse({ ...base, items: [{ ...item, src: { in: 0, out: 2, end: 3 } }] }))?.path).toEqual(['items', 0, 'src']);
    expect(firstIssue(EpisodeSchema.safeParse({ ...base, output: { ...base.output, fsp: 30 } }))?.path).toEqual(['output']);
    expect(firstIssue(EpisodeSchema.safeParse({ ...base, overlays: [{ kind: 'badge', text: 'X', start: 0, end: 1, color: 'red' }] }))?.message).toMatch(/^unknown key "color"/);
    expect(firstIssue(EpisodeSchema.safeParse({ ...base, music: [{ track: 'a.mp3', start: 0, end: 1, gain: -5 }] }))?.message).toMatch(/^unknown key "gain"/);
    expect(firstIssue(EpisodeSchema.safeParse({ ...base, slots: [{ id: 'n1', start: 0, end: 1, maxWords: 3, text: 'x' }] }))?.message).toMatch(/^unknown key "text"/);
    const vo = { recording: 'vo.m4a', lines: [{ slot: 'n1', at: 0, src: { in: 0, out: 1 } }] };
    expect(EpisodeSchema.safeParse({ ...base, voiceover: vo }).success).toBe(true);
    expect(firstIssue(EpisodeSchema.safeParse({ ...base, voiceover: { ...vo, file: 'x' } }))?.path).toEqual(['voiceover']);
    expect(firstIssue(EpisodeSchema.safeParse({ ...base, voiceover: { ...vo, lines: [{ ...vo.lines[0], start: 1 }] } }))?.path).toEqual(['voiceover', 'lines', 0]);
  });
});

describe('CatalogSchema and MusicLibrarySchema', () => {
  it('reject misspelled keys in the parts people edit', () => {
    const clip = {
      id: 'c001', path: '/x.mp4', sha256: 'a'.repeat(64), kind: 'screen', transcript: null, frames: [{ t: 0, file: 'frames/c001/f0001.jpg' }], notes: '', moments: [],
      probe: { durationSec: 1, width: 2, height: 2, fps: 30, hasVideo: true, hasAudio: false, videoCodec: 'h264', audioCodec: null },
    };
    expect(CatalogSchema.safeParse({ version: 1, clips: [clip] }).success).toBe(true);
    expect(firstIssue(CatalogSchema.safeParse({ version: 1, clips: [{ ...clip, note: 'x' }] }))?.message).toMatch(/^unknown key "note"/);
    expect(CatalogSchema.safeParse({ version: 1, clips: [{ ...clip, moments: [{ t: 1, lable: 'x' }] }] }).error?.issues).toContainEqual(expect.objectContaining({ path: ['clips', 0, 'moments', 0], code: 'unrecognized_keys' }));
    expect(firstIssue(MusicLibrarySchema.safeParse({ version: 1, tracks: [{ file: 'a.mp3', mood: 'upbeat', moood: 'x' }] }))?.message).toMatch(/^unknown key "moood"/);
  });

  it('parse minimal documents', () => {
    expect(CatalogSchema.parse({ version: 1, clips: [] }).clips).toEqual([]);
    const lib = MusicLibrarySchema.parse({ version: 1, tracks: [{ file: 'a.mp3', mood: 'upbeat' }] });
    expect(lib.tracks[0]).toMatchObject({ licence: '', bpm: null, beatOffset: null, durationSec: null });
  });
});
