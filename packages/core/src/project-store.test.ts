import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdlSchema } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { createProject, loadEdl, openProject, saveEdl, slugify } from './project-store.js';

const edl = EdlSchema.parse({
  version: 1,
  output: { width: 1920, height: 1080, fps: 30 },
  scenes: [{ id: 's1', src: { in: 0, out: 1 } }],
});

describe('slugify', () => {
  it('makes a safe folder name from a messy title', () => {
    expect(slugify('My Video: "Test" ✨ 2026')).toBe('my-video-test-2026');
    expect(slugify('   ')).toBe('untitled');
    expect(slugify('Ünïcödé')).toBe('unicode');
  });
});

describe('project store', () => {
  it('creates a project folder with project.json and reopens it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'we root with space-'));
    const h = await createProject(root, 'My Video: "Test"');
    expect(h.dir).toBe(join(root, 'my-video-test'));
    expect(h.project.stage).toBe('start');
    expect(h.project.title).toBe('My Video: "Test"');
    const again = await openProject(h.dir);
    expect(again.project.id).toBe(h.project.id);
  });

  it('adds a numeric suffix when the slug already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'we-'));
    await createProject(root, 'Same');
    const second = await createProject(root, 'Same');
    expect(second.dir).toBe(join(root, 'same-2'));
  });

  it('saves the EDL with numbered history snapshots and loads it back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'we-'));
    const h = await createProject(root, 'Hist');
    const a = await saveEdl(h, edl);
    const b = await saveEdl(h, { ...edl, endScreen: { seconds: 5 } });
    expect(a.snapshot.endsWith('edl.0001.json')).toBe(true);
    expect(b.snapshot.endsWith('edl.0002.json')).toBe(true);
    expect((await readdir(join(h.dir, 'history'))).sort()).toEqual(['edl.0001.json', 'edl.0002.json']);
    expect((await loadEdl(h)).endScreen.seconds).toBe(5);
    expect(JSON.parse(await readFile(join(h.dir, 'edl.json'), 'utf8')).version).toBe(1);
  });

  it('refuses to write an invalid EDL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'we-'));
    const h = await createProject(root, 'Bad');
    await expect(saveEdl(h, { ...edl, scenes: [] })).rejects.toThrow();
  });
});
