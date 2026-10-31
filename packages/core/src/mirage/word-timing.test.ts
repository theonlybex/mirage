import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Word } from '@wordedits/shared';
import { extractWav, run } from '@wordedits/sidecars';
import { describe, expect, it } from 'vitest';
import { readWavMono, refineTranscript, refineWordTimes } from './word-timing.js';

const RATE = 16000;
/** Audio with a 300 Hz tone (amplitude 0.3) over each [start, end) and near-silence (amplitude 1e-4 noise) elsewhere. */
function audio(durationSec: number, tones: [number, number][], floor = 1e-4): Float32Array {
  const out = new Float32Array(Math.round(durationSec * RATE));
  let seed = 1;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 16807) % 2147483647;
    out[i] = floor * (seed / 2147483647 - 0.5) * 2;
  }
  for (const [a, b] of tones) for (let i = Math.round(a * RATE); i < Math.round(b * RATE); i++) out[i] += 0.3 * Math.sin((2 * Math.PI * 300 * i) / RATE);
  return out;
}
const w = (word: string, start: number, end: number): Word => ({ w: word, start, end, conf: 1 });

describe('refineWordTimes', () => {
  it('moves a word\'s start past the silence credited to it', () => {
    const pcm = audio(6, [[0.2, 0.6], [2.1, 2.5]]);
    const out = refineWordTimes([w('Last', 0.2, 0.6), w('week.', 1.0, 2.5)], pcm, RATE);
    expect(out[0]).toEqual(w('Last', 0.2, 0.6));
    expect(out[1].start).toBeCloseTo(2.1, 1);
    expect(out[1].end).toBeCloseTo(2.5, 1);
  });

  it('extends a word\'s end to where its sound stops, but never into the next word or more than a second', () => {
    const pcm = audio(8, [[0.5, 1.5], [1.6, 2.0], [3.0, 5.0]]);
    const out = refineWordTimes([w('one', 0.5, 1.0), w('two', 1.6, 2.0), w('three', 3.0, 3.2)], pcm, RATE);
    expect(out[0].end).toBeCloseTo(1.5, 1);
    expect(out[1].end).toBeCloseTo(2.0, 1);
    expect(out[2].end).toBeCloseTo(3.2, 1); // the sound runs on for 1.8 s: no clear end, left alone
  });

  it('stops at the next word\'s start when the sound runs into it', () => {
    const pcm = audio(4, [[0.5, 2.0]]);
    const out = refineWordTimes([w('run', 0.5, 0.9), w('on', 1.2, 2.0)], pcm, RATE);
    expect(out[0].end).toBeLessThanOrEqual(1.2);
    expect(out[0].end).toBeGreaterThan(1.1);
  });

  it('leaves timings alone when the audio has no quiet parts to tell speech from', () => {
    const pcm = audio(4, [[0, 4]], 0.2);
    const words = [w('all', 0.5, 0.9), w('noise', 1.5, 1.8)];
    expect(refineWordTimes(words, pcm, RATE)).toEqual(words);
  });

  it('leaves a word with no sound inside it as it is', () => {
    const pcm = audio(4, [[0.2, 0.6]]);
    expect(refineWordTimes([w('a', 0.2, 0.6), w('ghost', 2, 2.5)], pcm, RATE)[1]).toEqual(w('ghost', 2, 2.5));
  });
});

describe('refineWordTimes in noisy audio', () => {
  it('keeps a soft opening that is quieter than the speech but clearly above the noise floor', () => {
    const pcm = audio(6, [[3, 4]], 0.01); // noise floor about -45 dB; a loud word at 3–4 s sets the speech level
    // "and": 0.3 s of soft sound (about -33 dB) before its loud part.
    for (let i = Math.round(1.0 * RATE); i < Math.round(1.3 * RATE); i++) pcm[i] += 0.03 * Math.sin((2 * Math.PI * 300 * i) / RATE);
    for (let i = Math.round(1.3 * RATE); i < Math.round(1.6 * RATE); i++) pcm[i] += 0.3 * Math.sin((2 * Math.PI * 300 * i) / RATE);
    const out = refineWordTimes([w('and', 0.5, 1.6), w('then', 3, 4)], pcm, RATE);
    expect(out[0].start).toBeGreaterThan(0.95);
    expect(out[0].start).toBeLessThan(1.05);
  });
});

describe('refineWordTimes and the previous word\'s tail', () => {
  it('starts a word after a short tail of sound and a pause at its credited start, in clean and noisy audio', () => {
    for (const floor of [1e-4, 0.01]) {
      // "JS" ends with a soft hiss at 1.0–1.1 s; "and" really starts at 1.3 s after a pause.
      const pcm = audio(6, [[0.2, 0.9], [1.3, 1.6], [3, 4]], floor);
      for (let i = Math.round(1.0 * RATE); i < Math.round(1.1 * RATE); i++) pcm[i] += 0.04 * Math.sin((2 * Math.PI * 3000 * i) / RATE);
      const out = refineWordTimes([w('JS,', 0.2, 1.0), w('and', 1.0, 1.6), w('then', 3, 4)], pcm, RATE);
      expect(out[1].start).toBeCloseTo(1.3, 1);
    }
  });
});

describe('readWavMono / refineTranscript', () => {
  it('reads a 16-bit mono WAV and refines a transcript from it; anything else is left as is', async () => {
    const pcm = audio(3, [[1.0, 1.5]]);
    const data = Buffer.alloc(pcm.length * 2);
    pcm.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVEfmt ', 8, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(RATE, 24);
    header.writeUInt32LE(RATE * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(data.length, 40);
    const dir = await mkdtemp(join(tmpdir(), 'we-wav-'));
    await writeFile(join(dir, 'a.wav'), Buffer.concat([header, data]));
    const wav = await readWavMono(join(dir, 'a.wav'));
    expect(wav?.sampleRate).toBe(RATE);
    expect(wav?.samples.length).toBe(pcm.length);
    const tx = { words: [w('hi', 0.2, 1.5)], segments: [], speech: [] };
    expect((await refineTranscript(tx, join(dir, 'a.wav'))).words[0].start).toBeCloseTo(1.0, 1);
    await writeFile(join(dir, 'b.wav'), 'not audio');
    expect(await readWavMono(join(dir, 'b.wav'))).toBeNull();
    expect(await refineTranscript(tx, join(dir, 'b.wav'))).toBe(tx);
  });
});

describe('refineTranscript on a WAV from extractWav (real ffmpeg)', () => {
  it('reads what extractWav writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-wav-'));
    const src = join(dir, 'take.m4a');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*300*t)*between(t,1,1.5)':s=48000:d=3", '-c:a', 'aac', src]);
    await extractWav(src, join(dir, 'take.wav'));
    const tx = { words: [w('hi', 0.1, 1.2)], segments: [], speech: [] };
    const out = (await refineTranscript(tx, join(dir, 'take.wav'))).words[0];
    expect(out.start).toBeGreaterThan(0.95);
    expect(out.start).toBeLessThan(1.1);
    expect(out.end).toBeGreaterThan(1.4);
    expect(out.end).toBeLessThan(1.6);
  }, 30_000);
});
