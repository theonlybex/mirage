// SPDX-License-Identifier: MIT
import { isCard, type Catalog, type ClipItem, type Episode, type TimelineItem } from '@wordedits/shared';
import type { ClipSource } from './render-episode.js';
import { layoutTimeline, type LaidItem } from './timeline.js';

/**
 * J- and L-cuts: a shot's own sound starting before its picture (`leadIn`) or carrying on under the next shot
 * (`tailOut`). Pure: what plays where, and the fades it asks of the neighbouring shots' own sound. The render plays it.
 */

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const s2 = (n: number) => n.toFixed(2);
const EPS = 1e-6;

/** A piece of a clip's own sound played outside its shot: `clip` from `srcIn` to `srcOut`, at output time `at` for `sec` seconds. */
export interface Spill {
  item: string;
  kind: 'lead' | 'tail';
  clip: string;
  srcIn: number;
  srcOut: number;
  at: number;
  sec: number;
}

/** A leadIn or tailOut that plays shorter than written (`got` seconds of the `asked`), and why. */
export interface Shortened {
  item: string;
  field: 'leadIn' | 'tailOut';
  asked: number;
  got: number;
  reason: string;
}

/** The clips' sound: the sources the render uses, or the catalog. */
export type SoundSources = Map<string, ClipSource> | Catalog;

/**
 * Whether the clip has sound, and how long it runs: its sound starts with the clip (before a late video stream) and can
 * run on past the picture, so this is the clip's whole duration. Undefined for a clip the sources don't have.
 */
function soundOf(sources: SoundSources, clip: string): { hasAudio: boolean; durationSec: number } | undefined {
  if (sources instanceof Map) return sources.get(clip);
  return sources.clips.find((c) => c.id === clip)?.probe;
}

/** True when the item asks for a leadIn or a tailOut: one written as 0 is none. */
export const hasSpill = (item: TimelineItem): item is ClipItem => !isCard(item) && ((item.leadIn ?? 0) > 0 || (item.tailOut ?? 0) > 0);

/** True when the item plays its own sound: a clip item with `audio: "keep"` at speed 1 (whether its clip has sound aside). */
export const playsOwnSound = (item: TimelineItem | undefined): item is ClipItem => !!item && !isCard(item) && item.audio === 'keep' && item.speed === 1;

/** True when the item's leadIn and tailOut can play: it plays its own sound, and its clip has some. */
export function keepsOwnSound(item: TimelineItem, sources: SoundSources): boolean {
  return playsOwnSound(item) && soundOf(sources, item.clip)?.hasAudio === true;
}

/**
 * Each usable lead and tail, in timeline order (an item's lead before its tail), worked out from the final layout
 * (`laid`, default the episode's): a lead is the leadIn, at most the clip's sound before `src.in` and the shot before's
 * length; a tail is the tailOut, at most the clip's sound after the shot's last frame and the shot after's length, and
 * starts after the shot's held frames. A lead on the first shot or a tail on the last has nothing to play under.
 * `shortened` names every value that plays shorter than written (to 0 included). Items that don't keep their own sound
 * (keepsOwnSound) give neither.
 */
export function spills(ep: Episode, sources: SoundSources, laid?: LaidItem[]): { spills: Spill[]; shortened: Shortened[] } {
  const out: Spill[] = [];
  const shortened: Shortened[] = [];
  if (!ep.items.some(hasSpill)) return { spills: out, shortened };
  const fps = ep.output.fps;
  const lay = laid ?? layoutTimeline(ep);
  const length = (l: LaidItem) => l.frames / fps;
  lay.forEach((l, i) => {
    const item = l.item;
    if (!hasSpill(item) || !keepsOwnSound(item, sources)) return;
    const duration = soundOf(sources, item.clip)!.durationSec;
    // Where the shot's sound is cut: its last source frame, as the render cuts it.
    const srcEnd = item.src.in + l.srcFrames / fps;
    const sides = [
      { field: 'leadIn' as const, asked: item.leadIn, neighbour: lay[i - 1], source: item.src.in, edge: "it's the first shot", side: 'before' },
      { field: 'tailOut' as const, asked: item.tailOut, neighbour: lay[i + 1], source: Math.max(0, duration - srcEnd), edge: "it's the last shot", side: 'after' },
    ];
    for (const s of sides) {
      if (s.asked === undefined || s.asked <= 0) continue;
      let got: number;
      let reason = '';
      if (!s.neighbour) {
        got = 0;
        reason = s.edge;
      } else {
        const room = length(s.neighbour);
        got = Math.min(s.asked, s.source, room);
        if (got < s.asked - EPS) reason = s.source <= room ? `${item.clip} has only ${s2(s.source)} s of sound ${s.side} the shot` : `the shot ${s.side} it is only ${s2(room)} s long`;
      }
      got = r6(got);
      if (reason) shortened.push({ item: item.id, field: s.field, asked: s.asked, got, reason });
      if (got <= EPS) continue;
      out.push(
        s.field === 'leadIn'
          ? { item: item.id, kind: 'lead', clip: item.clip, srcIn: r6(item.src.in - got), srcOut: item.src.in, at: r6(l.start - got), sec: got }
          : { item: item.id, kind: 'tail', clip: item.clip, srcIn: r6(srcEnd), srcOut: r6(srcEnd + got), at: r6(l.end), sec: got },
      );
    }
  });
  return { spills: out, shortened };
}

/**
 * An equal-power fade (a quarter sine, `curve=qsin`: a fade in and a fade out over one window add to one level) on a
 * sound: `t` in or out, over `sec` seconds starting `st` seconds into that sound. A negative `st` starts the fade before
 * the sound does: the sound is the later part of a longer fade, and begins part-way through it.
 */
export interface Fade {
  t: 'in' | 'out';
  st: number;
  sec: number;
}

/** The fades on an item's own sound: in at its start, out at its end. */
export interface ItemFades {
  fadeIn?: Fade;
  fadeOut?: Fade;
}

/** A spill's own fade where it meets no spill from the other side of its cut: a lead fades in over its length, a tail out. */
export const singleFade = (s: Spill): Fade => (s.kind === 'lead' ? { t: 'in', st: 0, sec: s.sec } : { t: 'out', st: 0, sec: s.sec });

/**
 * The crossfades of the spills, per cut, for the spills themselves (`spills`, in the order given) and the shots' own
 * sound under them (`items`, by item id).
 *
 * A lead alone fades in over its length while the shot before's own sound fades out over its last `sec` seconds; a tail
 * alone fades out over its length while the shot after's own sound fades in over its first `sec` seconds. Where a lead
 * and the tail of the shot before meet at one cut, the two sides crossfade once, over the whole window from `cut − lead`
 * to `cut + tail`: the shot before's own sound and its tail fade out as one fade, the lead and the shot after's own sound
 * fade in as one. A neighbour that doesn't play its own sound (muted, a card, sped up) has nothing to fade.
 */
export function fadesFor(laid: LaidItem[], spills: Spill[]): { items: Map<string, ItemFades>; spills: Fade[] } {
  const items = new Map<string, ItemFades>();
  const at = (id: string) => laid.findIndex((l) => l.item.id === id);
  // Each cut by the index of the shot before it: the tail that plays after it, the lead that plays before it.
  const tails = new Map<number, Spill>();
  const leads = new Map<number, Spill>();
  for (const s of spills) {
    const i = at(s.item);
    if (i < 0) continue;
    if (s.kind === 'tail') tails.set(i, s);
    else leads.set(i - 1, s);
  }
  const fades = spills.map((s): Fade => {
    const i = at(s.item);
    const cut = s.kind === 'tail' ? i : i - 1;
    const [tail, lead] = [tails.get(cut), leads.get(cut)];
    if (!tail || !lead) return singleFade(s);
    const sec = r6(lead.sec + tail.sec);
    return s.kind === 'lead' ? { t: 'in', st: 0, sec } : { t: 'out', st: r6(-lead.sec), sec };
  });
  for (const cut of new Set([...tails.keys(), ...leads.keys()])) {
    const [tail, lead] = [tails.get(cut), leads.get(cut)];
    const sec = r6((lead?.sec ?? 0) + (tail?.sec ?? 0));
    const [before, after] = [laid[cut], laid[cut + 1]];
    if (lead && before && playsOwnSound(before.item)) {
      items.set(before.item.id, { ...items.get(before.item.id), fadeOut: { t: 'out', st: r6(before.end - before.start - lead.sec), sec } });
    }
    if (tail && after && playsOwnSound(after.item)) {
      items.set(after.item.id, { ...items.get(after.item.id), fadeIn: { t: 'in', st: lead ? r6(-lead.sec) : 0, sec } });
    }
  }
  return { items, spills: fades };
}
