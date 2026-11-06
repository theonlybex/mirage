// SPDX-License-Identifier: MIT
import { access, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { VideoSchema, type Video } from '@wordedits/shared';
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
