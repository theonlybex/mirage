// SPDX-License-Identifier: MIT
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startWhenProject } from './monitor.js';

const fakeViewer = () => ({ url: 'u', port: 1, key: 'k', close: vi.fn(async () => {}) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('startWhenProject', () => {
  it('starts at once inside a Mirage project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-monitor-'));
    await writeFile(join(dir, 'mirage.json'), '{}');
    const start = vi.fn(async () => fakeViewer());
    const m = startWhenProject({ project: dir, intervalMs: 20, start });
    await m.started;
    expect(start).toHaveBeenCalledTimes(1);
    await m.stop();
  });

  it('waits outside a project, then starts once mirage.json appears, and only once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-monitor-'));
    const viewer = fakeViewer();
    const start = vi.fn(async () => viewer);
    const m = startWhenProject({ project: dir, intervalMs: 20, start });
    await sleep(100);
    expect(start).not.toHaveBeenCalled();
    await writeFile(join(dir, 'mirage.json'), '{}');
    await m.started;
    await sleep(100);
    expect(start).toHaveBeenCalledTimes(1);
    await m.stop();
    expect(viewer.close).toHaveBeenCalledTimes(1);
  });

  it('stop() before a project appears starts nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-monitor-'));
    const start = vi.fn(async () => fakeViewer());
    const m = startWhenProject({ project: dir, intervalMs: 20, start });
    await m.stop();
    await writeFile(join(dir, 'mirage.json'), '{}');
    await sleep(100);
    expect(start).not.toHaveBeenCalled();
  });

  it('closes a viewer that was still starting when stop() came', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-monitor-'));
    await writeFile(join(dir, 'mirage.json'), '{}');
    const viewer = fakeViewer();
    const start = vi.fn(async () => {
      await sleep(50);
      return viewer;
    });
    const m = startWhenProject({ project: dir, intervalMs: 20, start });
    await m.stop();
    expect(viewer.close).toHaveBeenCalledTimes(1);
  });
});
