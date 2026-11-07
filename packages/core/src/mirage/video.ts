// SPDX-License-Identifier: MIT
import { access, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { VideoSchema, type Video } from '@wordedits/shared';
import { MirageError } from './errors.js';
import { formatOf, type Format } from './formats.js';
import { readJsonFile, writeJsonFile } from './json-file.js';
import { episodeDir } from './render-episode.js';
import { listVersions } from './versions.js';

const videoPath = (project: string, n: number) => join(episodeDir(project, n), 'video.json');

/** Creates the next video (highest numbered folder in episodes/ plus 1) with its video.json, and returns its number. */
export async function newVideo(project: string, v: Omit<Video, 'version' | 'createdAt'>): Promise<number> {
  const video = VideoSchema.parse({ ...v, version: 1, createdAt: new Date().toISOString() });
  const root = join(resolve(project), 'episodes');
  await mkdir(root, { recursive: true });
  for (;;) {
    const highest = (await readdir(root)).reduce((m, f) => (/^[1-9]\d*$/.test(f) ? Math.max(m, Number(f)) : m), 0);
    const n = highest + 1;
    try {
      await mkdir(episodeDir(project, n)); // not recursive: whoever creates the folder owns the number
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    await writeJsonFile(videoPath(project, n), VideoSchema, video, `episodes/${n}/video.json`);
    return n;
  }
}

/** What `new_video` is asked for: a video.json's answers, with `from` to start from another video and a vlog's number left to count. */
export interface VideoRequest {
  title: string;
  about?: string;
  mention?: string;
  hide?: string;
  /** Absolute paths. */
  footage?: string[];
  format?: string;
  from?: number;
  vlog?: { name: string; number?: number; date: string };
  targetSec?: number;
}

/** The numbered folders of episodes/. */
async function videoNumbers(project: string): Promise<number[]> {
  const names = await readdir(join(resolve(project), 'episodes')).catch(() => [] as string[]);
  return names.filter((f) => /^[1-9]\d*$/.test(f)).map(Number);
}

/**
 * The video.json answers of a new video (for `newVideo`) and its format (null when even the build story can't be
 * loaded). `from: n` starts from video n's footage and answers (the request's own are added to them) and makes a short
 * unless a format is given; a vlog without a number gets one more than the highest of the project's vlogs of that name. Only keys asked for or
 * copied are set, so a plain video's video.json is as it always was.
 */
export async function planVideo(
  project: string,
  req: VideoRequest,
  { formats, problems }: { formats: Format[]; problems: string[] },
): Promise<{ video: Omit<Video, 'version' | 'createdAt'>; format: Format | null }> {
  let base = { about: '', mention: '', hide: '', footage: [] as string[] };
  if (req.from !== undefined) {
    const src = await readVideo(project, req.from);
    if (!src) {
      const folder = await access(episodeDir(project, req.from)).then(() => true, () => false);
      throw new MirageError('BAD_INPUT', folder ? `video ${req.from} has no video.json to copy from` : `there is no video ${req.from}`, 'Run status to see the videos.');
    }
    base = { about: src.about, mention: src.mention, hide: src.hide, footage: src.footage };
  } else if (req.about === undefined || req.footage === undefined) {
    throw new MirageError('BAD_INPUT', 'a new video needs about and footage, unless it is made from another video (from)', 'Say what the video is about and give the folders its footage is in.');
  }
  const format = req.format ?? (req.from !== undefined ? 'short' : undefined);
  if (format !== undefined && !formats.some((f) => f.id === format)) {
    throw new MirageError('BAD_INPUT', `unknown format "${format}"`, [`The formats are: ${formats.map((f) => f.id).join(', ') || 'none'}.`, ...problems].join('\n  '));
  }
  if (req.vlog && format !== 'vlog') {
    throw new MirageError('BAD_INPUT', 'vlog: { name, date } is for format vlog', 'Pass format: "vlog" with it, or leave vlog out.');
  }
  const add = (copied: string, more: string | undefined) => [copied, more ?? ''].filter((t) => t.trim()).join('\n');
  let vlog: Video['vlog'];
  if (req.vlog) {
    let number = req.vlog.number;
    if (number === undefined) {
      // Each vlog name counts on its own: a "Paris" vlog starts at 1 after "Ibiza" #4.
      number = 1;
      for (const n of await videoNumbers(project)) {
        const other = await readVideo(project, n).catch(() => null);
        if (other?.vlog && other.vlog.name === req.vlog.name) number = Math.max(number, other.vlog.number + 1);
      }
    }
    vlog = { name: req.vlog.name, number, date: req.vlog.date };
  }
  const video: Omit<Video, 'version' | 'createdAt'> = {
    title: req.title,
    about: add(base.about, req.about),
    mention: add(base.mention, req.mention),
    hide: add(base.hide, req.hide),
    footage: [...new Set([...base.footage, ...(req.footage ?? [])])],
    ...(format !== undefined ? { format } : {}),
    ...(req.from !== undefined ? { from: req.from } : {}),
    ...(vlog ? { vlog } : {}),
    ...(req.targetSec !== undefined ? { targetSec: req.targetSec } : {}),
  };
  let found: Format | null;
  try {
    found = formatOf({ ...video, version: 1, createdAt: '' }, formats);
  } catch {
    found = null;
  }
  return { video, format: found };
}

/** The video's video.json, or null when it has none. */
export async function readVideo(project: string, n: number): Promise<Video | null> {
  try {
    return await readJsonFile(videoPath(project, n), VideoSchema, `episodes/${n}/video.json`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export type VideoStage = 'new' | 'rough' | 'guide' | 'final';

/**
 * How far video `n` has come: the newest render that exists in episodes/<n>/ (final over guide over rough, else new), and how
 * many deliveries it has had.
 */
export async function videoStage(project: string, n: number): Promise<{ stage: VideoStage; deliveries: number }> {
  const dir = episodeDir(project, n);
  let stage: VideoStage = 'new';
  for (const s of ['final', 'guide', 'rough'] as const) {
    if (await access(join(dir, `${s}.mp4`)).then(() => true, () => false)) {
      stage = s;
      break;
    }
  }
  const deliveries = (await listVersions(project, n)).filter((v) => v.kind === 'delivery').length;
  return { stage, deliveries };
}
