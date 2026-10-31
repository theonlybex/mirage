import { readFile, rm } from 'node:fs/promises';
import type { MediaTools } from '../media-tools.js';

export interface Tempo {
  bpm: number;
  beatOffset: number;
  confidence: number;
}

const HOP = 128;
const WIN = 1024;
/**
 * Window-end bias, in samples. The RMS window of hop i spans [i*HOP, i*HOP + WIN), so a click that
 * starts at sample s shows up at the hop whose window END has passed it: trueStart = (i*HOP + WIN - DELTA) / sampleRate.
 * DELTA = half a hop of window-end latency (the onset peaks somewhere inside the hop, HOP / 2 on average)
 * plus 12 samples for the click's energy centroid (front-loaded decay), calibrated on the synthetic click
 * tracks in tempo.test.ts, where the uncorrected offset came out a constant ~7 ms late.
 */
const DELTA = HOP / 2 + 12;

/** Half-wave-rectified rise in RMS energy per hop. */
export function onsetEnvelope(samples: Float32Array): Float32Array {
  const n = Math.max(0, Math.floor((samples.length - WIN) / HOP) + 1);
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * HOP;
    for (let j = 0; j < WIN; j++) s += samples[o + j] * samples[o + j];
    energy[i] = Math.sqrt(s / WIN);
  }
  const onset = new Float32Array(n);
  for (let i = 1; i < n; i++) onset[i] = Math.max(0, energy[i] - energy[i - 1]);
  return onset;
}

/** Linear interpolation of the envelope at a fractional index; zero outside it. */
function at(x: Float32Array, pos: number): number {
  if (pos < 0 || pos > x.length - 1) return 0;
  const i = Math.floor(pos);
  const f = pos - i;
  return f === 0 ? x[i] : x[i] * (1 - f) + (x[i + 1] ?? 0) * f;
}

function autocorr(onset: Float32Array, lag: number): number {
  let s = 0;
  for (let i = 0; i < onset.length; i++) {
    if (onset[i] !== 0) s += onset[i] * at(onset, i + lag);
  }
  return s / Math.max(1, onset.length - lag);
}

/** Phase (in hops, within one period) that lines a comb of `period` up with the onsets best, and its mean onset value. */
function bestPhase(onset: Float32Array, period: number): { offset: number; value: number } {
  let offset = 0;
  let value = -Infinity;
  for (let off = 0; off < period; off += 0.25) {
    let v = 0;
    let n = 0;
    for (let p = off; p <= onset.length - 1; p += period) {
      v += at(onset, p);
      n++;
    }
    v /= Math.max(1, n);
    if (v > value) {
      value = v;
      offset = off;
    }
  }
  return { offset, value };
}

export function detectTempo(samples: Float32Array, sampleRate: number): Tempo {
  const raw = onsetEnvelope(samples);
  let energy = 0;
  for (const v of raw) energy += v * v;
  if (energy === 0) return { bpm: 120, beatOffset: 0, confidence: 0 };

  // Light smoothing so fractional-lag interpolation does not make neighbouring lags score unevenly.
  const onset = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) onset[i] = 0.25 * (raw[i - 1] ?? 0) + 0.5 * raw[i] + 0.25 * (raw[i + 1] ?? 0);

  const hopRate = sampleRate / HOP;
  const score = (bpm: number) => autocorr(onset, (hopRate * 60) / bpm) + 0.5 * autocorr(onset, (2 * hopRate * 60) / bpm);
  const candidates: { bpm: number; v: number }[] = [];
  let best = -Infinity;
  for (let k = 0; k <= 1400; k++) {
    const b = 60 + k * 0.1;
    const v = score(b);
    candidates.push({ bpm: b, v });
    if (v > best) best = v;
  }
  // A pulse train also scores at its sub-multiples (60 for a 180 BPM click), so take a faster near-best
  // peak over the best one, but only an integer multiple of it (+/-2%): 3:2 peaks are shuffle/triplet
  // subdivisions, not the beat. Then fold into 80-160.
  const isPeak = (i: number) => {
    for (let j = Math.max(0, i - 5); j <= Math.min(candidates.length - 1, i + 5); j++) if (candidates[j].v > candidates[i].v) return false;
    return true;
  };
  let bpm = candidates.reduce((a, c) => (c.v > a.v ? c : a)).bpm;
  const base = bpm;
  for (const [i, c] of candidates.entries()) {
    if (c.v < 0.85 * best || c.bpm <= bpm || !isPeak(i)) continue;
    const ratio = c.bpm / base;
    if (Math.abs(ratio - Math.round(ratio)) <= 0.02 * Math.round(ratio)) bpm = c.bpm;
  }
  while (bpm < 80) bpm *= 2;
  while (bpm > 160) bpm /= 2;

  // The autocorrelation peak is broad; the beat comb over the whole signal is sharp, so settle the tempo there.
  let combBest = -Infinity;
  let period = (hopRate * 60) / bpm;
  let offset = 0;
  const lo = bpm * 0.99;
  for (let b = lo; b <= bpm * 1.01; b += 0.02) {
    const ph = bestPhase(onset, (hopRate * 60) / b);
    if (ph.value > combBest) {
      combBest = ph.value;
      period = (hopRate * 60) / b;
      offset = ph.offset;
    }
  }
  bpm = (hopRate * 60) / period;

  // Periodicity: how much stronger the onsets on the beat comb are than the average onset. Beatless
  // material (noise, sustained pads) sits near 1-2.5; clean beats are 9+. Map 2..8 onto 0..1.
  const meanOnset = onset.reduce((a, v) => a + v, 0) / onset.length;
  const confidence = Math.round(Math.max(0, Math.min(1, (combBest / meanOnset - 2) / 6)) * 1000) / 1000;

  // An onset at hop i means the click entered the window's end: time (i*HOP + WIN - DELTA) / sampleRate.
  const beat = 60 / bpm;
  const beatOffset = ((((offset * HOP + WIN - DELTA) / sampleRate) % beat) + beat) % beat;
  return {
    bpm: Math.round(bpm * 10) / 10,
    beatOffset: Math.round(beatOffset * 1000) / 1000,
    confidence,
  };
}

/** Decodes the first `maxSec` (or all) of a file to mono float PCM. */
/**
 * Decodes `file` to mono float samples. `clipTime` pads audio that starts after the file does with silence, as
 * extractWav does, so sample times match its transcript's word times.
 */
export async function decodeMono(file: string, tmpOut: string, tools: MediaTools, o: { sampleRate: number; maxSec?: number; clipTime?: boolean }): Promise<Float32Array> {
  try {
    const pad = o.clipTime ? ['-af', 'aresample=async=1:first_pts=0'] : [];
    await tools.runFfmpeg([...(o.maxSec ? ['-t', String(o.maxSec)] : []), '-i', file, '-vn', ...pad, '-ac', '1', '-ar', String(o.sampleRate), '-f', 'f32le', tmpOut]);
    const buf = await readFile(tmpOut);
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  } finally {
    await rm(tmpOut, { force: true });
  }
}
