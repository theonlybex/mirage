import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MusicLibrarySchema } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonFileError, readJsonFile, writeJsonFile } from './json-file.js';

const Schema = z.object({
  version: z.literal(1),
  scenes: z.array(z.object({ id: z.string(), src: z.object({ in: z.number().min(0), out: z.number().positive() }) })).min(1),
});

const doc = { version: 1 as const, scenes: [{ id: 's1', src: { in: 0, out: 1 } }] };
const badDoc = { ...doc, scenes: [{ id: 's1', src: { in: 0, out: -1 } }] };

describe('writeJsonFile', () => {
  it('writes atomically, leaving no tmp file behind and readable content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'we-'));
    const target = join(root, 'doc.json');
    await writeJsonFile(target, Schema, doc);
    const files = await readdir(root);
    expect(files.some((f) => f.includes('.tmp-'))).toBe(false);
    expect(files).toContain('doc.json');
    expect(JSON.parse(await readFile(target, 'utf8')).version).toBe(1);
  });
});

describe('writeJsonFile errors', () => {
  it('names the file, the field and the problem instead of dumping the raw schema error, and writes nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'we-'));
    const p = join(root, 'doc.json');
    const err = await writeJsonFile(p, Schema, badDoc, 'doc.json').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JsonFileError);
    expect((err as Error).message).toMatch(/^doc\.json: scenes\[0\]\.src\.out: /);
    expect(await readdir(root)).toEqual([]);
  });
});

describe('readJsonFile errors', () => {
  it('names an unknown key and says to remove or rename it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'we-'));
    const p = join(root, 'lib.json');
    // "moood" also leaves "mood" missing: the unknown key is the one that explains it.
    await writeFile(p, JSON.stringify({ version: 1, tracks: [{ file: 'a.mp3', moood: 'x' }] }));
    await expect(readJsonFile(p, MusicLibrarySchema, 'music/library.json')).rejects.toMatchObject({
      message: expect.stringMatching(/^music\/library\.json: tracks\[0\]: unknown key "moood" \(valid keys: file, mood, /),
      hint: 'Remove or rename that key (a misspelled key would be ignored).',
    });
  });

  it('names the file, the field and the problem for a schema error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'we-'));
    const p = join(root, 'doc.json');
    await writeFile(p, JSON.stringify(badDoc));
    const err = await readJsonFile(p, Schema, 'doc.json').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JsonFileError);
    expect(err).toMatchObject({ file: 'doc.json', hint: 'Fix that field and run the command again.' });
    expect((err as Error).message).toMatch(/^doc\.json: scenes\[0\]\.src\.out: /);
  });
  it('names the file for invalid JSON, and keeps ENOENT as it is', async () => {
    const root = await mkdtemp(join(tmpdir(), 'we-'));
    const p = join(root, 'x.json');
    await writeFile(p, '{ "version": 1, ');
    await expect(readJsonFile(p, Schema)).rejects.toMatchObject({ name: 'JsonFileError', file: p, message: expect.stringContaining(`${p}: `) });
    await expect(readJsonFile(join(root, 'nope.json'), Schema)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
