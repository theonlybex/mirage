import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractWav, makeProxy, measureLoudness, pickEncoder, runFfmpeg } from './ffmpeg.js';
import { run } from './run.js';
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

  it('measures only the first maxSec seconds when asked', async () => {
    const f = join(await mkdtemp(join(tmpdir(), 'we-loud-')), 'late-tone.m4a');
    // Silence for 2 s, then a tone.
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "aevalsrc='if(gte(t,2),0.3*sin(2*PI*300*t),0)':s=48000:d=4", '-c:a', 'aac', f]);
    expect((await measureLoudness(f)).integratedLufs).toBeGreaterThan(-30);
    expect((await measureLoudness(f, { maxSec: 1.5 })).integratedLufs).toBeLessThan(-60);
  });
});

describe('extractWav', () => {
  it('keeps WAV time equal to clip time when the audio stream starts after the video', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-wav-'));
    const gen = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'v.mp4')]);
    await gen(['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=3', '-c:a', 'aac', join(dir, 'tone.m4a')]);
    await gen(['-i', join(dir, 'v.mp4'), '-itsoffset', '1.5', '-i', join(dir, 'tone.m4a'), '-map', '0:v', '-map', '1:a', '-c', 'copy', join(dir, 'late.mp4')]);
    await extractWav(join(dir, 'late.mp4'), join(dir, 'late.wav'));
    const rms = async (ss: number, t: number) => {
      const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(ss), '-t', String(t), '-i', join(dir, 'late.wav'), '-af', 'astats=metadata=0', '-f', 'null', '-']);
      const m = /Overall[\s\S]*?RMS level dB:\s+(-?[\d.]+|-inf)/.exec(stderr);
      return m && m[1] !== '-inf' ? Number(m[1]) : -Infinity;
    };
    expect(await rms(0, 1.4)).toBeLessThan(-80);
    expect(await rms(1.6, 2.5)).toBeGreaterThan(-30);
    expect((await probe(join(dir, 'late.wav'))).durationSec).toBeCloseTo(4.5, 1);
  });
});
