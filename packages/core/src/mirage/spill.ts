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
 * The fades the spills ask of the neighbouring shots' own sound, per item id: a lead fades out the shot before over its
 * last `sec` seconds (`fadeOutSec`), a tail fades in the shot after over its first `sec` seconds (`fadeInSec`), so the
 * two sounds crossfade. A neighbour that doesn't play its own sound (muted, a card, sped up) has nothing to fade.
 */
export function fadesFor(laid: LaidItem[], spills: Spill[]): Map<string, { fadeInSec?: number; fadeOutSec?: number }> {
  const out = new Map<string, { fadeInSec?: number; fadeOutSec?: number }>();
  for (const s of spills) {
    const i = laid.findIndex((l) => l.item.id === s.item);
    if (i < 0) continue;
    const n = laid[s.kind === 'lead' ? i - 1 : i + 1]?.item;
    if (!playsOwnSound(n)) continue;
    out.set(n.id, { ...out.get(n.id), ...(s.kind === 'lead' ? { fadeOutSec: s.sec } : { fadeInSec: s.sec }) });
  }
  return out;
}
