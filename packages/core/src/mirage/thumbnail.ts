// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCard, type CardItem, type Catalog, type ClipItem, type Episode } from '@wordedits/shared';
import type { MediaTools } from '../media-tools.js';
import { ffNum } from './encode.js';
import { MirageError } from './errors.js';
import { bundledFontsDir, CAPTION_FONT } from './fonts.js';
import { loadCatalog } from './ingest.js';
import { cardImagesFor } from './cards.js';
import { assDraw, buildAss, scaler, tidy } from './overlays.js';
import { cardPicture, cardPictureInput, episodeDir, filterValue, frameTolerance, loadEpisode, readFrom, sourcesFor } from './render-episode.js';
import { layoutTimeline, type LaidItem } from './timeline.js';

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
      // -accurate_seek (FFmpeg's default when transcoding) decodes from the keyframe before to the frame at p.t exactly.
      await tools.runFfmpeg(['-accurate_seek', '-ss', p.t.toFixed(3), '-i', cut, '-frames:v', '1', '-q:v', '2', join(work, file)], { signal: o.signal });
      if (!existsSync(join(work, file))) throw new MirageError('BAD_INPUT', `${source} has no picture at ${p.t.toFixed(1)} s`, `Render video ${n} again (cut or render), then pick frames.`);
      frames.push({ ...p, file });
    }
    o.signal?.throwIfAborted();
    const thumbs = join(dir, 'thumbs');
    await mkdir(thumbs, { recursive: true });
    for (const f of await readdir(thumbs)) if (CAND_FILE.test(f)) await rm(join(thumbs, f), { force: true });
    for (const f of frames) await rename(join(work, f.file), join(thumbs, f.file));
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

/** The tool's reply: how many frames and from which cut, then a line per frame (file, time, why). */
export function candidatesReport(n: number, r: CandidateFrames): string[] {
  return [
    `wrote ${r.frames.length} candidate frames to episodes/${n}/thumbs/ (from ${r.source})`,
    ...r.frames.map((f) => `${f.file}  ${formatThumbTime(f.t)}  ${f.reason}`),
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

/** Seconds as written in a reply: up to 3 decimals, no trailing zeros. */
const secs = (n: number) => String(ms(n));

/** What the video shows at an output time: a clip item's picture at `src` seconds into its clip, or a card. */
export type ThumbSource = { laid: LaidItem; src: number } | { laid: LaidItem; card: true };

/**
 * What video `ep` shows at output time `at`: the item of the frame showing it, and for a clip item the time in its clip
 * the render looks for: `src.in` + the frame's place in the item × speed / fps. During a hold, the held frame: the render
 * clones its frame `srcFrames`, at `src.in + srcFrames × speed / fps` (which can be a little past src.out, and past the
 * clip's last frame; the render, and writeThumbnail, then show the last frame there is). Under a move it is still the
 * clip's own frame: the thumbnail makes its own crop. Throws when `at` is outside the video.
 */
export function thumbSource(ep: Episode, at: number): ThumbSource {
  const fps = ep.output.fps;
  const laid = layoutTimeline(ep);
  const total = laid.reduce((f, l) => f + l.frames, 0);
  const outside = () => new MirageError('BAD_INPUT', `${at} s is outside the video (0–${secs(total / fps)} s)`, '');
  if (!Number.isFinite(at) || at < 0) throw outside();
  // The frame showing `at` (allowing for rounding: 4.6 × 30 is 137.99999…).
  const frame = Math.floor(at * fps + 1e-6);
  let first = 0;
  for (const l of laid) {
    if (frame < first + l.frames) {
      if (isCard(l.item)) return { laid: l, card: true };
      const { src, speed } = l.item;
      return { laid: l, src: src.in + (Math.min(frame - first, l.srcFrames) * speed) / fps };
    }
    first += l.frames;
  }
  throw outside();
}

const HAS_WORD = /[\p{L}\p{N}]/u;

/** The words of a thumbnail's text: emoji left out as they are when drawn, and a dash or other mark on its own is no word. */
export function thumbWordCount(text: string): number {
  return tidy(text).split(/\s+/).filter((w) => HAS_WORD.test(w)).length;
}

/**
 * The subtitle script drawing a thumbnail's text on a width×height picture: capitals in the bundled Montserrat
 * ExtraBold, white with a black outline px(10), size px(150) (pixels for a 1080-px short side, scaled by the picture's
 * short side), centred on the middle of the lower third and wrapping inside 5% side margins. The text goes through
 * assDraw as captions and overlays do (emoji left out, braces harmless).
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
    `Dialogue: 0,0:00:00.00,0:00:${CARD_SEC}.00,Thumb,,0,0,0,,{\\pos(${Math.round(width / 2)},${Math.round((height * 5) / 6)})}${assDraw(text.toUpperCase())}`,
    '',
  ].join('\n');
}

export interface Thumbnail {
  file: string;
  width: number;
  height: number;
  /** The clip and the second of it the picture is, or the card (its frame from the cut). */
  from: { clip: string; src: number } | 'card';
}

/**
 * Writes episodes/<n>/thumbnail.jpg from what video `n` shows at output second `at` (thumbSource), needing no cut:
 * - a clip item: its frame read from the clip file itself (not the compressed cut), scaled to cover the thumbnail size
 *   (thumbSize) and cropped around `focus` (default the item's own) the way Mirage crops, sharpened and brightened a little;
 * - a card: drawn at the thumbnail size as the render draws it, its background (black, or its picture covering the frame
 *   around `focus`, default the centre, sharpened and brightened as a clip's frame is) and its text in the card styles.
 * Then `text` (at most MAX_THUMB_WORDS words) drawn on it (thumbnailAss). Written beside the old one and then renamed
 * over it, so a stop or failure leaves an earlier thumbnail as it was.
 */
export async function writeThumbnail(
  project: string,
  n: number,
  o: { at: number; text?: string; focus?: { x: number; y: number } },
  tools: MediaTools,
  run: { signal?: AbortSignal } = {},
): Promise<Thumbnail> {
  const words = o.text === undefined ? 0 : thumbWordCount(o.text);
  if (words > MAX_THUMB_WORDS) throw new MirageError('BAD_INPUT', `thumbnail text is ${words} words — keep it to ${MAX_THUMB_WORDS} or fewer`, '');
  if (o.focus && ![o.focus.x, o.focus.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
    throw new MirageError('BAD_INPUT', 'focus x and y go from 0 to 1 (0 = the left or top edge, 1 = the right or bottom edge)', '');
  }
  const dir = episodeDir(project, n);
  const ep = await loadEpisode(project, n);
  const fps = ep.output.fps;
  const shown = thumbSource(ep, o.at);
  const { width: W, height: H } = thumbSize(ep.output);

  const focusAt = (f: { x: number; y: number }) => `(iw-ow)*${ffNum(f.x)}:(ih-oh)*${ffNum(f.y)}`;
  const look = 'unsharp=5:5:0.6:5:5:0.0,eq=brightness=0.03:saturation=1.08';
  const fontsDir = filterValue(bundledFontsDir());
  const scripts: [string, string][] = [];
  let input: string[];
  let picture: string;
  let from: Thumbnail['from'];
  let where: { name: string; hint: string };
  if ('card' in shown) {
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
    const item = shown.laid.item as ClipItem;
    const catalog = await loadCatalog(project);
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
    input = readFrom(src, from0);
    // Mirage's crop: the window at (iw−ow)·x, (ih−oh)·y.
    picture =
      `setpts=(PTS-${ffNum(Number(frameTolerance(fps)) + back)}/TB)/${ffNum(item.speed)}+${ffNum(k / fps)}/TB,fps=${ffNum(fps)}:start_time=0:round=up,` +
      `trim=end_frame=${k + 1},tpad=stop=${k + 1}:stop_mode=clone,select='eq(n,${k})',` +
      `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}:${focusAt(o.focus ?? item.focus)},setsar=1,${look}`;
    from = { clip: item.clip, src: ms(shown.src) };
    where = { name: item.clip, hint: `Check item ${item.id}'s src against ${item.clip}, or pick another time.` };
  }
  if (o.text !== undefined && tidy(o.text) !== '') scripts.push(['thumbnail.ass', thumbnailAss(W, H, o.text)]);
  // The picture is stamped CARD_SEC/2 into the scripts: past a card's fade in, before its fade out. Scripts are named
  // relative to the folder FFmpeg runs in, so their paths need no escaping in the graph.
  const vf = [picture, ...(scripts.length ? [`setpts=PTS-STARTPTS+${CARD_SEC / 2}/TB`] : []), ...scripts.map(([name]) => `ass=${name}:fontsdir=${fontsDir}`)].join(',');
  const file = join(dir, 'thumbnail.jpg');
  await sweep(dir, LEFT_THUMBNAIL);
  const part = join(dir, `.thumbnail-${randomUUID().slice(0, 8)}.jpg`);
  const work = await mkdtemp(join(tmpdir(), 'mirage-thumb-'));
  try {
    for (const [name, text] of scripts) await writeFile(join(work, name), text);
    await tools.runFfmpeg([...input, '-vf', vf, '-frames:v', '1', '-q:v', '2', part], { cwd: work, signal: run.signal });
    if (!existsSync(part)) throw new MirageError('BAD_INPUT', `${'card' in shown ? where.name : `${where.name} at ${secs(shown.src)} s`} gave no picture`, where.hint);
    run.signal?.throwIfAborted();
    await rename(part, file);
  } finally {
    await rm(part, { force: true });
    await rm(work, { recursive: true, force: true });
  }
  return { file, width: W, height: H, from };
}

/** The tool's reply: the file, its size and where the picture came from. */
export function thumbnailReport(n: number, r: Thumbnail): string {
  const from = r.from === 'card' ? 'the card' : `${r.from.clip} at ${Math.round(r.from.src * 100) / 100} s`;
  return `wrote episodes/${n}/thumbnail.jpg (${r.width}×${r.height}, from ${from})`;
}
