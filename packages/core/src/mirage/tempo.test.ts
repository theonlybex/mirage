import { describe, expect, it } from 'vitest';
import { detectTempo } from './tempo.js';

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
    expect(Math.abs(t.beatOffset - 0.25)).toBeLessThanOrEqual(0.03);
    expect(t.confidence).toBeGreaterThan(0);
  });
  it('finds 95 BPM without halving or doubling', () => {
    expect(Math.abs(detectTempo(clicks(95, 0.1, 30), SR).bpm - 95)).toBeLessThanOrEqual(1.5);
  });
  it('folds a slow pulse into the 80–160 range', () => {
    expect(Math.abs(detectTempo(clicks(140, 0, 30), SR).bpm - 140)).toBeLessThanOrEqual(1.5);
  });
  it('returns zero confidence for silence', () => {
    expect(detectTempo(new Float32Array(SR * 5), SR).confidence).toBe(0);
  });
});
