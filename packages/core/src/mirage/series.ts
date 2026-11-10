// SPDX-License-Identifier: MIT
// A series: a folder `series/<slug>/` in the project that groups its episodes and carries, from one episode to the next,
// the open question, the running counts (cost so far, attempts used), the sign-off, the title shape and the thumbnail
// layout (`series.json`). The videos stay in `episodes/<n>/` (every other path depends on those): the series folder
// groups them by number, and its README.md is a generated view of them (title, stage, files). `new_video { series }`
// adds a video to one, the `series` tool lists, shows and updates them, and the build story's recap and outro read from
// and write to it. Mirage never invents a question, a count or a sign-off: each is what the person or the catalog gave.
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SeriesSchema, type Series, type ThumbLayout } from '@wordedits/shared';
import { describeError, MirageError } from './errors.js';
import { readJsonFile, writeJsonFile } from './json-file.js';
import { readVideo, videoStage } from './video.js';

/** The face's share of the width when a series or a call sets none: about a third. */
export const DEFAULT_FACE_SHARE = 0.34;

export const seriesDir = (project: string, slug: string) => join(project, 'series', slug);
const seriesFile = (project: string, slug: string) => join(seriesDir(project, slug), 'series.json');
const shown = (slug: string) => `series/${slug}/series.json`;

/** A series' slug from what the person calls it: lower case, every run of other characters one `-`. Throws when nothing is left. */
export function seriesSlug(name: string): string {
  const slug = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new MirageError('BAD_INPUT', `"${name}" can't name a series`, 'Give the series a name with letters or digits in it.');
  return slug;
}

/** The series with this slug; null when there is none. A series.json that was edited and broke throws, naming the key. */
export async function readSeries(project: string, slug: string): Promise<Series | null> {
  try {
    return await readJsonFile(seriesFile(project, slug), SeriesSchema, shown(slug));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Every series of the project, in the order of their folder names. One that can't be read is left out and named in
 * `problems` as `✖ series/<slug>/series.json: <why>`: one typo never hides the others.
 */
export async function listSeries(project: string): Promise<{ series: Series[]; problems: string[] }> {
  const names = (await readdir(join(project, 'series')).catch(() => [] as string[])).sort();
  const series: Series[] = [];
  const problems: string[] = [];
  for (const slug of names) {
    if (!existsSync(seriesFile(project, slug))) continue;
    try {
      const s = await readSeries(project, slug);
      if (s && s.slug !== slug) problems.push(`✖ ${shown(slug)}: slug: the slug "${s.slug}" must be the folder's name, "${slug}"`);
      else if (s) series.push(s);
    } catch (e) {
      const m = describeError(e).message;
      problems.push(`✖ ${m.startsWith(shown(slug)) ? m : `${shown(slug)}: ${m}`}`);
    }
  }
  return { series, problems };
}

/** The series a name or a slug means: its slug, or the series whose name is this (case aside). Throws when there is none. */
export async function findSeries(project: string, ref: string): Promise<Series> {
  const { series } = await listSeries(project);
  const slug = seriesSlug(ref);
  const found = series.find((s) => s.slug === slug) ?? series.find((s) => s.name.toLowerCase() === ref.trim().toLowerCase());
  if (!found) throw new MirageError('BAD_INPUT', `there is no series "${ref}"`, `The series are: ${series.map((s) => s.slug).join(', ') || 'none'}. new_video with series starts one.`);
  return found;
}

/** The series video `n` belongs to (its video.json's `series`); null when it has none, or the series can't be read. */
export async function seriesOf(project: string, n: number): Promise<Series | null> {
  const video = await readVideo(project, n).catch(() => null);
  return video?.series ? await readSeries(project, video.series).catch(() => null) : null;
}

const countText = (c: { value: number; unit?: string }) => `${c.value}${c.unit ? ` ${c.unit}` : ''}`;
export const countsText = (s: Series) => Object.entries(s.counts).map(([name, c]) => `${name} ${countText(c)}`).join(' · ');
const layoutText = (l: ThumbLayout) => `the face on the ${l.face}, ${Math.round(l.share * 100)}% of the width`;

/**
 * `series/<slug>/README.md`: the grouped view of the series on disk. What it carries, then one line per episode with its
 * title, its stage and links to its files in `episodes/<n>/`. Generated: rewritten whenever the series is saved or shown.
 */
async function readme(project: string, s: Series): Promise<string> {
  const lines = [
    `# ${s.name}`,
    '',
    'Written by Mirage: do not edit, it is rewritten whenever the series changes or is shown. What the series carries is in `series.json`, beside this file.',
    '',
    `- Format: ${s.format}`,
    ...(s.question ? [`- The big question: ${s.question}`] : []),
    `- Open question for the next episode: ${s.openQuestion ? `${s.openQuestion}${s.openQuestionFrom ? ` (left by video ${s.openQuestionFrom})` : ''}` : 'none on record'}`,
    ...(Object.keys(s.counts).length ? [`- Running counts: ${countsText(s)}`] : []),
    ...(s.signOff ? [`- Sign-off: ${s.signOff}`] : []),
    ...(s.titleShape ? [`- Title shape: ${s.titleShape}`] : []),
    ...(s.thumbnail ? [`- Thumbnail layout: ${layoutText(s.thumbnail)}`] : []),
    '',
    '## Episodes',
    '',
  ];
  if (!s.episodes.length) lines.push('None yet.');
  for (const [i, n] of s.episodes.entries()) {
    const dir = join(project, 'episodes', String(n));
    const video = await readVideo(project, n).catch(() => null);
    const stage = existsSync(dir) ? (await videoStage(project, n)).stage : 'missing';
    const files = ['final.mp4', 'final.srt', 'rough.mp4', 'thumbnail.jpg', 'summary.md'].filter((f) => existsSync(join(dir, f)));
    const title = video?.titles?.chosen ?? video?.title ?? 'no video.json';
    lines.push(`${i + 1}. Video ${n} “${title}”: ${stage}${video?.posted ? `, posted ${video.posted.at} at ${video.posted.url}` : ''} · [episodes/${n}/](../../episodes/${n}/)${files.map((f) => ` · [${f}](../../episodes/${n}/${f})`).join('')}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Saves the series (making its folder) and rewrites its README.md; the README is a view, so failing to write it never fails the save. */
export async function writeSeries(project: string, s: Series): Promise<void> {
  await mkdir(seriesDir(project, s.slug), { recursive: true });
  await writeJsonFile(seriesFile(project, s.slug), SeriesSchema, s, shown(s.slug));
  await refreshReadme(project, s);
}

export async function refreshReadme(project: string, s: Series): Promise<void> {
  await writeFile(join(seriesDir(project, s.slug), 'README.md'), await readme(project, s)).catch(() => {});
}

/** The fields of a series the person can set. An empty text clears that field; a count set to null is removed. */
export interface SeriesFields {
  name?: string;
  format?: string;
  question?: string;
  openQuestion?: string;
  /** The video whose outro left the open question. */
  video?: number;
  counts?: Record<string, { value: number; unit?: string } | null>;
  signOff?: string;
  titleShape?: string;
  thumbnail?: { face: 'left' | 'right'; share?: number };
}

function withFields(s: Series, f: SeriesFields): Series {
  const out: Series = { ...s, counts: { ...s.counts } };
  for (const key of ['question', 'openQuestion', 'signOff', 'titleShape'] as const) {
    const text = f[key];
    if (text === undefined) continue;
    if (text.trim()) out[key] = text.trim();
    else delete out[key];
  }
  if (f.name?.trim()) out.name = f.name.trim();
  if (f.format) out.format = f.format;
  if (f.openQuestion !== undefined) {
    if (f.openQuestion.trim() && f.video !== undefined) out.openQuestionFrom = f.video;
    else delete out.openQuestionFrom;
  }
  for (const [name, c] of Object.entries(f.counts ?? {})) {
    if (c === null) delete out.counts[name];
    else out.counts[name] = { value: c.value, ...(c.unit ? { unit: c.unit } : {}) };
  }
  if (f.thumbnail) out.thumbnail = { face: f.thumbnail.face, share: f.thumbnail.share ?? s.thumbnail?.share ?? DEFAULT_FACE_SHARE };
  return out;
}

/**
 * The series a new video joins (`new_video`'s `series`): the one `ref` means (a slug, or a name), else a new one made
 * with the fields the person gave. Nothing is written: `addEpisode` saves it once the video has its number. On a series
 * that exists the other fields are not applied (`ignored` names them): the `series` tool changes a series.
 */
export async function planSeries(project: string, ref: string, f: SeriesFields, format: string, now: Date = new Date()): Promise<{ series: Series; created: boolean; ignored: string[] }> {
  const { series } = await listSeries(project);
  const slug = seriesSlug(ref);
  const found = series.find((s) => s.slug === slug) ?? series.find((s) => s.name.toLowerCase() === ref.trim().toLowerCase());
  if (found) return { series: found, created: false, ignored: Object.keys(f).filter((k) => k !== 'name' && f[k as keyof SeriesFields] !== undefined) };
  // A folder of that name with a series.json that can't be read is someone's series: never written over.
  if (existsSync(seriesFile(project, slug))) await readSeries(project, slug);
  const fresh: Series = { version: 1, slug, name: ref.trim(), format, counts: {}, episodes: [], createdAt: now.toISOString() };
  return { series: withFields(fresh, { ...f, name: undefined, format: undefined }), created: true, ignored: [] };
}

/** Adds video `n` to the series (once) and saves it. */
export async function addEpisode(project: string, s: Series, n: number): Promise<Series> {
  const next = { ...s, episodes: s.episodes.includes(n) ? s.episodes : [...s.episodes, n] };
  await writeSeries(project, next);
  return next;
}

/** `series { name, … }`: sets the fields given on the series `ref` means and saves it. */
export async function updateSeries(project: string, ref: string, f: SeriesFields): Promise<Series> {
  const s = await findSeries(project, ref);
  if (f.video !== undefined && !s.episodes.includes(f.video)) {
    throw new MirageError('BAD_INPUT', `video ${f.video} isn't an episode of the series "${s.name}"`, `Its episodes are: ${s.episodes.map((n) => `video ${n}`).join(', ') || 'none'}.`);
  }
  const next = withFields(s, f);
  await writeSeries(project, next);
  return next;
}

/** One line of `status` and of the `series` list: the series, its episodes and its open question. */
export function seriesLine(s: Series): string {
  const episodes = s.episodes.length ? `${s.episodes.length === 1 ? 'video' : 'videos'} ${s.episodes.join(', ')}` : 'no episodes yet';
  return `Series “${s.name}” (series/${s.slug}/, ${s.format}): ${episodes} · ${s.openQuestion ? `open question: “${s.openQuestion}”` : 'no open question on record'}`;
}

/** A series in full, as the `series` tool shows it: what it carries, then each episode with its title and stage. */
export async function seriesReport(project: string, s: Series): Promise<string[]> {
  const lines = [
    seriesLine(s),
    `  The big question: ${s.question ?? 'none on record'}`,
    ...(s.openQuestion && s.openQuestionFrom ? [`  The open question was left by video ${s.openQuestionFrom}`] : []),
    `  Running counts: ${countsText(s) || 'none on record'}`,
    `  Sign-off: ${s.signOff ?? 'none on record'}`,
    `  Title shape: ${s.titleShape ?? 'none on record'}`,
    `  Thumbnail layout: ${s.thumbnail ? layoutText(s.thumbnail) : 'none on record'}`,
  ];
  for (const n of s.episodes) {
    const video = await readVideo(project, n).catch(() => null);
    const stage = existsSync(join(project, 'episodes', String(n))) ? (await videoStage(project, n)).stage : 'missing';
    lines.push(`  Video ${n}${video ? ` “${video.titles?.chosen ?? video.title}”` : ''}: ${stage}${video?.posted ? ' · posted' : ''}`);
  }
  await refreshReadme(project, s);
  lines.push(`  The grouped view is series/${s.slug}/README.md`);
  return lines;
}
