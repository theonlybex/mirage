// SPDX-License-Identifier: AGPL-3.0-or-later
// Test fixtures for the viewer server: a temp Mirage project with an awkward folder name, one video, one clip and an episode.
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CLIP_BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

export type TestProject = { root: string; project: string; footage: string; outside: string; uiDir: string; pluginData: string };

/** A project named `we proj 'q' "d" 100% #1 ✨` (spaces, quotes, a percent sign, a hash and an emoji must all survive URLs) with video 1. */
export async function makeProject(): Promise<TestProject> {
  const root = await mkdtemp(join(tmpdir(), 'mirage-viewer-'));
  const project = join(root, `we proj 'q' "d" 100% #1 ✨`);
  const footage = join(root, 'footage');
  const outside = join(root, 'outside');
  const uiDir = join(root, 'ui');
  const pluginData = join(root, 'data');
  for (const d of [join(project, 'episodes', '1'), footage, outside, join(uiDir, 'assets'), pluginData]) await mkdir(d, { recursive: true });
  await writeFile(join(project, 'mirage.json'), JSON.stringify({ version: 1, title: 'Test project', createdAt: new Date().toISOString() }));
  await writeFile(
    join(project, 'episodes', '1', 'video.json'),
    JSON.stringify({ version: 1, title: 'First video', about: '', mention: '', hide: '', footage: [footage], createdAt: new Date().toISOString() }),
  );
  await writeFile(join(project, 'clip.mp4'), CLIP_BYTES);
  await writeFile(join(footage, 'raw.mov'), CLIP_BYTES);
  await writeFile(join(outside, 'secret.txt'), 'top secret');
  await symlink(outside, join(project, 'link'));
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css"><script type="module" src="/assets/app.js"></script></head><body></body></html>');
  await writeFile(join(uiDir, 'assets', 'app.js'), 'console.log("app")');
  await writeFile(join(uiDir, 'assets', 'app.css'), '@font-face{src:url(./font.woff2) format("woff2")} .x{background:url(data:image/png;base64,AAA)} .y{background:url("/assets/bg.png")}');
  await writeFile(join(uiDir, 'assets', 'font.woff2'), 'font');
  await writeFile(join(root, 'ui-secret.txt'), 'not for the web');
  return { root, project, footage, outside, uiDir, pluginData };
}

export const episodeJson = (title = 'Build story', over: Record<string, unknown> = {}) => ({
  version: 2,
  number: 1,
  title,
  output: { width: 1920, height: 1080, fps: 30 },
  items: [
    { id: 'i1', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 10 } },
    { id: 'i2', beat: 'montage', clip: 'c001', src: { in: 20, out: 60 }, speed: 4, quiet: true },
  ],
  overlays: [{ kind: 'callout', text: 'It works', tone: 'pass', start: 1, end: 3 }],
  music: [{ track: 'calm', start: 0, end: 12 }],
  slots: [{ id: 's1', start: 0, end: 4, maxWords: 10, line: 'Hello there.' }],
  voiceover: { recording: '/r.m4a', lines: [{ slot: 's1', at: 0.5, src: { in: 2, out: 6 }, cuts: [[3, 3.5]] }] },
  ...over,
});

export const catalogJson = () => ({
  version: 1,
  clips: [
    {
      id: 'c001',
      path: '/clips/a.mov',
      sha256: 'a'.repeat(64),
      probe: { durationSec: 100, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: false, videoCodec: 'h264', audioCodec: null },
      kind: 'screen',
      transcript: null,
      frames: [0, 5, 10, 15, 20].map((t) => ({ t, file: `frames/c001/f${t}.jpg` })),
      notes: '',
      moments: [],
    },
  ],
});
