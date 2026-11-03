// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { VideoSchema, type Video } from '@wordedits/shared';
import { readJsonFile, writeJsonFile } from './json-file.js';
import { episodeDir } from './render-episode.js';

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
