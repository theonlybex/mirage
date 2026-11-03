import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { describeError, MirageError } from './errors.js';
import { initProject, readProject, resolveUserPath } from './project.js';

const errno = (code: string, syscall: string, path: string) => Object.assign(new Error(`${code}: ${syscall} '${path}'`), { code, syscall, path });

describe('describeError', () => {
  it('turns a stray schema error into one readable line, never the raw issue list', () => {
    const e = z.object({ items: z.array(z.object({ end: z.number() })) }).safeParse({ items: [{ end: 'x' }] }).error!;
    expect(describeError(e)).toEqual({ message: 'items[0].end: Invalid input: expected number, received string', hint: 'This is a bug in Mirage; the file was not changed.' });
  });

  it('says which folder cannot be written or read', () => {
    expect(describeError(errno('EACCES', 'open', '/p/episodes/1/episode.json.tmp-1')).message).toBe("can't write in /p/episodes/1: permission denied");
    expect(describeError(errno('EACCES', 'mkdir', '/p/episodes/1/.work-1')).message).toBe("can't write in /p/episodes/1: permission denied");
    expect(describeError(errno('EROFS', 'open', '/Volumes/ro/x')).message).toBe("can't write in /Volumes/ro: the disk is read-only");
    expect(describeError(errno('EACCES', 'scandir', '/clips')).message).toBe("can't read /clips: permission denied");
  });

  it('says which file cannot be read when opening an existing file fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-perm-'));
    const file = join(dir, 'catalog.json');
    await writeFile(file, '{}');
    await chmod(file, 0o000);
    try {
      const e = await readFile(file, 'utf8').catch((x: unknown) => x);
      expect(describeError(e)).toMatchObject({ message: `can't read ${file}: permission denied`, hint: expect.stringContaining('readable') });
    } finally {
      await chmod(file, 0o644);
    }
  });

  it('keeps the message and hint of errors that have one', () => {
    expect(describeError(new MirageError('BAD_ITEM', 'nope', 'do this'))).toEqual({ message: 'nope', hint: 'do this' });
  });
});

describe('resolveUserPath', () => {
  it('expands ~/ and resolves relative paths against the folder the command was typed in', () => {
    expect(resolveUserPath('~/Mirage/x', '/repo', '/Users/me')).toBe('/Users/me/Mirage/x');
    expect(resolveUserPath('~', '/repo', '/Users/me')).toBe('/Users/me');
    expect(resolveUserPath('proj', '/Users/me/Desktop', '/Users/me')).toBe('/Users/me/Desktop/proj');
    expect(resolveUserPath('/abs/p', '/repo', '/Users/me')).toBe('/abs/p');
    expect(resolveUserPath('~other/x', '/repo', '/Users/me')).toBe('/repo/~other/x');
  });
});

describe('readProject', () => {
  it('reads what init wrote, null when there is no project, and names a broken file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-proj-'));
    expect(await readProject(dir)).toBeNull();
    await initProject(dir, 'My build');
    expect(await readProject(dir)).toMatchObject({ version: 1, title: 'My build' });
    await writeFile(join(dir, 'mirage.json'), JSON.stringify({ version: 1, title: 3 }));
    await expect(readProject(dir)).rejects.toThrow(/mirage\.json/);
  });
});
