import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '@wordedits/sidecars';
import { realMediaTools, type MediaTools } from '../media-tools.js';
import { decodeMono, detectTempo } from './tempo.js';

const SR = 11025;
function clicks(bpm: number, offset: number, seconds: number): Float32Array {
  const x = new Float32Array(seconds * SR);
  for (let t = offset; t < seconds; t += 60 / bpm) {
    const s0 = Math.round(t * SR);
    for (let j = 0; j < 220 && s0 + j < x.length; j++) x[s0 + j] = Math.sin(j * 0.6) * Math.exp(-j / 40);
  }
  return x;
}

describe('detectTempo', () => {
  it('finds 120 BPM and the first beat', () => {
    const t = detectTempo(clicks(120, 0.25, 30), SR);
    expect(Math.abs(t.bpm - 120)).toBeLessThanOrEqual(1);
    expect(Math.abs(t.beatOffset - 0.25)).toBeLessThanOrEqual(0.02);
    expect(t.confidence).toBeGreaterThan(0);
  });
  it('finds 95 BPM without halving or doubling', () => {
    expect(Math.abs(detectTempo(clicks(95, 0.1, 30), SR).bpm - 95)).toBeLessThanOrEqual(1.5);
  });
  it('finds 140 BPM without halving it', () => {
    expect(Math.abs(detectTempo(clicks(140, 0, 30), SR).bpm - 140)).toBeLessThanOrEqual(1.5);
  });
  it('finds 100 BPM and the first beat over 60 s', () => {
    const t = detectTempo(clicks(100, 0.1, 60), SR);
    expect(Math.abs(t.bpm - 100)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(t.beatOffset - 0.1)).toBeLessThanOrEqual(0.03);
  });
  it('finds 124 BPM and the first beat over 60 s', () => {
    const t = detectTempo(clicks(124, 0.1, 60), SR);
    expect(Math.abs(t.bpm - 124)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(t.beatOffset - 0.1)).toBeLessThanOrEqual(0.03);
  });
  it('folds a 70 BPM pulse up to 140', () => {
    expect(Math.abs(detectTempo(clicks(70, 0, 60), SR).bpm - 140)).toBeLessThanOrEqual(1);
  });
  it('folds a 180 BPM pulse down to 90', () => {
    expect(Math.abs(detectTempo(clicks(180, 0, 60), SR).bpm - 90)).toBeLessThanOrEqual(1);
  });
  it('returns zero confidence for silence', () => {
    expect(detectTempo(new Float32Array(SR * 5), SR).confidence).toBe(0);
  });
  it('resolves 140 BPM to 0.3 BPM and puts the first beat on the true phase', () => {
    const t = detectTempo(clicks(140, 0, 30), SR);
    expect(Math.abs(t.bpm - 140)).toBeLessThanOrEqual(0.3);
    const period = 60 / 140;
    const d = Math.min(t.beatOffset % period, period - (t.beatOffset % period));
    expect(d).toBeLessThanOrEqual(0.03);
  });
  it('resolves a fractional 139.5 BPM', () => {
    expect(Math.abs(detectTempo(clicks(139.5, 0.2, 30), SR).bpm - 139.5)).toBeLessThanOrEqual(0.3);
  });
});

describe('tempo robustness', () => {
  const add = (x: Float32Array, t: number, a: number) => {
    const s0 = Math.round(t * SR);
    for (let j = 0; j < 220 && s0 + j < x.length; j++) x[s0 + j] += a * Math.sin(j * 0.6) * Math.exp(-j / 40);
  };
  it('keeps the beat of a 12/8 shuffle at 120 BPM (does not take the 3:2 triplet peak)', () => {
    const x = new Float32Array(30 * SR);
    const beat = 0.5;
    for (let t = 0.1; t < 30; t += beat) {
      add(x, t, 1);
      add(x, t + beat / 3, 0.7);
      add(x, t + (2 * beat) / 3, 0.7);
    }
    expect(Math.abs(detectTempo(x, SR).bpm - 120)).toBeLessThanOrEqual(1);
  });
  it('gives noise and a sustained pad a confidence below the analyze gate, and clean beats well above it', () => {
    const noise = new Float32Array(30 * SR);
    let seed = 1;
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      noise[i] = (seed / 2 ** 32 - 0.5) * 0.5;
    }
    const pad = new Float32Array(30 * SR);
    for (let i = 0; i < pad.length; i++) pad[i] = 0.3 * Math.sin(i * 0.1) + 0.2 * Math.sin(i * 0.037);
    const beats = new Float32Array(30 * SR);
    for (let t = 0.25; t < 30; t += 0.5) add(beats, t, 1);
    expect(detectTempo(noise, SR).confidence).toBeLessThan(0.1);
    expect(detectTempo(pad, SR).confidence).toBeLessThan(0.1);
    expect(detectTempo(beats, SR).confidence).toBeGreaterThan(0.5);
  });
});

describe('decodeMono', () => {
  it('removes the temp file when ffmpeg fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we decode '));
    const tmpOut = join(dir, '.tmp-x.f32');
    const tools = {
      runFfmpeg: async (args: string[]) => {
        await writeFile(args[args.length - 1], 'partial');
        throw new Error('ffmpeg exploded');
      },
    } as unknown as MediaTools;
    await expect(decodeMono('/x.wav', tmpOut, tools, { sampleRate: 11025 })).rejects.toThrow('ffmpeg exploded');
    await expect(access(tmpOut)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('with clipTime, keeps sample time equal to file time when the audio starts late (as its transcript does)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-late-'));
    const gen = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'v.mp4')]);
    await gen(['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=2', '-c:a', 'aac', join(dir, 'tone.m4a')]);
    await gen(['-i', join(dir, 'v.mp4'), '-itsoffset', '1', '-i', join(dir, 'tone.m4a'), '-map', '0:v', '-map', '1:a', '-c', 'copy', join(dir, 'late.mp4')]);
    const x = await decodeMono(join(dir, 'late.mp4'), join(dir, 'x.f32'), await realMediaTools(), { sampleRate: 1000, clipTime: true });
    const peak = (a: number, b: number) => x.slice(a, b).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak(0, 900)).toBeLessThan(1e-4);
    expect(peak(1100, 2900)).toBeGreaterThan(0.1);
  });
});
