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

const EPS = 1e-9;
const shiftRange = <T extends { start: number; end: number }>(r: T, at: number, delta: number): T => ({
  ...r,
  start: r.start >= at - EPS ? r.start + delta : r.start,
  end: r.end > at + EPS ? r.end + delta : r.end,
});

/** Opens `delta` seconds at output time `at`: everything after moves, anything spanning it stretches. Items are untouched. */
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
