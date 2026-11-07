// SPDX-License-Identifier: MIT
import { isCard, type ClipItem, type Move, type TimelineItem } from '@wordedits/shared';
import { ffNum } from './encode.js';
import type { LaidItem } from './timeline.js';

/**
 * Where a move runs in an item's own frames, `a` up to, not including, `b` (moveFrames' timing), when it isn't the
 * item's `move.start`/`move.end`: on a part of a split shot (see `splitFrom`) it may begin before the part or end
 * after it.
 */
export type MoveClock = { a: number; b: number };

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
 * value at `a`: one that starts on the shot's last frame cuts to its end value there, and one that starts after it
 * (`a` ≥ `frames`) never plays. Times past the shot are clamped to it.
 *
 * Zoom moves at a steady rate to the eye, z = z0·(z1/z0)^e(p); focus moves linearly, f = f0 + (f1 − f0)·e(p). The
 * move starts from the item's own `zoom` and `focus`; a focus axis the move leaves out stays the item's.
 *
 * `clock` (`LaidItem.clock`, from moveClocks) replaces `a` and `b` for a part of a split shot.
 */
export function moveFrames(item: ClipItem, frames: number, fps: number, clock?: MoveClock): { zoom: number; x: number; y: number }[] {
  const m = item.move;
  const { z0, z1, x0, x1, y0, y1, a, b } = moveSpan(item, frames, fps, clock);
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
function moveSpan(item: ClipItem, frames: number, fps: number, clock?: MoveClock) {
  const m = item.move;
  return {
    z0: item.zoom,
    z1: m?.zoom ?? item.zoom,
    x0: item.focus.x,
    x1: m?.focus?.x ?? item.focus.x,
    y0: item.focus.y,
    y1: m?.focus?.y ?? item.focus.y,
    a: clock?.a ?? Math.round((m?.start ?? 0) * fps),
    b: clock?.b ?? Math.round((m?.end ?? frames / fps) * fps),
  };
}

/** True when two moves are the same (two absent moves are). */
export function sameMove(p: Move | undefined, q: Move | undefined): boolean {
  if (!p || !q) return p === q;
  return p.zoom === q.zoom && p.ease === q.ease && p.start === q.start && p.end === q.end && p.focus?.x === q.focus?.x && p.focus?.y === q.focus?.y;
}

/** The split shot an item is a part of (a card never is). */
const shotOf = (item: TimelineItem): string | undefined => (isCard(item) ? undefined : item.splitFrom?.item);

/** The parts of each split shot: runs of two or more items next to each other with the same `splitFrom.item` (indices, inclusive). */
export function splitShots(items: TimelineItem[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let i = 0; i < items.length; ) {
    const shot = shotOf(items[i]);
    let j = i;
    while (shot !== undefined && j + 1 < items.length && shotOf(items[j + 1]) === shot) j++;
    if (j > i) out.push({ from: i, to: j });
    i = j + 1;
  }
  return out;
}

/**
 * The clock each part of a split shot plays the shot's move on (undefined for every other item, and for a part whose
 * `move` was changed since the split): the move as the unsplit item would play it with the frozen frames in it. The
 * parts' source frames are the shot's frames in order, so a time of the shot lands on its own picture; a frozen frame
 * inside the shot (a part's hold, other than the last part's) adds frames to the move that runs across it, as a hold at
 * the end does. A move that starts on a part's first source frame starts after the frozen frames before it; one whose
 * last frame is a part's last source frame has arrived before them. With no `end`, the move ends at the end of the last
 * part.
 */
export function moveClocks(laid: LaidItem[], fps: number): (MoveClock | undefined)[] {
  const out: (MoveClock | undefined)[] = laid.map(() => undefined);
  for (const { from, to } of splitShots(laid.map((l) => l.item))) {
    const parts = laid.slice(from, to + 1);
    const m = (parts[0].item as ClipItem).splitFrom!.move;
    const offsets: number[] = [];
    const srcStarts: number[] = [];
    let frames = 0;
    let src = 0;
    for (const p of parts) {
      offsets.push(frames);
      srcStarts.push(src);
      frames += p.frames;
      src += p.srcFrames;
    }
    const last = parts.length - 1;
    // Where frame x of the shot's picture plays among the parts: inside a part's source, or in the last part's hold.
    const at = (x: number) => {
      const j = parts.findIndex((p, k) => x < srcStarts[k] + p.srcFrames);
      return j < 0 ? offsets[last] + parts[last].srcFrames + (x - src) : offsets[j] + (x - srcStarts[j]);
    };
    const a = at(Math.round((m.start ?? 0) * fps));
    const end = m.end === undefined ? undefined : Math.round(m.end * fps);
    const b = end === undefined ? frames : end <= 0 ? 0 : at(end - 1) + 1;
    parts.forEach((p, k) => {
      if (sameMove((p.item as ClipItem).move, m)) out[from + k] = { a: a - offsets[k], b: b - offsets[k] };
    });
  }
  return out;
}

/**
 * moveFrames' numbers, for an item with a move, as FFmpeg expressions of the frame number `n` (the name of the filter's
 * variable for it, which is `first` on the item's first frame), so a filter can work them out per frame. `e` stores the
 * eased progress in slot 0 (st(0)); `zoom`, `x` and `y` read it back (ld(0)), so each goes after `e` in the same
 * expression: `${e};${zoom}`.
 */
export function moveExprs(item: ClipItem, frames: number, fps: number, n: string, first = 0, clock?: MoveClock): { e: string; zoom: string; x: string; y: string } {
  const { z0, z1, x0, x1, y0, y1, a, b } = moveSpan(item, frames, fps, clock);
  const f = ffNum;
  const at = a + first;
  let e: string;
  // A move of one frame or less is a cut to the end value at `a`.
  if (b - a <= 1) e = `st(0,gte(${n},${at}))`;
  else {
    // On a part of a split shot the move may have started before the part (`at` < 0).
    const p = `st(0,clip(${at === 0 ? n : at < 0 ? `(${n}+${-at})` : `(${n}-${at})`}/${b - a - 1},0,1))`;
    const curve = { linear: '', in: 'ld(0)^2', out: '1-(1-ld(0))^2', inOut: 'if(lt(ld(0),0.5),2*ld(0)^2,1-2*(1-ld(0))^2)' }[item.move!.ease];
    e = curve ? `${p};st(0,${curve})` : p;
  }
  return {
    e,
    zoom: z1 === z0 ? f(z0) : `${f(z0)}*(${f(z1)}/${f(z0)})^ld(0)`,
    x: x1 === x0 ? f(x0) : `${f(x0)}+(${f(x1)}-${f(x0)})*ld(0)`,
    y: y1 === y0 ? f(y0) : `${f(y0)}+(${f(y1)}-${f(y0)})*ld(0)`,
  };
}
