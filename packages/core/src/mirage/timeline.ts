import { createHash } from 'node:crypto';
import { isCard, type Episode, type TimelineItem } from '@wordedits/shared';
import { moveClocks, type MoveClock } from './move.js';

export interface LaidItem {
  item: TimelineItem;
  index: number;
  start: number;
  end: number;
  srcFrames: number;
  holdFrames: number;
  frames: number;
  /** On a part of a split shot that plays the shot's move: where the move runs in this item's frames (moveClocks). */
  clock?: MoveClock;
}

/** An item's frames: its source (a card's `sec`, a clip item's source range at its speed), then its held frames. */
export function itemFrames(item: TimelineItem, fps: number): { srcFrames: number; holdFrames: number; frames: number } {
  const srcFrames = isCard(item) ? Math.max(1, Math.round(item.card.sec * fps)) : Math.max(1, Math.round(((item.src.out - item.src.in) / item.speed) * fps));
  const holdFrames = Math.round(item.hold * fps);
  return { srcFrames, holdFrames, frames: srcFrames + holdFrames };
}

export function layoutTimeline(ep: Episode): LaidItem[] {
  const fps = ep.output.fps;
  let frame = 0;
  const laid: LaidItem[] = ep.items.map((item, index) => {
    const f = itemFrames(item, fps);
    const start = frame / fps;
    frame += f.frames;
    return { item, index, start, end: frame / fps, ...f };
  });
  moveClocks(laid, fps).forEach((clock, i) => {
    if (clock) laid[i].clock = clock;
  });
  return laid;
}

/**
 * Identifies a cut: sha256 (first 16 hex) of each item's id, clip, source range, speed and hold (a card's `['card', id,
 * sec, hold]`). Hold is included because a changed hold moves everything after it just like a changed source range.
 */
export function itemsFingerprint(items: TimelineItem[]): string {
  const key = items.map((i) => (isCard(i) ? ['card', i.id, i.card.sec, i.hold] : [i.id, i.clip, i.src.in, i.src.out, i.speed, i.hold]));
  return createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 16);
}

export function timelineDuration(ep: Episode): number {
  const laid = layoutTimeline(ep);
  return laid.length ? laid[laid.length - 1].end : 0;
}

export function formatTime(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const EPS = 1e-9;
/** Where a range edge lands when `delta` seconds open at `at` (or, for delta < 0, the time just before `at` is removed). */
const shiftEdge = (p: number, after: boolean, at: number, delta: number) => (after ? p + delta : delta < 0 ? Math.min(p, at + delta) : p);
const shiftRange = <T extends { start: number; end: number }>(r: T, at: number, delta: number): T => ({
  ...r,
  start: shiftEdge(r.start, r.start >= at - EPS, at, delta),
  end: shiftEdge(r.end, r.end > at + EPS, at, delta),
});

/**
 * Opens `delta` seconds at output time `at`: everything after moves, anything spanning it stretches. A negative `delta`
 * removes the time just before `at`; ranges inside it collapse to its start (never end before they start; see dropCollapsed),
 * and so do sound effects. Items are untouched.
 */
export function shiftAfter(ep: Episode, at: number, delta: number): Episode {
  const shifted: Episode = {
    ...ep,
    overlays: ep.overlays.map((o) => shiftRange(o, at, delta)),
    music: ep.music.map((m) => {
      const cue = shiftRange(m, at, delta);
      return m.dips ? { ...cue, dips: m.dips.map((d) => shiftRange(d, at, delta)) } : cue;
    }),
    slots: ep.slots.map((s) => shiftRange(s, at, delta)),
    voiceover: ep.voiceover
      ? { ...ep.voiceover, lines: ep.voiceover.lines.map((l) => (l.at >= at - EPS ? { ...l, at: l.at + delta } : l)) }
      : null,
  };
  if (ep.sfx) shifted.sfx = ep.sfx.map((x) => ({ ...x, at: shiftEdge(x.at, x.at >= at - EPS, at, delta) }));
  return shifted;
}

/**
 * Removes overlays, music cues (and dips of a cue) and slots that closing a gap (shiftAfter) left shorter than one frame, naming each one
 * removed. `before` is the episode before the shifts (same lists, same order): a range already that short there was
 * written so and is kept.
 */
export function dropCollapsed(ep: Episode, before: Episode): { episode: Episode; dropped: string[] } {
  const min = 1 / ep.output.fps - EPS;
  const dropped: string[] = [];
  const keep = <T extends { start: number; end: number }>(list: T[], was: T[], name: (x: T, i: number) => string) =>
    list.filter((x, i) => {
      if (x.end - x.start >= min || !was[i] || was[i].end - was[i].start < min) return true;
      dropped.push(name(x, i));
      return false;
    });
  const overlays = keep(ep.overlays, before.overlays, (o, i) => `overlay ${i + 1} ("${o.text}")`);
  const music = keep(ep.music, before.music, (c, i) => `music cue ${i + 1} (${c.track})`).map((c) => {
    const i = ep.music.indexOf(c);
    if (!c.dips) return c;
    const dips = keep(c.dips, before.music[i]?.dips ?? [], (d) => `music cue ${i + 1} (${c.track})'s dip at ${d.start.toFixed(2)} s`);
    return dips.length === c.dips.length ? c : { ...c, dips };
  });
  const slots = keep(ep.slots, before.slots, (s) => `slot ${s.id}${s.line.trim() ? ` (line "${s.line}")` : ''}`);
  return dropped.length ? { episode: { ...ep, overlays, music, slots }, dropped } : { episode: ep, dropped };
}
