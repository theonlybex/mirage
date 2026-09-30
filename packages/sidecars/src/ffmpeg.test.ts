import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeProxy, measureLoudness, pickEncoder, runFfmpeg } from './ffmpeg.js';
import { probe } from './ffprobe.js';

describe('pickEncoder', () => {
  it('returns a working encoder for this machine', async () => {
    const enc = await pickEncoder();
    expect(['h264_videotoolbox', 'h264_nvenc', 'libx264']).toContain(enc.name);
    const dir = await mkdtemp(join(tmpdir(), 'we-enc-'));
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=0.5', '-c:v', enc.name, ...enc.extraArgs, '-pix_fmt', 'yuv420p', join(dir, 'x.mp4')]);
    expect((await probe(join(dir, 'x.mp4'))).videoCodec).toBe('h264');
  });
});

describe('runFfmpeg', () => {
  it('reports finite progress in [0,1] ending at exactly 1 when expectedDurationSec is omitted', async () => {
    const seen: number[] = [];
    await runFfmpeg(
      ['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=0.5', '-pix_fmt', 'yuv420p', '-f', 'null', '-'],
      { onProgress: (f) => seen.push(f) },
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((f) => Number.isFinite(f))).toBe(true);
    expect(seen.every((f) => f >= 0 && f <= 1)).toBe(true);
    expect(seen.at(-1)).toBe(1);
  });
});

describe('makeProxy', () => {
  it('writes a 540p proxy and reports progress up to ~1', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-proxy-'));
    const out = join(dir, 'proxy.mp4');
    const seen: number[] = [];
    await makeProxy('fixtures/tone-6s.mp4', out, { onProgress: (f) => seen.push(f) });
    const info = await probe(out);
    expect(info.height).toBe(540);
    expect(info.width).toBe(960);
    expect(info.hasAudio).toBe(true);
    expect(info.durationSec).toBeCloseTo(6, 0);
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(0.9);
    expect(seen.every((f) => f >= 0 && f <= 1)).toBe(true);
  });
});

describe('measureLoudness', () => {
  it('measures a sine tone at a plausible level', async () => {
    const r = await measureLoudness('fixtures/tone-6s.mp4');
    expect(r.integratedLufs).toBeLessThan(0);
    expect(r.integratedLufs).toBeGreaterThan(-70);
    expect(r.truePeakDb).toBeLessThan(3);
  });
});
