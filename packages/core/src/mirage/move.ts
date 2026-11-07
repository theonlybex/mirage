// SPDX-License-Identifier: MIT
import type { Move, TimelineItem } from '@wordedits/shared';
import { ffNum } from './encode.js';

/** Easing of progress `p` (0–1, clamped): 0 at 0 and 1 at 1 for every kind. */
export function ease(kind: Move['ease'], p: number): number {
  const q = Math.min(1, Math.max(0, p));
  switch (kind) {
    case 'linear':
      return q;
    case 'in':
      return q * q;
    case 'out':
      return 1 - (1 - q) * (1 - q);
    case 'inOut':
      return q < 0.5 ? 2 * q * q : 1 - 2 * (1 - q) * (1 - q);
  }
}

/**
 * The zoom and focus of each output frame of an item (`frames` = `LaidItem.frames`, held frames included).
 *
 * Timing: the move covers the frames from `round(start·fps)` up to, not including, `round(end·fps)` — `end` is where
 * the move's last frame stops, as the end of a clip is. Those frames get progress p = (i − a) / (b − a − 1), so the
 * first frame is exactly the start value and the last is exactly the end value: a whole-shot move ends on the shot's
 * last frame (p = i / (n − 1)), and a 0.1 s punch-in at 30 fps (3 frames) is at its end value on the third. Frames
 * before the move hold the start value, frames after it the end value. A move of one frame or less is a cut to the end
 * value at `a`; one that starts at or after the shot's last frame never plays. Times past the shot are clamped to it.
 *
 * Zoom moves at a steady rate to the eye, z = z0·(z1/z0)^e(p); focus moves linearly, f = f0 + (f1 − f0)·e(p). The
 * move starts from the item's own `zoom` and `focus`; a focus axis the move leaves out stays the item's.
 */
export function moveFrames(item: TimelineItem, frames: number, fps: number): { zoom: number; x: number; y: number }[] {
  const m = item.move;
  const { z0, z1, x0, x1, y0, y1, a, b } = moveSpan(item, frames, fps);
  const at = (p: number) => {
    const e = ease(m?.ease ?? 'inOut', p);
    if (e === 0) return { zoom: z0, x: x0, y: y0 };
    if (e === 1) return { zoom: z1, x: x1, y: y1 };
    return { zoom: z0 * (z1 / z0) ** e, x: x0 + (x1 - x0) * e, y: y0 + (y1 - y0) * e };
  };
  return Array.from({ length: Math.max(0, frames) }, (_, i) => {
    if (!m || i < a) return at(0);
    if (i >= b - 1) return at(1);
    return at((i - a) / (b - a - 1));
  });
}

/** Where a move starts and ends: its zoom and focus, and the frames it covers, `a` up to, not including, `b`. */
function moveSpan(item: TimelineItem, frames: number, fps: number) {
  const m = item.move;
  return {
    z0: item.zoom,
    z1: m?.zoom ?? item.zoom,
    x0: item.focus.x,
    x1: m?.focus?.x ?? item.focus.x,
    y0: item.focus.y,
    y1: m?.focus?.y ?? item.focus.y,
    a: Math.round((m?.start ?? 0) * fps),
    b: Math.round((m?.end ?? frames / fps) * fps),
  };
}

/**
 * moveFrames' numbers as FFmpeg expressions of the frame number `n` (the name of the filter's variable for it, which is
 * `first` on the item's first frame), so a filter can work them out per frame. `e` stores the eased progress in slot 0
 * (st(0)); `zoom`, `x` and `y` read it back (ld(0)), so each goes after `e` in the same expression: `${e};${zoom}`.
 */
export function moveExprs(item: TimelineItem, frames: number, fps: number, n: string, first = 0): { e: string; zoom: string; x: string; y: string } {
  const { z0, z1, x0, x1, y0, y1, a, b } = moveSpan(item, frames, fps);
  const f = ffNum;
  const at = a + first;
  let e: string;
  if (!item.move) e = 'st(0,0)';
  // A move of one frame or less is a cut to the end value at `a`.
  else if (b - a <= 1) e = `st(0,gte(${n},${at}))`;
  else {
    const p = `st(0,clip(${at === 0 ? n : `(${n}-${at})`}/${b - a - 1},0,1))`;
    const curve = { linear: '', in: 'ld(0)^2', out: '1-(1-ld(0))^2', inOut: 'if(lt(ld(0),0.5),2*ld(0)^2,1-2*(1-ld(0))^2)' }[item.move.ease];
    e = curve ? `${p};st(0,${curve})` : p;
  }
  return {
    e,
    zoom: z1 === z0 ? f(z0) : `${f(z0)}*(${f(z1)}/${f(z0)})^ld(0)`,
    x: x1 === x0 ? f(x0) : `${f(x0)}+(${f(x1)}-${f(x0)})*ld(0)`,
    y: y1 === y0 ? f(y0) : `${f(y0)}+(${f(y1)}-${f(y0)})*ld(0)`,
  };
}
