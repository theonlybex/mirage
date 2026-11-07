import { createHash } from 'node:crypto';
import { EpisodeSchema } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { dropCollapsed, formatTime, itemFrames, itemsFingerprint, layoutTimeline, shiftAfter, timelineDuration } from './timeline.js';

const ep = EpisodeSchema.parse({
  version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
  items: [
    { id: 'a', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 2 } },
    { id: 'b', beat: 'montage', clip: 'c002', src: { in: 0, out: 60 }, speed: 20 },
    { id: 'c', beat: 'truth', clip: 'c003', src: { in: 1, out: 2 }, hold: 0.5 },
  ],
  overlays: [
    { kind: 'callout', text: 'x', start: 1, end: 3 },
    { kind: 'badge', text: 'y', start: 3, end: 4 },
    { kind: 'label', text: 'z', start: 0, end: 1 },
  ],
  slots: [{ id: 'n1', start: 2.5, end: 5, maxWords: 5 }],
});

describe('timeline layout', () => {
  it('counts whole frames including speed and hold', () => {
    expect(itemFrames(ep.items[1], 30)).toEqual({ srcFrames: 90, holdFrames: 0, frames: 90 });
    expect(itemFrames(ep.items[2], 30)).toEqual({ srcFrames: 30, holdFrames: 15, frames: 45 });
  });
  it('lays items back to back', () => {
    expect(layoutTimeline(ep).map((l) => [l.item.id, l.start, l.end])).toEqual([['a', 0, 2], ['b', 2, 5], ['c', 5, 6.5]]);
    expect(timelineDuration(ep)).toBe(6.5);
  });
  it('never gives an item zero frames', () => {
    const tiny = EpisodeSchema.parse({ ...ep, items: [{ id: 't', beat: 'montage', clip: 'c', src: { in: 0, out: 0.001 } }] });
    expect(layoutTimeline(tiny)[0].frames).toBe(1);
  });
});

describe('cards on the timeline', () => {
  const card = (id: string, sec: number, extra: object = {}) => ({ id, beat: 'title', card: { style: 'bold', text: id, sec }, ...extra });
  const withCards = EpisodeSchema.parse({ ...ep, items: [card('k0', 1.5), ep.items[0], card('k1', 2, { hold: 0.5 }), card('k2', 0.51), ep.items[1]] });
  it("gives a card round(sec · fps) source frames, then its hold", () => {
    expect(itemFrames(withCards.items[2], 30)).toEqual({ srcFrames: 60, holdFrames: 15, frames: 75 });
    expect(itemFrames(withCards.items[3], 30)).toEqual({ srcFrames: 15, holdFrames: 0, frames: 15 });
  });
  it('lays cards out between clip items, at the start, and two in a row', () => {
    expect(layoutTimeline(withCards).map((l) => [l.item.id, l.start, l.end])).toEqual([['k0', 0, 1.5], ['a', 1.5, 3.5], ['k1', 3.5, 6], ['k2', 6, 6.5], ['b', 6.5, 9.5]]);
    const only = EpisodeSchema.parse({ ...ep, items: [card('k0', 1), card('k1', 2)] });
    expect(timelineDuration(only)).toBe(3);
  });
  it("fingerprints a card as ['card', id, sec, hold]: a changed length is a re-cut, a changed text isn't", () => {
    const fp = itemsFingerprint(withCards.items);
    const edit = (f: (c: (typeof withCards.items)[number]) => object) => itemsFingerprint(EpisodeSchema.parse({ ...withCards, items: withCards.items.map((i) => (i.id === 'k1' ? f(i) : i)) }).items);
    expect(edit((c) => ({ ...c, card: { style: 'bold', text: 'k1', sec: 2.5 } }))).not.toBe(fp);
    expect(edit((c) => ({ ...c, hold: 1 }))).not.toBe(fp);
    expect(edit((c) => ({ ...c, card: { style: 'mono', text: 'other', sec: 2 } }))).toBe(fp);
  });
  it('fingerprints clip items exactly as before: [id, clip, in, out, speed, hold] each', () => {
    const old = [['a', 'c001', 0, 2, 1, 0], ['b', 'c002', 0, 60, 20, 0], ['c', 'c003', 1, 2, 1, 0.5]];
    expect(itemsFingerprint(ep.items)).toBe(createHash('sha256').update(JSON.stringify(old)).digest('hex').slice(0, 16));
    expect(itemsFingerprint(ep.items)).toBe('3bb643a6be3722e4');
  });
});

describe('shiftAfter', () => {
  it('moves ranges starting at or after the point and stretches ranges spanning it', () => {
    const s = shiftAfter(ep, 2, 1);
    expect(s.overlays.map((o) => [o.start, o.end])).toEqual([[1, 4], [4, 5], [0, 1]]);
    expect(s.slots[0]).toMatchObject({ start: 3.5, end: 6 });
    expect(s.items).toBe(ep.items);
  });

  it('closes a gap without ever ending a range before it starts: what was inside the removed time collapses to its start', () => {
    // Removes 1.5–2 s: the badge 1.6–1.9 was entirely inside it, the callout 1–3 spanned it, the slot starts after it.
    const withBadge = EpisodeSchema.parse({ ...ep, overlays: [...ep.overlays, { kind: 'badge', text: 'w', start: 1.6, end: 1.9 }, { kind: 'label', text: 'v', start: 1.8, end: 2.4 }] });
    const s = shiftAfter(withBadge, 2, -0.5);
    expect(s.overlays.map((o) => [o.start, o.end])).toEqual([[1, 2.5], [2.5, 3.5], [0, 1], [1.5, 1.5], [1.5, 1.9]]);
    expect(s.slots[0]).toMatchObject({ start: 2, end: 4.5 });
    expect(s.overlays.every((o) => o.end >= o.start)).toBe(true);
  });

  it('moves sound effects and the dips of a music cue with the picture, and leaves absent ones absent', () => {
    const withSfx = EpisodeSchema.parse({
      ...ep, sfx: [{ sound: 'hit', at: 1 }, { sound: 'whoosh', at: 2 }, { sound: 'pop', at: 1.8 }],
      music: [{ track: 'a.mp3', start: 0, end: 6, dips: [{ start: 1, end: 1.4 }, { start: 3, end: 3.5 }, { start: 1.6, end: 1.9 }] }],
    });
    const later = shiftAfter(withSfx, 2, 1);
    expect(later.sfx!.map((x) => x.at)).toEqual([1, 3, 1.8]);
    expect(later.music[0]!.dips).toEqual([{ start: 1, end: 1.4 }, { start: 4, end: 4.5 }, { start: 1.6, end: 1.9 }]);
    // Closing 1.5–2 s: what was inside it lands on 1.5.
    const closed = shiftAfter(withSfx, 2, -0.5);
    expect(closed.sfx!.map((x) => x.at)).toEqual([1, 1.5, 1.5]);
    expect(closed.music[0]!.dips).toEqual([{ start: 1, end: 1.4 }, { start: 2.5, end: 3 }, { start: 1.5, end: 1.5 }]);
    const plain = shiftAfter(EpisodeSchema.parse({ ...ep, music: [{ track: 'a.mp3', start: 3, end: 6 }] }), 2, 1);
    expect('sfx' in plain).toBe(false);
    expect('dips' in plain.music[0]!).toBe(false);
  });
});

describe('dropCollapsed', () => {
  it('removes overlays, cues and slots shorter than one frame and says which', () => {
    const collapsed = {
      ...ep,
      overlays: [{ ...ep.overlays[0], text: 'FAILED', start: 1.5, end: 1.51 }, ep.overlays[1]],
      music: [{ track: 'drive.mp3', start: 2, end: 2, gainDb: -5, fadeIn: 0, fadeOut: 0, offset: 0 }],
      slots: [{ id: 'n1', start: 3, end: 3.01, maxWords: 0, line: 'Gone.' }],
    };
    const before = { ...collapsed, overlays: [{ ...collapsed.overlays[0], end: 2 }, ep.overlays[1]], music: [{ ...collapsed.music[0], end: 4 }], slots: [{ ...collapsed.slots[0], end: 4 }] };
    const r = dropCollapsed(collapsed, before);
    expect(r.episode.overlays).toEqual([ep.overlays[1]]);
    expect(r.episode.music).toEqual([]);
    expect(r.episode.slots).toEqual([]);
    expect(r.dropped).toEqual(['overlay 1 ("FAILED")', 'music cue 1 (drive.mp3)', 'slot n1 (line "Gone.")']);
    expect(dropCollapsed(ep, ep)).toEqual({ episode: ep, dropped: [] });
  });

  it('removes a dip that closing a gap left shorter than one frame, naming its cue', () => {
    const cue = { track: 'drive.mp3', start: 0, end: 6, gainDb: -5, fadeIn: 0, fadeOut: 0, offset: 0 };
    const before = { ...ep, music: [{ ...cue, dips: [{ start: 1.6, end: 1.9 }, { start: 3, end: 3.5 }] }] };
    const after = { ...ep, music: [{ ...cue, dips: [{ start: 1.5, end: 1.5 }, { start: 2.5, end: 3 }] }] };
    const r = dropCollapsed(after, before);
    expect(r.episode.music[0]!.dips).toEqual([{ start: 2.5, end: 3 }]);
    expect(r.dropped).toEqual(['music cue 1 (drive.mp3)\'s dip at 1.50 s']);
  });

  it('leaves a range that was already shorter than one frame before snapping alone', () => {
    const short = { ...ep, overlays: [{ ...ep.overlays[0], text: 'LIVE', start: 4, end: 4.02 }, ep.overlays[1]] };
    expect(dropCollapsed(short, short)).toEqual({ episode: short, dropped: [] });
  });
});

describe('formatTime', () => {
  it('prints m:ss under an hour and h:mm:ss above, rounding to whole seconds', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(9.4)).toBe('0:09');
    expect(formatTime(59.5)).toBe('1:00');
    expect(formatTime(781)).toBe('13:01');
    expect(formatTime(3725)).toBe('1:02:05');
  });
});
