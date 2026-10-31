import { readFile } from 'node:fs/promises';
import type { Transcript, Word } from '@wordedits/shared';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** Energy frames of 10 ms. */
const FRAME_SEC = 0.01;
/** A quiet stretch at least this long ends a word's sound. */
const QUIET_FRAMES = 10;
/** A word's end moves later by at most this much. */
const MAX_EXTEND_SEC = 1;

function frameDb(samples: Float32Array, sampleRate: number): number[] {
  const size = Math.max(1, Math.round(sampleRate * FRAME_SEC));
  const out: number[] = [];
  for (let i = 0; i + size <= samples.length; i += size) {
    let sum = 0;
    for (let j = i; j < i + size; j++) sum += samples[j] * samples[j];
    out.push(10 * Math.log10(sum / size + 1e-12));
  }
  return out;
}

const percentile = (sorted: number[], q: number) => sorted[Math.floor(q * (sorted.length - 1))];

/**
 * Word timings checked against the audio they came from. The transcriber credits the silence before a word to the word
 * and can end a word before its sound does, so: a word's start moves forward to its first frame of sound (if it has one),
 * and its end moves later to where its sound stops — before the next word, within a second, and only when a quiet
 * stretch shows where it stops. Audio without clear quiet parts (steady noise, music) leaves timings as they are.
 */
export function refineWordTimes(words: Word[], samples: Float32Array, sampleRate: number): Word[] {
  const db = frameDb(samples, sampleRate);
  if (db.length < 50 || words.length === 0) return words;
  const sorted = [...db].sort((a, b) => a - b);
  const quiet = percentile(sorted, 0.1);
  const loud = percentile(sorted, 0.95);
  if (loud - quiet < 20) return words;
  const threshold = Math.min(loud - 10, Math.max(quiet + 15, loud - 40));
  const sounds = (f: number) => db[f] >= threshold;
  const frame = (t: number) => Math.max(0, Math.min(db.length, Math.round(t / FRAME_SEC)));

  const starts = words.map((w) => {
    const a = frame(w.start);
    const b = frame(w.end);
    for (let f = a; f < b; f++) if (sounds(f)) return f > a ? r3(f * FRAME_SEC) : w.start;
    return w.start;
  });
  return words.map((w, i) => {
    const start = starts[i];
    const next = i + 1 < words.length ? starts[i + 1] : Infinity;
    const limit = frame(Math.min(next, w.end + MAX_EXTEND_SEC));
    let lastSound = -1;
    let quietRun = 0;
    let stopped = false;
    for (let f = frame(w.end); f < limit; f++) {
      if (sounds(f)) {
        lastSound = f;
        quietRun = 0;
      } else if (++quietRun >= QUIET_FRAMES) {
        stopped = true;
        break;
      }
    }
    // Sound right up to the limit: it runs into the next word (fine to end there) or on past a second (no clear end).
    const reachedNext = !stopped && Number.isFinite(next) && limit === frame(next);
    let end = w.end;
    if (lastSound >= 0 && (stopped || reachedNext)) end = Math.max(w.end, r3((lastSound + 1) * FRAME_SEC));
    if (Number.isFinite(next)) end = Math.min(end, Math.max(w.end, next));
    return start === w.start && end === w.end ? w : { ...w, start, end };
  });
}

/** The samples of a 16-bit PCM WAV (mixed to mono), or null for any other file. */
export async function readWavMono(path: string): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  const b = await readFile(path);
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | null = null;
  for (let o = 12; o + 8 <= b.length; ) {
    const id = b.toString('ascii', o, o + 4);
    const size = b.readUInt32LE(o + 4);
    if (id === 'fmt ' && o + 24 <= b.length) {
      fmt = { format: b.readUInt16LE(o + 8), channels: b.readUInt16LE(o + 10), sampleRate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1) return null;
      const end = Math.min(b.length, o + 8 + size);
      const count = Math.floor((end - o - 8) / (2 * fmt.channels));
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) sum += b.readInt16LE(o + 8 + (i * fmt.channels + c) * 2);
        samples[i] = sum / fmt.channels / 32768;
      }
      return { samples, sampleRate: fmt.sampleRate };
    }
    o += 8 + size + (size % 2);
  }
  return null;
}

/** `transcript` with its word timings refined against the WAV it was transcribed from (unchanged when that isn't a PCM WAV). */
export async function refineTranscript(transcript: Transcript, wav: string): Promise<Transcript> {
  const audio = await readWavMono(wav).catch(() => null);
  if (!audio) return transcript;
  return { ...transcript, words: refineWordTimes(transcript.words, audio.samples, audio.sampleRate) };
}
