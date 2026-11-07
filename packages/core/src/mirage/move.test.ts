import { ClipItemSchema } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { ease, moveExprs, moveFrames } from './move.js';

const item = (extra: object = {}) =>
  ClipItemSchema.parse({ id: 'a', beat: 'montage', clip: 'c001', src: { in: 0, out: 6 }, ...extra });

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

  it('eases in (slow, then faster) and out (fast, then slower) on a steady zoom rate', () => {
    const exps = (ease: 'in' | 'out') => moveFrames(item({ move: { zoom: 2, ease } }), 5, 30).map((x) => Math.log2(x.zoom));
    // p = 0, 0.25, 0.5, 0.75, 1: in is p², out is 1 − (1 − p)².
    expect(exps('in')).toEqual([0, 0.0625, 0.25, 0.5625, 1].map((v) => expect.closeTo(v, 12)));
    expect(exps('out')).toEqual([0, 0.4375, 0.75, 0.9375, 1].map((v) => expect.closeTo(v, 12)));
  });

  it('moves both focus axes when the move sets both', () => {
    const f = moveFrames(item({ focus: { x: 0.2, y: 0.4 }, move: { zoom: 1.2, focus: { x: 0.8, y: 0.1 }, ease: 'linear' } }), 3, 30);
    expect(f.map((p) => p.x)).toEqual([0.2, expect.closeTo(0.5, 12), 0.8]);
    expect(f.map((p) => p.y)).toEqual([0.4, expect.closeTo(0.25, 12), 0.1]);
  });

  it('runs on a clock that replaces start and end, beginning before the item or ending after it', () => {
    const m = item({ move: { zoom: 2, ease: 'linear' } });
    // Frames −10 … 19 of a 30-frame move: this 10-frame item is its middle third.
    const f = moveFrames(m, 10, 30, { a: -10, b: 20 });
    expect(f.map((x) => Math.log2(x.zoom))).toEqual(Array.from({ length: 10 }, (_, i) => expect.closeTo((i + 10) / 29, 12)));
    expect(moveFrames(m, 3, 30, { a: -5, b: -1 }).map((x) => x.zoom)).toEqual([2, 2, 2]);
    expect(moveFrames(m, 3, 30, { a: 3, b: 9 }).map((x) => x.zoom)).toEqual([1, 1, 1]);
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

  it('cuts to the end value on the last frame when the move starts there', () => {
    const f = moveFrames(item({ move: { zoom: 1.5, start: 0.98 } }), 30, 30);
    expect(f[28]!.zoom).toBe(1);
    expect(f[29]!.zoom).toBe(1.5);
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

/** Evaluates one of moveExprs' FFmpeg expressions at frame `n` (the variable named `n`), as FFmpeg's evaluator does. */
const evalExpr = (expr: string, n: number): number => {
  const slots: number[] = Array(10).fill(0);
  const fns = {
    st: (i: number, v: number) => (slots[i] = v),
    ld: (i: number) => slots[i],
    clip: (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)),
    lt: (a: number, b: number) => Number(a < b),
    gte: (a: number, b: number) => Number(a >= b),
    IF: (c: number, a: number, b: number) => (c ? a : b),
  };
  // FFmpeg's ; runs expressions in turn and gives the last (JS's comma), ^ is a power.
  const js = expr.replaceAll('^', '**').replaceAll('if(', 'IF(').replaceAll(';', ',');
  return new Function(...Object.keys(fns), 'n', `return (${js});`)(...Object.values(fns), n) as number;
};

describe('moveExprs', () => {
  const agree = (it: ReturnType<typeof item>, frames: number, clock?: { a: number; b: number }) => {
    const want = moveFrames(it, frames, 30, clock);
    const x = moveExprs(it, frames, 30, 'n', 0, clock);
    want.forEach((w, i) => {
      expect(evalExpr(`${x.e};${x.zoom}`, i)).toBeCloseTo(w.zoom, 9);
      expect(evalExpr(`${x.e};${x.x}`, i)).toBeCloseTo(w.x, 9);
      expect(evalExpr(`${x.e};${x.y}`, i)).toBeCloseTo(w.y, 9);
    });
  };
  it('gives, at every frame, the zoom and focus moveFrames gives, for every ease', () => {
    for (const e of ['linear', 'in', 'out', 'inOut'] as const) {
      agree(item({ move: { zoom: 1.3, ease: e } }), 180);
      agree(item({ zoom: 1.3, focus: { x: 0.2, y: 0.9 }, move: { zoom: 1, focus: { x: 0.7 }, ease: e, start: 1, end: 4.5 } }), 180);
    }
  });
  it('agrees on a 3-frame punch-in, a one-frame step, a move that never plays and one cut off by the shot end', () => {
    agree(item({ move: { zoom: 1.5, start: 1, end: 1.1 } }), 90);
    agree(item({ move: { zoom: 1.5, start: 1, end: 1.02 } }), 60);
    agree(item({ move: { zoom: 1.5, start: 10 } }), 30);
    agree(item({ move: { zoom: 1.5, start: 0, end: 10, ease: 'linear' } }), 30);
    agree(item({ hold: 1, move: { zoom: 1.2 } }), 180);
    agree(item({ move: { zoom: 1.5 } }), 1);
  });
  it('agrees on a clock that begins before the item or ends after it (a part of a split shot)', () => {
    for (const e of ['linear', 'in', 'out', 'inOut'] as const) {
      agree(item({ move: { zoom: 1.3, focus: { x: 0.1, y: 0.9 }, ease: e } }), 60, { a: -40, b: 50 });
      agree(item({ move: { zoom: 1.3, ease: e } }), 60, { a: 10, b: 200 });
    }
    agree(item({ move: { zoom: 1.3 } }), 30, { a: -5, b: -4 });
    expect(moveExprs(item({ move: { zoom: 1.2, ease: 'linear' } }), 60, 30, 'in', 1, { a: -40, b: 50 }).e).toBe('st(0,clip((in+39)/89,0,1))');
  });
  it('writes the eased progress once, in slot 0, and reads it back', () => {
    const x = moveExprs(item({ focus: { x: 0.5, y: 0.5 }, move: { zoom: 1.5, focus: { x: 0.25 }, ease: 'linear' } }), 60, 30, 'in');
    expect(x).toEqual({ e: 'st(0,clip(in/59,0,1))', zoom: '1*(1.5/1)^ld(0)', x: '0.5+(0.25-0.5)*ld(0)', y: '0.5' });
    expect(moveExprs(item({ move: { zoom: 1.2, start: 0.5 } }), 60, 30, 'in').e).toBe('st(0,clip((in-15)/44,0,1));st(0,if(lt(ld(0),0.5),2*ld(0)^2,1-2*(1-ld(0))^2))');
  });
});
