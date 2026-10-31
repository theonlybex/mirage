import type { Catalog, Episode, Slot } from '@wordedits/shared';
import { speechWords } from './overlays.js';
import { layoutTimeline, timelineDuration } from './timeline.js';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function computeSlots(ep: Episode, catalog: Catalog, o: { minLen?: number; pad?: number; wpm?: number } = {}): Slot[] {
  const minLen = o.minLen ?? 2.5;
  const pad = o.pad ?? 0.3;
  const wpm = o.wpm ?? 170;
  const D = timelineDuration(ep);
  const busy: [number, number][] = [];
  for (const w of speechWords(ep, catalog, null)) busy.push([Math.max(0, w.start - pad), Math.min(D, w.end + pad)]);
  for (const l of layoutTimeline(ep)) if (l.item.quiet) busy.push([l.start, l.end]);
  busy.sort((a, b) => a[0] - b[0]);

  const free: [number, number][] = [];
  let cursor = 0;
  for (const [a, b] of busy) {
    if (a > cursor) free.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (D > cursor) free.push([cursor, D]);

  return free
    .filter(([a, b]) => b - a >= minLen - 1e-9)
    .map(([a, b], i) => ({ id: `n${i + 1}`, start: r3(a), end: r3(b), maxWords: Math.max(0, Math.floor(((b - a - 0.4) * wpm) / 60)), line: '' }));
}

export function mergeSlots(prev: Slot[], next: Slot[]): Slot[] {
  const used = new Set<number>();
  return next.map((slot) => {
    let best = -1;
    let bestOverlap = 0;
    prev.forEach((p, i) => {
      if (used.has(i) || !p.line.trim()) return;
      const overlap = Math.min(p.end, slot.end) - Math.max(p.start, slot.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = i;
      }
    });
    if (best < 0) return slot;
    used.add(best);
    return { ...slot, line: prev[best].line };
  });
}
