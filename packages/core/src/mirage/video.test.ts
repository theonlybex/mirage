// SPDX-License-Identifier: MIT
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DELIVERY_LABEL } from './labels.js';
import { snapshotVersion } from './versions.js';
import { VideoSchema } from '@wordedits/shared';
import { loadFormats } from './formats.js';
import { newVideo, planVideo, readVideo, videoStage } from './video.js';

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

describe('video.json and formats', () => {
  const OLD = {
    version: 1, title: 'Weather app, part 1', about: 'a build story', mention: 'the bug', hide: '', footage: ['/clips/a', '/clips/b'], createdAt: '2026-01-02T03:04:05.000Z',
  };

  it('a video.json from before formats round-trips byte for byte, with no new key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-video-'));
    await mkdir(join(dir, 'episodes', '1'), { recursive: true });
    const text = JSON.stringify(OLD, null, 2) + '\n';
    await writeFile(join(dir, 'episodes', '1', 'video.json'), text);
    const read = await readVideo(dir, 1);
    expect(JSON.stringify(read, null, 2) + '\n').toBe(text);
    expect(JSON.stringify(VideoSchema.parse(OLD), null, 2) + '\n').toBe(text);
  });

  it('newVideo without the new fields writes none of them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-video-'));
    const n = await newVideo(dir, v('Plain'));
    const written = JSON.parse(await readFile(join(dir, 'episodes', String(n), 'video.json'), 'utf8'));
    expect(Object.keys(written).sort()).toEqual(['about', 'createdAt', 'footage', 'hide', 'mention', 'title', 'version']);
  });

  it('takes format, from, vlog and targetSec, all optional, and keeps them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-video-'));
    const n = await newVideo(dir, { ...v('Teaser'), format: 'short', from: 3, vlog: { name: 'Ibiza', number: 2, date: '2026-07-01' }, targetSec: 30 });
    expect(await readVideo(dir, n)).toMatchObject({ format: 'short', from: 3, vlog: { name: 'Ibiza', number: 2, date: '2026-07-01' }, targetSec: 30 });
  });

  it('refuses a misspelled key and bad values', () => {
    expect(VideoSchema.safeParse({ ...OLD, formt: 'short' }).success).toBe(false);
    expect(VideoSchema.safeParse({ ...OLD, from: 0 }).success).toBe(false);
    expect(VideoSchema.safeParse({ ...OLD, from: 1.5 }).success).toBe(false);
    expect(VideoSchema.safeParse({ ...OLD, targetSec: -1 }).success).toBe(false);
    expect(VideoSchema.safeParse({ ...OLD, vlog: { name: 'x', number: 0, date: 'd' } }).success).toBe(false);
    expect(VideoSchema.safeParse({ ...OLD, vlog: { name: 'x', number: 1, date: 'd', extra: 1 } }).success).toBe(false);
  });
});

describe('planVideo', () => {
  const loaded = loadFormats();
  const big = { title: 'The proposal', about: 'my brother proposes', mention: 'the ring', hide: 'the address', footage: ['/clips/a', '/clips/b'] };

  it('a plain video: as asked, no new keys, a build story', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-video-'));
    const { video, format } = await planVideo(dir, { title: 'Part 1', about: 'x', footage: ['/clips/a'] }, loaded);
    expect(video).toEqual({ title: 'Part 1', about: 'x', mention: '', hide: '', footage: ['/clips/a'] });
    expect(format?.id).toBe('build-story');
  });

  it('a video in a format keeps the format and its target', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-video-'));
    const { video, format } = await planVideo(dir, { title: 'Trip', about: 'x', footage: [], format: 'vlog', targetSec: 600 }, loaded);
    expect(video).toMatchObject({ format: 'vlog', targetSec: 600 });
    expect(format?.id).toBe('vlog');
  });

  it("refuses an unknown format, naming the ids, and needs about and footage unless it's made from another video", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-video-'));
    await expect(planVideo(dir, { title: 'x', about: 'x', footage: [], format: 'reel' }, loaded)).rejects.toMatchObject({ message: 'unknown format "reel"', hint: 'The formats are: build-story, short, vlog.' });
    await expect(planVideo(dir, { title: 'x', footage: [] }, loaded)).rejects.toMatchObject({ message: 'a new video needs about and footage, unless it is made from another video (from)' });
    await expect(planVideo(dir, { title: 'x', about: 'x' }, loaded)).rejects.toMatchObject({ message: 'a new video needs about and footage, unless it is made from another video (from)' });
  });

  it('numbers vlogs: the first is 1, the next one more than the highest; a number given is kept', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-video-'));
    await newVideo(dir, v('Not a vlog'));
    const first = (await planVideo(dir, { title: 'Day 1', about: 'x', footage: [], format: 'vlog', vlog: { name: 'Ibiza', date: '2026-07-01' } }, loaded)).video;
    expect(first.vlog).toEqual({ name: 'Ibiza', number: 1, date: '2026-07-01' });
    await newVideo(dir, first);
    await newVideo(dir, { ...first, vlog: { name: 'Ibiza', number: 4, date: '2026-07-04' } });
    const next = (await planVideo(dir, { title: 'Day 5', about: 'x', footage: [], format: 'vlog', vlog: { name: 'Ibiza', date: '2026-07-05' } }, loaded)).video;
    expect(next.vlog).toEqual({ name: 'Ibiza', number: 5, date: '2026-07-05' });
    const given = (await planVideo(dir, { title: 'Day 2', about: 'x', footage: [], format: 'vlog', vlog: { name: 'Ibiza', number: 2, date: '2026-07-02' } }, loaded)).video;
    expect(given.vlog?.number).toBe(2);
  });

  it("from a big video: its footage and answers, the caller's added to them, a short by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-video-'));
    const n = await newVideo(dir, big);
    const { video, format } = await planVideo(dir, { title: 'Did he say yes?', from: n, about: 'the moment he kneels', footage: ['/clips/b', '/clips/c'] }, loaded);
    expect(video).toEqual({
      title: 'Did he say yes?', about: 'my brother proposes\nthe moment he kneels', mention: 'the ring', hide: 'the address', footage: ['/clips/a', '/clips/b', '/clips/c'], format: 'short', from: n,
    });
    expect(format?.id).toBe('short');
    expect((await planVideo(dir, { title: 'Vlog cut', from: n, format: 'vlog' }, loaded)).video).toMatchObject({ format: 'vlog', about: 'my brother proposes', footage: ['/clips/a', '/clips/b'] });
  });

  it('from a short is allowed (a short of a short), and from a video that is not there is refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-video-'));
    const n = await newVideo(dir, big);
    const s = await newVideo(dir, (await planVideo(dir, { title: 'Short', from: n }, loaded)).video);
    const again = (await planVideo(dir, { title: 'Short of a short', from: s }, loaded)).video;
    expect(again).toMatchObject({ format: 'short', from: s, footage: ['/clips/a', '/clips/b'], about: 'my brother proposes' });
    await expect(planVideo(dir, { title: 'x', from: 9 }, loaded)).rejects.toMatchObject({ code: 'BAD_INPUT', message: 'there is no video 9' });
    await mkdir(join(dir, 'episodes', '7'));
    await expect(planVideo(dir, { title: 'x', from: 7 }, loaded)).rejects.toMatchObject({ code: 'BAD_INPUT', message: 'video 7 has no video.json to copy from' });
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
