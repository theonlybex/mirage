import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { _resetLocateCache } from './locate.js';
import { run, createLineSplitter } from './run.js';

describe('run', () => {
  it('runs ffmpeg -version and returns stdout', async () => {
    const { stdout } = await run('ffmpeg', ['-version']);
    expect(stdout).toContain('ffmpeg version');
  });

  it('turns a non-zero exit into a SidecarError with stderr', async () => {
    await expect(run('ffmpeg', ['-i', '/no/such/file.mp4', '-f', 'null', '-'])).rejects.toMatchObject({
      name: 'SidecarError',
      code: 'EXIT',
      stderr: expect.stringContaining('No such file'),
    });
  });

  it('times out with code TIMEOUT', async () => {
    await expect(
      run('ffmpeg', ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=60', '-c:v', 'libx264', '-preset', 'veryslow', '-f', 'null', '-'], { timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('streams stdout lines to the callback', async () => {
    const lines: string[] = [];
    await run('ffmpeg', ['-f', 'lavfi', '-i', 'testsrc2=duration=1', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-'], {
      onStdoutLine: (l) => lines.push(l),
    });
    expect(lines.some((l) => l.startsWith('out_time_us='))).toBe(true);
  });
});

describe('run with a binary that cannot start', () => {
  const savedDir = process.env.WORDEDITS_FFMPEG_DIR;
  afterEach(() => {
    if (savedDir === undefined) delete process.env.WORDEDITS_FFMPEG_DIR;
    else process.env.WORDEDITS_FFMPEG_DIR = savedDir;
    _resetLocateCache();
  });

  it.skipIf(process.platform === 'win32')('reports NOT_FOUND with an install hint instead of "exit code undefined"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-badbin-'));
    const bin = join(dir, 'ffmpeg');
    await writeFile(bin, '#!/nonexistent\ngarbage\n');
    await chmod(bin, 0o755);
    process.env.WORDEDITS_FFMPEG_DIR = dir;
    _resetLocateCache();
    await expect(run('ffmpeg', ['-version'])).rejects.toMatchObject({
      name: 'SidecarError',
      code: 'NOT_FOUND',
      message: 'ffmpeg could not be started',
      hint: expect.stringContaining('WORDEDITS_FFMPEG_DIR'),
    });
  });

  it.skipIf(process.platform === 'win32')('reports a process killed by a signal as EXIT, not NOT_FOUND', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-killed-'));
    const bin = join(dir, 'ffmpeg');
    await writeFile(bin, '#!/bin/sh\nkill -9 $$\n');
    await chmod(bin, 0o755);
    process.env.WORDEDITS_FFMPEG_DIR = dir;
    _resetLocateCache();
    await expect(run('ffmpeg', ['-version'])).rejects.toMatchObject({
      name: 'SidecarError',
      code: 'EXIT',
      message: 'ffmpeg was stopped by SIGKILL',
    });
  });
});

describe('createLineSplitter', () => {
  it('emits complete lines as they arrive and flushes a trailing unterminated line', () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((l) => lines.push(l));
    splitter.feed('a\nb');
    splitter.feed('c');
    expect(lines).toEqual(['a']);
    splitter.flush();
    expect(lines).toEqual(['a', 'bc']);
  });

  it('does not emit anything extra on flush when the buffer already ended on a newline', () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((l) => lines.push(l));
    splitter.feed('a\nb\n');
    expect(lines).toEqual(['a', 'b']);
    splitter.flush();
    expect(lines).toEqual(['a', 'b']);
  });
});
