// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isCard, type CardItem, type Catalog, type ClipItem, type Episode, type ThumbLayout } from '@wordedits/shared';
import type { MediaTools } from '../media-tools.js';
import { ffNum } from './encode.js';
import { MirageError } from './errors.js';
import { bundledFontsDir, CAPTION_FONT } from './fonts.js';
import { loadCatalog } from './ingest.js';
import { cardImagesFor } from './cards.js';
import { assDraw, buildAss, scaler, tidy } from './overlays.js';
import { cardPicture, cardPictureInput, episodeDir, filterValue, frameTolerance, loadEpisode, readFrom, sourcesFor } from './render-episode.js';
import { moveFrames } from './move.js';
import { DEFAULT_FACE_SHARE, seriesOf } from './series.js';
import { layoutTimeline, type LaidItem } from './timeline.js';

/**
 * A frame of the cut worth considering as a thumbnail: where it is and why it was picked. `t` is the middle of the
 * output frame (frameTime), the time to pass to `thumbnail` as `at` for a thumbnail of that same frame.
 */
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
/** Seconds as written in a reply: up to 3 decimals, no trailing zeros. */
const secs = (n: number) => String(ms(n));

/** The output frame showing time `t` (allowing for rounding: 4.6 × 30 is 137.99999…). */
export const outputFrame = (t: number, fps: number) => Math.floor(t * fps + 1e-6);
/** The middle of output frame `f`: a time that lands on that frame however it is rounded to the millisecond. */
export const frameTime = (f: number, fps: number) => (f + 0.5) / fps;

/**
 * The times worth a thumbnail, in this order, none within MIN_GAP_SEC of an earlier pick and at most `max`:
 * 1. each moment of a catalogued clip, at every output time an item shows that clip time (through the item's speed);
 * 2. the loudest 400 ms inside each item that plays its clip's own sound at real time (`loudness`: readings of the cut's
 *    audio, `t` the middle of the 400 ms each covers; silent readings are ignored);
 * 3. the middle of each item whose beat makes the point (THUMB_BEATS), a card as well;
 * 4. even spacing over the video until `max`.
 * Each time is snapped to the output frame showing it, and given as that frame's middle (frameTime): a moment on an
 * item's first frame stays on that item's frame, not the frame before. Pure: a video of cards, or without sound, still
 * gets its beats and even spacing.
 */
export function thumbCandidates(ep: Episode, catalog: Catalog, loudness: { t: number; lufs: number }[], max: number = MAX_CANDIDATES): ThumbCandidate[] {
  const laid = layoutTimeline(ep);
  const fps = ep.output.fps;
  const duration = laid.length ? laid[laid.length - 1]!.end : 0;
  const frames = laid.reduce((n, l) => n + l.frames, 0);
  const clips = new Map(catalog.clips.map((c) => [c.id, c]));
  const picks: ThumbCandidate[] = [];
  const add = (at: number, reason: string) => {
    const f = outputFrame(at, fps);
    if (picks.length >= max || at < -EPS || f < 0 || f >= frames) return;
    const t = frameTime(f, fps);
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
 * The last filter of every JPEG Mirage writes from a frame: clips and cuts are BT.709 at limited range, and a JPEG is
 * read as BT.601 at full range. Without converting, FFmpeg writes the BT.709 numbers as they are and skin comes out
 * duller and cooler.
 */
export const JPEG_COLOUR = 'scale=out_color_matrix=bt601:out_range=pc,format=yuvj420p';

/**
 * Waits for `op` (a rename or removal of a file the person may have open); a file another app holds open (EBUSY, or EPERM
 * on Windows) is said in plain words.
 */
async function openElsewhere<T>(op: Promise<T>, shown: string): Promise<T> {
  try {
    return await op;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EBUSY' || code === 'EPERM') throw new MirageError('BUSY', `${shown} is open in another app`, 'Close it there, then run thumbnail again.');
    throw e;
  }
}

/** What writeCandidates and writeThumbnail write before swapping it in: left behind only by a run that was killed. */
const LEFT_CANDIDATES = /^\.thumbs-/;
const LEFT_THUMBNAIL = /^\.thumbnail-[^/\\]*\.jpg$/;

/** Removes the entries of `dir` named like `pattern` (as versions sweeps its .tmp- entries); a folder that isn't there has none. */
async function sweep(dir: string, pattern: RegExp): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const f of names) if (pattern.test(f)) await rm(join(dir, f), { recursive: true, force: true }).catch(() => {});
}

/** Video `n`'s last cut: the newer of final.mp4 and rough.mp4 by modification time (final on a tie). Throws when there is none. */
function latestCut(dir: string, n: number): 'final.mp4' | 'rough.mp4' {
  const made = (['final.mp4', 'rough.mp4'] as const).flatMap((f) => (existsSync(join(dir, f)) ? [{ f, at: statSync(join(dir, f)).mtimeMs }] : []));
  if (!made.length) throw new MirageError('NO_EPISODE', `video ${n} has no cut yet`, 'Run cut (or render) first.');
  return made.reduce((a, b) => (b.at > a.at ? b : a)).f;
}

/**
 * Writes the candidate frames of video `n`'s last cut (latestCut) as episodes/<n>/thumbs/cand-01.jpg …, each at the cut's
 * size. They are written in a folder of their own inside the episode folder first and only then swapped in, removing the
 * earlier cand-*.jpg files (nothing else in thumbs/): stopped or failed part way, the earlier candidates stay as they were.
 * Throws when there is no cut.
 */
export async function writeCandidates(project: string, n: number, tools: MediaTools, o: { signal?: AbortSignal } = {}): Promise<CandidateFrames> {
  const dir = episodeDir(project, n);
  const source = latestCut(dir, n);
  const cut = join(dir, source);
  const ep = await loadEpisode(project, n);
  const catalog = await loadCatalog(project);

  // The audio is only read when an item's own sound could be the loudest moment.
  const probe = await tools.probe(cut);
  const ownSound = ep.items.some((i) => !isCard(i) && i.audio === 'keep' && i.speed === 1);
  const loudness = ownSound && probe.hasAudio ? await cutLoudness(cut, tools, o) : [];
  const laid = layoutTimeline(ep);
  const cutSec = probe.videoDurationSec ?? probe.durationSec;
  // The render accepts a cut this close to the timeline's length as the timeline's own.
  const timelineChanged = Math.abs(cutSec - laid[laid.length - 1]!.end) > Math.max(0.1, 1 / ep.output.fps) + EPS;
  // A timeline that grew after the cut has times the cut doesn't reach.
  const picks = thumbCandidates(ep, catalog, loudness).filter((p) => p.t < cutSec - 1 / ep.output.fps);

  // What a stopped or failed run left (its own folder), then this run's folder.
  await sweep(dir, LEFT_CANDIDATES);
  const work = await mkdtemp(join(dir, '.thumbs-'));
  try {
    const frames: CandidateFrames['frames'] = [];
    for (const [i, p] of picks.entries()) {
      const file = `cand-${String(i + 1).padStart(2, '0')}.jpg`;
      // -accurate_seek (FFmpeg's default when transcoding) decodes from the keyframe before and keeps the first frame
      // at or after the seek time: half a frame before frame f (p.t is its middle), so it is frame f exactly.
      const seek = Math.max(0, p.t - 1 / ep.output.fps);
      await tools.runFfmpeg(['-accurate_seek', '-ss', ffNum(seek), '-i', cut, '-vf', JPEG_COLOUR, '-frames:v', '1', '-q:v', '2', join(work, file)], { signal: o.signal });
      if (!existsSync(join(work, file))) throw new MirageError('BAD_INPUT', `${source} has no picture at ${p.t.toFixed(1)} s`, `Render video ${n} again (cut or render), then pick frames.`);
      frames.push({ ...p, file });
    }
    o.signal?.throwIfAborted();
    const thumbs = join(dir, 'thumbs');
    await mkdir(thumbs, { recursive: true });
    for (const f of await readdir(thumbs)) if (CAND_FILE.test(f)) await openElsewhere(rm(join(thumbs, f), { force: true }), `episodes/${n}/thumbs/${f}`);
    for (const f of frames) await openElsewhere(rename(join(work, f.file), join(thumbs, f.file)), `episodes/${n}/thumbs/${f.file}`);
    return { source, timelineChanged, frames };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** A time as m:ss.s (tenths rounded as a whole, so 59.96 is 1:00.0). */
export function formatThumbTime(t: number): string {
  const tenths = Math.round(t * 10);
  return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`;
}

/**
 * The tool's reply: how many frames and from which cut, then a line per frame: file, time (m:ss.s), the `at` that writes a
 * thumbnail of that frame (seconds), and why it was picked.
 */
export function candidatesReport(n: number, r: CandidateFrames): string[] {
  return [
    `wrote ${r.frames.length} candidate frames to episodes/${n}/thumbs/ (from ${r.source})`,
    ...r.frames.map((f) => `${f.file}  ${formatThumbTime(f.t)}  at ${secs(f.t)}  ${f.reason}`),
    ...(r.timelineChanged ? [`⚠ the timeline changed after ${r.source} was made — run cut again for frames that match`] : []),
  ];
}

/** Seconds the scripts drawing a thumbnail's text show their events: a card's text fades in and out at its ends. */
const CARD_SEC = 10;

/** At most this many words on a thumbnail. */
export const MAX_THUMB_WORDS = 4;

/** The thumbnail's size: 1280×720 for a video wider than tall, else the 1080×1920 cover of a Short or Reel. */
export function thumbSize(output: { width: number; height: number }): { width: number; height: number } {
  return output.width > output.height ? { width: 1280, height: 720 } : { width: 1080, height: 1920 };
}

/**
 * What the video shows at an output time: a clip item's picture at `src` seconds into its clip, on the item's output
 * frame `frame` (0 = its first, held frames counted), or a card.
 */
export type ThumbSource = { laid: LaidItem; src: number; frame: number } | { laid: LaidItem; card: true };

/**
 * What video `ep` shows at output time `at`: the item of the frame showing it, and for a clip item the time in its clip
 * the render looks for: `src.in` + the frame's place in the item × speed / fps. During a hold, the held frame: the render
 * clones its frame `srcFrames`, at `src.in + srcFrames × speed / fps` (which can be a little past src.out, and past the
 * clip's last frame; the render, and writeThumbnail, then show the last frame there is). Under a move it is still the
 * clip's own frame; `frame` says where in the item it is, for the move's zoom and focus there (thumbFraming). Throws
 * when `at` is outside the video.
 */
export function thumbSource(ep: Episode, at: number): ThumbSource {
  const fps = ep.output.fps;
  const laid = layoutTimeline(ep);
  const total = laid.reduce((f, l) => f + l.frames, 0);
  const outside = () => new MirageError('BAD_INPUT', `${at} s is outside the video (0–${secs(total / fps)} s)`, '');
  if (!Number.isFinite(at) || at < 0) throw outside();
  const frame = outputFrame(at, fps);
  let first = 0;
  for (const l of laid) {
    if (frame < first + l.frames) {
      if (isCard(l.item)) return { laid: l, card: true };
      const { src, speed } = l.item;
      return { laid: l, src: src.in + (Math.min(frame - first, l.srcFrames) * speed) / fps, frame: frame - first };
    }
    first += l.frames;
  }
  throw outside();
}

/**
 * The zoom and focus a clip item shows on its output frame `frame` (moveFrames: an animated `move` at that frame, else
 * the item's own `zoom` and `focus`).
 */
export function thumbFraming(l: LaidItem, frame: number, fps: number): { zoom: number; focus: { x: number; y: number } } {
  const item = l.item as ClipItem;
  const at = moveFrames(item, l.frames, fps, l.clock)[Math.min(Math.max(0, frame), l.frames - 1)] ?? { zoom: item.zoom, x: item.focus.x, y: item.focus.y };
  return { zoom: at.zoom, focus: { x: at.x, y: at.y } };
}

/**
 * The crop that frames a source picture for a W×H thumbnail as the video frames it (FFmpeg expressions of the picture's
 * own iw×ih, so a turned clip is measured upright): the part of the picture the video shows is, for `fill`, the largest
 * window of the output's shape, and for `fit` and `blur` the whole picture, either one over `zoom`; the crop is the
 * largest window of the thumbnail's shape inside that, at (iw−ow)·x, (ih−oh)·y as Mirage's crops are. Placed this way,
 * zooming in then cropping the output's shape and then the thumbnail's shape, each around the same focus, comes to the
 * one window. With `zoom` 1 and footage the shape of the thumbnail the window is the whole picture, so the focus has no
 * room to move it.
 */
export function thumbCrop(o: { frame: ClipItem['frame']; zoom: number; focus: { x: number; y: number }; output: { width: number; height: number }; thumb: { width: number; height: number } }): string {
  const { width: W, height: H } = o.thumb;
  const z = ffNum(o.zoom);
  const [vw, vh] = o.frame === 'fill' ? [`min(iw,ih*${o.output.width}/${o.output.height})/${z}`, `min(ih,iw*${o.output.height}/${o.output.width})/${z}`] : [`iw/${z}`, `ih/${z}`];
  return `crop=w='min(${vw},${vh}*${W}/${H})':h='min(${vh},${vw}*${H}/${W})':x='(iw-ow)*${ffNum(o.focus.x)}':y='(ih-oh)*${ffNum(o.focus.y)}'`;
}

const HAS_WORD = /[\p{L}\p{N}]/u;

/** The words of a thumbnail's text: emoji left out as they are when drawn, and a dash or other mark on its own is no word. */
export function thumbWordCount(text: string): number {
  return tidy(text).split(/\s+/).filter((w) => HAS_WORD.test(w)).length;
}

/**
 * The subtitle script drawing a thumbnail's text on a width×height picture: capitals in the bundled Montserrat
 * ExtraBold, white with a black outline px(10), size px(150) (pixels for a 1080-px short side, scaled by the picture's
 * short side), wrapping inside 5% side margins. Centred on the middle of the lower third (5/6 of the height) of a
 * landscape thumbnail; on a vertical cover at 60% of the height, clear of the bottom 20% the Shorts and Reels buttons
 * and caption cover. The text goes through assDraw as captions and overlays do (emoji left out, braces harmless).
 */
export function thumbnailAss(width: number, height: number, text: string): string {
  const px = scaler(width, height);
  const side = Math.round(width * 0.05);
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // The bundled face is heavy already: no faux bold.
    `Style: Thumb,${CAPTION_FONT},${px(150)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,${px(10)},0,5,${side},${side},0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 0,0:00:00.00,0:00:${CARD_SEC}.00,Thumb,,0,0,0,,{\\pos(${Math.round(width / 2)},${Math.round(width > height ? (height * 5) / 6 : height * 0.6)})}${assDraw(text.toUpperCase())}`,
    '',
  ].join('\n');
}

/**
 * `episodes/<n>/thumbnail.json`: how the thumbnail beside it was last made, for `posted`'s snapshot (features.json) and so
 * for `learn`: `made` (`one-frame`, with its `at`, or `two-sources`, with each source and the `layout`), and the `text`.
 */
export const THUMBNAIL_RECORD = 'thumbnail.json';

/** One of the two sources of a two-source thumbnail: a second of the video (`at`), or a picture inside the project (`image`, a photo the person gave); `focus` is the point its crop keeps in view. */
export interface ThumbPart {
  at?: number;
  image?: string;
  focus?: { x: number; y: number };
}

/**
 * A thumbnail from two sources, for when the face and the subject are never in one good frame: two crops side by side
 * with a thin white line between them, the face on `side` taking `share` of the width (default: the series' layout, else
 * the left third) and the subject filling the rest. Nothing is cut out and no background is removed.
 */
export interface TwoSources {
  face: ThumbPart;
  subject: ThumbPart;
  side?: 'left' | 'right';
  share?: number;
}

/** The white line between the two crops, in pixels of the 1280-wide thumbnail. */
const JOIN_PX = 8;

export interface Thumbnail {
  file: string;
  width: number;
  height: number;
  /** The clip and the second of it the picture is, or the card (its frame from the cut); for two sources, each one in words and the layout. */
  from: { clip: string; src: number } | 'card' | { face: string; subject: string; layout: ThumbLayout };
  /** What the person should hear about (⚠): a layout that differs from the series'. */
  warnings?: string[];
}

const LOOK = 'unsharp=5:5:0.6:5:5:0.0,eq=brightness=0.03:saturation=1.08';

/**
 * The input and the filters that make a clip item's frame a width×height picture: its frame read from the clip file
 * itself (not the compressed cut), framed as the video frames it there (thumbCrop), sharpened and brightened a little.
 */
function clipPicture(ep: Episode, catalog: Catalog, shown: Extract<ThumbSource, { src: number }>, focus: { x: number; y: number } | undefined, size: { width: number; height: number }): { input: string[]; picture: string } {
  const fps = ep.output.fps;
  const item = shown.laid.item as ClipItem;
  const src = sourcesFor({ ...ep, items: [item] }, catalog).get(item.clip)!;
  // Read as the render's chunks read a clip (readFrom: the clip's clock, a late video stream included; FFmpeg turns a
  // rotated clip upright as it does there), and pick the frame the render shows: the latest at or before the time, a
  // quarter of a frame late still counting, on the render's clock (setpts … / speed, then fps). The seek goes to the
  // keyframe before and decodes from there, so the frame is exact.
  // The time can be at or past the clip's last frame (a freeze on its end, a shot running a little past the video):
  // reading from there, FFmpeg would have nothing at or after 0 and write nothing. So it reads from `back` seconds
  // earlier (a frame's worth, and at least a second before the video's end), puts the time `k` output frames in, and
  // keeps frame k, or the last frame there is when the clip ends first, as the render's hold does (tpad clones it).
  const videoEnd = (() => {
    const p = catalog.clips.find((c) => c.id === item.clip)!.probe;
    return p.videoDurationSec ?? p.durationSec;
  })();
  const from0 = Math.max(0, Math.min(shown.src - item.speed / fps, videoEnd - 1));
  const back = shown.src - from0;
  const k = Math.max(0, Math.ceil((back * fps) / item.speed - 1e-6));
  // What the video shows on that frame: the item's framing, at the move's zoom and focus there.
  const framing = thumbFraming(shown.laid, shown.frame, fps);
  const crop = thumbCrop({ frame: item.frame, zoom: framing.zoom, focus: focus ?? framing.focus, output: ep.output, thumb: size });
  return {
    input: readFrom(src, from0),
    picture:
      `setpts=(PTS-${ffNum(Number(frameTolerance(fps)) + back)}/TB)/${ffNum(item.speed)}+${ffNum(k / fps)}/TB,fps=${ffNum(fps)}:start_time=0:round=up,` +
      `trim=end_frame=${k + 1},tpad=stop=${k + 1}:stop_mode=clone,select='eq(n,${k})',` +
      `${crop},scale=${size.width}:${size.height}:flags=lanczos,setsar=1,${LOOK}`,
  };
}

const PHOTO_HINT = 'Put the picture (a PNG or JPEG) in the project folder and give its path from there, e.g. photos/me.jpg.';
const badFocus = (f?: { x: number; y: number }) => f !== undefined && ![f.x, f.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1);

/** One source of a two-source thumbnail as an input and the filters that make it a width×height picture, and what it is in words. */
function partPicture(project: string, ep: Episode, catalog: Catalog, which: 'face' | 'subject', part: ThumbPart, size: { width: number; height: number }, k: number): { input: string[]; picture: string; what: string } {
  if ((part.at === undefined) === (part.image === undefined)) {
    throw new MirageError('BAD_INPUT', `the ${which} needs at (a second of the video) or image (a picture inside the project), one of the two`, '');
  }
  if (badFocus(part.focus)) throw new MirageError('BAD_INPUT', 'focus x and y go from 0 to 1 (0 = the left or top edge, 1 = the right or bottom edge)', '');
  if (part.image !== undefined) {
    const image = part.image;
    if (isAbsolute(image) || /^[A-Za-z]:/.test(image) || image.split(/[\\/]/).includes('..')) throw new MirageError('BAD_INPUT', `the ${which}'s picture ${image} must be a plain path inside the project`, PHOTO_HINT);
    let pic;
    try {
      pic = cardImagesFor(project, { ...ep, items: [{ id: which, beat: 'photo', card: { text: '', style: 'image', sec: 1, image }, hold: 0, quiet: true } as CardItem] }).get(which)!;
    } catch (e) {
      throw new MirageError('BAD_INPUT', `the ${which}'s picture ${image} ${(e as Error).message.endsWith('is missing') ? 'is missing' : "isn't a PNG or JPEG"}`, PHOTO_HINT);
    }
    return { input: cardPictureInput(pic, ep.output.fps), picture: `${cardPicture(pic, size, k, part.focus ?? { x: 0.5, y: 0.5 })},trim=end_frame=1,${LOOK}`, what: image };
  }
  const shown = thumbSource(ep, part.at!);
  if ('card' in shown) throw new MirageError('BAD_INPUT', `the ${which}: the video shows a card at ${secs(part.at!)} s`, 'Pick a second that shows a clip, or give a picture with image.');
  return { ...clipPicture(ep, catalog, shown, part.focus, size), what: `${(shown.laid.item as ClipItem).clip} at ${secs(Math.round(shown.src * 100) / 100)} s` };
}

/**
 * Writes episodes/<n>/thumbnail.jpg from what video `n` shows at output second `at` (thumbSource), needing no cut:
 * - a clip item: its frame read from the clip file itself (not the compressed cut), framed as the video frames it there
 *   (thumbCrop: the item's `frame`, and the zoom and focus it shows on that frame, a `move`'s included; `focus` given
 *   moves the window instead), scaled to the thumbnail size (thumbSize), sharpened and brightened a little;
 * - a card: drawn at the thumbnail size as the render draws it, its background (black, or its picture covering the frame
 *   around `focus`, default the centre, sharpened and brightened as a clip's frame is) and its text in the card styles.
 * Then `text` (at most MAX_THUMB_WORDS words) drawn on it (thumbnailAss), and the colours turned into a JPEG's own
 * (JPEG_COLOUR). Written beside the old one and then renamed over it, so a stop or failure leaves an earlier thumbnail as
 * it was; a thumbnail.jpg open in another app is said so.
 * With `two` instead of `at`: the thumbnail is built from two sources (TwoSources), each a second of the video or a
 * picture inside the project, cropped to its own part of a landscape thumbnail around its own `focus`. The layout is the
 * one given, else the one the video's series keeps (so every episode matches), else the face on the left third; one that
 * differs from the series' comes back as a warning. How it was made is recorded in thumbnail.json either way.
 */
export async function writeThumbnail(
  project: string,
  n: number,
  o: { at?: number; text?: string; focus?: { x: number; y: number }; two?: TwoSources },
  tools: MediaTools,
  run: { signal?: AbortSignal } = {},
): Promise<Thumbnail> {
  const words = o.text === undefined ? 0 : thumbWordCount(o.text);
  if (words > MAX_THUMB_WORDS) throw new MirageError('BAD_INPUT', `thumbnail text is ${words} words — keep it to ${MAX_THUMB_WORDS} or fewer`, '');
  if (badFocus(o.focus)) throw new MirageError('BAD_INPUT', 'focus x and y go from 0 to 1 (0 = the left or top edge, 1 = the right or bottom edge)', '');
  if ((o.at === undefined) === (o.two === undefined)) throw new MirageError('BAD_INPUT', 'a thumbnail is written from at (one second of the video) or from face and subject (two sources), one of the two', '');
  const dir = episodeDir(project, n);
  const ep = await loadEpisode(project, n);
  const fps = ep.output.fps;
  const { width: W, height: H } = thumbSize(ep.output);
  const look = LOOK;
  const fontsDir = filterValue(bundledFontsDir());
  const scripts: [string, string][] = [];
  let input: string[];
  let picture: string;
  let from: Thumbnail['from'];
  let where: { name: string; hint: string };
  /** For two sources: the graph that joins them, ending in [two]. */
  let graph: string | null = null;
  let record: object;
  const warnings: string[] = [];
  const shown = o.two ? null : thumbSource(ep, o.at!);
  if (o.two) {
    if (W < H) throw new MirageError('BAD_INPUT', 'a thumbnail from two sources is for a landscape video', "A vertical video's cover is one frame: call thumbnail with at.");
    const kept = await seriesOf(project, n);
    const layout: ThumbLayout = { face: o.two.side ?? kept?.thumbnail?.face ?? 'left', share: o.two.share ?? kept?.thumbnail?.share ?? DEFAULT_FACE_SHARE };
    if (!(layout.share >= 0.2 && layout.share <= 0.5)) throw new MirageError('BAD_INPUT', "the face's share of the width goes from 0.2 to 0.5", 'About a third (0.34) is the usual.');
    if (kept?.thumbnail && (kept.thumbnail.face !== layout.face || Math.abs(kept.thumbnail.share - layout.share) > 0.005)) {
      warnings.push(`this thumbnail has the face on the ${layout.face} at ${Math.round(layout.share * 100)}% of the width, and the series “${kept.name}” keeps it on the ${kept.thumbnail.face} at ${Math.round(kept.thumbnail.share * 100)}% — leave side and share out so every episode matches, or change the series' layout with the series tool`);
    }
    const faceW = Math.round((W * layout.share) / 2) * 2;
    const catalog = await loadCatalog(project);
    const face = partPicture(project, ep, catalog, 'face', o.two.face, { width: faceW, height: H }, 0);
    const subject = partPicture(project, ep, catalog, 'subject', o.two.subject, { width: W - faceW - JOIN_PX, height: H }, 1);
    // Each crop is one frame at time 0 in the same pixel format; the left one carries the white line on its right edge.
    const one = 'setpts=PTS-STARTPTS,format=yuv420p';
    const [l, r] = layout.face === 'left' ? ['f', 's'] : ['s', 'f'];
    input = [...face.input, ...subject.input];
    graph = `[0:v]${face.picture},${one}[f];[1:v]${subject.picture},${one}[s];[${l}]pad=iw+${JOIN_PX}:ih:0:0:color=white[l];[l][${r}]hstack=inputs=2,setsar=1[two]`;
    picture = '';
    from = { face: face.what, subject: subject.what, layout };
    where = { name: `${face.what} and ${subject.what}`, hint: 'Check both sources, or pick other ones.' };
    record = { made: 'two-sources', face: o.two.face, subject: o.two.subject, layout };
  } else if ('card' in shown!) {
    // A card is drawn at the thumbnail's size as the render draws it: its background (black, or its picture through the
    // render's own picture chain, cropped around the focus), then its text in the card styles of buildAss.
    const item = shown.laid.item as CardItem;
    const focus = o.focus ?? { x: 0.5, y: 0.5 };
    if (item.card.style === 'image') {
      const pic = cardImagesFor(project, { ...ep, items: [item] }).get(item.id)!;
      input = cardPictureInput(pic, fps);
      picture = `${cardPicture(pic, { width: W, height: H }, 0, focus)},${look}`;
    } else {
      input = ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${ffNum(fps)}:d=1`];
      picture = 'setsar=1';
    }
    if (item.card.text.trim()) {
      scripts.push(['card.ass', buildAss({ width: W, height: H, captions: [], overlays: [], prompts: [], cards: [{ start: 0, end: CARD_SEC, card: item.card }] })]);
    }
    from = 'card';
    where = { name: `card ${item.id}`, hint: `Check card ${item.id} (run check), then write the thumbnail again.` };
  } else {
    const item = shown!.laid.item as ClipItem;
    const made = clipPicture(ep, await loadCatalog(project), shown as Extract<ThumbSource, { src: number }>, o.focus, { width: W, height: H });
    input = made.input;
    picture = made.picture;
    from = { clip: item.clip, src: ms((shown as { src: number }).src) };
    where = { name: item.clip, hint: `Check item ${item.id}'s src against ${item.clip}, or pick another time.` };
  }
  const text = o.text !== undefined && tidy(o.text) !== '' ? o.text : null;
  record = o.two ? { ...record!, text } : { made: 'one-frame', at: o.at, text };
  if (o.text !== undefined && tidy(o.text) !== '') scripts.push(['thumbnail.ass', thumbnailAss(W, H, o.text)]);
  // The picture is stamped CARD_SEC/2 into the scripts: past a card's fade in, before its fade out. Scripts are named
  // relative to the folder FFmpeg runs in, so their paths need no escaping in the graph.
  const vf = [...(graph ? [] : [picture]), ...(scripts.length ? [`setpts=PTS-STARTPTS+${CARD_SEC / 2}/TB`] : []), ...scripts.map(([name]) => `ass=${name}:fontsdir=${fontsDir}`), JPEG_COLOUR].join(',');
  const file = join(dir, 'thumbnail.jpg');
  await sweep(dir, LEFT_THUMBNAIL);
  const part = join(dir, `.thumbnail-${randomUUID().slice(0, 8)}.jpg`);
  const work = await mkdtemp(join(tmpdir(), 'mirage-thumb-'));
  try {
    for (const [name, text] of scripts) await writeFile(join(work, name), text);
    const filters = graph ? ['-filter_complex', `${graph};[two]${vf}[out]`, '-map', '[out]'] : ['-vf', vf];
    await tools.runFfmpeg([...input, ...filters, '-frames:v', '1', '-q:v', '2', part], { cwd: work, signal: run.signal });
    if (!existsSync(part)) throw new MirageError('BAD_INPUT', `${!shown || 'card' in shown ? where.name : `${where.name} at ${secs(shown.src)} s`} gave no picture`, where.hint);
    run.signal?.throwIfAborted();
    await openElsewhere(rename(part, file), `episodes/${n}/thumbnail.jpg`);
    // What it was written with, for `posted`'s snapshot of the video (features.json): a record, so failing to write it never fails the thumbnail.
    await writeFile(join(dir, THUMBNAIL_RECORD), `${JSON.stringify(record, null, 2)}\n`).catch(() => {});
  } finally {
    await rm(part, { force: true });
    await rm(work, { recursive: true, force: true });
  }
  return { file, width: W, height: H, from, ...(warnings.length ? { warnings } : {}) };
}

/** The tool's reply: the file, its size and where the picture came from. */
export function thumbnailReport(n: number, r: Thumbnail): string {
  const from = r.from === 'card' ? 'the card'
    : 'layout' in r.from ? `two sources: the face (${r.from.face}) on the ${r.from.layout.face}, ${Math.round(r.from.layout.share * 100)}% of the width, and the subject (${r.from.subject}) filling the rest`
    : `${r.from.clip} at ${Math.round(r.from.src * 100) / 100} s`;
  return `wrote episodes/${n}/thumbnail.jpg (${r.width}×${r.height}, from ${from})`;
}
