import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSetupState } from '@wordedits/shared/setup-state';
import { captionsHint, ffmpegCaptions, locate, _resetLocateCache, _setCaptionsCheck } from './locate.js';
import { SidecarError } from './errors.js';

const saved = { path: process.env.PATH, dir: process.env.WORDEDITS_FFMPEG_DIR, data: process.env.MIRAGE_PLUGIN_DATA };
const roots: string[] = [];

afterEach(async () => {
  process.env.PATH = saved.path;
  for (const [k, v] of [['WORDEDITS_FFMPEG_DIR', saved.dir], ['MIRAGE_PLUGIN_DATA', saved.data]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _setCaptionsCheck({});
  _resetLocateCache();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
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

describe('captionsHint', () => {
  it('names the install for each platform', () => {
    expect(captionsHint('darwin')).toBe("Install Homebrew's complete build: brew install ffmpeg-full (Mirage finds it by itself).");
    expect(captionsHint('win32')).toBe('Install the full build: winget install --id Gyan.FFmpeg -e.');
    expect(captionsHint('linux')).toBe("Install an FFmpeg built with libass (your distribution's ffmpeg package usually is), or set WORDEDITS_FFMPEG_DIR to one.");
  });
});

const sh = describe.skipIf(process.platform === 'win32');

sh('ffmpegCaptions', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'we-captions-'));
    roots.push(root);
    delete process.env.WORDEDITS_FFMPEG_DIR;
    delete process.env.MIRAGE_PLUGIN_DATA;
    _resetLocateCache();
  });

  /** A folder holding a fake ffmpeg (and ffprobe). `body` is the shell that answers `-filters`; every run is counted in `<dir>/runs`. */
  async function fake(name: string, body: string, probe = true): Promise<string> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'ffmpeg'), `#!/bin/sh\necho run >> "${dir}/runs"\n${body}\n`);
    await chmod(join(dir, 'ffmpeg'), 0o755);
    if (probe) {
      await writeFile(join(dir, 'ffprobe'), '#!/bin/sh\nexit 0\n');
      await chmod(join(dir, 'ffprobe'), 0o755);
    }
    return dir;
  }
  const withAss = 'echo " T.. ass               V->V       Render ASS subtitles onto input video using the libass library."\necho " ... scale             V->V       Scale the input video."';
  const withoutAss = 'echo " ... scale             V->V       Scale the input video."\necho " ... subtitles_x       V->V       Not it."';
  const runs = async (dir: string) => (await readFile(join(dir, 'runs'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

  it('takes the keg FFmpeg when the one on PATH has no libass', async () => {
    const plain = await fake('plain', withoutAss);
    const keg = await fake('keg', withAss);
    process.env.PATH = plain;
    _setCaptionsCheck({ kegDirs: [keg] });
    expect(await ffmpegCaptions()).toEqual({ ok: true, path: join(keg, 'ffmpeg') });
    expect(await locate('ffmpeg')).toBe(join(keg, 'ffmpeg'));
  });

  it('keeps the PATH FFmpeg when it can draw captions, without asking the keg', async () => {
    const good = await fake('good', withAss);
    const keg = await fake('keg', withAss);
    process.env.PATH = good;
    _setCaptionsCheck({ kegDirs: [keg] });
    expect(await ffmpegCaptions()).toEqual({ ok: true, path: join(good, 'ffmpeg') });
    expect(await runs(keg)).toBe(0);
  });

  it('reports the first FFmpeg found, with a hint, when none can draw captions', async () => {
    const plain = await fake('plain', withoutAss);
    const keg = await fake('keg', withoutAss);
    process.env.PATH = plain;
    _setCaptionsCheck({ kegDirs: [keg] });
    expect(await ffmpegCaptions()).toEqual({ ok: false, path: join(plain, 'ffmpeg'), hint: captionsHint() });
    expect(await locate('ffmpeg')).toBe(join(plain, 'ffmpeg'));
  });

  it('looks only in WORDEDITS_FFMPEG_DIR when set: a build without libass there is reported, the keg ignored', async () => {
    const mine = await fake('mine', withoutAss);
    const keg = await fake('keg', withAss);
    const onPath = await fake('onpath', withAss);
    process.env.WORDEDITS_FFMPEG_DIR = mine;
    process.env.PATH = onPath;
    _setCaptionsCheck({ kegDirs: [keg] });
    expect(await ffmpegCaptions()).toEqual({ ok: false, path: join(mine, 'ffmpeg'), hint: captionsHint() });
    expect(await runs(keg)).toBe(0);
    expect(await runs(onPath)).toBe(0);
  });

  it('counts an FFmpeg that hangs on -filters as unable to draw captions, within the timeout', async () => {
    const hang = await fake('hang', 'exec /bin/sleep 20');
    process.env.PATH = hang;
    _setCaptionsCheck({ timeoutMs: 300 });
    const t0 = Date.now();
    expect(await ffmpegCaptions()).toMatchObject({ ok: false, path: join(hang, 'ffmpeg') });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('counts an FFmpeg that exits 1 as unable to draw captions, and moves on to the keg', async () => {
    const broken = await fake('broken', 'exit 1');
    const keg = await fake('keg', withAss);
    process.env.PATH = broken;
    _setCaptionsCheck({ kegDirs: [keg] });
    expect(await ffmpegCaptions()).toEqual({ ok: true, path: join(keg, 'ffmpeg') });
  });

  it('asks each FFmpeg file once per process, and again when its mtime changes', async () => {
    const dir = await fake('one', withoutAss);
    process.env.PATH = dir;
    await ffmpegCaptions();
    await ffmpegCaptions();
    await locate('ffmpeg');
    expect(await runs(dir)).toBe(1);
    await writeFile(join(dir, 'ffmpeg'), `#!/bin/sh\necho run >> "${dir}/runs"\n${withAss}\n`);
    const later = new Date(Date.now() + 5000);
    const { utimes } = await import('node:fs/promises');
    await utimes(join(dir, 'ffmpeg'), later, later);
    expect(await ffmpegCaptions()).toEqual({ ok: true, path: join(dir, 'ffmpeg') });
    expect(await runs(dir)).toBe(2);
  });

  it('finds an ffmpeg-full installed while the engine runs', async () => {
    const plain = await fake('plain', withoutAss);
    const kegDir = join(root, 'keg-later');
    process.env.PATH = plain;
    _setCaptionsCheck({ kegDirs: [kegDir] });
    expect(await ffmpegCaptions()).toMatchObject({ ok: false });
    expect(await locate('ffmpeg')).toBe(join(plain, 'ffmpeg'));
    await fake('keg-later', withAss);
    expect(await ffmpegCaptions()).toEqual({ ok: true, path: join(kegDir, 'ffmpeg') });
    expect(await locate('ffmpeg')).toBe(join(kegDir, 'ffmpeg'));
  });

  it('takes ffprobe from the folder of the chosen ffmpeg, falling back to the usual lookup', async () => {
    const plain = await fake('plain', withoutAss);
    const keg = await fake('keg', withAss);
    process.env.PATH = plain;
    _setCaptionsCheck({ kegDirs: [keg] });
    expect(await locate('ffprobe')).toBe(join(keg, 'ffprobe'));
    const bare = await fake('bare', withAss, false);
    process.env.PATH = `${bare}:${plain}`;
    _setCaptionsCheck({ kegDirs: [] });
    _resetLocateCache();
    expect(await locate('ffmpeg')).toBe(join(bare, 'ffmpeg'));
    expect(await locate('ffprobe')).toBe(join(plain, 'ffprobe'));
  });

  it('throws NOT_FOUND when there is no FFmpeg to ask', async () => {
    process.env.PATH = join(root, 'empty');
    _setCaptionsCheck({ kegDirs: [], noStatic: true });
    await expect(ffmpegCaptions()).rejects.toBeInstanceOf(SidecarError);
  });

  it('records the check in setup.json when the plugin data folder is set', async () => {
    const dir = await fake('one', withAss);
    process.env.PATH = dir;
    process.env.MIRAGE_PLUGIN_DATA = join(root, 'data');
    await ffmpegCaptions();
    const rec = readSetupState(join(root, 'data')).ffmpeg;
    expect(rec).toMatchObject({ path: join(dir, 'ffmpeg'), captions: true });
    expect(typeof rec?.mtimeMs).toBe('number');
  });
});
