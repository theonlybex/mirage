// SPDX-License-Identifier: MIT
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCard, type Catalog, type Episode } from '@wordedits/shared';
import type { MediaTools } from '../media-tools.js';
import { MirageError } from './errors.js';
import { loadCatalog } from './ingest.js';
import { episodeDir, loadEpisode } from './render-episode.js';
import { layoutTimeline } from './timeline.js';

/** A frame of the cut worth considering as a thumbnail: where it is (output seconds) and why it was picked. */
export interface ThumbCandidate {
  t: number;
  reason: string;
}

/** At most this many candidate frames. */
export const MAX_CANDIDATES = 12;
/** A candidate is dropped when an earlier pick is closer than this many seconds. */
export const MIN_GAP_SEC = 1;
/** The beats whose middle is offered as a candidate: where a video makes its point. */
export const THUMB_BEATS: readonly string[] = ['truth', 'headline', 'payoff', 'twist', 'reveal'];
/** Below this momentary loudness (R128's absolute gate) a stretch of the cut counts as silent. */
const SILENT_LUFS = -70;
/** A momentary loudness reading covers 400 ms; the readings come every 100 ms. */
const WINDOW_SEC = 0.4;
const STEP_SEC = 0.1;
const EPS = 1e-9;
const ms = (t: number) => Math.round(t * 1000) / 1000;

/**
 * The times worth a thumbnail, in this order, none within MIN_GAP_SEC of an earlier pick and at most `max`:
 * 1. each moment of a catalogued clip, at every output time an item shows that clip time (through the item's speed);
 * 2. the loudest 400 ms inside each item that plays its clip's own sound at real time (`loudness`: readings of the cut's
 *    audio, `t` the middle of the 400 ms each covers; silent readings are ignored);
 * 3. the middle of each item whose beat makes the point (THUMB_BEATS), a card as well;
 * 4. even spacing over the video until `max`.
 * Pure: a video of cards, or without sound, still gets its beats and even spacing.
 */
export function thumbCandidates(ep: Episode, catalog: Catalog, loudness: { t: number; lufs: number }[], max: number = MAX_CANDIDATES): ThumbCandidate[] {
  const laid = layoutTimeline(ep);
  const duration = laid.length ? laid[laid.length - 1]!.end : 0;
  const clips = new Map(catalog.clips.map((c) => [c.id, c]));
  const picks: ThumbCandidate[] = [];
  const add = (t: number, reason: string) => {
    t = ms(t);
    if (picks.length >= max || t < 0 || t >= duration - EPS) return;
    if (picks.some((p) => Math.abs(p.t - t) < MIN_GAP_SEC - EPS)) return;
    picks.push({ t, reason });
  };

  for (const l of laid) {
    const item = l.item;
    if (isCard(item)) continue;
    const moments = (clips.get(item.clip)?.moments ?? []).filter((m) => m.t >= item.src.in && m.t < item.src.out).sort((a, b) => a.t - b.t);
    for (const m of moments) add(l.start + (m.t - item.src.in) / item.speed, `moment: ${m.label}`);
  }

  for (const l of laid) {
    const item = l.item;
    if (isCard(item) || item.audio !== 'keep' || item.speed !== 1) continue;
    const shown = l.start + l.srcFrames / ep.output.fps;
    let best: { t: number; lufs: number } | null = null;
    for (const s of loudness) {
      if (s.t < l.start - EPS || s.t >= shown - EPS || !(s.lufs > SILENT_LUFS)) continue;
      if (!best || s.lufs > best.lufs) best = s;
    }
    if (best) add(best.t, `loudest moment of item ${item.id}`);
  }

  for (const l of laid) {
    if (THUMB_BEATS.includes(l.item.beat)) add((l.start + l.end) / 2, `${l.item.beat} beat (item ${l.item.id})`);
  }

  // Evenly spaced points; where a pick is in the way, a finer grid fills what is left.
  for (const n of [max, max * 2, max * 4, max * 8]) {
    for (let i = 0; i < n; i++) add((duration * (i + 0.5)) / n, 'even spacing');
    if (picks.length >= max) break;
  }
  return picks;
}

/**
 * The momentary loudness (EBU R128, 400 ms) of the cut's audio every 100 ms: FFmpeg's ebur128 writes it with each
 * reading's end time, and `t` is the middle of the 400 ms it covers. One pass over the audio.
 */
export async function cutLoudness(file: string, tools: MediaTools, o: { signal?: AbortSignal } = {}): Promise<{ t: number; lufs: number }[]> {
  const work = await mkdtemp(join(tmpdir(), 'mirage-thumb-'));
  try {
    // The metadata file is named relative to the folder FFmpeg runs in, so its path needs no escaping in the graph.
    const af = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,ebur128=metadata=1,ametadata=mode=print:file=loudness.txt';
    await tools.runFfmpeg(['-i', file, '-vn', '-af', af, '-f', 'null', '-'], { cwd: work, signal: o.signal });
    const text = await readFile(join(work, 'loudness.txt'), 'utf8');
    const out: { t: number; lufs: number }[] = [];
    let at: number | null = null;
    for (const line of text.split(/\r?\n/)) {
      const frame = /pts_time:(\S+)/.exec(line);
      if (frame) at = Number(frame[1]);
      const m = /^lavfi\.r128\.M=(\S+)$/.exec(line);
      if (m && at !== null && Number.isFinite(at)) {
        const lufs = Number(m[1]);
        // The frame at `at` holds the 100 ms after it; the reading ends where that frame does (the first ones cover less than 400 ms).
        const end = at + STEP_SEC;
        if (Number.isFinite(lufs)) out.push({ t: ms((Math.max(0, end - WINDOW_SEC) + end) / 2), lufs });
      }
    }
    return out;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export interface CandidateFrames {
  source: 'final.mp4' | 'rough.mp4';
  /**
   * The cut is not the length of the timeline any more (more than a frame off): the timeline changed after the cut was made.
   * (Renders don't record which cut they were made from, so the cut's own duration is compared with the layout's.)
   */
  timelineChanged: boolean;
  frames: (ThumbCandidate & { file: string })[];
}

const CAND_FILE = /^cand-\d+\.jpg$/;

/**
 * Writes the candidate frames of video `n`'s last cut (the newer of final.mp4 and rough.mp4 by modification time, final on a tie) as episodes/<n>/thumbs/cand-01.jpg …, each at
 * the cut's size, after removing the earlier cand-*.jpg files (nothing else in thumbs/). Throws when there is no cut.
 */
export async function writeCandidates(project: string, n: number, tools: MediaTools, o: { signal?: AbortSignal } = {}): Promise<CandidateFrames> {
  const dir = episodeDir(project, n);
  const made = (['final.mp4', 'rough.mp4'] as const).flatMap((f) => (existsSync(join(dir, f)) ? [{ f, at: statSync(join(dir, f)).mtimeMs }] : []));
  const source = made.length ? made.reduce((a, b) => (b.at > a.at ? b : a)).f : undefined;
  if (!source) throw new MirageError('NO_EPISODE', `video ${n} has no cut yet`, 'Run cut (or render) first.');
  const cut = join(dir, source);
  const ep = await loadEpisode(project, n);
  const catalog = await loadCatalog(project);

  // The audio is only read when an item's own sound could be the loudest moment.
  const probe = await tools.probe(cut);
  const ownSound = ep.items.some((i) => !isCard(i) && i.audio === 'keep' && i.speed === 1);
  const loudness = ownSound && probe.hasAudio ? await cutLoudness(cut, tools, o) : [];
  const laid = layoutTimeline(ep);
  const cutSec = probe.videoDurationSec ?? probe.durationSec;
  const timelineChanged = Math.abs(cutSec - laid[laid.length - 1]!.end) > 1 / ep.output.fps + EPS;
  // A timeline that grew after the cut has times the cut doesn't reach.
  const picks = thumbCandidates(ep, catalog, loudness).filter((p) => p.t < cutSec - 1 / ep.output.fps);

  const thumbs = join(dir, 'thumbs');
  await mkdir(thumbs, { recursive: true });
  for (const f of await readdir(thumbs)) if (CAND_FILE.test(f)) await rm(join(thumbs, f), { force: true });

  const frames: CandidateFrames['frames'] = [];
  for (const [i, p] of picks.entries()) {
    const file = `cand-${String(i + 1).padStart(2, '0')}.jpg`;
    // -accurate_seek (FFmpeg's default when transcoding) decodes from the keyframe before to the frame at p.t exactly.
    await tools.runFfmpeg(['-accurate_seek', '-ss', p.t.toFixed(3), '-i', cut, '-frames:v', '1', '-q:v', '2', join(thumbs, file)], { signal: o.signal });
    if (!existsSync(join(thumbs, file))) throw new MirageError('BAD_INPUT', `${source} has no picture at ${p.t.toFixed(1)} s`, `Render video ${n} again (cut or render), then pick frames.`);
    frames.push({ ...p, file });
  }
  return { source, timelineChanged, frames };
}

/** A time as m:ss.s (tenths rounded as a whole, so 59.96 is 1:00.0). */
export function formatThumbTime(t: number): string {
  const tenths = Math.round(t * 10);
  return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`;
}

/** The tool's reply: how many frames and from which cut, then a line per frame (file, time, why). */
export function candidatesReport(n: number, r: CandidateFrames): string[] {
  return [
    `wrote ${r.frames.length} candidate frames to episodes/${n}/thumbs/ (from ${r.source})`,
    ...r.frames.map((f) => `${f.file}  ${formatThumbTime(f.t)}  ${f.reason}`),
    ...(r.timelineChanged ? [`⚠ the timeline changed after ${r.source} was made — run cut again for frames that match`] : []),
  ];
}
