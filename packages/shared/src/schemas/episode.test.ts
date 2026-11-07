import { describe, expect, it } from 'vitest';
import { CatalogSchema } from './catalog.js';
import { EpisodeSchema } from './episode.js';
import { MusicLibrarySchema } from './library.js';

const item = { id: 'i1', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 2 } };
const base = { version: 2, number: 1, title: 'Weather app, part 1', output: { width: 1920, height: 1080, fps: 30 }, items: [item] };

describe('EpisodeSchema', () => {
  it('fills defaults', () => {
    const ep = EpisodeSchema.parse(base);
    expect(ep.items[0]).toMatchObject({ speed: 1, audio: 'mute', zoom: 1, frame: 'fit', focus: { x: 0.5, y: 0.5 }, hold: 0, quiet: false, onBeat: false });
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
  it('takes a frame mode and a focus point inside the picture', () => {
    const ep = EpisodeSchema.parse({ ...base, items: [{ ...item, frame: 'fill', focus: { x: 0.8 } }] });
    expect(ep.items[0]).toMatchObject({ frame: 'fill', focus: { x: 0.8, y: 0.5 } });
    expect(EpisodeSchema.safeParse({ ...base, items: [{ ...item, frame: 'stretch' }] }).success).toBe(false);
    expect(EpisodeSchema.safeParse({ ...base, items: [{ ...item, focus: { x: 1.2, y: 0.5 } }] }).success).toBe(false);
  });
});

describe('EpisodeSchema move', () => {
  const withMove = (move: object) => ({ ...base, items: [{ ...item, move }] });
  it('stays absent when absent, and a move keeps only what was written', () => {
    const ep = EpisodeSchema.parse(base);
    expect('move' in ep.items[0]!).toBe(false);
    expect(JSON.stringify(ep)).not.toContain('move');
    const m = EpisodeSchema.parse(withMove({ zoom: 1.2, start: 1 })).items[0]!.move;
    expect(m).toEqual({ zoom: 1.2, ease: 'inOut', start: 1 });
  });
  it('takes a focus, an ease and times', () => {
    const m = EpisodeSchema.parse(withMove({ zoom: 1, focus: { x: 0.8, y: 0.3 }, ease: 'out', start: 0.5, end: 2 })).items[0]!.move;
    expect(m).toEqual({ zoom: 1, focus: { x: 0.8, y: 0.3 }, ease: 'out', start: 0.5, end: 2 });
  });
  it('refuses end <= start, a zoom outside 1–2, a missing zoom, a bad focus or ease and an unknown key', () => {
    expect(EpisodeSchema.safeParse(withMove({ zoom: 1.2, start: 2, end: 2 })).success).toBe(false);
    expect(EpisodeSchema.safeParse(withMove({ zoom: 1.2, start: 3, end: 2 })).success).toBe(false);
    expect(EpisodeSchema.safeParse(withMove({ zoom: 2.5 })).success).toBe(false);
    expect(EpisodeSchema.safeParse(withMove({ zoom: 0.9 })).success).toBe(false);
    expect(EpisodeSchema.safeParse(withMove({ ease: 'out' })).success).toBe(false);
    expect(EpisodeSchema.safeParse(withMove({ zoom: 1.2, focus: { x: 1.2 } })).success).toBe(false);
    expect(EpisodeSchema.safeParse(withMove({ zoom: 1.2, ease: 'bounce' })).success).toBe(false);
    expect(EpisodeSchema.safeParse(withMove({ zoom: 1.2, speed: 2 })).success).toBe(false);
  });
});

describe('EpisodeSchema captions', () => {
  it('stays absent when absent: parses undefined and stringifies without the key', () => {
    const ep = EpisodeSchema.parse(base);
    expect(ep.captions).toBeUndefined();
    expect('captions' in ep).toBe(false);
    expect(JSON.stringify(ep)).not.toContain('captions');
  });
  it('fills style defaults, and refuses a colour name or an unknown key', () => {
    expect(EpisodeSchema.parse({ ...base, captions: { style: 'pop' } }).captions).toEqual({ style: 'pop', position: 'bottom', highlight: [] });
    expect(EpisodeSchema.parse({ ...base, captions: {} }).captions).toEqual({ style: 'phrase', position: 'bottom', highlight: [] });
    const full = { style: 'pop', position: 'middle', highlight: ['gulp', { word: 'money', at: 4.5 }], color: '#C6FF3D' };
    expect(EpisodeSchema.parse({ ...base, captions: full }).captions).toEqual(full);
    expect(EpisodeSchema.safeParse({ ...base, captions: { color: 'lime' } }).success).toBe(false);
    expect(EpisodeSchema.safeParse({ ...base, captions: { style: 'bounce' } }).success).toBe(false);
    expect(EpisodeSchema.safeParse({ ...base, captions: { highlight: [''] } }).success).toBe(false);
    expect(firstIssue(EpisodeSchema.safeParse({ ...base, captions: { colour: '#C6FF3D' } }))?.message).toMatch(/^unknown key "colour"/);
  });
});

const firstIssue = (r: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) => r.error && { path: r.error.issues[0].path, message: r.error.issues[0].message };

describe('EpisodeSchema unknown keys', () => {
  it('rejects a misspelled key anywhere, naming it and the valid keys', () => {
    expect(firstIssue(EpisodeSchema.safeParse({ ...base, items: [item, { ...item, id: 'i2', speeed: 2 }] }))).toEqual({
      path: ['items', 1],
      message: 'unknown key "speeed" (valid keys: id, beat, clip, src, speed, audio, zoom, frame, focus, move, hold, quiet, onBeat)',
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
