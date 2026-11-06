// SPDX-License-Identifier: MIT
import { join, resolve } from 'node:path';
import { layoutTimeline, timelineDuration } from '@wordedits/core';
import { CatalogSchema, EpisodeSchema, type Catalog } from '@wordedits/shared';
import type { TimelineView } from '../view-types.js';
import { mediaPath } from './media.js';

export type { TimelineView };

const emptyView = (status: TimelineView['status']): TimelineView => ({ status, title: '', durationSec: 0, items: [], overlays: [], music: [], slots: [], voice: [] });

function parse(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The clip's catalog frame nearest the middle of the part used, as a media path. */
function thumbFor(project: string, catalog: Catalog | null, clipId: string, src: { in: number; out: number }): string | null {
  const frames = catalog?.clips.find((c) => c.id === clipId)?.frames ?? [];
  const mid = (src.in + src.out) / 2;
  let best: (typeof frames)[number] | null = null;
  for (const f of frames) if (!best || Math.abs(f.t - mid) < Math.abs(best.t - mid)) best = f;
  return best ? mediaPath(resolve(join(project, best.file))) : null;
}

/**
 * The timeline as the page draws it, from the raw text of episode.json and catalog.json (null = no such file). A missing
 * episode is `empty`. One that doesn't parse or fails its schema (Claude is writing it) is `editing` and shows `previous`'s
 * lists, else empty ones. A catalog that is missing or broken only means no thumbnails.
 */
export function buildTimelineView(project: string, raw: { episode: string | null; catalog: string | null }, previous: TimelineView | null): TimelineView {
  if (raw.episode === null) return emptyView('empty');
  const parsed = EpisodeSchema.safeParse(parse(raw.episode));
  if (!parsed.success) return { ...(previous ?? emptyView('editing')), status: 'editing' };
  const ep = parsed.data;
  const catalogParsed = CatalogSchema.safeParse(parse(raw.catalog));
  const catalog = catalogParsed.success ? catalogParsed.data : null;
  return {
    status: 'ok',
    title: ep.title,
    durationSec: timelineDuration(ep),
    items: layoutTimeline(ep).map(({ item, start, end }) => ({
      id: item.id,
      beat: item.beat,
      clip: item.clip,
      start,
      end,
      thumb: thumbFor(project, catalog, item.clip, item.src),
      quiet: item.quiet,
      speed: item.speed,
    })),
    overlays: ep.overlays.map((o) => ({ kind: o.kind, text: o.text, tone: o.tone, start: o.start, end: o.end })),
    music: ep.music.map((m) => ({ track: m.track, start: m.start, end: m.end })),
    slots: ep.slots.map((s) => ({ id: s.id, start: s.start, end: s.end, line: s.line, maxWords: s.maxWords })),
    voice: (ep.voiceover?.lines ?? []).map((l) => ({ slot: l.slot, start: l.at, end: l.at + (l.src.out - l.src.in) - l.cuts.reduce((s, [a, b]) => s + (b - a), 0) })),
  };
}
