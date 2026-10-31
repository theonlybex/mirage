import { EpisodeSchema, type Catalog } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { carrySlots, computeSlots, cutOf, mergeSlots, slotsStale } from './slots.js';

const catalog: Catalog = {
  version: 1,
  clips: [
    { id: 'c001', path: '/t.mov', sha256: 'a'.repeat(64), probe: { durationSec: 30, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', colorTransfer: null }, kind: 'talking', transcript: { words: [{ w: 'Hi', start: 0.5, end: 1 }, { w: 'there.', start: 1.1, end: 2.5 }].map((w) => ({ ...w, conf: 1 })), segments: [], speech: [] }, frames: [], notes: '', moments: [] },
  ],
};
const ep = EpisodeSchema.parse({
  version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
  items: [
    { id: 'talk', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 3 }, audio: 'keep' },
    { id: 'screen', beat: 'problem', clip: 'c001', src: { in: 10, out: 16 } },
    { id: 'reveal', beat: 'truth', clip: 'c001', src: { in: 20, out: 23 }, quiet: true },
    { id: 'tail', beat: 'outro', clip: 'c001', src: { in: 24, out: 26 } },
  ],
});

describe('computeSlots', () => {
  it('finds speech-free stretches outside quiet items, sized at 170 wpm', () => {
    expect(computeSlots(ep, catalog)).toEqual([{ id: 'n1', start: 2.8, end: 9, maxWords: 16, line: '' }]);
  });
  it('honours minLen', () => {
    expect(computeSlots(ep, catalog, { minLen: 1.5 }).map((s) => [s.start, s.end])).toEqual([[2.8, 9], [12, 14]]);
  });
});

describe('computeSlots rounding', () => {
  it('sizes maxWords from rounded bounds without float loss (2.8 to 9.2 -> 17)', () => {
    const ep2 = EpisodeSchema.parse({
      version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
      items: [
        { id: 'talk', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 3 }, audio: 'keep' },
        { id: 'screen', beat: 'problem', clip: 'c001', src: { in: 10, out: 16.2 } },
      ],
    });
    expect(computeSlots(ep2, catalog)).toEqual([{ id: 'n1', start: 2.8, end: 9.2, maxWords: 17, line: '' }]);
  });
});

describe('mergeSlots', () => {
  it('carries written lines to the most-overlapping new slot', () => {
    const prev = [{ id: 'n1', start: 2, end: 8, maxWords: 16, line: 'Old line.' }];
    const next = [{ id: 'n1', start: 0, end: 1, maxWords: 0, line: '' }, { id: 'n2', start: 3, end: 9, maxWords: 16, line: '' }];
    expect(mergeSlots(prev, next).map((s) => s.line)).toEqual(['', 'Old line.']);
  });
  it('globally matches: a split re-cut sends the line to the larger overlap', () => {
    const prev = [{ id: 'n1', start: 2, end: 20, maxWords: 40, line: 'Long line.' }];
    const next = [{ id: 'n1', start: 2, end: 8, maxWords: 16, line: '' }, { id: 'n2', start: 12, end: 20, maxWords: 22, line: '' }];
    expect(mergeSlots(prev, next).map((s) => s.line)).toEqual(['', 'Long line.']);
  });
  it('competing old lines: larger overlap wins, the other falls to its next-best slot', () => {
    const prev = [
      { id: 'n1', start: 0, end: 6, maxWords: 16, line: 'A' },
      { id: 'n2', start: 5, end: 12, maxWords: 16, line: 'B' },
    ];
    const next = [{ id: 'n1', start: 4, end: 11, maxWords: 16, line: '' }, { id: 'n2', start: 0, end: 4.5, maxWords: 10, line: '' }];
    // B overlaps n1 by 6 (wins); A overlaps n1 by 2 and n2 by 4.5 -> n2
    expect(mergeSlots(prev, next).map((s) => s.line)).toEqual(['B', 'A']);
  });
  it('ignores trivial overlaps (< 25% of the shorter slot)', () => {
    const prev = [{ id: 'n1', start: 2, end: 8, maxWords: 16, line: 'Old.' }];
    const next = [{ id: 'n1', start: 7.99, end: 12, maxWords: 10, line: '' }];
    expect(mergeSlots(prev, next).map((s) => s.line)).toEqual(['']);
  });
});

describe('slots after a re-cut (carrySlots)', () => {
  const screens = EpisodeSchema.parse({
    version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
    items: [
      { id: 'intro', beat: 'cold-open', clip: 'c001', src: { in: 10, out: 14 } },
      { id: 'talk', beat: 'problem', clip: 'c001', src: { in: 0, out: 3 }, audio: 'keep' },
      { id: 's1', beat: 'problem', clip: 'c001', src: { in: 10, out: 16 } },
      { id: 'reveal', beat: 'truth', clip: 'c001', src: { in: 20, out: 23 }, quiet: true },
      { id: 'outro', beat: 'outro', clip: 'c001', src: { in: 24, out: 29 } },
    ],
  });
  const written = (() => {
    const slots = computeSlots(screens, catalog);
    const lines = ['Intro line.', 'Screen line.', 'Outro line.'];
    return { ...screens, slots: slots.map((s, i) => ({ ...s, line: lines[i] ?? '' })), slotsCut: cutOf(screens) };
  })();

  it('records the cut the slots were computed for, and knows when it changed', () => {
    expect(written.slots.map((s) => [s.id, s.start, s.end])).toEqual([['n1', 0, 4.2], ['n2', 6.8, 13], ['n3', 16, 21]]);
    expect(slotsStale(written)).toBe(false);
    expect(slotsStale({ ...written, items: written.items.slice(1) })).toBe(true);
    // An episode from before slotsCut, with no voice-over: nothing to compare.
    expect(slotsStale({ ...written, slotsCut: undefined, items: written.items.slice(1) })).toBe(false);
  });

  it('keeps each line on the picture it was written for when an item before it is removed', () => {
    const recut = { ...written, items: written.items.slice(1) }; // the 4 s intro is gone
    const r = carrySlots(recut, computeSlots(recut, catalog));
    expect(r.slots.map((s) => [s.id, s.start, s.end, s.line])).toEqual([['n1', 2.8, 9, 'Screen line.'], ['n2', 12, 17, 'Outro line.']]);
    expect(r.dropped.map((s) => s.line)).toEqual(['Intro line.']);
    expect(r.moved.map((m) => [m.line, m.from.id, m.to.id])).toEqual([['Screen line.', 'n2', 'n1'], ['Outro line.', 'n3', 'n2']]);
  });

  it('follows the source when an item is trimmed at its start', () => {
    // s1 now starts 2 s later in its clip; the screen line still sits on what it showed (src 12–16).
    const items = written.items.map((i) => (i.id === 's1' ? { ...i, src: { in: 12, out: 16 } } : i));
    const recut = { ...written, items };
    const r = carrySlots(recut, computeSlots(recut, catalog));
    expect(r.slots.filter((s) => s.line).map((s) => [s.line, s.start])).toEqual([['Intro line.', 0], ['Screen line.', 6.8], ['Outro line.', 14]]);
    expect(r.dropped).toEqual([]);
  });

  it('matches by absolute time for slots written before slotsCut existed', () => {
    const old = { ...written, slotsCut: undefined };
    expect(carrySlots(old, computeSlots(old, catalog)).slots.map((s) => s.line)).toEqual(['Intro line.', 'Screen line.', 'Outro line.']);
  });
});
