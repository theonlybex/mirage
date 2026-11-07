// SPDX-License-Identifier: MIT
import type { Move, TimelineItem } from '@wordedits/shared';

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
  const z0 = item.zoom;
  const z1 = m?.zoom ?? z0;
  const x0 = item.focus.x;
  const y0 = item.focus.y;
  const x1 = m?.focus?.x ?? x0;
  const y1 = m?.focus?.y ?? y0;
  const a = Math.round((m?.start ?? 0) * fps);
  const b = Math.round((m?.end ?? frames / fps) * fps);
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
