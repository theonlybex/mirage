import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { locate, _resetLocateCache } from './locate.js';
import { SidecarError } from './errors.js';

afterEach(() => {
  delete process.env.WORDEDITS_FFMPEG_DIR;
  _resetLocateCache();
});

describe('locate', () => {
  it('finds ffmpeg and ffprobe as existing files', async () => {
    await expect(access(await locate('ffmpeg'))).resolves.toBeUndefined();
    await expect(access(await locate('ffprobe'))).resolves.toBeUndefined();
  });

  it('prefers WORDEDITS_FFMPEG_DIR when the binary exists there', async () => {
    const real = await locate('ffmpeg');
    _resetLocateCache();
    process.env.WORDEDITS_FFMPEG_DIR = dirname(real);
    expect(await locate('ffmpeg')).toBe(real);
  });

  it('throws a SidecarError with an install hint when the override dir is wrong', async () => {
    process.env.WORDEDITS_FFMPEG_DIR = '/definitely/not/here';
    await expect(locate('ffmpeg')).rejects.toMatchObject({
      name: 'SidecarError',
      code: 'NOT_FOUND',
      hint: expect.stringContaining('WORDEDITS_FFMPEG_DIR'),
    });
  });
});
