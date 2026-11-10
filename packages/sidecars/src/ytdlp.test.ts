import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { locateYtDlp, runYtDlp, ytDlpInstallHint } from './ytdlp.js';

const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';

afterEach(() => {
  vi.unstubAllEnvs();
});

async function fakeInstall(script = '#!/bin/sh\necho "$@"\n'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mirage-ytdlp-'));
  await writeFile(join(dir, exe), script);
  await chmod(join(dir, exe), 0o755);
  return dir;
}

describe('locateYtDlp', () => {
  it('uses WORDEDITS_YTDLP_DIR, and only that folder when it is set', async () => {
    const dir = await fakeInstall();
    vi.stubEnv('WORDEDITS_YTDLP_DIR', dir);
    expect(await locateYtDlp()).toBe(join(dir, exe));
    vi.stubEnv('WORDEDITS_YTDLP_DIR', join(dir, 'empty'));
    await expect(locateYtDlp()).rejects.toMatchObject({
      code: 'NOT_FOUND', message: `yt-dlp not found in WORDEDITS_YTDLP_DIR (${join(dir, 'empty')})`, hint: `Put ${exe} in that folder or unset WORDEDITS_YTDLP_DIR.`,
    });
  });

  it('finds yt-dlp on PATH', async () => {
    const dir = await fakeInstall();
    vi.stubEnv('WORDEDITS_YTDLP_DIR', '');
    vi.stubEnv('PATH', dir);
    expect(await locateYtDlp()).toBe(join(dir, exe));
  });

  it('the install hint names both platforms and the override', () => {
    expect(ytDlpInstallHint()).toBe(`Install yt-dlp (macOS: brew install yt-dlp; Windows: winget install yt-dlp) or set WORDEDITS_YTDLP_DIR to a folder containing ${exe}.`);
  });
});

describe.skipIf(process.platform === 'win32')('runYtDlp', () => {
  it('passes the arguments as they are, without a shell', async () => {
    vi.stubEnv('WORDEDITS_YTDLP_DIR', await fakeInstall());
    const { stdout } = await runYtDlp(['--print', '%(id)s|%(title)s', 'a b; c']);
    expect(stdout.trim()).toBe('--print %(id)s|%(title)s a b; c');
  });
});
