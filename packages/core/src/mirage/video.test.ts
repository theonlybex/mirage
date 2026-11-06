// SPDX-License-Identifier: MIT
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DELIVERY_LABEL } from './labels.js';
import { snapshotVersion } from './versions.js';
import { newVideo, readVideo, videoStage } from './video.js';

const v = (title: string) => ({ title, about: 'a build story', mention: 'the bug', hide: 'the API key', footage: ['/clips/a'] });

describe('videos', () => {
  it('numbers videos 1, then 2, and writes video.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-video-'));
    expect(await newVideo(dir, v('First'))).toBe(1);
    expect(await newVideo(dir, v('Second'))).toBe(2);
    expect(await readVideo(dir, 2)).toMatchObject({ version: 1, title: 'Second', about: 'a build story', footage: ['/clips/a'] });
    expect(Date.parse((await readVideo(dir, 1))!.createdAt)).toBeGreaterThan(0);
  });

  it('goes after the highest numbered folder, ignoring other names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-video-'));
    await mkdir(join(dir, 'episodes', '4'), { recursive: true });
    await mkdir(join(dir, 'episodes', 'scratch'));
    expect(await newVideo(dir, v('Fifth'))).toBe(5);
  });

  it('gives different numbers to videos made at the same time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-video-'));
    const ns = await Promise.all([newVideo(dir, v('a')), newVideo(dir, v('b')), newVideo(dir, v('c'))]);
    expect([...ns].sort()).toEqual([1, 2, 3]);
  });

  it('reads null for a video without video.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-video-'));
    await mkdir(join(dir, 'episodes', '1'), { recursive: true });
    expect(await readVideo(dir, 1)).toBeNull();
    expect(await readVideo(dir, 9)).toBeNull();
  });

  it('refuses an empty title without creating the folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-video-'));
    await expect(newVideo(dir, v(''))).rejects.toThrow(/title/);
    expect(await newVideo(dir, v('ok'))).toBe(1);
  });
});

describe('videoStage', () => {
  it('is new for a video with no render, then the newest of rough, guide and final', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-stage-'));
    const n = await newVideo(dir, v('Staged'));
    expect(await videoStage(dir, n)).toEqual({ stage: 'new', deliveries: 0 });
    const ep = join(dir, 'episodes', String(n));
    await writeFile(join(ep, 'rough.mp4'), 'x');
    expect((await videoStage(dir, n)).stage).toBe('rough');
    await writeFile(join(ep, 'guide.mp4'), 'x');
    expect((await videoStage(dir, n)).stage).toBe('guide');
    await writeFile(join(ep, 'final.mp4'), 'x');
    expect((await videoStage(dir, n)).stage).toBe('final');
  });

  it('counts deliveries, not checkpoints, and knows a folder that is not there', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-stage-'));
    const n = await newVideo(dir, v('Delivered'));
    const ep = join(dir, 'episodes', String(n));
    await writeFile(join(ep, 'rough.mp4'), 'x');
    await snapshotVersion(dir, n, { kind: 'delivery', label: DELIVERY_LABEL.rough, render: 'rough' });
    await snapshotVersion(dir, n, { kind: 'checkpoint', label: 'Edited' });
    expect(await videoStage(dir, n)).toEqual({ stage: 'rough', deliveries: 1 });
    expect(await videoStage(dir, 99)).toEqual({ stage: 'new', deliveries: 0 });
  });
});
