import type { Catalog, Episode, Slot } from '@wordedits/shared';
import { MirageError } from './errors.js';
import { speechWords } from './overlays.js';
import { itemsFingerprint, layoutTimeline, timelineDuration } from './timeline.js';

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

type Span = { start: number; end: number };

/**
 * Gives each written line in `prev` the new slot its span overlaps most (matched globally, largest overlap first).
 * `where` says where an old slot's span is now (null: its picture is gone); by default, where it was.
 */
export function mergeSlots(prev: Slot[], next: Slot[], where: (p: Slot) => Span | null = (p) => p): Slot[] {
  const pairs: { p: number; n: number; overlap: number }[] = [];
  prev.forEach((p, pi) => {
    if (!p.line.trim()) return;
    const span = where(p);
    if (!span) return;
    next.forEach((slot, ni) => {
      const overlap = Math.min(span.end, slot.end) - Math.max(span.start, slot.start);
      const shorter = Math.min(span.end - span.start, slot.end - slot.start);
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

export type SlotsCut = NonNullable<Episode['slotsCut']>;

/** The cut slots are computed for: its fingerprint, and each item's place on the timeline and in its clip. */
export function cutOf(ep: Episode): SlotsCut {
  return {
    fingerprint: itemsFingerprint(ep.items),
    items: layoutTimeline(ep).map((l) => ({ id: l.item.id, start: r3(l.start), end: r3(l.end), in: l.item.src.in, speed: l.item.speed })),
  };
}

/** True when the items changed since the slots were computed (or, for older episodes, since the voice-over was fitted). */
export function slotsStale(ep: Episode): boolean {
  const known = ep.slotsCut?.fingerprint ?? ep.voiceover?.fittedItemsFingerprint;
  return known !== undefined && known !== itemsFingerprint(ep.items);
}

export function slotsStaleError(n: number): MirageError {
  return new MirageError(
    'BAD_ITEM',
    'The cut changed since slots were written — run slots first',
    `Run: pnpm mirage slots <project> ${n}, check the lines it carried over, then run vo again (it reuses the saved transcript).`,
  );
}

/**
 * Where a span of the cut `was` sits in `ep`: each part of it follows the source of the item it was on (by item id), so
 * re-ordering, removing or trimming items moves a slot with its picture. Null when none of its items are left.
 */
function follow(span: Span, was: SlotsCut, ep: Episode): Span | null {
  const now = new Map(layoutTimeline(ep).map((l) => [l.item.id, l]));
  let start = Infinity;
  let end = -Infinity;
  for (const o of was.items) {
    const a = Math.max(span.start, o.start);
    const b = Math.min(span.end, o.end);
    const l = now.get(o.id);
    if (b <= a || !l) continue;
    const at = (t: number) => {
      const src = o.in + (t - o.start) * o.speed;
      return Math.min(l.end, Math.max(l.start, l.start + (src - l.item.src.in) / l.item.speed));
    };
    const [x, y] = [at(a), at(b)];
    if (y - x < 1e-6) continue;
    start = Math.min(start, x);
    end = Math.max(end, y);
  }
  return end > start ? { start: r3(start), end: r3(end) } : null;
}

/**
 * The `slots` command's merge: carries each written line of `ep` onto the new `next` slots, following the picture it
 * was written over (absolute times for slots written before the cut was recorded). Reports lines that moved to another
 * place on the timeline and lines whose picture is gone or found no slot.
 */
export function carrySlots(ep: Episode, next: Slot[]): { slots: Slot[]; moved: { line: string; from: Slot; to: Slot }[]; dropped: Slot[] } {
  const was = ep.slotsCut;
  const slots = mergeSlots(ep.slots, next, was ? (p) => follow(p, was, ep) : undefined);
  const moved: { line: string; from: Slot; to: Slot }[] = [];
  const dropped: Slot[] = [];
  const taken = new Set<number>();
  for (const p of ep.slots) {
    if (!p.line.trim()) continue;
    const i = slots.findIndex((s, k) => !taken.has(k) && s.line === p.line);
    if (i < 0) {
      dropped.push(p);
      continue;
    }
    taken.add(i);
    if (Math.abs(slots[i].start - p.start) > 0.5 || Math.abs(slots[i].end - p.end) > 0.5) moved.push({ line: p.line, from: p, to: slots[i] });
  }
  return { slots, moved, dropped };
}
