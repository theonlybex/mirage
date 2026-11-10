// SPDX-License-Identifier: MIT
// The `posted` and `learn` tools: what Mirage knows about how the person's own videos did. `posted` records where a
// finished video is live and snapshots what its cut was made of (episodes/<n>/features.json). `learn` reads each posted
// video's public numbers with yt-dlp (its info only, never the video), keeps them by day in results/<n>.json, and reports
// them per format with the evidence a formula change can rest on (results/evidence.json). Neither writes a formula: the
// mirage:learn skill does, in the project's formulas folder. Node only, so it runs the same on macOS and Windows.
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ALSO_PLATFORMS, CaptionsSchema, ExperimentSchema, IdeaSchema, isCard, strictObject, ThumbLayoutSchema, type Catalog, type Episode, type Video, type Word } from '@wordedits/shared';
import { z } from 'zod';
import type { MediaTools } from '../media-tools.js';
import { clockText, viewsText } from './channel.js';
import { MirageError, errorReason } from './errors.js';
import { formatOf, loadFormats, shortKind, type Format } from './formats.js';
import { loadCatalog } from './ingest.js';
import { readJsonFile, writeJsonFile } from './json-file.js';
import { splitShots } from './move.js';
import { speechWords } from './overlays.js';
import { episodeDir, loadEpisode, loadVoiceoverTranscripts } from './render-episode.js';
import { readSeries } from './series.js';
import { THUMBNAIL_RECORD } from './thumbnail.js';
import { BANDS, forecastText, readPrediction, STEPS, type Band, type Prediction } from './prediction.js';
import { layoutTimeline, type LaidItem } from './timeline.js';
import { readVideo, videoNumbers, writeVideo } from './video.js';

/**
 * The three reads of a posted video, in days after it went up: YouTube needs a few days to judge a video, and some keep
 * growing for a month. An early read (a short can be judged on it), the main read (a long video is judged here), and a
 * late read that only confirms or corrects. These day counts are starting points, not measurements: change them here.
 */
export const READS = { early: 3, main: 7, late: 28 } as const;
export type Read = keyof typeof READS;
const READ_ORDER: Read[] = ['early', 'main', 'late'];

/** The read a video of this age is at; null before the early read. */
export function readAt(ageDays: number): Read | null {
  return [...READ_ORDER].reverse().find((r) => ageDays >= READS[r]) ?? null;
}

/** The read that is due: the latest one the video is old enough for and that no snapshot was taken at or after; null when none is. */
export function readDue(ageDays: number, snapshotAges: number[]): Read | null {
  const at = readAt(ageDays);
  return at !== null && !snapshotAges.some((a) => a >= READS[at]) ? at : null;
}

const readText = (r: Read | null) => (r === null ? 'before the early read' : `${r} read`);
/** A format needs this many posted videos before its better half is compared with its weaker half. */
export const MIN_TO_COMPARE = 4;
/** How many of a video's most replayed points are reported. */
const PEAKS = 3;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
/** Whole days from one YYYY-MM-DD to a later one. */
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
const plural = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// ---- posted ----

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;
const VIDEO_HINT = "Give the video's own address, e.g. https://www.youtube.com/watch?v=…, https://youtu.be/… or https://www.youtube.com/shorts/….";

/**
 * A posted video as the person gives it (a watch, youtu.be or Shorts address) → its id and the address kept for it: the
 * same page without the extras a share link carries (`?si=…`, `&t=…`, a playlist).
 */
export function videoAddress(input: string): { url: string; id: string } {
  const bad = () => new MirageError('BAD_INPUT', `"${input}" isn't a YouTube video address`, VIDEO_HINT);
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw bad();
  }
  if (u.protocol !== 'https:') throw bad();
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  let id: string | null | undefined;
  let short = false;
  if (host === 'youtu.be') id = parts.length === 1 ? parts[0] : null;
  else if (!YOUTUBE_HOSTS.has(host)) throw bad();
  else if (parts.length === 1 && parts[0] === 'watch') id = u.searchParams.get('v');
  else if (parts.length === 2 && parts[0] === 'shorts') {
    id = parts[1];
    short = true;
  }
  if (!id || !VIDEO_ID.test(id)) throw bad();
  return { id, url: short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}` };
}

/**
 * `episodes/<n>/features.json`: what the cut was made of on the day the video was recorded as posted, so what viewers did
 * can later be held against what the edit did. Everything is computed from episode.json, the catalog and the format.
 * Nothing the brief asked for is left out; what Mirage can't see honestly is `null` instead of a guess:
 * - the three word numbers, when an item keeps the sound of a clip that has no transcript (its speech is invisible);
 * - `answerShare`, when the format has no answer beat (a teaser short ends before it, on purpose) or the cut has none.
 * Cuts are the timeline's own: a cut that is already inside a source clip is not seen. Words are the ones captions show
 * (kept live audio, carried-over sound and fitted narration), so fillers ("um") are not counted.
 */
export const FeaturesSchema = strictObject({
  version: z.literal(1),
  video: z.number().int().positive(),
  /** The day the snapshot was taken (YYYY-MM-DD). */
  at: day,
  format: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  lengthSec: z.number().positive(),
  /** Seconds before the first spoken word; null without words, or when the words can't be seen. */
  firstWordSec: z.number().min(0).nullable(),
  /** Where the answer beat starts, 0–1 of the length (`truth`, a vlog's `headline`, a standalone short's `payoff`). */
  answerShare: z.number().min(0).max(1).nullable(),
  cutsPerMin: z.number().min(0),
  medianShotSec: z.number().positive(),
  wordsPerMin: z.number().min(0).nullable(),
  /** The longest stretch with no words, in seconds. */
  longestSilenceSec: z.number().min(0).nullable(),
  /** The share of the length a music cue plays under, 0–1 (a cue's dips are not taken off). */
  musicShare: z.number().min(0).max(1),
  overlays: z.number().int().min(0),
  captions: CaptionsSchema.shape.style,
  /** Only on a short: its kind, and whether its last item is a `pointer`. */
  short: strictObject({ kind: z.enum(['teaser', 'standalone']), endsOnPointer: z.boolean() }).optional(),
  /** The question the video was built on, as video.json holds it. */
  idea: IdeaSchema.optional(),
  /** The video's one deliberate change against its format's formula, as video.json holds it. */
  experiment: ExperimentSchema.optional(),
  /**
   * What Mirage knows of the thumbnail: whether episodes/<n>/thumbnail.jpg is there, and whether it was written with
   * text (null when that isn't on record: no thumbnail, or one not written by the thumbnail tool). What it shows (a face,
   * the subject) is not known to Mirage: the mirage:learn skill looks at the picture.
   */
  thumbnail: strictObject({
    exists: z.boolean(), text: z.boolean().nullable(),
    /** How the thumbnail tool made it (its thumbnail.json): from one frame of the video, or from two sources side by side, and then in which layout. Left out when that isn't on record. */
    made: z.enum(['one-frame', 'two-sources']).optional(),
    layout: ThumbLayoutSchema.optional(),
  }),
  /** Each item's place in the output, so a moment viewers replay can be tied to what the cut shows there. */
  items: z.array(strictObject({ id: z.string().min(1), beat: z.string().min(1), start: z.number().min(0), end: z.number().positive() })),
});
export type Features = z.infer<typeof FeaturesSchema>;

/** The beat that holds a format's answer; a short's depends on its kind, and any other format has none Mirage knows. */
function answerBeat(format: Format, kind: 'teaser' | 'standalone' | null): string | null {
  if (format.id === 'build-story') return 'truth';
  if (format.id === 'vlog') return 'headline';
  return kind === 'standalone' ? 'payoff' : null;
}

/** Whether the video has a thumbnail.jpg, and whether the thumbnail tool wrote it with text (its thumbnail.json; unknown without one). */
async function thumbnailKnown(project: string, n: number): Promise<Features['thumbnail']> {
  const dir = episodeDir(project, n);
  if (!existsSync(join(dir, 'thumbnail.jpg'))) return { exists: false, text: null };
  try {
    const record = JSON.parse(await readFile(join(dir, THUMBNAIL_RECORD), 'utf8')) as { text?: unknown; made?: unknown; layout?: unknown };
    const made = record.made === 'one-frame' || record.made === 'two-sources' ? record.made : undefined;
    const layout = ThumbLayoutSchema.safeParse(record.layout);
    return { exists: true, text: typeof record.text === 'string' ? true : record.text === null ? false : null, ...(made ? { made } : {}), ...(made === 'two-sources' && layout.success ? { layout: layout.data } : {}) };
  } catch {
    return { exists: true, text: null };
  }
}

/**
 * What a cut is made of before any number is taken from it: its items laid out, its shots and its spoken words. The
 * features snapshot (cutFeatures) and the playbook (`check`, `predict`) both measure from this, so they never disagree.
 */
export interface CutParts {
  laid: LaidItem[];
  lengthSec: number;
  /** One per shot, with its first and last item (indices into `laid`): a shot voice-over fitting split in two is still one shot. */
  shots: { start: number; end: number; from: number; to: number }[];
  /** The first item that keeps the sound of a clip with no transcript: its speech is invisible, so the cut's words are not known. */
  unheard: { item: string; clip: string } | null;
  /**
   * The words captions show, in order (kept live audio, carried-over sound and fitted narration; fillers are not
   * counted); null when `unheard`.
   */
  said: Word[] | null;
}

export async function cutParts(project: string, ep: Episode, catalog: Catalog): Promise<CutParts> {
  const laid = layoutTimeline(ep);
  const lengthSec = laid.at(-1)!.end;
  const joined = new Map(splitShots(ep.items).map((s) => [s.from, s.to]));
  const shots: CutParts['shots'] = [];
  for (let i = 0; i < laid.length; i++) {
    const to = joined.get(i) ?? i;
    shots.push({ start: laid[i]!.start, end: laid[to]!.end, from: i, to });
    i = to;
  }
  let unheard: CutParts['unheard'] = null;
  for (const item of ep.items) {
    if (isCard(item) || item.audio !== 'keep' || item.speed !== 1) continue;
    const clip = catalog.clips.find((c) => c.id === item.clip);
    if (clip?.probe.hasAudio && clip.transcript === null) {
      unheard = { item: item.id, clip: clip.id };
      break;
    }
  }
  const said = unheard ? null : speechWords(ep, catalog, ep.voiceover ? await loadVoiceoverTranscripts(project, ep) : null).filter((w) => w.start < lengthSec);
  return { laid, lengthSec, shots, unheard, said };
}

/** The snapshot of video `n`'s cut as its episode.json is now (see FeaturesSchema). */
export async function cutFeatures(project: string, n: number, video: Video | null, format: Format, at: string): Promise<Features> {
  const ep: Episode = await loadEpisode(project, n);
  const { laid, lengthSec: length, shots: cut, said } = await cutParts(project, ep, await loadCatalog(project));
  const minutes = length / 60;
  const shots = cut.map((s) => s.end - s.start);

  let words: { firstWordSec: number | null; wordsPerMin: number | null; longestSilenceSec: number | null } = { firstWordSec: null, wordsPerMin: null, longestSilenceSec: null };
  if (said) {
    let silence = 0;
    let heardUntil = 0;
    for (const w of said) {
      silence = Math.max(silence, w.start - heardUntil);
      heardUntil = Math.max(heardUntil, Math.min(w.end, length));
    }
    words = { firstWordSec: said.length ? round(said[0]!.start, 2) : null, wordsPerMin: round(said.length / minutes, 1), longestSilenceSec: round(Math.max(silence, length - heardUntil), 2) };
  }

  // Cues can overlap: the time under any of them is counted once.
  let under = 0;
  let playedUntil = 0;
  for (const c of [...ep.music].sort((a, b) => a.start - b.start)) {
    const [from, to] = [Math.max(c.start, playedUntil), Math.min(c.end, length)];
    if (to > from) {
      under += to - from;
      playedUntil = to;
    }
  }

  const kind = shortKind(format, video);
  const beat = answerBeat(format, kind);
  const answer = beat === null ? undefined : laid.find((l) => l.item.beat === beat);
  return {
    version: 1,
    video: n,
    at,
    format: format.id,
    width: ep.output.width,
    height: ep.output.height,
    lengthSec: round(length, 2),
    ...words,
    answerShare: answer ? round(answer.start / length, 3) : null,
    cutsPerMin: round((shots.length - 1) / minutes, 2),
    medianShotSec: round(median(shots)!, 2),
    musicShare: round(Math.min(1, under / length), 3),
    overlays: ep.overlays.filter((o) => o.start < length).length,
    captions: ep.captions?.style ?? 'phrase',
    ...(kind ? { short: { kind, endsOnPointer: ep.items.at(-1)!.beat === 'pointer' } } : {}),
    ...(video?.idea ? { idea: video.idea } : {}),
    ...(video?.experiment ? { experiment: video.experiment } : {}),
    thumbnail: await thumbnailKnown(project, n),
    items: laid.map((l) => ({ id: l.item.id, beat: l.item.beat, start: round(l.start, 3), end: round(l.end, 3) })),
  };
}

const pct = (share: number) => `${Math.round(share * 100)}%`;
const secs = (n: number) => `${n.toFixed(1)} s`;

/** A features snapshot as one report line's worth of words. */
function featuresText(f: Features): string {
  return [
    f.format,
    `${f.width}×${f.height}`,
    clockText(f.lengthSec),
    f.wordsPerMin === null ? 'words not known (a kept clip has no transcript)' : f.firstWordSec === null ? 'no words' : `first word at ${secs(f.firstWordSec)}`,
    ...(f.answerShare === null ? [] : [`answer at ${pct(f.answerShare)}`]),
    `${f.cutsPerMin.toFixed(1)} cuts a minute`,
    `typical shot ${secs(f.medianShotSec)}`,
    ...(f.wordsPerMin === null ? [] : [`${Math.round(f.wordsPerMin)} words a minute`, `longest stretch without words ${secs(f.longestSilenceSec!)}`]),
    `music under ${pct(f.musicShare)}`,
    plural(f.overlays, 'overlay'),
    `captions ${f.captions}`,
    ...(f.short ? [`${f.short.kind}, ${f.short.endsOnPointer ? 'ends on a pointer' : 'no pointer at the end'}`] : []),
    !f.thumbnail.exists ? 'no thumbnail' : `${f.thumbnail.made === 'two-sources' ? `a thumbnail from two sources${f.thumbnail.layout ? ` (face on the ${f.thumbnail.layout.face})` : ''}` : 'a thumbnail'}${f.thumbnail.text === null ? '' : ` ${f.thumbnail.text ? 'with' : 'without'} text`}`,
    ...(f.experiment ? [`experiment on “${f.experiment.rule}”`] : []),
  ].join(' · ');
}

const featuresFile = (project: string, n: number) => join(episodeDir(project, n), 'features.json');

const PLATFORM_NAMES: Record<(typeof ALSO_PLATFORMS)[number] | 'youtube', string> = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok' };
type Also = NonNullable<NonNullable<Video['posted']>['also']>;

/** Where else a short went, as the person gives it: an https address on that platform's own site, kept without its tracking extras. */
function alsoAddresses(also: Also): Also {
  return also.map(({ platform, url }) => {
    let u: URL | null = null;
    try {
      u = new URL(url.trim());
    } catch {
      // Not an address at all: refused below.
    }
    const host = u?.hostname.toLowerCase() ?? '';
    if (!u || u.protocol !== 'https:' || !(host === `${platform}.com` || host.endsWith(`.${platform}.com`))) {
      throw new MirageError('BAD_INPUT', `also: "${url}" isn't an address on ${PLATFORM_NAMES[platform]}`, "Give the video's own https address on that platform, or leave it out.");
    }
    return { platform, url: `${u.origin}${u.pathname}` };
  });
}

/**
 * `posted { video, url }`: records in episodes/<n>/video.json that video `n` is live at that YouTube address (its id kept,
 * the day from `now`), and writes episodes/<n>/features.json, the snapshot of its cut. A video without a final render is
 * refused. Called again, it replaces the address and takes the snapshot again. `also` records where else the same short
 * went (Instagram, TikTok), so the record is complete: Mirage reads no numbers there. A video.json whose format isn't one
 * of Mirage's is snapshotted as a build story, with a ⚠ saying so.
 */
export async function markPosted(
  project: string,
  n: number,
  url: string,
  o: { tools: Pick<MediaTools, 'probe'>; formatsDir?: string; now?: () => Date; also?: Also },
): Promise<string[]> {
  const address = videoAddress(url);
  const also = alsoAddresses(o.also ?? []);
  const video = await readVideo(project, n);
  if (!video) throw new MirageError('BAD_INPUT', existsSync(episodeDir(project, n)) ? `video ${n} has no video.json to record it in` : `there is no video ${n}`, 'Run status to see the videos.');
  const final = join(episodeDir(project, n), 'final.mp4');
  if (!existsSync(final)) throw new MirageError('NO_EPISODE', `video ${n} has no final render yet`, 'Run render first: a video is posted from its final.mp4.');
  const at = dayOf(o.now?.() ?? new Date());
  const { formats } = loadFormats(o.formatsDir);
  const unknown = video.format !== undefined && !formats.some((f) => f.id === video.format);
  const features = await cutFeatures(project, n, video, formatOf(video, formats), at);
  // Renders don't record which timeline they were made from, so the render's own length is held against the layout's
  // (as thumbnail does): the render accepts a cut this close to the timeline's length as the timeline's own.
  const probe = await o.tools.probe(final);
  const rendered = probe.videoDurationSec ?? probe.durationSec;
  const changed = Math.abs(rendered - features.lengthSec) > 0.1 + 0.005;
  await writeJsonFile(featuresFile(project, n), FeaturesSchema, features, `episodes/${n}/features.json`);
  await writeVideo(project, n, { ...video, posted: { ...address, at, ...(also.length ? { also } : {}) } });
  const before = video.posted && video.posted.id !== address.id ? ` (it was ${video.posted.url})` : '';
  return [
    `video ${n} “${video.title}” is posted at ${address.url}${before}`,
    ...(also.length ? [`also posted on ${also.map((a) => `${PLATFORM_NAMES[a.platform]} (${a.url})`).join(' and ')} — Mirage reads no numbers there: give learn the ones you see in the app, as studio with platform`] : []),
    `wrote episodes/${n}/features.json: ${featuresText(features)}`,
    ...(unknown ? [`⚠ video.json names the format "${video.format}", which isn't one of Mirage's (${formats.map((f) => f.id).join(', ')}) — features.json describes the cut as a build story: fix format in episodes/${n}/video.json, then call posted again`] : []),
    ...(changed ? [`⚠ the timeline is ${secs(features.lengthSec)} long and final.mp4 is ${secs(rendered)} — the timeline changed after the final render, so features.json may not describe the video that was posted`] : []),
    'Run learn to read its numbers.',
  ];
}

// ---- learn ----

const StudioSchema = strictObject({
  at: day,
  /** Where the numbers are from; left out, YouTube Studio. Instagram's and TikTok's are typed by the person from the app's own insights: Mirage reads nothing there. */
  platform: z.enum(['youtube', ...ALSO_PLATFORMS]).optional(),
  /** The counts the app shows its owner, for a platform Mirage can't read (on YouTube they are read, not typed). */
  views: z.number().min(0).optional(),
  likes: z.number().min(0).optional(),
  comments: z.number().min(0).optional(),
  /** Shares, or Instagram's sends. */
  shares: z.number().min(0).optional(),
  saves: z.number().min(0).optional(),
  /** The click rate on impressions, 0–100. */
  clickRate: z.number().min(0).max(100).optional(),
  /** The average percentage viewed, 0–100. */
  percentViewed: z.number().min(0).max(100).optional(),
  /** The average view duration, in seconds. */
  avgViewSec: z.number().min(0).optional(),
  /** For a short: the share that viewed rather than swiped away, 0–100. */
  viewedVsSwiped: z.number().min(0).max(100).optional(),
  /** Seconds into the video where the person's retention graph falls or viewers skip, each with what they noted. */
  drops: z.array(strictObject({ at: z.number().min(0), note: z.string().min(1).optional() })).optional(),
  /** Seconds into the video where the retention graph rises: viewers rewatch. */
  spikes: z.array(strictObject({ at: z.number().min(0) })).optional(),
});
type Studio = z.infer<typeof StudioSchema>;
/** The numbers only the owner sees in YouTube Studio, for one video, as `learn` is given them. */
export type StudioNumbers = { video: number } & Omit<Studio, 'at'>;
const STUDIO_KEYS = ['clickRate', 'percentViewed', 'avgViewSec', 'viewedVsSwiped', 'drops', 'spikes', 'views', 'likes', 'comments', 'shares', 'saves'] as const;
const platformOf = (s: { platform?: Studio['platform'] }) => s.platform ?? 'youtube';

/** `results/<n>.json`: what was read about posted video `n`, a snapshot per day it was read, and the Studio numbers given. */
export const ResultsSchema = strictObject({
  version: z.literal(1),
  video: z.number().int().positive(),
  /** The YouTube id the numbers are of: a video posted again under another address starts afresh. */
  id: z.string().min(1),
  url: z.string().min(1),
  title: z.string().nullable(),
  uploadDate: day.nullable(),
  durationSec: z.number().positive().nullable(),
  /** Oldest first, at most one per day (the latest read of a day wins). */
  snapshots: z.array(strictObject({ at: day, views: z.number().min(0), likes: z.number().min(0).nullable(), comments: z.number().min(0).nullable() })),
  /** YouTube's "most replayed" graph as last read; null when it shows none. */
  heatmap: z.array(strictObject({ start: z.number().min(0), end: z.number().min(0), value: z.number().min(0) })).nullable(),
  /** One entry per day the person gave numbers; a later entry's number replaces an earlier one's. */
  studio: z.array(StudioSchema),
});
export type Results = z.infer<typeof ResultsSchema>;

export const FEATURE_KEYS = ['lengthSec', 'firstWordSec', 'answerShare', 'cutsPerMin', 'medianShotSec', 'wordsPerMin', 'longestSilenceSec', 'musicShare', 'overlays'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
/** The numeric features the halves are compared on, as the report names and prints them. */
export const COMPARED: Record<FeatureKey, [label: string, text: (n: number) => string]> = {
  lengthSec: ['Length', clockText],
  firstWordSec: ['Seconds before the first word', secs],
  answerShare: ['Where the answer starts', pct],
  cutsPerMin: ['Cuts a minute', (n) => n.toFixed(1)],
  medianShotSec: ['Typical shot', secs],
  wordsPerMin: ['Words a minute', (n) => String(Math.round(n))],
  longestSilenceSec: ['Longest stretch without words', secs],
  musicShare: ['Share of the length under music', pct],
  overlays: ['Overlays', (n) => String(round(n, 1))],
};

const TitleSchema = strictObject({
  words: z.number().int().min(0),
  allCaps: z.boolean(),
  hasNumber: z.boolean(),
  /** I, my, me, we, our … */
  firstPerson: z.boolean(),
  /** Ends with ? or !! (a bracket tag after it aside). */
  endsEmphatic: z.boolean(),
  /** Ends with a tag in brackets: "(GONE WRONG)". */
  bracketTag: z.boolean(),
});
export type TitleFeatures = z.infer<typeof TitleSchema>;
const TITLE_KEYS = ['words', 'allCaps', 'hasNumber', 'firstPerson', 'endsEmphatic', 'bracketTag'] as const;
const TITLE_LABELS: Record<(typeof TITLE_KEYS)[number], string> = {
  words: 'Title words', allCaps: 'Title in ALL CAPS', hasNumber: 'Title has a number', firstPerson: 'Title in the first person', endsEmphatic: 'Title ends with ? or !!', bracketTag: 'Title ends with a bracket tag',
};

/** What a title is made of, as the live title on YouTube reads. */
export function titleFeatures(title: string): TitleFeatures {
  const tag = /[([][^)\]]+[)\]]\s*$/;
  return {
    words: title.trim().split(/\s+/).filter(Boolean).length,
    allCaps: /\p{L}/u.test(title) && title === title.toUpperCase(),
    hasNumber: /\d/.test(title),
    firstPerson: /(^|[^\p{L}])(I|I'M|I’M|I'VE|I’VE|I'LL|I’LL|MY|ME|WE|OUR|US)(?![\p{L}])/iu.test(title),
    endsEmphatic: /(\?|!!)\s*$/.test(title.replace(tag, '')),
    bracketTag: tag.test(title),
  };
}

/** The numbers an experiment can name in its `expect`, by the words that name them, and how each is printed. */
const MEASURES: { key: 'viewedVsSwiped' | 'clickRate' | 'percentViewed' | 'avgViewSec' | 'likesPer1000' | 'commentsPer1000'; words: RegExp; label: string; text: (n: number) => string }[] = [
  { key: 'viewedVsSwiped', words: /swipe/i, label: 'viewed vs swiped', text: (n) => `${round(n, 1)}%` },
  { key: 'clickRate', words: /click/i, label: 'the click rate', text: (n) => `${round(n, 1)}%` },
  { key: 'percentViewed', words: /percentage viewed|% viewed|percent viewed|retention/i, label: 'the percentage viewed', text: (n) => `${round(n, 1)}%` },
  { key: 'avgViewSec', words: /average view|view duration|watch time/i, label: 'the average view', text: clockText },
  { key: 'likesPer1000', words: /\blikes?\b/i, label: 'likes per 1,000 views', text: (n) => n.toFixed(1) },
  { key: 'commentsPer1000', words: /\bcomments?\b/i, label: 'comments per 1,000 views', text: (n) => n.toFixed(1) },
];

const numberOrNull = z.number().nullable();
const moment = { sec: z.number().min(0), item: z.string().nullable(), beat: z.string().nullable() };
/** `results/evidence.json`: the same evidence the `learn` report prints, for the mirage:learn skill to read. */
export const EvidenceSchema = strictObject({
  version: z.literal(1),
  at: day,
  formats: z.array(strictObject({
    format: z.string().min(1),
    videos: z.array(strictObject({
      video: z.number().int().positive(),
      id: z.string().min(1),
      title: z.string(),
      /** The title Mirage has on record as chosen (video.json's `titles.chosen`), when it isn't the live one. */
      recordedTitle: z.string().optional(),
      /** The name of the series the video belongs to. */
      series: z.string().optional(),
      /** Where else the short went, with the newest numbers the person typed for that platform (null when none). Never read by Mirage. */
      elsewhere: z.array(strictObject({ platform: z.enum(ALSO_PLATFORMS), url: z.string().nullable(), numbers: StudioSchema.nullable() })).optional(),
      titleFeatures: TitleSchema,
      ageDays: z.number().int().min(0),
      /** The read the video is at by its age; null before the early read. Before the main read, what it shows is early. */
      read: z.enum(['early', 'main', 'late']).nullable(),
      views: z.number().min(0),
      viewsPerDay: z.number().min(0),
      likesPer1000: numberOrNull,
      commentsPer1000: numberOrNull,
      /** The newest of each Studio number given, and the day of the newest entry. */
      studio: StudioSchema.nullable(),
      /** The strongest most replayed points, strongest first; `item` and `beat` are null when the cut can't be tied to them. */
      mostReplayed: z.array(strictObject({ sec: z.number().min(0), share: z.number().min(0).max(1), item: z.string().nullable(), beat: z.string().nullable() })).nullable(),
      /** Where the person's Studio retention graph falls or viewers skip, and where it rises, each with the item of the cut playing there. */
      left: z.array(strictObject({ ...moment, note: z.string().nullable() })).nullable(),
      rewatched: z.array(strictObject(moment)).nullable(),
      features: FeaturesSchema.nullable(),
    })),
    /** How the videos are ranked, and the number each was ranked on, best first. */
    rankedBy: z.enum(['views-at-the-same-age', 'views-per-day']),
    rankedAtAgeDays: z.number().int().positive().nullable(),
    ranking: z.array(strictObject({ video: z.number().int().positive(), value: z.number().min(0) })),
    /** The better half against the weaker half, the median of each numeric feature; null with fewer than 4 videos. */
    halves: strictObject({
      better: z.array(z.number().int().positive()),
      weaker: z.array(z.number().int().positive()),
      features: z.array(strictObject({ feature: z.enum(FEATURE_KEYS), better: numberOrNull, weaker: numberOrNull })),
      /** The titles: the middle word count of each half, and for the rest how many of the half's titles have it. */
      titles: z.array(strictObject({ feature: z.enum(TITLE_KEYS), better: z.number(), weaker: z.number() })),
    }).nullable(),
    /**
     * Each video that carries an experiment, held against the format's other posted videos on the number its `expect`
     * names (found by its words: click, swipe, percentage viewed, average view, likes, comments), else on the ranking's.
     */
    experiments: z.array(strictObject({
      video: z.number().int().positive(),
      rule: z.string(),
      change: z.string(),
      expect: z.string(),
      measure: z.string(),
      value: z.number(),
      /** The middle value of the other videos that have the number, and how many they are; null with none. */
      others: numberOrNull,
      otherVideos: z.number().int().min(0),
    })),
    /**
     * Each video that had a forecast (`predict`, before it was posted) against where it landed: its place in the ranking,
     * the band that place is (the better half is above, the weaker half below, the middle video around; null with fewer
     * than 4 videos), and whether the forecast's band was right (null when it gave none, or none can be said yet).
     */
    forecasts: z.array(strictObject({
      video: z.number().int().positive(),
      band: z.enum(BANDS).nullable(),
      weakest: z.enum(STEPS).nullable(),
      scores: z.array(strictObject({ step: z.enum(STEPS), score: z.number().nullable() })),
      rank: z.number().int().positive(),
      of: z.number().int().positive(),
      landed: z.enum(BANDS).nullable(),
      right: z.boolean().nullable(),
    })).default([]),
    confidence: z.enum(['weak', 'fair', 'strong']),
  })),
  /** Posted videos left out this time, each with why. */
  leftOut: z.array(strictObject({ video: z.number().int().positive(), why: z.string() })),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
type EvidenceVideo = Evidence['formats'][number]['videos'][number];

/** What `learn` needs from outside the process (a ChannelDeps fits). Tests pass stubs, so nothing reaches the network. */
export interface LearnDeps {
  /** Runs yt-dlp with these arguments and returns what it printed. */
  ytDlp(args: string[], opts?: { signal?: AbortSignal }): Promise<string>;
  now?(): Date;
}

/** How far a number of posted videos can be trusted: under 5 weak, 5–9 fair, 10 or more strong. */
export function confidence(videos: number): 'weak' | 'fair' | 'strong' {
  return videos < 5 ? 'weak' : videos < 10 ? 'fair' : 'strong';
}

export const resultsDir = (project: string) => join(project, 'results');
const resultsFile = (project: string, n: number) => join(resultsDir(project), `${n}.json`);

async function readResults(project: string, n: number): Promise<Results | null> {
  try {
    return await readJsonFile(resultsFile(project, n), ResultsSchema, `results/${n}.json`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

const writeResults = (project: string, r: Results) => writeJsonFile(resultsFile(project, r.video), ResultsSchema, r, `results/${r.video}.json`);

/** The posted videos of the project, lowest number first. */
async function postedVideos(project: string): Promise<{ n: number; video: Video & { posted: NonNullable<Video['posted']> } }[]> {
  const out: { n: number; video: Video & { posted: NonNullable<Video['posted']> } }[] = [];
  for (const n of await videoNumbers(project)) {
    const video = await readVideo(project, n);
    if (video?.posted) out.push({ n, video: { ...video, posted: video.posted } });
  }
  return out;
}

/** The fields of yt-dlp's info JSON that `learn` reads; anything else in it is ignored. */
const InfoSchema = z.object({
  title: z.string().nullish(),
  /** YYYYMMDD. */
  upload_date: z.string().nullish(),
  duration: z.number().nullish(),
  view_count: z.number().nullish(),
  like_count: z.number().nullish(),
  comment_count: z.number().nullish(),
  heatmap: z.array(z.object({ start_time: z.number(), end_time: z.number(), value: z.number() })).nullish(),
});

/** The newest of each Studio number, with the day of the newest entry; null when none was given. */
function latestStudio(entries: Studio[]): Studio | null {
  if (!entries.length) return null;
  return entries.reduce((all, e) => ({ ...all, ...e }));
}

/**
 * The strongest points of a "most replayed" graph, strongest first. A point that touches one already taken is the same
 * peak, so it is passed over.
 */
export function replayPeaks(heatmap: NonNullable<Results['heatmap']>, count = PEAKS): NonNullable<Results['heatmap']> {
  const out: NonNullable<Results['heatmap']> = [];
  for (const h of [...heatmap].sort((a, b) => b.value - a.value)) {
    if (out.length === count) break;
    if (!out.some((p) => h.start <= p.end + 1e-6 && h.end >= p.start - 1e-6)) out.push(h);
  }
  return out;
}

/**
 * A video's views when it was `age` days old: a read on that day, or a straight line between the reads either side of
 * it. Null when its reads don't reach that far back (nothing is guessed before the first read).
 */
export function viewsAtAge(snapshots: { ageDays: number; views: number }[], age: number): number | null {
  const on = snapshots.find((s) => s.ageDays === age);
  if (on) return on.views;
  const before = snapshots.filter((s) => s.ageDays < age).at(-1);
  const after = snapshots.find((s) => s.ageDays > age);
  if (!before || !after) return null;
  return before.views + ((after.views - before.views) * (age - before.ageDays)) / (after.ageDays - before.ageDays);
}

const percent = (n: number) => `${round(n, 1)}%`;

function studioText(s: Studio): string {
  return [
    ...(s.clickRate !== undefined ? [`click rate ${percent(s.clickRate)}`] : []),
    ...(s.percentViewed !== undefined ? [`${percent(s.percentViewed)} viewed`] : []),
    ...(s.avgViewSec !== undefined ? [`average view ${clockText(s.avgViewSec)}`] : []),
    ...(s.viewedVsSwiped !== undefined ? [`${percent(s.viewedVsSwiped)} viewed vs swiped`] : []),
  ].join(' · ');
}

/** The numbers the person typed for another platform, as one phrase. */
function elsewhereText(s: Studio): string {
  const count = (n: number | undefined, what: string) => (n === undefined ? [] : [`${viewsText(n)} ${what}`]);
  return [...count(s.views, 'views'), ...count(s.likes, 'likes'), ...count(s.comments, 'comments'), ...count(s.shares, 'shares'), ...count(s.saves, 'saves'), ...(studioText(s) ? [studioText(s)] : [])].join(' · ') || 'no numbers';
}

const per1000 = (n: number | null, views: number) => (n === null || views <= 0 ? null : round((n / views) * 1000, 1));
const names = (videos: number[]) => `${videos.length === 1 ? 'video' : 'videos'} ${videos.join(', ')}`;

/**
 * `learn { studio? }`: reads every posted video's public numbers with yt-dlp (title, upload date, length, views, likes,
 * comments and the "most replayed" graph; never the video), adds today's snapshot to `results/<n>.json` (one per day, the
 * latest wins), saves the Studio numbers given for one video, and reports per format: each video's numbers, what viewers
 * replay and which item of the cut plays there, the videos ranked fairly across ages, the better half against the weaker
 * half on each numeric feature (4 or more videos), each video's forecast (`predict`) against where it landed, with how
 * often the forecast's band was right, and how far the sample can be trusted. The same evidence goes to
 * `results/evidence.json`. A video yt-dlp can't read is one ⚠ line and is left out; the others still come.
 */
export async function learnResults(
  project: string,
  o: { studio?: StudioNumbers },
  deps: LearnDeps,
  h: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<string[]> {
  const today = dayOf(deps.now?.() ?? new Date());
  const posted = await postedVideos(project);
  const POSTED_HINT = 'When a video is live, call posted with its number and its YouTube address, then learn.';
  if (o.studio) {
    const given = STUDIO_KEYS.filter((k) => o.studio![k] !== undefined);
    if (!given.length) throw new MirageError('BAD_INPUT', 'studio needs at least one number', 'Give clickRate, percentViewed, avgViewSec, viewedVsSwiped, drops or spikes (for Instagram or TikTok also views, likes, comments, shares or saves) with the video\'s number, or leave studio out.');
    if (!posted.some((p) => p.n === o.studio!.video)) throw new MirageError('BAD_INPUT', `video ${o.studio.video} isn't posted yet, so it has no Studio numbers to keep`, POSTED_HINT);
  }
  if (!posted.length) throw new MirageError('BAD_INPUT', 'no video is posted yet', POSTED_HINT);
  await mkdir(resultsDir(project), { recursive: true });

  const warnings: string[] = [];
  const leftOut: Evidence['leftOut'] = [];
  const read: { n: number; video: Video; results: Results; features: Features | null; prediction: Prediction | null; series: string | null }[] = [];
  for (const [i, { n, video }] of posted.entries()) {
    h.signal?.throwIfAborted();
    h.onProgress?.(i / posted.length);
    const { id, url } = video.posted;
    let kept = await readResults(project, n);
    if (kept && kept.id !== id) {
      warnings.push(`⚠ video ${n}: its address changed since its numbers were last read — the earlier numbers were of ${kept.url} and are dropped`);
      kept = null;
    }
    let results: Results = kept ?? { version: 1, video: n, id, url, title: null, uploadDate: null, durationSec: null, snapshots: [], heatmap: null, studio: [] };
    if (o.studio?.video === n) {
      // Only the numbers given: one left out keeps what an earlier call of the day said.
      const numbers = Object.fromEntries(STUDIO_KEYS.flatMap((k) => (o.studio![k] === undefined ? [] : [[k, o.studio![k]]])));
      const platform = platformOf(o.studio);
      const sameDay = (s: Studio) => s.at === today && platformOf(s) === platform;
      results = { ...results, studio: [...results.studio.filter((s) => !sameDay(s)), { ...results.studio.find(sameDay), ...numbers, at: today, ...(platform === 'youtube' ? {} : { platform }) }] };
      await writeResults(project, results);
    }
    const skip = (why: string) => {
      warnings.push(`⚠ video ${n} (${id}): yt-dlp couldn't read it (${why}) — it is left out`);
      leftOut.push({ video: n, why });
    };
    let stdout: string;
    try {
      stdout = await deps.ytDlp(['--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings', url], { signal: h.signal });
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      // No yt-dlp, or the person stopped it: that is the whole call's answer, not one video's.
      if (code === 'NOT_FOUND' || code === 'CANCELLED' || (e as { name?: unknown }).name === 'AbortError') throw e;
      skip(errorReason(e));
      continue;
    }
    let info: z.infer<typeof InfoSchema>;
    try {
      info = InfoSchema.parse(JSON.parse(stdout));
    } catch {
      skip('its answer was not the video\'s info');
      continue;
    }
    if (typeof info.view_count !== 'number') {
      skip('it has no view count: private, upcoming or live');
      continue;
    }
    const uploaded = /^(\d{4})(\d{2})(\d{2})$/.exec(info.upload_date ?? '');
    results = {
      ...results,
      title: info.title ?? results.title,
      uploadDate: uploaded ? `${uploaded[1]}-${uploaded[2]}-${uploaded[3]}` : results.uploadDate,
      durationSec: info.duration && info.duration > 0 ? info.duration : results.durationSec,
      snapshots: [...results.snapshots.filter((s) => s.at !== today), { at: today, views: info.view_count, likes: info.like_count ?? null, comments: info.comment_count ?? null }].sort((a, b) => a.at.localeCompare(b.at)),
      heatmap: info.heatmap?.length ? info.heatmap.map((p) => ({ start: p.start_time, end: p.end_time, value: p.value })) : null,
    };
    await writeResults(project, results);
    const features = await readJsonFile(featuresFile(project, n), FeaturesSchema, `episodes/${n}/features.json`).catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    });
    const series = video.series ? ((await readSeries(project, video.series).catch(() => null))?.name ?? video.series) : null;
    read.push({ n, video, results, features, prediction: await readPrediction(project, n), series });
  }

  const lines: string[] = [];
  const formats: Evidence['formats'] = [];
  const formatOfVideo = (v: (typeof read)[number]) => v.features?.format ?? v.video.format ?? 'build-story';
  for (const format of [...new Set(read.map(formatOfVideo))].sort()) {
    const of = read.filter((v) => formatOfVideo(v) === format);
    lines.push(`Format ${format}: ${plural(of.length, 'posted video')}, read ${today}`);

    // An upload date YouTube didn't give is taken to be the day the video was recorded as posted.
    const born = (v: (typeof read)[number]) => v.results.uploadDate ?? v.video.posted!.at;
    const videos: EvidenceVideo[] = of.map((v) => {
      const last = v.results.snapshots.at(-1)!;
      const ageDays = Math.max(0, daysBetween(born(v), today));
      const length = v.results.durationSec ?? v.features?.lengthSec ?? null;
      // The cut's items are tied to YouTube's times only when the posted video is as long as the cut was.
      const tied = v.features !== null && v.results.durationSec !== null && Math.abs(v.results.durationSec - v.features.lengthSec) <= 1.5;
      // Only YouTube's numbers are compared: the other platforms' are kept and shown beside them.
      const studio = latestStudio(v.results.studio.filter((s) => platformOf(s) === 'youtube'));
      const others = [...new Set([...(v.video.posted!.also ?? []).map((a) => a.platform), ...v.results.studio.flatMap((s) => (platformOf(s) === 'youtube' ? [] : [platformOf(s) as (typeof ALSO_PLATFORMS)[number]]))])];
      const elsewhere = others.map((platform) => ({
        platform,
        url: v.video.posted!.also?.find((a) => a.platform === platform)?.url ?? null,
        numbers: latestStudio(v.results.studio.filter((s) => platformOf(s) === platform)),
      }));
      const chosen = v.video.titles?.chosen;
      if ((v.results.heatmap || studio?.drops?.length || studio?.spikes?.length) && v.features && !tied) {
        warnings.push(`⚠ video ${v.n}: on YouTube it is ${clockText(v.results.durationSec ?? 0)} long and its cut was ${clockText(v.features.lengthSec)} — the moments viewers replayed or left can't be tied to the cut's items`);
      }
      const playing = (sec: number) => {
        const item = tied ? v.features!.items.find((it) => sec >= it.start && sec < it.end) : undefined;
        return { sec: round(sec, 1), item: item?.id ?? null, beat: item?.beat ?? null };
      };
      const title = v.results.title ?? v.video.title;
      const mostReplayed = !v.results.heatmap || !length ? null : replayPeaks(v.results.heatmap).map((p) => {
        const sec = (p.start + p.end) / 2;
        const at = playing(sec);
        return { sec: at.sec, share: round(Math.min(1, sec / length), 4), item: at.item, beat: at.beat };
      });
      return {
        video: v.n,
        id: v.results.id,
        title,
        ...(chosen && chosen.trim() !== title.trim() ? { recordedTitle: chosen } : {}),
        ...(v.series ? { series: v.series } : {}),
        ...(elsewhere.length ? { elsewhere } : {}),
        titleFeatures: titleFeatures(title),
        ageDays,
        read: readAt(ageDays),
        views: last.views,
        viewsPerDay: round(last.views / Math.max(1, ageDays), 1),
        likesPer1000: per1000(last.likes, last.views),
        commentsPer1000: per1000(last.comments, last.views),
        studio,
        mostReplayed,
        left: studio?.drops?.length ? studio.drops.map((d) => ({ ...playing(d.at), note: d.note ?? null })) : null,
        rewatched: studio?.spikes?.length ? studio.spikes.map((x) => playing(x.at)) : null,
        features: v.features,
      };
    });
    for (const v of videos) {
      const studio = v.studio ? studioText(v.studio) : '';
      lines.push([
        `  Video ${v.video} “${v.title}”${v.series ? ` (series “${v.series}”)` : ''}: ${plural(v.ageDays, 'day')} old, ${readText(v.read)}`,
        `${viewsText(v.views)} views`,
        `${viewsText(v.viewsPerDay)} a day`,
        v.likesPer1000 === null ? 'no like count' : `${v.likesPer1000.toFixed(1)} likes per 1,000 views`,
        v.commentsPer1000 === null ? 'no comment count' : `${v.commentsPer1000.toFixed(1)} comments per 1,000 views`,
        ...(studio ? [`Studio (${v.studio!.at}): ${studio}`] : []),
      ].join(' · '));
    }
    for (const v of videos) {
      if (v.recordedTitle) lines.push(`  Title, video ${v.video}: live on YouTube it is “${v.title}”, and Mirage recorded “${v.recordedTitle}” as the one chosen — they differ, and the title numbers here are the live title's`);
      if (v.elsewhere) {
        lines.push(`  Elsewhere, video ${v.video}: ${v.elsewhere.map((e) => `${PLATFORM_NAMES[e.platform]}${e.url ? ` ${e.url}` : ''} — ${e.numbers ? `${elsewhereText(e.numbers)} (typed by the person, ${e.numbers.at})` : 'no numbers given yet'}`).join(' · ')}`);
      }
    }
    for (const v of videos) {
      if (!v.mostReplayed) continue;
      lines.push(`  Most replayed, video ${v.video}: ${v.mostReplayed.map((p) => `${clockText(p.sec)} (${pct(p.share)})${p.item ? ` item ${p.item}, ${p.beat}` : ''}`).join(' · ')}`);
    }
    const none = videos.filter((v) => !v.mostReplayed).map((v) => v.video);
    if (none.length) lines.push(`  Most replayed: YouTube shows none for ${names(none)}`);
    // Where viewers leave is only in the owner's Studio graph: public data has the most replayed points and nothing else.
    const during = (m: { sec: number; item: string | null; beat: string | null }) => `${clockText(m.sec)}${m.item ? ` during item ${m.item} (beat ${m.beat})` : ''}`;
    for (const v of videos) {
      if (v.left) lines.push(`  Viewers left (Studio), video ${v.video}: ${v.left.map((m) => `${during(m)}${m.note ? ` — “${m.note}”` : ''}`).join(' · ')}`);
      if (v.rewatched) lines.push(`  Viewers rewatched (Studio), video ${v.video}: ${v.rewatched.map(during).join(' · ')}`);
    }
    const early = videos.filter((v) => v.read !== 'main' && v.read !== 'late').map((v) => v.video);
    if (early.length) lines.push(`  Early: ${names(early)} ${early.length === 1 ? 'is' : 'are'} before the main read (${READS.main} days) — what ${early.length === 1 ? 'it shows' : 'they show'} so far is early and may still change`);

    // The fair comparison is at one age: the newest video's, where every older video has reads either side of it.
    const ages = of.map((v) => v.results.snapshots.map((s) => ({ ageDays: daysBetween(born(v), s.at), views: s.views })));
    const age = Math.min(...ages.map((a) => a.at(-1)!.ageDays));
    const atAge = ages.map((a) => viewsAtAge(a, age));
    const sameAge = of.length >= 2 && age >= 1 && atAge.every((x) => x !== null);
    const ranking = videos
      .map((v, i) => ({ video: v.video, value: sameAge ? round(atAge[i]!, 1) : v.viewsPerDay }))
      .sort((a, b) => b.value - a.value || a.video - b.video);
    if (of.length >= 2) {
      const how = sameAge
        ? `views at ${plural(age, 'day')} old, the newest video's age (worked out between two reads where there was none on that day): no age is favoured, but only each video's first ${plural(age, 'day')} count`
        : 'views a day, because the reads so far don\'t let the videos be compared at the same age: this favours newer videos, which get most of their views in their first days';
      lines.push(`  Ranked by ${how}`, `  Best first: ${ranking.map((r) => `video ${r.video} (${viewsText(r.value)})`).join(' · ')}`);
    }

    let halves: Evidence['formats'][number]['halves'] = null;
    if (of.length >= MIN_TO_COMPARE) {
      const half = Math.floor(of.length / 2);
      const better = ranking.slice(0, half).map((r) => r.video);
      const weaker = ranking.slice(-half).map((r) => r.video);
      const mid = (side: number[], key: FeatureKey) => median(videos.flatMap((v) => (side.includes(v.video) && typeof v.features?.[key] === 'number' ? [v.features[key]] : [])));
      const titled = (side: number[], key: (typeof TITLE_KEYS)[number]) => {
        const of = videos.filter((v) => side.includes(v.video)).map((v) => v.titleFeatures[key]);
        return key === 'words' ? median(of as number[])! : of.filter(Boolean).length;
      };
      halves = {
        better, weaker,
        features: FEATURE_KEYS.map((feature) => ({ feature, better: mid(better, feature), weaker: mid(weaker, feature) })),
        titles: TITLE_KEYS.map((feature) => ({ feature, better: titled(better, feature), weaker: titled(weaker, feature) })),
      };
      lines.push(`  Better half (${names(better)}) against weaker half (${names(weaker)}), the middle value of each:`);
      for (const f of halves.features) {
        const [label, text] = COMPARED[f.feature];
        const show = (x: number | null) => (x === null ? 'not known' : text(x));
        lines.push(`    ${label}: better half ${show(f.better)} · weaker half ${show(f.weaker)}`);
      }
      for (const t of halves.titles) {
        const show = (x: number) => (t.feature === 'words' ? String(round(x, 1)) : `${x} of ${half}`);
        lines.push(`    ${TITLE_LABELS[t.feature]}: better half ${show(t.better)} · weaker half ${show(t.weaker)}`);
      }
      // How each half's thumbnails were made, once the thumbnail tool recorded it for any of them.
      const twoSources = (side: number[]) => videos.filter((v) => side.includes(v.video) && v.features?.thumbnail.made === 'two-sources').length;
      if (videos.some((v) => v.features?.thumbnail.made)) lines.push(`    Thumbnail from two sources: better half ${twoSources(better)} of ${half} · weaker half ${twoSources(weaker)} of ${half}`);
    } else {
      lines.push(`  too few to compare: ${plural(of.length, 'video')} — ${MIN_TO_COMPARE - of.length} more needed`);
    }
    // An experiment is held against the other videos on the number its `expect` names, when they have it; else on the ranking's.
    const ranked: { label: string; text: (n: number) => string } = { label: sameAge ? `views at ${plural(age, 'day')} old` : 'views a day', text: viewsText };
    const experiments: Evidence['formats'][number]['experiments'] = [];
    for (const v of videos) {
      const x = v.features?.experiment;
      if (!x) continue;
      const number = (of: EvidenceVideo, key: (typeof MEASURES)[number]['key']) => (key === 'likesPer1000' || key === 'commentsPer1000' ? of[key] : of.studio?.[key]) ?? null;
      const others = videos.filter((o) => o.video !== v.video);
      const named = MEASURES.find((m) => m.words.test(x.expect) && number(v, m.key) !== null && others.some((o) => number(o, m.key) !== null));
      const value = named ? number(v, named.key)! : ranking.find((r) => r.video === v.video)!.value;
      const rest = named ? others.flatMap((o) => number(o, named.key) ?? []) : others.map((o) => ranking.find((r) => r.video === o.video)!.value);
      const middle = median(rest);
      const { label, text } = named ?? ranked;
      experiments.push({ video: v.video, rule: x.rule, change: x.change, expect: x.expect, measure: label, value, others: middle, otherVideos: rest.length });
      if (experiments.length === 1) lines.push('  Experiments:');
      const against = middle === null
        ? 'there is no other video of this format to hold it against yet'
        : `on ${label} it has ${text(value)} against a middle of ${text(middle)} for the other ${plural(rest.length, 'video')}: ${value > middle ? 'higher' : value < middle ? 'lower' : 'the same'}`;
      lines.push(`    Video ${v.video} changed “${x.rule}”: ${x.change}. Expected: ${x.expect}. So far ${against}${v.read === 'main' || v.read === 'late' ? '' : ' (early: before its main read)'}`);
    }
    // What `predict` said of a video before it was posted, against where it landed among the format's videos.
    const forecasts: Evidence['formats'][number]['forecasts'] = [];
    for (const v of videos) {
      const p = of.find((x) => x.n === v.video)!.prediction;
      if (!p) continue;
      const rank = ranking.findIndex((r) => r.video === v.video) + 1;
      const landed: Band | null = !halves ? null : halves.better.includes(v.video) ? 'above' : halves.weaker.includes(v.video) ? 'below' : 'around';
      const right = p.band !== null && landed !== null ? p.band === landed : null;
      forecasts.push({ video: v.video, band: p.band, weakest: p.weakest, scores: p.steps.map((s) => ({ step: s.step, score: s.score })), rank, of: of.length, landed, right });
      const where = of.length < 2
        ? "it is the format's only posted video, so there is no ranking to hold it against yet"
        : `it landed ${rank} of ${of.length} in the ranking${landed === null ? '' : landed === 'around' ? ', in the middle' : `, in the ${landed === 'above' ? 'better' : 'weaker'} half`}`;
      const verdict = right === null ? (p.band !== null && of.length >= 2 ? ' — too few videos to say whether the band was right' : '') : right ? ' — the band was right' : ` — the band was wrong (it landed ${landed})`;
      lines.push(`  Forecast against result, video ${v.video}: ${forecastText(p)} · ${where}${verdict}${v.read === 'main' || v.read === 'late' ? '' : ' (early: before its main read)'}`);
    }
    const trust = confidence(of.length);
    lines.push(`  Confidence, ${format}: ${plural(of.length, 'posted video')} — a ${trust} signal`);
    formats.push({ format, videos, rankedBy: sameAge ? 'views-at-the-same-age' : 'views-per-day', rankedAtAgeDays: sameAge ? age : null, ranking, halves, experiments, forecasts, confidence: trust });
  }

  // The running count: how often the forecast's band was the band the video landed in, over every format.
  const forecast = formats.flatMap((f) => f.forecasts);
  const judged = forecast.filter((f) => f.right !== null);
  if (judged.length) lines.push(`Forecasts so far: the band was right for ${judged.filter((f) => f.right).length} of ${plural(judged.length, 'posted video')}`);
  else if (forecast.length) lines.push(`Forecasts so far: none can be judged yet — a forecast is judged once it gave a band and its format has ${MIN_TO_COMPARE} posted videos`);

  await writeJsonFile(join(resultsDir(project), 'evidence.json'), EvidenceSchema, { version: 1, at: today, formats, leftOut }, 'results/evidence.json');
  h.onProgress?.(1);
  if (!read.length) return [...warnings, 'No posted video could be read, so there is nothing to compare yet.'];
  const typed = formats.some((f) => f.videos.some((v) => v.elsewhere));
  return [
    ...lines,
    ...warnings,
    ...(typed ? ['Instagram and TikTok numbers are the ones the person typed: Mirage reads numbers only from YouTube, and every comparison above is of the YouTube numbers.'] : []),
    'The better and weaker halves show what goes with more views, never what causes them. The same evidence is in results/evidence.json.',
  ];
}

/**
 * The `Results:` line of `status`: how many videos are posted, the last day their numbers were read, and which videos
 * have a read due and which (see READS): the early, main or late read a video is old enough for and that hasn't been
 * taken. A results file that can't be read counts as never read; `learn` says what is wrong with it.
 */
export async function resultsLine(project: string, now: Date = new Date()): Promise<string> {
  const today = dayOf(now);
  const due: string[] = [];
  const lastRead: string[] = [];
  let posted = 0;
  for (const n of await videoNumbers(project)) {
    const video = await readVideo(project, n).catch(() => null);
    if (!video?.posted) continue;
    posted++;
    const results = await readResults(project, n).catch(() => null);
    const kept = results?.id === video.posted.id ? results : null;
    const born = kept?.uploadDate ?? video.posted.at;
    const last = kept?.snapshots.at(-1)?.at;
    if (last) lastRead.push(last);
    const read = readDue(daysBetween(born, today), (kept?.snapshots ?? []).map((s) => daysBetween(born, s.at)));
    if (read) due.push(`video ${n} (${read} read)`);
  }
  if (!posted) return 'Results: no video posted yet';
  return `Results: ${plural(posted, 'video')} posted · ${lastRead.length ? `last read ${lastRead.sort().at(-1)}` : 'not read yet'}${due.length ? ` · learn is due: ${due.join(', ')}` : ''}`;
}
