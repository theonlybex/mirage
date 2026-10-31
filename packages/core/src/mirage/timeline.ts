import type { Episode, TimelineItem } from '@wordedits/shared';

export interface LaidItem {
  item: TimelineItem;
  index: number;
  start: number;
  end: number;
  srcFrames: number;
  holdFrames: number;
  frames: number;
}

export function itemFrames(item: TimelineItem, fps: number): { srcFrames: number; holdFrames: number; frames: number } {
  const srcFrames = Math.max(1, Math.round(((item.src.out - item.src.in) / item.speed) * fps));
  const holdFrames = Math.round(item.hold * fps);
  return { srcFrames, holdFrames, frames: srcFrames + holdFrames };
}

export function layoutTimeline(ep: Episode): LaidItem[] {
  const fps = ep.output.fps;
  let frame = 0;
  return ep.items.map((item, index) => {
    const f = itemFrames(item, fps);
    const start = frame / fps;
    frame += f.frames;
    return { item, index, start, end: frame / fps, ...f };
  });
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
 * removes the time just before `at`; ranges inside it collapse to its start (never end before they start; see dropCollapsed).
 * Items are untouched.
 */
export function shiftAfter(ep: Episode, at: number, delta: number): Episode {
  return {
    ...ep,
    overlays: ep.overlays.map((o) => shiftRange(o, at, delta)),
    music: ep.music.map((m) => shiftRange(m, at, delta)),
    slots: ep.slots.map((s) => shiftRange(s, at, delta)),
    voiceover: ep.voiceover
      ? { ...ep.voiceover, lines: ep.voiceover.lines.map((l) => (l.at >= at - EPS ? { ...l, at: l.at + delta } : l)) }
      : null,
  };
}

/** Removes overlays, music cues and slots left shorter than one frame (by shiftAfter closing a gap), naming each one removed. */
export function dropCollapsed(ep: Episode): { episode: Episode; dropped: string[] } {
  const min = 1 / ep.output.fps - EPS;
  const dropped: string[] = [];
  const keep = <T extends { start: number; end: number }>(list: T[], name: (x: T, i: number) => string) =>
    list.filter((x, i) => {
      if (x.end - x.start >= min) return true;
      dropped.push(name(x, i));
      return false;
    });
  const overlays = keep(ep.overlays, (o, i) => `overlay ${i + 1} ("${o.text}")`);
  const music = keep(ep.music, (c, i) => `music cue ${i + 1} (${c.track})`);
  const slots = keep(ep.slots, (s) => `slot ${s.id}${s.line.trim() ? ` (line "${s.line}")` : ''}`);
  return dropped.length ? { episode: { ...ep, overlays, music, slots }, dropped } : { episode: ep, dropped };
}
