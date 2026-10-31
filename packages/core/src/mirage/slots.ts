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
  const clamp = (n: number) => Math.min(D, Math.max(0, n));
  for (const w of speechWords(ep, catalog, null)) busy.push([clamp(w.start - pad), clamp(w.end + pad)]);
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
    .map(([a, b]) => [r3(a), r3(b)] as const)
    .filter(([a, b]) => b - a >= minLen - 1e-9)
    .map(([a, b], i) => ({ id: `n${i + 1}`, start: a, end: b, maxWords: Math.max(0, Math.floor(((b - a - 0.4) * wpm) / 60 + 1e-9)), line: '' }));
}

/** Minimum overlap, as a fraction of the shorter slot, for a written line to follow a re-cut slot. */
const MIN_OVERLAP_FRACTION = 0.25;

export function mergeSlots(prev: Slot[], next: Slot[]): Slot[] {
  const pairs: { p: number; n: number; overlap: number }[] = [];
  prev.forEach((p, pi) => {
    if (!p.line.trim()) return;
    next.forEach((slot, ni) => {
      const overlap = Math.min(p.end, slot.end) - Math.max(p.start, slot.start);
      const shorter = Math.min(p.end - p.start, slot.end - slot.start);
      if (overlap > 0 && overlap >= MIN_OVERLAP_FRACTION * shorter - 1e-9) pairs.push({ p: pi, n: ni, overlap });
    });
  });
  pairs.sort((x, y) => y.overlap - x.overlap || next[x.n].start - next[y.n].start || x.p - y.p);

  const usedPrev = new Set<number>();
  const assigned = new Map<number, number>();
  for (const { p, n } of pairs) {
    if (usedPrev.has(p) || assigned.has(n)) continue;
    usedPrev.add(p);
    assigned.set(n, p);
  }
  return next.map((slot, ni) => {
    const p = assigned.get(ni);
    return p === undefined ? slot : { ...slot, line: prev[p].line };
  });
}
