import { EpisodeSchema } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { dropCollapsed, formatTime, itemFrames, layoutTimeline, shiftAfter, timelineDuration } from './timeline.js';

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

  it('closes a gap without ever ending a range before it starts: what was inside the removed time collapses to its start', () => {
    // Removes 1.5–2 s: the badge 1.6–1.9 was entirely inside it, the callout 1–3 spanned it, the slot starts after it.
    const withBadge = EpisodeSchema.parse({ ...ep, overlays: [...ep.overlays, { kind: 'badge', text: 'w', start: 1.6, end: 1.9 }, { kind: 'label', text: 'v', start: 1.8, end: 2.4 }] });
    const s = shiftAfter(withBadge, 2, -0.5);
    expect(s.overlays.map((o) => [o.start, o.end])).toEqual([[1, 2.5], [2.5, 3.5], [0, 1], [1.5, 1.5], [1.5, 1.9]]);
    expect(s.slots[0]).toMatchObject({ start: 2, end: 4.5 });
    expect(s.overlays.every((o) => o.end >= o.start)).toBe(true);
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
    const r = dropCollapsed(collapsed);
    expect(r.episode.overlays).toEqual([ep.overlays[1]]);
    expect(r.episode.music).toEqual([]);
    expect(r.episode.slots).toEqual([]);
    expect(r.dropped).toEqual(['overlay 1 ("FAILED")', 'music cue 1 (drive.mp3)', 'slot n1 (line "Gone.")']);
    expect(dropCollapsed(ep)).toEqual({ episode: ep, dropped: [] });
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
