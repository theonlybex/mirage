// SPDX-License-Identifier: MIT
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '@wordedits/sidecars';
import { beforeAll, describe, expect, it } from 'vitest';
import { realMediaTools, type MediaTools } from '../media-tools.js';
import { BUILTIN_SFX, builtinSfx, measureSfxLevel, resolveSfx, sfxDir, sfxSource, SFX_RECIPE_VERSION, sfxVolumeDb } from './sfx.js';

const SR = 48000;
/** The plan's names, lengths and peak times, copied here so the test checks the module against the spec, not itself. */
const SPEC: Record<string, { len: number; peak: number }> = {
  whoosh: { len: 0.6, peak: 0.3 },
  'swoosh-out': { len: 0.5, peak: 0.06 },
  hit: { len: 0.8, peak: 0.01 },
  riser: { len: 2.0, peak: 2.0 },
  pop: { len: 0.12, peak: 0.005 },
  ding: { len: 1.5, peak: 0.005 },
  click: { len: 0.03, peak: 0.002 },
};

/** Both channels of a WAV as 48 kHz float samples. */
async function decodeStereo(file: string, tmp: string): Promise<{ left: Float32Array; right: Float32Array }> {
  const out = join(tmp, `decode-${Math.random().toString(36).slice(2)}.f32`);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-ac', '2', '-ar', String(SR), '-f', 'f32le', out]);
  const buf = await readFile(out);
  await rm(out, { force: true });
  const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const left = new Float32Array(all.length / 2);
  const right = new Float32Array(all.length / 2);
  for (let i = 0; i < left.length; i++) {
    left[i] = all[2 * i]!;
    right[i] = all[2 * i + 1]!;
  }
  return { left, right };
}

/** Energy below 40 Hz, from 40 Hz to 12 kHz and above 12 kHz, from the exact spectrum of the whole sound (zero-padded FFT). */
function bandEnergies(x: Float32Array): { low: number; mid: number; high: number } {
  let n = 1;
  while (n < x.length) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(x);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(step * k);
        const wi = Math.sin(step * k);
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
  const e = { low: 0, mid: 0, high: 0 };
  for (let k = 0; k <= n / 2; k++) {
    const f = (k * SR) / n;
    const p = re[k]! ** 2 + im[k]! ** 2;
    if (f < 40) e.low += p;
    else if (f <= 12000) e.mid += p;
    else e.high += p;
  }
  return e;
}

const db = (ratio: number) => 10 * Math.log10(ratio);

describe('sfxDir', () => {
  it('uses MIRAGE_SFX_DIR, else <plugin data>/sfx, else ~/.cache/mirage/sfx', () => {
    expect(sfxDir({ MIRAGE_SFX_DIR: '/x/sfx', MIRAGE_PLUGIN_DATA: '/data' })).toBe('/x/sfx');
    expect(sfxDir({ MIRAGE_PLUGIN_DATA: '/data' })).toBe(join('/data', 'sfx'));
    expect(sfxDir({})).toBe(join(homedir(), '.cache', 'mirage', 'sfx'));
  });
});

describe('BUILTIN_SFX', () => {
  it('names the seven built-ins in the plan order, recipe version 1', () => {
    expect(BUILTIN_SFX).toEqual(['whoosh', 'swoosh-out', 'hit', 'riser', 'pop', 'ding', 'click']);
    expect(SFX_RECIPE_VERSION).toBe(1);
  });
});

describe('builtinSfx (real ffmpeg)', () => {
  let tools: MediaTools;
  let dir: string;
  beforeAll(async () => {
    tools = await realMediaTools();
    dir = await mkdtemp(join(tmpdir(), "we sfx 'q' ✨ "));
  });

  it.each(BUILTIN_SFX.map((n) => [n]))('makes %s to the spec', async (name) => {
    const spec = SPEC[name]!;
    const r = await builtinSfx(name, tools, { dir });
    expect(r.file).toBe(join(dir, 'v1', `${name}.wav`));
    expect(r.peakSec).toBeCloseTo(spec.peak, 6);

    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', r.file]);
    const st = JSON.parse(stdout).streams[0];
    expect(st).toMatchObject({ codec_name: 'pcm_s16le', sample_rate: '48000', channels: 2 });

    const { left, right } = await decodeStereo(r.file, dir);
    expect(right).toEqual(left);
    const x = left;
    // Length within 5%, and the length returned is the file's.
    expect(Math.abs(x.length / SR - spec.len) / spec.len).toBeLessThanOrEqual(0.05);
    expect(r.durationSec).toBeCloseTo(x.length / SR, 6);
    // Peak at or below -1 dBFS, within 10 ms of the peak time.
    let peak = 0;
    let at = 0;
    let sum = 0;
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]!);
      sum += x[i]!;
      if (a > peak) [peak, at] = [a, i];
    }
    expect(20 * Math.log10(peak)).toBeLessThanOrEqual(-1);
    expect(peak).toBeGreaterThan(0.5);
    expect(Math.abs(at / SR - spec.peak)).toBeLessThanOrEqual(0.01);
    // No DC offset.
    expect(Math.abs(sum / x.length)).toBeLessThan(0.001);
    // Fades: the first and last millisecond stay 40 dB under the peak.
    const ms = SR / 1000;
    const edge = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(edge(x.subarray(0, ms))).toBeLessThanOrEqual(peak / 100);
    expect(edge(x.subarray(x.length - ms))).toBeLessThanOrEqual(peak / 100);
    // Below 40 Hz and above 12 kHz at least 24 dB under the band in between.
    const e = bandEnergies(x);
    expect(db(e.mid / e.low)).toBeGreaterThanOrEqual(24);
    expect(db(e.mid / e.high)).toBeGreaterThanOrEqual(24);
  });

  it('returns the cached file without making it again', async () => {
    const d = await mkdtemp(join(tmpdir(), 'we-sfx-cache-'));
    const first = await builtinSfx('pop', tools, { dir: d });
    const before = (await stat(first.file)).mtimeMs;
    await new Promise((res) => setTimeout(res, 50));
    const second = await builtinSfx('pop', tools, { dir: d });
    expect(second).toEqual(first);
    expect((await stat(second.file)).mtimeMs).toBe(before);
  });

  it('two calls at once for the same sound both succeed and leave one complete file', async () => {
    const d = await mkdtemp(join(tmpdir(), 'we-sfx-race-'));
    const [a, b] = await Promise.all([builtinSfx('ding', tools, { dir: d }), builtinSfx('ding', tools, { dir: d })]);
    expect(a.file).toBe(b.file);
    expect(await readdir(join(d, 'v1'))).toEqual(['ding.wav']);
    const { left } = await decodeStereo(a.file, d);
    expect(left.length / SR).toBeCloseTo(1.5, 2);
  });

  it('leaves no file behind when it is cancelled', async () => {
    const d = await mkdtemp(join(tmpdir(), 'we-sfx-abort-'));
    const ac = new AbortController();
    ac.abort();
    await expect(builtinSfx('riser', tools, { dir: d, signal: ac.signal })).rejects.toThrow();
    expect(await readdir(join(d, 'v1')).catch(() => [])).toEqual([]);
  });

  it('refuses a name that is not a built-in', async () => {
    await expect(builtinSfx('airhorn', tools, { dir })).rejects.toThrow(/airhorn/);
  });
});

describe('sfxSource', () => {
  let project: string;
  beforeAll(async () => {
    project = await mkdtemp(join(tmpdir(), 'we-sfx-src-'));
    await mkdir(join(project, 'sfx', 'more'), { recursive: true });
    for (const f of ['pop.mp3', 'airhorn.wav', 'more/boing.flac', 'notes.txt']) await writeFile(join(project, 'sfx', f), '');
    await mkdir(join(project, 'music'));
    await writeFile(join(project, 'music', 'x.wav'), '');
  });
  const notFound = (sound: string, k = 1) => ({
    name: 'MirageError', code: 'BAD_INPUT',
    message: `sfx ${k}: "${sound}" isn't a built-in sound or a file in sfx/`,
    hint: 'Built-in sounds: whoosh, swoosh-out, hit, riser, pop, ding, click. Or put the file in the project\'s sfx folder.',
  });
  it("takes the person's sfx/<name> file over the built-in of that name, else the built-in", () => {
    expect(sfxSource(project, 'pop', 'sfx 1')).toEqual({ file: join(project, 'sfx', 'pop.mp3'), path: 'sfx/pop.mp3' });
    expect(sfxSource(project, 'hit', 'sfx 1')).toEqual({ builtin: 'hit' });
    expect(sfxSource(project, 'airhorn', 'sfx 1')).toEqual({ file: join(project, 'sfx', 'airhorn.wav'), path: 'sfx/airhorn.wav' });
  });
  it('takes a path inside sfx/ as that file', () => {
    expect(sfxSource(project, 'sfx/airhorn.wav', 'sfx 1')).toEqual({ file: join(project, 'sfx', 'airhorn.wav'), path: 'sfx/airhorn.wav' });
    expect(sfxSource(project, 'sfx/more/boing.flac', 'sfx 1')).toEqual({ file: join(project, 'sfx', 'more', 'boing.flac'), path: 'sfx/more/boing.flac' });
    // A file in sfx/ of another kind is found here; whether FFmpeg can read it is checked when it is used.
    expect(sfxSource(project, 'sfx/notes.txt', 'sfx 1')).toEqual({ file: join(project, 'sfx', 'notes.txt'), path: 'sfx/notes.txt' });
  });
  it('refuses an unknown name, a missing file, and any path outside sfx/', () => {
    for (const sound of ['airhorn2', 'sfx/gone.wav', 'sfx/../music/x.wav', '../sfx/pop.mp3', 'music/x.wav', join(project, 'sfx', 'airhorn.wav'), 'sfx/more', 'sfx/', 'Hit']) {
      expect(() => sfxSource(project, sound, 'sfx 3')).toThrow(expect.objectContaining(notFound(sound, 3)));
    }
  });
});

describe('sfxVolumeDb', () => {
  it("sets the loudest 400 ms on the target, never raising the peak past -1 dBFS; a silent sound isn't changed", () => {
    expect(sfxVolumeDb({ momentaryMaxLufs: -12, peakDb: -1.5 }, -20)).toBeCloseTo(-8, 6);
    expect(sfxVolumeDb({ momentaryMaxLufs: -30, peakDb: -6 }, -20)).toBeCloseTo(5, 6);
    expect(sfxVolumeDb({ momentaryMaxLufs: -40, peakDb: -10 }, -20)).toBeCloseTo(9, 6);
    expect(sfxVolumeDb({ momentaryMaxLufs: -Infinity, peakDb: -Infinity }, -20)).toBe(0);
    expect(sfxVolumeDb({ momentaryMaxLufs: -120.7, peakDb: -Infinity }, -20)).toBe(0);
    expect(sfxVolumeDb({ momentaryMaxLufs: -80, peakDb: -70 }, -20)).toBe(0);
  });
});

describe('resolveSfx and measureSfxLevel (real ffmpeg)', () => {
  let tools: MediaTools;
  let project: string;
  let cache: string;
  const gen = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  beforeAll(async () => {
    tools = await realMediaTools();
    project = await mkdtemp(join(tmpdir(), "we sfx 'q' "));
    cache = await mkdtemp(join(tmpdir(), 'we-sfx-res-'));
    await mkdir(join(project, 'sfx'));
    // A click at 0.25 s in a 1 s mono file; a silent second; a minute of tone; bytes that aren't audio.
    await gen(['-f', 'lavfi', '-i', "aevalsrc='0.5*between(t,0.25,0.2502)':s=44100:d=1", join(project, 'sfx', 'tick.wav')]);
    await gen(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '1', join(project, 'sfx', 'hush.wav')]);
    await gen(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=60', '-c:a', 'libmp3lame', join(project, 'sfx', 'long.mp3')]);
    await writeFile(join(project, 'sfx', 'broken.wav'), 'RIFF but not really a wave file');
  });
  it('makes a built-in in the data folder and gives its peak and length', async () => {
    const r = await resolveSfx(project, 'riser', tools, { dir: cache });
    expect(r).toEqual({ file: join(cache, 'v1', 'riser.wav'), peakSec: 2, durationSec: 2.02 });
  });
  it("gives a person's file its loudest sample as the peak, and its length", async () => {
    const r = await resolveSfx(project, 'tick', tools, { dir: cache });
    expect(r.file).toBe(join(project, 'sfx', 'tick.wav'));
    expect(Math.abs(r.peakSec - 0.25)).toBeLessThan(0.002);
    expect(r.durationSec).toBeCloseTo(1, 2);
    const hush = await resolveSfx(project, 'sfx/hush.wav', tools, { dir: cache });
    expect(hush).toMatchObject({ peakSec: 0 });
    expect(hush.durationSec).toBeCloseTo(1, 2);
  });
  it("says FFmpeg is missing, not that the file can't be read, when FFmpeg isn't there", async () => {
    const missing = Object.assign(new Error('ffmpeg was not found'), { code: 'NOT_FOUND' });
    const noFfmpeg = { ...tools, runFfmpeg: async () => { throw missing; } };
    await expect(resolveSfx(project, 'tick', noFfmpeg, { dir: cache })).rejects.toBe(missing);
  });
  it("refuses a file FFmpeg can't read", async () => {
    await expect(resolveSfx(project, 'broken', tools, { dir: cache, label: 'sfx 2' })).rejects.toMatchObject({
      name: 'MirageError', code: 'BAD_INPUT', message: "sfx 2: sfx/broken.wav isn't audio Mirage can read", hint: 'Use a WAV, MP3, M4A, AIFF, FLAC or OGG file.',
    });
  });
  it('measures the loudest 400 ms and the peak of the stereo sound as the episode plays it', async () => {
    const work = await mkdtemp(join(tmpdir(), "we sfx work 'q' "));
    const hit = await measureSfxLevel((await builtinSfx('hit', tools, { dir: cache })).file, tools, { metaFile: join(work, 'level-0.txt') });
    expect(hit.peakDb).toBeCloseTo(-1.5, 1);
    expect(hit.momentaryMaxLufs).toBeGreaterThan(-16);
    expect(hit.momentaryMaxLufs).toBeLessThan(-8);
    // A 30 ms click is measured over 400 ms of silence after it, not skipped.
    const click = await measureSfxLevel((await builtinSfx('click', tools, { dir: cache })).file, tools, { metaFile: join(work, 'level-1.txt') });
    expect(click.momentaryMaxLufs).toBeGreaterThan(-45);
    expect(click.momentaryMaxLufs).toBeLessThan(-20);
    const hush = await measureSfxLevel(join(project, 'sfx', 'hush.wav'), tools, { metaFile: join(work, 'level-2.txt') });
    expect(hush.peakDb).toBe(-Infinity);
    expect(sfxVolumeDb(hush, -20)).toBe(0);
    // A steady mono tone at -18 dBFS, played in stereo (-3 dB a side): its momentary loudness is its loudness.
    const long = await measureSfxLevel(join(project, 'sfx', 'long.mp3'), tools, { metaFile: join(work, 'level-3.txt') });
    expect(long.peakDb).toBeGreaterThan(-22);
    expect(long.peakDb).toBeLessThan(-20);
    expect(long.momentaryMaxLufs).toBeGreaterThan(long.peakDb - 6);
    expect(await readdir(work)).toEqual([]);
  });
});
