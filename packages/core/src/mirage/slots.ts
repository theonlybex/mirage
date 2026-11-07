import { isCard, type Catalog, type Episode, type Slot, type TimelineItem } from '@wordedits/shared';
import { MirageError } from './errors.js';
import { speechWords } from './overlays.js';
import { itemsFingerprint, layoutTimeline, timelineDuration } from './timeline.js';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * What an item shows of its source: a clip item its clip from `in` to `out` at its speed; a card its own time, 0 to
 * `sec` at speed 1, with no clip (slots run over cards: they are picture time).
 */
const shown = (item: TimelineItem): { in: number; out: number; speed: number; clip?: string } =>
  isCard(item) ? { in: 0, out: item.card.sec, speed: 1 } : { in: item.src.in, out: item.src.out, speed: item.speed, clip: item.clip };

/** Seconds kept clear of narration either side of a spoken word (check pads carried-over words the same). */
export const SPEECH_PAD_SEC = 0.3;

export function computeSlots(ep: Episode, catalog: Catalog, o: { minLen?: number; pad?: number; wpm?: number } = {}): Slot[] {
  const minLen = o.minLen ?? 2.5;
  const pad = o.pad ?? SPEECH_PAD_SEC;
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
    items: layoutTimeline(ep).map((l) => {
      const at = { id: l.item.id, start: r3(l.start), end: r3(l.end) };
      const s = shown(l.item);
      return s.clip === undefined ? { ...at, in: s.in, speed: s.speed, out: s.out } : { ...at, in: s.in, speed: s.speed, clip: s.clip, out: s.out };
    }),
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
 * Where a span of the cut `was` sits in `ep`. Each part of it follows the source it showed: in the item with the same id,
 * and for source that item no longer shows, in the item on the same clip showing most of it (a split whose second half
 * got a new id). Re-ordering, removing, trimming and splitting items move a slot with its picture. Of the pieces found,
 * the longest run decides (not their hull, which could span unrelated items between them). Null when none is left.
 */
function follow(span: Span, was: SlotsCut, ep: Episode): Span | null {
  const laid = layoutTimeline(ep);
  const pieces: [number, number][] = [];
  const place = (l: (typeof laid)[number], a: number, b: number) => {
    const s = shown(l.item);
    const x = Math.max(a, s.in);
    const y = Math.min(b, s.out);
    if (y - x > 1e-6) pieces.push([l.start + (x - s.in) / s.speed, l.start + (y - s.in) / s.speed]);
  };
  for (const o of was.items) {
    const a = Math.max(span.start, o.start);
    const b = Math.min(span.end, o.end);
    if (b <= a) continue;
    // Source shown over [a, b]; a frozen tail shows the item's last frame.
    const srcAt = (t: number) => Math.min(o.out ?? Infinity, o.in + (t - o.start) * o.speed);
    const [sa, sb] = [srcAt(a), srcAt(b)];
    const same = laid.find((l) => l.item.id === o.id);
    let rest: [number, number][] = [[sa, sb]];
    // A card (no clip) follows the card with its id.
    if (same && (o.clip === undefined || shown(same.item).clip === o.clip)) {
      const s = shown(same.item);
      place(same, sa, sb);
      rest = [[sa, Math.min(sb, s.in)], [Math.max(sa, s.out), sb]].filter(([x, y]) => y - x > 1e-6) as [number, number][];
    }
    if (o.clip === undefined) continue;
    for (const [x, y] of rest) {
      const overlap = (l: (typeof laid)[number]) => Math.min(y, shown(l.item).out) - Math.max(x, shown(l.item).in);
      const best = laid
        .filter((l) => shown(l.item).clip === o.clip && l.item.id !== o.id && overlap(l) > 1e-6)
        .sort((p, q) => overlap(q) - overlap(p) || Math.abs(p.start - o.start) - Math.abs(q.start - o.start))[0];
      if (best) place(best, x, y);
    }
  }
  if (!pieces.length) return null;
  pieces.sort((p, q) => p[0] - q[0]);
  const runs: [number, number][] = [];
  for (const [x, y] of pieces) {
    const last = runs[runs.length - 1];
    if (last && x <= last[1] + 0.05) last[1] = Math.max(last[1], y);
    else runs.push([x, y]);
  }
  const [x, y] = runs.reduce((m, r) => (r[1] - r[0] > m[1] - m[0] ? r : m));
  return { start: r3(x), end: r3(y) };
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
