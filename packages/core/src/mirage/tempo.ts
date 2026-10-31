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
 * Window-end bias, in samples. The RMS window of hop i spans [i*HOP, i*HOP + WIN), so the energy rise of
 * a click that starts at sample s peaks when the window END is DELTA samples past s (the click's
 * energy is front-loaded). Hence trueStart = (i*HOP + WIN - DELTA) / sampleRate. DELTA = 76 was calibrated
 * on the synthetic click tracks in tempo.test.ts: before correction the offset came out a constant
 * ~7 ms late.
 */
const DELTA = 76;

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
  // A pulse train also scores at its sub-multiples (60 for a 180 BPM click), so among the peaks
  // that come close to the best one take the fastest, then fold into 80-160.
  const isPeak = (i: number) => {
    for (let j = Math.max(0, i - 5); j <= Math.min(candidates.length - 1, i + 5); j++) if (candidates[j].v > candidates[i].v) return false;
    return true;
  };
  let bpm = 120;
  let top = -Infinity;
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].v >= 0.85 * best && isPeak(i) && candidates[i].bpm > top) {
      top = candidates[i].bpm;
      bpm = top;
    }
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

  // An onset at hop i means the click entered the window's end: time (i*HOP + WIN - DELTA) / sampleRate.
  const beat = 60 / bpm;
  const beatOffset = ((((offset * HOP + WIN - DELTA) / sampleRate) % beat) + beat) % beat;
  return {
    bpm: Math.round(bpm * 10) / 10,
    beatOffset: Math.round(beatOffset * 1000) / 1000,
    confidence: Math.min(1, best / (energy / onset.length)),
  };
}

/** Decodes the first `maxSec` (or all) of a file to mono float PCM. */
export async function decodeMono(file: string, tmpOut: string, tools: MediaTools, o: { sampleRate: number; maxSec?: number }): Promise<Float32Array> {
  try {
    await tools.runFfmpeg([...(o.maxSec ? ['-t', String(o.maxSec)] : []), '-i', file, '-vn', '-ac', '1', '-ar', String(o.sampleRate), '-f', 'f32le', tmpOut]);
    const buf = await readFile(tmpOut);
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  } finally {
    await rm(tmpOut, { force: true });
  }
}
