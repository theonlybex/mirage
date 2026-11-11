// SPDX-License-Identifier: MIT
// The `channel` tool: gathers a YouTube channel's public data (its video list, thumbnails, captions and "most replayed"
// points) into <project>/analysis/<slug>/ and reports the numbers an analysis starts from. It never downloads a video.
// Node only (no Python, no shell pipelines), so it runs the same on macOS and Windows.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { strictObject } from '@wordedits/shared';
import { runYtDlp } from '@wordedits/sidecars';
import { z } from 'zod';
import { MirageError, errorReason } from './errors.js';
import { readJsonFile, writeJsonFile } from './json-file.js';
import type { MediaTools } from '../media-tools.js';

/** How many of the newest videos count as "the latest": older ones have had longer to collect views, and the channel was smaller. */
export const LATEST = 60;
/** How many videos a list or a contact sheet shows (4×3 tiles). */
export const LIST = 12;
export const DEFAULT_VIDEOS = 200;
export const MAX_VIDEOS = 1000;
const TILE = { width: 480, height: 270, across: 4, down: 3 };

const VideoSchema = strictObject({
  id: z.string().min(1),
  title: z.string(),
  durationSec: z.number().nonnegative().nullable(),
  views: z.number().nonnegative().nullable(),
  /** The day it was posted, `YYYY-MM-DD`, when it is known. From a channel's list it is approximate (YouTube shows "2 weeks ago"). */
  posted: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type ChannelVideo = z.infer<typeof VideoSchema>;

/** `analysis/<slug>/videos.json`: the channel's videos, newest first. */
export const ChannelFileSchema = strictObject({
  version: z.literal(1),
  /** The page the list was read from. */
  url: z.string().min(1),
  gatheredAt: z.string().min(1),
  videos: z.array(VideoSchema),
});
export type ChannelFile = z.infer<typeof ChannelFileSchema>;

/** What `channel` needs from outside the process. Tests pass stubs, so nothing reaches the network. */
export interface ChannelDeps {
  /** Runs yt-dlp with these arguments and returns what it printed. */
  ytDlp(args: string[], opts?: { signal?: AbortSignal }): Promise<string>;
  /** The bytes at `url`, or null when the server has no such file. */
  fetchImage(url: string, opts?: { signal?: AbortSignal }): Promise<Uint8Array | null>;
  runFfmpeg(args: string[], opts?: { signal?: AbortSignal }): Promise<void>;
  now?(): Date;
}

export function realChannelDeps(tools: Pick<MediaTools, 'runFfmpeg'>): ChannelDeps {
  return {
    ytDlp: async (args, opts) => (await runYtDlp(args, { signal: opts?.signal })).stdout,
    fetchImage: async (url, opts) => {
      const r = await fetch(url, { signal: opts?.signal });
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    },
    runFfmpeg: (args, opts) => tools.runFfmpeg(args, { signal: opts?.signal }),
  };
}

const TABS = ['videos', 'shorts', 'streams'] as const;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const ADDRESS_HINT = 'Give the channel\'s address, e.g. https://www.youtube.com/@handle, or just @handle.';

/**
 * A channel as the person names it (`@handle`, or its YouTube address with or without a tab) → the page yt-dlp lists and
 * the folder name its analysis is kept under. The Videos tab is listed unless the address names the Shorts or Live tab,
 * which gets a folder of its own (`<handle>-shorts`).
 */
export function channelAddress(input: string): { url: string; slug: string } {
  const text = input.trim();
  let u: URL;
  try {
    u = new URL(/^@[^/\s]+$/.test(text) ? `https://www.youtube.com/${text}` : text);
  } catch {
    throw new MirageError('BAD_INPUT', `"${input}" isn't a YouTube channel address`, ADDRESS_HINT);
  }
  if (u.protocol !== 'https:' || !YOUTUBE_HOSTS.has(u.hostname.toLowerCase())) throw new MirageError('BAD_INPUT', `"${input}" isn't a YouTube channel address`, ADDRESS_HINT);
  const parts = u.pathname.split('/').filter(Boolean);
  const last = parts.at(-1);
  const tab = TABS.find((t) => t === last) ?? 'videos';
  if (last === tab || last === 'featured') parts.pop();
  const named = parts[0]?.startsWith('@') ? parts.length === 1 : parts.length === 2 && ['channel', 'c', 'user'].includes(parts[0]!);
  if (!named) throw new MirageError('BAD_INPUT', `"${input}" isn't a YouTube channel address`, ADDRESS_HINT);
  let handle = parts.at(-1)!;
  try {
    handle = decodeURIComponent(handle);
  } catch {
    // an odd escape: the name is used as it is
  }
  const base = handle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'channel';
  return { url: `https://www.youtube.com/${parts.join('/')}/${tab}`, slug: tab === 'videos' ? base : `${base}-${tab}` };
}

/** The folder a channel's analysis is kept in, relative to the project (always with `/`, as reports print it). */
const relDir = (slug: string) => `analysis/${slug}`;
const absDir = (project: string, slug: string) => join(project, 'analysis', slug);

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The gathered video list of the channel `name`, or a BAD_INPUT naming the channels there are. */
export async function readChannel(project: string, name: string): Promise<ChannelFile> {
  const file = join(absDir(project, name), 'videos.json');
  if (!NAME.test(name) || !existsSync(file)) {
    const known = (await readdir(join(project, 'analysis')).catch(() => [] as string[])).filter((d) => existsSync(join(project, 'analysis', d, 'videos.json'))).sort();
    throw new MirageError('BAD_INPUT', `no channel "${name}" has been gathered in this project`, `${known.length ? `The channels are: ${known.join(', ')}. ` : ''}Run channel with the channel's url first; its report says the name to use.`);
  }
  return readJsonFile(file, ChannelFileSchema, `${relDir(name)}/videos.json`);
}

// ---- numbers as the reports print them ----

/** 13.0M, 950K, 812. */
export function viewsText(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** 4:20, 1:02:05. */
export function clockText(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const p = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h ? `${h}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`;
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = sorted(xs);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The value a share `p` of the way through the sorted list (0 the smallest, 0.5 the middle, 1 the largest). */
const at = (s: number[], p: number) => s[Math.round(p * (s.length - 1))]!;
const medianViews = (videos: ChannelVideo[]) => median(videos.flatMap((v) => (v.views === null ? [] : [v.views])));
const medianText = (videos: ChannelVideo[]) => {
  const m = medianViews(videos);
  return m === null ? 'no view counts' : viewsText(m);
};

const BUCKETS: [string, number][] = [
  ['under 1 min', 60], ['1–4 min', 240], ['4–8 min', 480], ['8–15 min', 900], ['15–30 min', 1800], ['30–45 min', 2700], ['45–60 min', 3600], ['over 60 min', Infinity],
];

const isAllCaps = (title: string) => /\p{L}/u.test(title) && title === title.toUpperCase();
const wordCount = (title: string) => title.trim().split(/\s+/).filter(Boolean).length;

/** One video as a list line: its place, views, length, id and title. */
const videoLine = (v: ChannelVideo, i: number) =>
  `  ${i + 1}. ${v.views === null ? 'no view count' : viewsText(v.views)} · ${v.durationSec === null ? 'length unknown' : clockText(v.durationSec)}${v.posted ? ` · ${v.posted}` : ''} · ${v.id} · ${v.title}`;

const byViews = (videos: ChannelVideo[], dir: 1 | -1) => videos.filter((v) => v.views !== null).sort((a, b) => dir * (a.views! - b.views!));

/** The 12 videos a list or a contact sheet is about: the most viewed of all, the newest, or the least viewed of the latest 60. */
export function pickVideos(videos: ChannelVideo[], which: 'top' | 'newest' | 'lowest'): ChannelVideo[] {
  if (which === 'newest') return videos.slice(0, LIST);
  return which === 'top' ? byViews(videos, -1).slice(0, LIST) : byViews(videos.slice(0, LATEST), 1).slice(0, LIST);
}

/** The lines of numbers for one set of videos (all of them, or the latest 60), each starting with `<what>, <set>:`. */
function statLines(videos: ChannelVideo[], set: string): string[] {
  const lines: string[] = [];
  const lengths = sorted(videos.flatMap((v) => (v.durationSec === null ? [] : [v.durationSec])));
  if (lengths.length) {
    const of = lengths.length === videos.length ? '' : ` (${lengths.length} of ${videos.length} have a length)`;
    lines.push(`Length, ${set}: ${clockText(lengths[0]!)} shortest · ${clockText(at(lengths, 0.25))} quarter · ${clockText(at(lengths, 0.5))} middle · ${clockText(at(lengths, 0.75))} three-quarters · ${clockText(lengths.at(-1)!)} longest${of}`);
    const buckets = BUCKETS.flatMap(([label, below], i) => {
      const from = i === 0 ? 0 : BUCKETS[i - 1]![1];
      const inBucket = videos.filter((v) => v.durationSec !== null && v.durationSec >= from && v.durationSec < below);
      return inBucket.length ? [`${label} ${medianText(inBucket)} (${inBucket.length})`] : [];
    });
    lines.push(`Median views by length, ${set}: ${buckets.join(' · ')}`);
  }
  const words = sorted(videos.map((v) => wordCount(v.title)));
  const chars = median(videos.map((v) => v.title.length))!;
  const caps = videos.filter((v) => isAllCaps(v.title)).length;
  lines.push(`Titles, ${set}: ${words[0]}–${words.at(-1)} words, ${at(words, 0.5)} typical, about ${Math.round(chars)} characters · ALL CAPS on ${caps} of ${videos.length} (${Math.round((caps / videos.length) * 100)}%)`);
  return lines;
}

const DAY_MS = 86_400_000;

/** How often the videos of a set were posted, from the ones whose day is known; nothing when fewer than two are. */
function postedLines(videos: ChannelVideo[], set: string, approximate: boolean): string[] {
  const days = sorted(videos.flatMap((v) => (v.posted ? [Date.parse(`${v.posted}T00:00:00Z`)] : [])));
  if (days.length < 2) return [];
  const every = (days.at(-1)! - days[0]!) / DAY_MS / (days.length - 1);
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const of = days.length === videos.length ? '' : ` (${days.length} of ${videos.length} have a date)`;
  return [`Posted, ${set}: one every ${every < 10 ? every.toFixed(1) : Math.round(every)} days, ${day(days[0]!)} to ${day(days.at(-1)!)}${of}${approximate ? ' · approximate: the list only says "2 weeks ago"' : ''}`];
}

/** `20261103` → `2026-11-03`; anything else is unknown. */
const dayOrNull = (text: string): string | null => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(text.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

/** `NA`, an empty field or anything that isn't a number is unknown. */
const numberOrNull = (text: string): number | null => (/^\d+(\.\d+)?$/.test(text.trim()) ? Number(text) : null);

/** What yt-dlp prints for each listed video (the title last: it may hold a `|`). */
export const LIST_PRINT = '%(id)s|%(duration)s|%(view_count)s|%(upload_date)s|%(title)s';
/** What it prints for one video read by itself. */
export const DETAIL_PRINT = '%(id)s|%(duration)s|%(upload_date)s';
/** How many videos are read at once when a list gives no lengths. */
const DETAILS_AT_ONCE = 6;

/** yt-dlp's `LIST_PRINT` lines. */
export function parseVideoLines(stdout: string): ChannelVideo[] {
  const videos: ChannelVideo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]{6,})\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/.exec(line);
    if (!m) continue;
    const posted = dayOrNull(m[4]!);
    videos.push({ id: m[1]!, durationSec: numberOrNull(m[2]!), views: numberOrNull(m[3]!), title: m[5]!.trim(), ...(posted ? { posted } : {}) });
  }
  return videos;
}

/**
 * A Shorts tab lists neither lengths nor dates. Reads both for these videos, one video at a time (a few at once), and
 * sets them on the videos. Returns how many could not be read.
 */
async function readDetails(videos: ChannelVideo[], deps: ChannelDeps, signal?: AbortSignal): Promise<number> {
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < videos.length) {
      const v = videos[next++]!;
      signal?.throwIfAborted();
      try {
        const out = await deps.ytDlp(['--skip-download', '--print', DETAIL_PRINT, `https://www.youtube.com/watch?v=${v.id}`], { signal });
        const m = out.split(/\r?\n/).map((l) => /^([A-Za-z0-9_-]{6,})\|([^|]*)\|([^|]*)$/.exec(l.trim())).find((x) => x?.[1] === v.id);
        const duration = m ? numberOrNull(m[2]!) : null;
        const posted = m ? dayOrNull(m[3]!) : null;
        if (duration !== null) v.durationSec = duration;
        if (posted) v.posted = posted;
        if (duration === null && !posted) failed++;
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        // No yt-dlp, or the person stopped it: that is the whole call's answer, not one video's.
        if (code === 'NOT_FOUND' || code === 'CANCELLED' || (e as { name?: unknown }).name === 'AbortError') throw e;
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DETAILS_AT_ONCE, videos.length) }, worker));
  return failed;
}

/**
 * `channel { url, videos? }`: lists the channel's newest `count` videos with yt-dlp (titles, lengths and views only),
 * writes them to `analysis/<slug>/videos.json` and reports the numbers an analysis starts from.
 */
export async function gatherChannel(project: string, o: { url: string; videos?: number }, deps: ChannelDeps, signal?: AbortSignal): Promise<string[]> {
  const { url, slug } = channelAddress(o.url);
  const count = o.videos ?? DEFAULT_VIDEOS;
  const stdout = await deps.ytDlp(['--flat-playlist', '--extractor-args', 'youtubetab:approximate_date', '--playlist-end', String(count), '--print', LIST_PRINT, url], { signal });
  const videos = parseVideoLines(stdout);
  if (!videos.length) throw new MirageError('BAD_INPUT', `no videos were found at ${url}`, 'Check the channel\'s address (open it in a browser: its Videos tab must list videos).');
  // A list with dates got them from "2 weeks ago" labels; dates read one video at a time are exact.
  const approximate = videos.some((v) => v.posted);
  const newest = videos.slice(0, LATEST);
  const unlisted = newest.filter((v) => v.durationSec === null && VIDEO_ID.test(v.id));
  const oneByOne = unlisted.length * 2 >= newest.length ? unlisted : [];
  const unread = oneByOne.length ? await readDetails(oneByOne, deps, signal) : 0;
  await mkdir(absDir(project, slug), { recursive: true });
  await writeJsonFile(join(absDir(project, slug), 'videos.json'), ChannelFileSchema, { version: 1, url, gatheredAt: (deps.now?.() ?? new Date()).toISOString(), videos }, `${relDir(slug)}/videos.json`);

  const all = `all ${videos.length}`;
  const latest = videos.slice(0, LATEST);
  const more = videos.length > LATEST;
  const lines = [
    `Channel ${slug}: ${videos.length} videos gathered, newest first (${relDir(slug)}/videos.json). Use name "${slug}" in the next channel calls.`,
    `Median views: ${medianText(videos)} (${all})${more ? ` · ${medianText(latest)} (latest ${LATEST})` : ''}`,
    ...statLines(videos, all),
    ...postedLines(videos, all, approximate),
    ...(more ? [...statLines(latest, `latest ${LATEST}`), ...postedLines(latest, `latest ${LATEST}`, approximate)] : []),
  ];
  if (oneByOne.length) {
    const older = videos.length - newest.length;
    lines.push(`This page lists no lengths or dates, so those of the newest ${oneByOne.length} were read one video at a time${older ? `; the ${older} older videos have none (channel { name, captions } reports one video's)` : ''}.`);
  }
  if (unread) lines.push(`⚠ ${unread} of ${oneByOne.length} videos couldn't be read one by one — their length and date stay unknown`);
  const unknown = videos.filter((v) => v.views === null).length;
  if (unknown) lines.push(`⚠ ${unknown} of ${videos.length} videos have no view count (members-only, upcoming or live) — they are left out of the medians and the most and least viewed lists`);
  lines.push('Most viewed:', ...pickVideos(videos, 'top').map(videoLine));
  lines.push('Newest:', ...pickVideos(videos, 'newest').map(videoLine));
  lines.push(`Least viewed of the latest ${Math.min(LATEST, videos.length)}:`, ...pickVideos(videos, 'lowest').map(videoLine));
  return lines;
}

/** Under this many videos on either side, a comparison says nothing. */
const MIN_SIDE = 3;

/**
 * `channel { name, patterns }`: for each title pattern, over all videos and over the latest 60, how many titles match and
 * the median views with against without, as a ratio. The ratio shows what goes with more views, never what causes them.
 */
export async function channelPatterns(project: string, name: string, patterns: { label: string; regex: string }[]): Promise<string[]> {
  const compiled = patterns.map((p) => {
    try {
      return { label: p.label, re: new RegExp(p.regex, 'i') };
    } catch (e) {
      throw new MirageError('BAD_INPUT', `pattern "${p.label}": its regex can't be read (${(e as Error).message})`, 'Fix that regex and run it again; nothing was compared.');
    }
  });
  const { videos } = await readChannel(project, name);
  const counted = videos.filter((v) => v.views !== null);
  const sets: [string, ChannelVideo[]][] = [[`all ${counted.length}`, counted]];
  if (videos.length > LATEST) sets.push([`latest ${LATEST}`, videos.slice(0, LATEST).filter((v) => v.views !== null)]);
  const lines = [`Channel ${name}: ${compiled.length} title ${compiled.length === 1 ? 'pattern' : 'patterns'}. × is the median views of the videos whose title matches against the rest: it shows what goes with more views, not what causes them.`];
  for (const { label, re } of compiled) {
    lines.push(`${label} (/${re.source}/i)`);
    for (const [set, of] of sets) {
      const yes = of.filter((v) => re.test(v.title));
      const no = of.filter((v) => !re.test(v.title));
      const [a, b] = [medianViews(yes), medianViews(no)];
      const compared = yes.length < MIN_SIDE || no.length < MIN_SIDE || a === null || !b ? 'too few to compare' : `${viewsText(a)} with · ${viewsText(b)} without · ×${(a / b).toFixed(2)}`;
      lines.push(`  ${set}: ${yes.length} match · ${compared}`);
    }
  }
  return lines;
}

const THUMB_FILES = ['maxresdefault.jpg', 'hq720.jpg', 'hqdefault.jpg'];
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

/** A video's thumbnail in `dir` (fetched once: the largest YouTube has), or null when none of the sizes is there. */
async function thumbnailFile(dir: string, id: string, deps: ChannelDeps, signal?: AbortSignal): Promise<string | null> {
  const file = join(dir, `${id}.jpg`);
  if (existsSync(file)) return file;
  for (const name of THUMB_FILES) {
    const bytes = await deps.fetchImage(`https://i.ytimg.com/vi/${id}/${name}`, { signal });
    if (bytes?.length) {
      await writeFile(file, bytes);
      return file;
    }
  }
  return null;
}

/** The ffmpeg arguments that tile `files` 4 across into `out`. Each image is scaled and padded to one size first: mixed sizes break `tile`. */
export function sheetArgs(files: string[], out: string): string[] {
  const { width: w, height: h, across, down } = TILE;
  const tiles = files.map((_, i) => `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuvj420p[t${i}]`);
  const graph = [...tiles, `${files.map((_, i) => `[t${i}]`).join('')}concat=n=${files.length}:v=1:a=0,tile=${across}x${down}[sheet]`].join(';');
  return [...files.flatMap((f) => ['-i', f]), '-filter_complex', graph, '-map', '[sheet]', '-frames:v', '1', '-q:v', '3', out];
}

/**
 * `channel { name, thumbnails }`: fetches the thumbnails of 12 videos (the most viewed, the newest, or the least viewed of
 * the latest 60) and tiles them into `analysis/<slug>/thumbs-<which>.jpg`, in reading order. The single thumbnails stay
 * in `analysis/<slug>/thumbs/`.
 */
export async function channelThumbnails(project: string, name: string, which: 'top' | 'newest' | 'lowest', deps: ChannelDeps, signal?: AbortSignal): Promise<string[]> {
  const { videos } = await readChannel(project, name);
  const dir = join(absDir(project, name), 'thumbs');
  await mkdir(dir, { recursive: true });
  const tiles: { video: ChannelVideo; file: string }[] = [];
  const warnings: string[] = [];
  for (const v of pickVideos(videos, which)) {
    signal?.throwIfAborted();
    const file = VIDEO_ID.test(v.id) ? await thumbnailFile(dir, v.id, deps, signal) : null;
    if (file) tiles.push({ video: v, file });
    else warnings.push(`⚠ no thumbnail could be fetched for ${v.id} (${v.title}) — it is left out of the sheet`);
  }
  if (!tiles.length) throw new MirageError('BAD_INPUT', 'no thumbnail could be fetched', 'Check the internet connection and run it again.');
  const sheet = `thumbs-${which}.jpg`;
  await deps.runFfmpeg(sheetArgs(tiles.map((t) => t.file), join(absDir(project, name), sheet)), { signal });
  const what = { top: 'the most viewed', newest: 'the newest', lowest: `the least viewed of the latest ${Math.min(LATEST, videos.length)}` }[which];
  return [
    `wrote ${relDir(name)}/${sheet} (${tiles.length} tiles, ${TILE.across} across, in reading order: ${what})`,
    ...tiles.map((t, i) => videoLine(t.video, i)),
    ...warnings,
  ];
}

// ---- captions ----

interface Word { t: number; w: string }

/** The words of a json3 caption file, each with the second it is said at. */
export function wordsFromJson3(text: string): { words: Word[]; lines: { t: number; text: string }[] } {
  const doc = JSON.parse(text) as { events?: { tStartMs?: number; segs?: { utf8?: string; tOffsetMs?: number }[] }[] };
  const words: Word[] = [];
  const lines: { t: number; text: string }[] = [];
  for (const ev of doc.events ?? []) {
    const start = (ev.tStartMs ?? 0) / 1000;
    const said: string[] = [];
    for (const seg of ev.segs ?? []) {
      for (const w of (seg.utf8 ?? '').split(/\s+/).filter(Boolean)) {
        words.push({ t: start + (seg.tOffsetMs ?? 0) / 1000, w });
        said.push(w);
      }
    }
    if (said.length) lines.push({ t: start, text: said.join(' ') });
  }
  return { words, lines };
}

const BLOCK_SEC = 300;
const OPENING_SEC = 150;
const ENDING_SEC = 100;
const REPLAYED = 8;

interface VideoInfo {
  title?: string;
  upload_date?: string;
  duration?: number;
  heatmap?: { start_time: number; end_time: number; value: number }[] | null;
  chapters?: { start_time: number; title: string }[] | null;
}

/** The report lines for one video's captions and info, and the transcript file's text (null without captions). */
export function captionsReport(id: string, info: VideoInfo, json3: string | null, dir: string): { lines: string[]; transcript: string | null } {
  const title = info.title ? ` “${info.title}”` : '';
  const { words, lines: said } = json3 === null ? { words: [], lines: [] } : wordsFromJson3(json3);
  const duration = info.duration ?? words.at(-1)?.t ?? 0;
  const lines: string[] = [];
  if (!words.length) {
    lines.push(`⚠ ${id}${title}: no English captions — no transcript for this video`);
  } else {
    lines.push(`${id}${title}: ${clockText(duration)}, ${words.length} words (${dir}/${id}.txt)`);
    const blocks: string[] = [];
    for (let from = 0; from < duration; from += BLOCK_SEC) {
      const to = Math.min(duration, from + BLOCK_SEC);
      // A last block of a few seconds gives a rate that means nothing.
      if (to - from < 20) continue;
      const n = words.filter((w) => w.t >= from && w.t < from + BLOCK_SEC).length;
      blocks.push(`${from / 60}–${Math.round((to / 60) * 10) / 10} min ${Math.round(n / ((to - from) / 60))}`);
    }
    lines.push(`  Words a minute, per 5-minute block: ${blocks.join(' · ')}`);
  }
  if (info.heatmap?.length && duration > 0) {
    const top = [...info.heatmap].sort((a, b) => b.value - a.value).slice(0, REPLAYED);
    lines.push(`  Most replayed, strongest first: ${top.map((h) => `${Math.round((((h.start_time + h.end_time) / 2) / duration) * 100)}% (${clockText((h.start_time + h.end_time) / 2)})`).join(' · ')}`);
  } else {
    lines.push('  Most replayed: YouTube shows none for this video');
  }
  const posted = info.upload_date ? dayOrNull(info.upload_date) : null;
  if (posted) lines.push(`  Posted: ${posted}`);
  lines.push(info.chapters?.length ? `  Chapters: ${info.chapters.map((c) => `${clockText(c.start_time)} ${c.title}`).join(' · ')}` : '  Chapters: none set');
  if (words.length) {
    const text = (ws: Word[]) => ws.map((w) => w.w).join(' ');
    lines.push(`  First ${OPENING_SEC} s: ${text(words.filter((w) => w.t < OPENING_SEC))}`);
    lines.push(`  Last ${ENDING_SEC} s: ${text(words.filter((w) => w.t >= duration - ENDING_SEC))}`);
  }
  return { lines, transcript: words.length ? `${said.map((l) => `[${clockText(l.t)}] ${l.text}`).join('\n')}\n` : null };
}

/**
 * `channel { name, captions: [ids] }`: for each video, has yt-dlp write its automatic English captions and its info
 * (never the video) into `analysis/<slug>/raw/`, writes the timestamped transcript to `analysis/<slug>/<id>.txt`, and
 * reports its pace, most replayed points, chapters, and how it opens and ends. A video that can't be read is one ⚠ line,
 * and the others still come.
 */
export async function channelCaptions(project: string, name: string, ids: string[], deps: ChannelDeps, signal?: AbortSignal): Promise<string[]> {
  await readChannel(project, name);
  for (const id of ids) {
    if (!VIDEO_ID.test(id)) throw new MirageError('BAD_INPUT', `"${id}" isn't a video id`, 'Use the ids the channel lists show, e.g. dQw4w9WgXcQ.');
  }
  const dir = absDir(project, name);
  const raw = join(dir, 'raw');
  await mkdir(raw, { recursive: true });
  const lines: string[] = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    try {
      await deps.ytDlp(['--skip-download', '--write-auto-subs', '--sub-langs', 'en', '--sub-format', 'json3', '--write-info-json', '-P', raw, '-o', '%(id)s.%(ext)s', `https://www.youtube.com/watch?v=${id}`], { signal });
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      // No yt-dlp, or the person stopped it: that is the whole call's answer, not one video's.
      if (code === 'NOT_FOUND' || code === 'CANCELLED' || (e as { name?: unknown }).name === 'AbortError') throw e;
      lines.push(`⚠ ${id}: yt-dlp couldn't read this video (${errorReason(e)}) — it is left out`);
      continue;
    }
    const infoFile = join(raw, `${id}.info.json`);
    if (!existsSync(infoFile)) {
      lines.push(`⚠ ${id}: yt-dlp wrote no info for this video — it is left out`);
      continue;
    }
    const info = JSON.parse(await readFile(infoFile, 'utf8')) as VideoInfo;
    const subs = (await readdir(raw)).filter((f) => f.startsWith(`${id}.`) && f.endsWith('.json3')).sort((a, b) => Number(b === `${id}.en.json3`) - Number(a === `${id}.en.json3`))[0];
    const report = captionsReport(id, info, subs ? await readFile(join(raw, subs), 'utf8') : null, relDir(name));
    if (report.transcript !== null) await writeFile(join(dir, `${id}.txt`), report.transcript);
    lines.push(...report.lines);
  }
  return lines;
}
