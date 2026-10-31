import { EpisodeSchema } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { itemFrames, layoutTimeline, shiftAfter, timelineDuration } from './timeline.js';

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

describe('shiftAfter', () => {
  it('moves ranges starting at or after the point and stretches ranges spanning it', () => {
    const s = shiftAfter(ep, 2, 1);
    expect(s.overlays.map((o) => [o.start, o.end])).toEqual([[1, 4], [4, 5], [0, 1]]);
    expect(s.slots[0]).toMatchObject({ start: 3.5, end: 6 });
    expect(s.items).toBe(ep.items);
  });
});
