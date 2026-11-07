import { TimelineItemSchema } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { ease, moveFrames } from './move.js';

const item = (extra: object = {}) =>
  TimelineItemSchema.parse({ id: 'a', beat: 'montage', clip: 'c001', src: { in: 0, out: 6 }, ...extra });

describe('ease', () => {
  it('gives 0 at 0 and 1 at 1 for every kind', () => {
    for (const k of ['linear', 'in', 'out', 'inOut'] as const) {
      expect(ease(k, 0)).toBe(0);
      expect(ease(k, 1)).toBe(1);
    }
  });
  it('follows the four curves', () => {
    expect([0.25, 0.5].map((p) => ease('linear', p))).toEqual([0.25, 0.5]);
    expect([0.25, 0.5].map((p) => ease('in', p))).toEqual([0.0625, 0.25]);
    expect([0.25, 0.5].map((p) => ease('out', p))).toEqual([0.4375, 0.75]);
    expect([0.25, 0.5].map((p) => ease('inOut', p))).toEqual([0.125, 0.5]);
  });
  it('clamps progress outside 0–1', () => {
    expect(ease('in', -1)).toBe(0);
    expect(ease('out', 2)).toBe(1);
  });
});

describe('moveFrames', () => {
  it('holds the item zoom and focus for every frame of an item without a move', () => {
    const f = moveFrames(item({ zoom: 1.5, focus: { x: 0.2, y: 0.7 } }), 4, 30);
    expect(f).toEqual(Array(4).fill({ zoom: 1.5, x: 0.2, y: 0.7 }));
  });

  it('runs a whole-shot move from the first frame to exactly the end value on the last', () => {
    const f = moveFrames(item({ move: { zoom: 1.2 } }), 180, 30);
    expect(f).toHaveLength(180);
    expect(f[0]).toEqual({ zoom: 1, x: 0.5, y: 0.5 });
    expect(f[179]).toEqual({ zoom: 1.2, x: 0.5, y: 0.5 });
  });

  it('eases a steady zoom rate: the middle frame of an odd-length shot is 1.2^0.5 for inOut', () => {
    const f = moveFrames(item({ move: { zoom: 1.2 } }), 181, 30);
    expect(f[90]!.zoom).toBeCloseTo(1.2 ** 0.5, 12);
    // Symmetric about the middle: the two frames either side multiply to the whole change.
    const g = moveFrames(item({ move: { zoom: 1.2 } }), 180, 30);
    expect(g[89]!.zoom * g[90]!.zoom).toBeCloseTo(1.2, 12);
  });

  it('uses linear progress p = i / (n - 1) over the shot', () => {
    const f = moveFrames(item({ move: { zoom: 2, ease: 'linear' } }), 5, 30);
    expect(f.map((x) => x.zoom)).toEqual([1, 2 ** 0.25, 2 ** 0.5, 2 ** 0.75, 2].map((v) => expect.closeTo(v, 12)));
    expect(f[4]!.zoom).toBe(2);
  });

  it('moves the focus linearly with the eased progress, defaulting to the item focus per axis', () => {
    const f = moveFrames(item({ focus: { x: 0.2, y: 0.4 }, move: { zoom: 1, focus: { x: 0.8 }, ease: 'linear' } }), 3, 30);
    expect(f.map((p) => p.x)).toEqual([0.2, expect.closeTo(0.5, 12), 0.8]);
    expect(f.map((p) => p.y)).toEqual([0.4, 0.4, 0.4]);
  });

  it('moves from the item zoom, so a pull-out goes 1.5 to 1', () => {
    const f = moveFrames(item({ zoom: 1.5, move: { zoom: 1 } }), 10, 30);
    expect(f[0]!.zoom).toBe(1.5);
    expect(f[9]!.zoom).toBe(1);
  });

  it('holds before start and after end (seconds into the shot)', () => {
    const f = moveFrames(item({ move: { zoom: 1.5, start: 2, end: 4, ease: 'linear' } }), 180, 30);
    expect(f[0]!.zoom).toBe(1);
    expect(f[60]!.zoom).toBe(1);
    expect(f[59]!.zoom).toBe(1);
    expect(f[61]!.zoom).toBeGreaterThan(1);
    expect(f[119]!.zoom).toBe(1.5);
    expect(f[120]!.zoom).toBe(1.5);
    expect(f[179]!.zoom).toBe(1.5);
  });

  it('keeps moving through held frames', () => {
    const f = moveFrames(item({ hold: 1, move: { zoom: 1.2 } }), 180, 30);
    expect(f[179]!.zoom).toBe(1.2);
    expect(f[150]!.zoom).toBeLessThan(1.2);
  });

  it('reaches its end value on the third frame of a 0.1 s punch-in', () => {
    const f = moveFrames(item({ move: { zoom: 1.5, start: 1, end: 1.1 } }), 90, 30);
    expect(f[29]!.zoom).toBe(1);
    expect(f[30]!.zoom).toBe(1);
    expect(f[31]!.zoom).toBeGreaterThan(1);
    expect(f[31]!.zoom).toBeLessThan(1.5);
    expect(f[32]!.zoom).toBe(1.5);
    expect(f[33]!.zoom).toBe(1.5);
    expect(f.every((p) => Number.isFinite(p.zoom))).toBe(true);
  });

  it('steps in one frame when start and end are a frame apart or equal after rounding', () => {
    const f = moveFrames(item({ move: { zoom: 1.5, start: 1, end: 1.02 } }), 60, 30);
    expect(f[29]!.zoom).toBe(1);
    expect(f[30]!.zoom).toBe(1.5);
    expect(f.every((p) => Number.isFinite(p.zoom))).toBe(true);
  });

  it('never plays a move that starts after the shot ends, and clamps one that ends after it', () => {
    const late = moveFrames(item({ move: { zoom: 1.5, start: 10 } }), 30, 30);
    expect(late.every((p) => p.zoom === 1)).toBe(true);
    const long = moveFrames(item({ move: { zoom: 1.5, start: 0, end: 10, ease: 'linear' } }), 30, 30);
    expect(long[29]!.zoom).toBeLessThan(1.5);
    expect(long[29]!.zoom).toBeGreaterThan(1);
  });

  it('gives one entry for a one-frame item, at the end value since a one-frame move is a cut to it', () => {
    expect(moveFrames(item({ move: { zoom: 1.5 } }), 1, 30)).toEqual([{ zoom: 1.5, x: 0.5, y: 0.5 }]);
    expect(moveFrames(item({ move: { zoom: 1.5 } }), 0, 30)).toEqual([]);
  });
});
