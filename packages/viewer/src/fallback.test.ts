// SPDX-License-Identifier: MIT
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { otherViewer } from './fallback.js';

const project = async (info?: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'mirage-fallback-'));
  if (info !== undefined) {
    await mkdir(join(dir, '.mirage'));
    await writeFile(join(dir, '.mirage', 'viewer.json'), info);
  }
  return dir;
};

describe('otherViewer', () => {
  it('is true only for a live viewer that is another process', async () => {
    const dir = await project(JSON.stringify({ url: 'http://127.0.0.1:1/?k=x', pid: 42 }));
    expect(otherViewer(dir, 7, () => true)).toBe(true);
    expect(otherViewer(dir, 42, () => true)).toBe(false);
    expect(otherViewer(dir, 7, () => false)).toBe(false);
  });
  it('is false with no viewer.json, or a broken one', async () => {
    expect(otherViewer(await project(), 7, () => true)).toBe(false);
    expect(otherViewer(await project('{'), 7, () => true)).toBe(false);
    expect(otherViewer(await project('{"url":1}'), 7, () => true)).toBe(false);
  });
});
