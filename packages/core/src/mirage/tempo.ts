import { readFile, rm } from 'node:fs/promises';
import type { MediaTools } from '../media-tools.js';

export interface Tempo {
  bpm: number;
  beatOffset: number;
  confidence: number;
}

const HOP = 256;
const WIN = 1024;

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

function autocorr(onset: Float32Array, lag: number): number {
  const L = Math.round(lag);
  let s = 0;
  for (let i = 0; i + L < onset.length; i++) s += onset[i] * onset[i + L];
  return s / Math.max(1, onset.length - L);
}

export function detectTempo(samples: Float32Array, sampleRate: number): Tempo {
  const onset = onsetEnvelope(samples);
  let energy = 0;
  for (const v of onset) energy += v * v;
  if (energy === 0) return { bpm: 120, beatOffset: 0, confidence: 0 };

  const hopRate = sampleRate / HOP;
  const score = (bpm: number) => autocorr(onset, (hopRate * 60) / bpm) + 0.5 * autocorr(onset, (2 * hopRate * 60) / bpm);
  let bpm = 120;
  let best = -Infinity;
  for (let b = 60; b <= 200; b += 0.5) {
    const v = score(b);
    if (v > best) {
      best = v;
      bpm = b;
    }
  }
  if (bpm < 80 && score(bpm * 2) >= 0.5 * best) bpm *= 2;
  if (bpm > 160 && score(bpm / 2) >= 0.5 * best) bpm /= 2;

  const period = (hopRate * 60) / bpm;
  let bestOffset = 0;
  let bestPhase = -Infinity;
  for (let off = 0; off < period; off += 1) {
    let v = 0;
    for (let p = off; p < onset.length; p += period) v += onset[Math.round(p)] ?? 0;
    if (v > bestPhase) {
      bestPhase = v;
      bestOffset = off;
    }
  }
  // An onset at hop i means the click entered the window's end: time (i*HOP + WIN) / sampleRate.
  const beatOffset = ((bestOffset * HOP + WIN) / sampleRate) % (60 / bpm);
  return {
    bpm: Math.round(bpm * 10) / 10,
    beatOffset: Math.round(beatOffset * 1000) / 1000,
    confidence: Math.min(1, best / (energy / onset.length)),
  };
}

/** Decodes the first `maxSec` (or all) of a file to mono float PCM. */
export async function decodeMono(file: string, tmpOut: string, tools: MediaTools, o: { sampleRate: number; maxSec?: number }): Promise<Float32Array> {
  await tools.runFfmpeg([...(o.maxSec ? ['-t', String(o.maxSec)] : []), '-i', file, '-vn', '-ac', '1', '-ar', String(o.sampleRate), '-f', 'f32le', tmpOut]);
  try {
    const buf = await readFile(tmpOut);
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  } finally {
    await rm(tmpOut, { force: true });
  }
}
