import { describe, expect, it } from 'vitest';
import { CatalogSchema } from './catalog.js';
import { EpisodeSchema, isCard, type ClipItem, type TimelineItem } from './episode.js';
import { MusicLibrarySchema } from './library.js';

/** The item as a clip item (a card here is a mistake in the test). */
const clip = (i: TimelineItem): ClipItem => {
  if (isCard(i)) throw new Error(`item ${i.id} is a card`);
  return i;
};

const item = { id: 'i1', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 2 } };
const base = { version: 2, number: 1, title: 'Weather app, part 1', output: { width: 1920, height: 1080, fps: 30 }, items: [item] };

describe('EpisodeSchema', () => {
  it('fills defaults', () => {
    const ep = EpisodeSchema.parse(base);
    expect(ep.items[0]).toMatchObject({ speed: 1, audio: 'mute', zoom: 1, frame: 'fit', focus: { x: 0.5, y: 0.5 }, hold: 0, quiet: false, onBeat: false });
    expect(ep).toMatchObject({ overlays: [], music: [], slots: [], voiceover: null, loudnessLufs: -14 });
  });
  describe('beat', () => {
    const beatOf = (beat: string) => EpisodeSchema.safeParse({ ...base, items: [{ ...item, beat }] });
    it('is any lower-case word, with digits and hyphens after the first letter', () => {
      for (const beat of ['title-card', 'hook', 'bit', 'a1-b2']) expect(beatOf(beat).success, beat).toBe(true);
    });
    it('refuses anything else', () => {
      for (const beat of ['Title Card', 'Hook', 'title card', 'title_card', '1st', '-x', '', 'x-é']) expect(beatOf(beat).success, beat).toBe(false);
    });
    it('still takes every beat of the build story', () => {
      for (const beat of ['cold-open', 'title', 'recap', 'new-toy', 'problem', 'montage', 'twist', 'truth', 'outro', 'blooper']) expect(beatOf(beat).success, beat).toBe(true);
    });
    it('is a word on a card too', () => {
      const card = { id: 'k1', beat: 'title-card', card: { style: 'bold', text: 'Hi', sec: 2 } };
      expect(EpisodeSchema.safeParse({ ...base, items: [card] }).success).toBe(true);
      expect(EpisodeSchema.safeParse({ ...base, items: [{ ...card, beat: 'Title Card' }] }).success).toBe(false);
    });
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
    const m = clip(EpisodeSchema.parse(withMove({ zoom: 1.2, start: 1 })).items[0]!).move;
    expect(m).toEqual({ zoom: 1.2, ease: 'inOut', start: 1 });
  });
  it('takes a focus, an ease and times', () => {
    const m = clip(EpisodeSchema.parse(withMove({ zoom: 1, focus: { x: 0.8, y: 0.3 }, ease: 'out', start: 0.5, end: 2 })).items[0]!).move;
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
      message: 'unknown key "speeed" (valid keys: id, beat, clip, src, speed, audio, zoom, frame, focus, move, hold, quiet, onBeat, splitFrom)',
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

describe('EpisodeSchema sound effects and dips', () => {
  const cue = { track: 'a.mp3', start: 0, end: 10 };
  it('stays absent when absent: no sfx on the episode, no dips on a cue', () => {
    const ep = EpisodeSchema.parse({ ...base, music: [cue] });
    expect('sfx' in ep).toBe(false);
    expect('dips' in ep.music[0]!).toBe(false);
    expect(JSON.stringify(ep)).not.toMatch(/sfx|dips/);
  });
  it('takes sound effects with a default gain of -6 dB, and dips on a cue', () => {
    const ep = EpisodeSchema.parse({ ...base, sfx: [{ sound: 'hit', at: 2 }, { sound: 'sfx/airhorn.wav', at: 0, gainDb: 0 }], music: [{ ...cue, dips: [{ start: 3, end: 3.5 }] }] });
    expect(ep.sfx).toEqual([{ sound: 'hit', at: 2, gainDb: -6 }, { sound: 'sfx/airhorn.wav', at: 0, gainDb: 0 }]);
    expect(ep.music[0]!.dips).toEqual([{ start: 3, end: 3.5 }]);
    expect(EpisodeSchema.parse(JSON.parse(JSON.stringify(ep)))).toEqual(ep);
  });
  it('refuses a positive gain, a negative time, an empty sound, an unknown key, and a dip that ends at or before its start', () => {
    const sfx = (s: object) => EpisodeSchema.safeParse({ ...base, sfx: [s] }).success;
    expect(sfx({ sound: 'hit', at: 1, gainDb: 0.5 })).toBe(false);
    expect(sfx({ sound: 'hit', at: -1 })).toBe(false);
    expect(sfx({ sound: '', at: 1 })).toBe(false);
    expect(sfx({ sound: 'hit' })).toBe(false);
    expect(firstIssue(EpisodeSchema.safeParse({ ...base, sfx: [{ sound: 'hit', at: 1, volume: -3 }] }))?.message).toMatch(/^unknown key "volume"/);
    const dip = (d: object) => EpisodeSchema.safeParse({ ...base, music: [{ ...cue, dips: [d] }] }).success;
    expect(dip({ start: 3, end: 3 })).toBe(false);
    expect(dip({ start: 3, end: 2 })).toBe(false);
    expect(dip({ start: -1, end: 2 })).toBe(false);
    expect(dip({ start: 1, end: 2, fade: 0.1 })).toBe(false);
  });
});

describe('EpisodeSchema card items', () => {
  const card = (c: object, extra: object = {}) => ({ id: 'k1', beat: 'title', card: { style: 'bold', sec: 2, text: 'Day 3', ...c }, ...extra });
  const parses = (c: object, extra: object = {}) => EpisodeSchema.safeParse({ ...base, items: [item, card(c, extra)] }).success;
  it('parses a card item, filling text, hold and quiet, and tells it from a clip item', () => {
    const ep = EpisodeSchema.parse({ ...base, items: [item, { id: 'k1', beat: 'title', card: { style: 'image', sec: 3, image: 'pics/shot.png' } }] });
    expect(ep.items[1]).toEqual({ id: 'k1', beat: 'title', card: { style: 'image', sec: 3, image: 'pics/shot.png', text: '' }, hold: 0, quiet: false });
    expect(ep.items.map(isCard)).toEqual([false, true]);
    expect(EpisodeSchema.parse(JSON.parse(JSON.stringify(ep)))).toEqual(ep);
  });
  it('refuses clip, src, speed, audio, zoom, move, frame, focus and onBeat on a card, naming the key', () => {
    for (const k of ['clip', 'src', 'speed', 'audio', 'zoom', 'move', 'frame', 'focus', 'onBeat']) {
      const r = EpisodeSchema.safeParse({ ...base, items: [card({}, { [k]: k === 'move' ? { zoom: 1.2 } : 1 })] });
      expect(firstIssue(r)?.message).toMatch(new RegExp(`^unknown key "${k}" \\(valid keys: id, beat, card, hold, quiet\\)`));
    }
  });
  it('keeps sec within 0.5–30 and hold within 0–10', () => {
    expect(parses({ sec: 0.5 })).toBe(true);
    expect(parses({ sec: 30 })).toBe(true);
    expect(parses({ sec: 0.4 })).toBe(false);
    expect(parses({ sec: 31 })).toBe(false);
    expect(parses({}, { hold: 11 })).toBe(false);
    expect(parses({ style: 'fancy' })).toBe(false);
  });
  it('an image card needs an image inside the project; mono and bold refuse one and need text', () => {
    expect(parses({ style: 'image', text: '' })).toBe(false);
    expect(parses({ style: 'image', image: 'a.jpg', text: 'Over it' })).toBe(true);
    for (const bad of ['../a.png', 'pics/../../a.png', '/abs/a.png', 'C:\\pics\\a.png', 'pics\\..\\..\\a.png', '\\a.png']) expect(parses({ style: 'image', image: bad })).toBe(false);
    expect(parses({ style: 'mono', image: 'a.png' })).toBe(false);
    expect(parses({ style: 'bold', text: '' })).toBe(false);
    expect(parses({ style: 'mono', text: '  \n ' })).toBe(false);
    expect(parses({ style: 'mono', text: 'line 1\nline 2' })).toBe(true);
    const r = EpisodeSchema.safeParse({ ...base, items: [card({ style: 'image' })] });
    expect(firstIssue(r)).toEqual({ path: ['items', 0, 'card', 'image'], message: 'item k1: an image card needs an image (a PNG or JPEG in the project)' });
  });
  it('round-trips an existing clip-only episode byte for byte', () => {
    const saved = {
      version: 2, number: 3, title: 'Old one', output: { width: 1080, height: 1920, fps: 30 },
      items: [
        { id: 'i1', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 2 }, speed: 1, audio: 'keep', zoom: 1, frame: 'fit', focus: { x: 0.5, y: 0.5 }, hold: 0, quiet: false, onBeat: false },
        { id: 'i2', beat: 'montage', clip: 'c002', src: { in: 1, out: 9 }, speed: 4, audio: 'mute', zoom: 1.2, frame: 'fill', focus: { x: 0.3, y: 0.5 }, move: { zoom: 1.4, ease: 'inOut', start: 0.5 }, hold: 0.4, quiet: true, onBeat: true, splitFrom: { item: 'i2', move: { zoom: 1.4, ease: 'inOut', start: 0.5 } } },
      ],
      overlays: [], music: [], slots: [], voiceover: null, loudnessLufs: -14,
    };
    const text = JSON.stringify(saved, null, 2);
    expect(JSON.stringify(EpisodeSchema.parse(JSON.parse(text)), null, 2)).toBe(text);
  });

  describe('name labels, chosen subtitles and time tags', () => {
    const ov = (o: object) => EpisodeSchema.safeParse({ ...base, overlays: [{ text: 'Sam', start: 0, end: 2, ...o }] });
    it('takes the kinds name, subtitle and timecard', () => {
      for (const kind of ['name', 'subtitle', 'timecard']) expect(ov({ kind }).success, kind).toBe(true);
    });
    it('takes a sub line on a name label only, and says so on any other kind', () => {
      const parsed = ov({ kind: 'name', sub: 'Founder, Lamp Co' });
      expect(parsed.success && parsed.data.overlays[0]).toMatchObject({ kind: 'name', text: 'Sam', sub: 'Founder, Lamp Co' });
      for (const kind of ['callout', 'counter', 'badge', 'label', 'chapter', 'before', 'after', 'subtitle', 'timecard']) {
        expect(firstIssue(ov({ kind, sub: 'x' })), kind).toEqual({ path: ['overlays', 0, 'sub'], message: `overlay "Sam": sub (the second line) is only for a name label — a ${kind} overlay has none` });
      }
      expect(ov({ kind: 'name', sub: '' }).success).toBe(false);
    });
    it('writes no sub for a name without one, and keeps the old kinds unchanged', () => {
      const saved = { kind: 'badge', text: 'FAILED', tone: 'fail', start: 3, end: 5 };
      const out = EpisodeSchema.parse({ ...base, overlays: [saved, { kind: 'name', text: 'Sam', start: 0, end: 2 }] });
      expect(out.overlays[0]).toEqual(saved);
      expect('sub' in out.overlays[1]).toBe(false);
    });
  });
});
