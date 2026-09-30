import { describe, expect, it } from 'vitest';
import { run } from './run.js';

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
