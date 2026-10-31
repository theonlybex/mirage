import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { describeError, MirageError } from './errors.js';
import { resolveUserPath } from './project.js';

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
