// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Episode, Transcript, Word } from '@wordedits/shared';
import { KOKORO_VOICES, type Speaker } from '@wordedits/sidecars';
import type { MediaTools } from '../media-tools.js';
import { asCancelled } from './cancel.js';
import { MirageError } from './errors.js';
import { episodeDir, loadEpisode } from './render-episode.js';
import { slotsStale, slotsStaleError } from './slots.js';
import { cutChanged, cutChangedError, englishOnlyError, hasWords, notEnglish, type FitReport } from './voiceover.js';
import { fitRecording } from './voiceover-files.js';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Silence before the first line, between a line's sentences, and between lines (more than vo's 0.6 s, so lines never run together). */
export const NARRATION_GAPS = { lead: 0.3, sentence: 0.3, line: 0.8 };
/** Sound kept around a sentence's voiced part when it is trimmed. */
const MARGIN_SEC = 0.03;
/** A line that would run past its slot is spoken faster, up to this much faster than asked, before the fit freezes the picture. */
export const MAX_SPEEDUP = 1.15;
/** Kokoro reads at most about 500 phonemes at once: a longer sentence is read in clauses. */
const MAX_SENTENCE_WORDS = 40;

/**
 * A line as Kokoro reads it: one piece per sentence (ending at . ! ? or …), a long sentence split at its commas, semicolons,
 * colons and dashes.
 */
export function lineSentences(line: string): string[] {
  const sentences = line.trim().replace(/\s+/g, ' ').split(/(?<=[.!?…]["'”’)\]]*)\s+/).filter((s) => hasWords(s));
  return sentences.flatMap((s) => {
    if (s.split(' ').length <= MAX_SENTENCE_WORDS) return [s];
    const out: string[] = [];
    let cur = '';
    for (const clause of s.split(/(?<=[,;:—–])\s+/)) {
      if (cur && (cur + ' ' + clause).split(' ').length > MAX_SENTENCE_WORDS) {
        out.push(cur);
        cur = clause;
      } else cur = cur ? `${cur} ${clause}` : clause;
    }
    if (cur) out.push(cur);
    return out;
  });
}

/** 10 ms energy frames in dB. */
function frameDb(samples: Float32Array, sampleRate: number): { db: number[]; size: number } {
  const size = Math.max(1, Math.round(sampleRate * 0.01));
  const db: number[] = [];
  for (let i = 0; i + size <= samples.length; i += size) {
    let sum = 0;
    for (let j = i; j < i + size; j++) sum += samples[j] * samples[j];
    db.push(10 * Math.log10(sum / size + 1e-12));
  }
  return { db, size };
}

/** Where the voice is in synthesized audio (frames within 45 dB of its loudest), in samples; null for silence. */
export function voicedSpan(samples: Float32Array, sampleRate: number): { start: number; end: number; quiet: [number, number][] } | null {
  const { db, size } = frameDb(samples, sampleRate);
  const peak = Math.max(-120, ...db);
  if (peak < -60) return null;
  const voiced = (f: number) => db[f] >= peak - 45;
  let a = 0;
  while (a < db.length && !voiced(a)) a++;
  let b = db.length - 1;
  while (b > a && !voiced(b)) b--;
  // Pauses inside the voice (at a comma): runs of 80 ms or more well under the voice.
  const quiet: [number, number][] = [];
  for (let f = a, run = -1; f <= b; f++) {
    const low = db[f] < peak - 35;
    if (low && run < 0) run = f;
    if (!low && run >= 0) {
      if (f - run >= 8) quiet.push([run * size, f * size]);
      run = -1;
    }
  }
  return { start: a * size, end: Math.min(samples.length, (b + 1) * size), quiet };
}

/** How long a word takes to say, roughly: its letters, a digit counting as a short word, plus a little for the break after it. */
const weight = (w: string) => [...w].reduce((n, c) => n + (/\d/.test(c) ? 3 : /\p{L}/u.test(c) ? 1 : 0), 0) + 1.5;

/** The words of `text` spread over [start, end] by how long each takes to say. */
export function spreadWords(text: string, start: number, end: number): Word[] {
  const words = text.split(/\s+/).filter(Boolean);
  const total = words.reduce((n, w) => n + weight(w), 0);
  let t = start;
  return words.map((w) => {
    const d = ((end - start) * weight(w)) / total;
    const word = { w, start: r3(t), end: r3(t + d), conf: 1 };
    t += d;
    return word;
  });
}

/**
 * The words of a sentence spoken over [start, end]: when the audio pauses once for each comma (or other clause mark), each
 * clause is spread over its own stretch between the pauses; otherwise the words are spread over the whole sentence.
 */
export function sentenceWords(text: string, start: number, end: number, pauses: [number, number][]): Word[] {
  const clauses = text.split(/(?<=[,;:—–])\s+/).filter(Boolean);
  if (clauses.length < 2 || pauses.length < clauses.length - 1) return spreadWords(text, start, end);
  // The longest pauses are the clause breaks, taken in time order.
  const breaks = [...pauses].sort((a, b) => b[1] - b[0] - (a[1] - a[0])).slice(0, clauses.length - 1).sort((a, b) => a[0] - b[0]);
  return clauses.flatMap((c, i) => spreadWords(c, i === 0 ? start : breaks[i - 1][1], i === clauses.length - 1 ? end : breaks[i][0]));
}

export interface SpokenLine {
  slot: string;
  /** Each sentence of the line with Kokoro's audio for it. */
  sentences: { text: string; samples: Float32Array }[];
}

/**
 * Joins the spoken lines into one recording, in the order given, with NARRATION_GAPS of silence (each sentence trimmed to
 * its voice), and the transcript of that recording: the written words, timed by where each sentence's voice is. In the
 * transcript each line is one sentence (only its last word ends one): the fit never reads two lines as one, and a line of
 * many sentences is still one span to match (the fit lets a span cover at most six sentences).
 */
export function assembleNarration(lines: SpokenLine[], sampleRate: number, gaps = NARRATION_GAPS): { samples: Float32Array; transcript: Transcript; lines: { slot: string; start: number; end: number }[] } {
  const pieces: Float32Array[] = [];
  const words: Word[] = [];
  const segments: Transcript['segments'] = [];
  const spans: { slot: string; start: number; end: number }[] = [];
  let at = 0;
  const silence = (sec: number) => {
    const n = Math.round(sec * sampleRate);
    pieces.push(new Float32Array(n));
    at += n;
  };
  const margin = Math.round(MARGIN_SEC * sampleRate);
  silence(gaps.lead);
  lines.forEach((line, k) => {
    if (k > 0) silence(gaps.line);
    const lineStart = at;
    let spoken = 0;
    const lineFrom = words.length;
    for (const s of line.sentences) {
      const v = voicedSpan(s.samples, sampleRate);
      if (!v) continue;
      if (spoken++ > 0) silence(gaps.sentence);
      const from = Math.max(0, v.start - margin);
      const to = Math.min(s.samples.length, v.end + margin);
      pieces.push(s.samples.subarray(from, to));
      const sec = (x: number) => (at + x - from) / sampleRate;
      const sw = sentenceWords(s.text, sec(v.start), sec(v.end), v.quiet.map(([a, b]) => [sec(a), sec(b)]));
      words.push(...sw);
      segments.push({ start: r3(sec(v.start)), end: r3(sec(v.end)), text: s.text });
      at += to - from;
    }
    if (!spoken) return;
    for (let i = lineFrom; i < words.length - 1; i++) words[i] = { ...words[i], w: words[i].w.replace(/[.?!…]+(?=["'”’)\]]*$)/, '') };
    const last = words[words.length - 1];
    if (!/[.?!]["'”’)\]]*$/.test(last.w)) words[words.length - 1] = { ...last, w: `${last.w}.` };
    spans.push({ slot: line.slot, start: r3(lineStart / sampleRate), end: r3(at / sampleRate) });
  });
  silence(gaps.lead);
  const samples = new Float32Array(at);
  let o = 0;
  for (const p of pieces) {
    samples.set(p, o);
    o += p.length;
  }
  return { samples, transcript: { words, segments, speech: segments.map((s) => [s.start, s.end]) }, lines: spans };
}

/** Mono samples as a 16-bit PCM WAV file. */
export function wavBytes(samples: Float32Array, sampleRate: number): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return b;
}

/** Refuses a voice Kokoro doesn't have, or a speed outside 0.5–2 (Kokoro's usable range). */
export function checkSpeakOptions(voice: string, speed: number): void {
  if (!(KOKORO_VOICES as readonly string[]).includes(voice)) {
    throw new MirageError('BAD_INPUT', `There is no voice ${voice}`, `Pick one of: ${KOKORO_VOICES.join(', ')} (af/am: American, bf/bm: British; f female, m male).`);
  }
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new MirageError('BAD_INPUT', `Speed ${speed} is out of range`, 'Use a speed from 0.5 (slower) to 2 (faster); 1 is normal.');
}

/** The next unused narration-<k>.wav name in `dir`: every run of speak keeps its own recording. */
export async function nextNarrationFile(dir: string): Promise<string> {
  const used = (await readdir(dir).catch(() => [] as string[])).map((f) => /^narration-(\d+)\.wav$/.exec(f)?.[1]).filter(Boolean).map(Number);
  return `narration-${used.length ? Math.max(...used) + 1 : 1}.wav`;
}

/** The written lines speak reads: `only` (each must have a line), else every English line, in slot order. Throws what vo would. */
export function narrationTargets(ep: Episode, only?: string[]): Episode['slots'] {
  if (!ep.slots.some((s) => hasWords(s.line))) {
    const foreign = ep.slots.filter((s) => notEnglish(s.line)).map((s) => s.id);
    if (foreign.length) throw englishOnlyError(foreign);
    throw new MirageError('NOTHING_MATCHED', 'No narration lines are written yet', 'Run slots and write a line for each slot first.');
  }
  if (slotsStale(ep)) throw slotsStaleError(ep.number);
  if (only?.length) {
    if (cutChanged(ep)) throw cutChangedError();
    for (const id of only) {
      const slot = ep.slots.find((s) => s.id === id);
      if (!slot) throw new MirageError('BAD_ITEM', `there is no slot ${id}`, 'List slots from the slots tool.');
      if (!hasWords(slot.line)) throw new MirageError('BAD_ITEM', `slot ${id} has no written line`, 'Write its line first, or list slots that have one.');
    }
  }
  const wanted = only?.length ? new Set(only) : null;
  return ep.slots.filter((s) => hasWords(s.line) && (!wanted || wanted.has(s.id))).sort((a, b) => a.start - b.start);
}

export interface SpeakResult {
  /** The recording, relative to the project. */
  recording: string;
  report: FitReport;
  episode: Episode;
  /** Seconds of speech in the recording and seconds it took to synthesize. */
  audioSec: number;
  synthSec: number;
  /** Lines spoken faster than asked so they fit their slot. */
  spedUp: { slot: string; speed: number }[];
}

/**
 * The `speak` command: reads each written line (or just `slots`) with `speaker`, joins them into a new recording
 * episodes/<n>/narration-<k>.wav, and fits it like vo does (with `slots`, as vo --add --slots), using the transcript the
 * synthesis already knows instead of transcribing it. A line too long for its slot is first spoken up to MAX_SPEEDUP faster.
 */
export async function speakNarration(o: {
  project: string;
  episode: number;
  tools: MediaTools;
  speaker: Speaker;
  voice: string;
  speed: number;
  slots?: string[];
  onStep?: (m: string) => void;
  onProgress?: (f: number) => void;
  signal?: AbortSignal;
}): Promise<SpeakResult> {
  checkSpeakOptions(o.voice, o.speed);
  const project = resolve(o.project);
  const n = o.episode;
  const targets = narrationTargets(await loadEpisode(project, n), o.slots);
  const english = targets.filter((s) => !notEnglish(s.line));
  // Lines in another language aren't read (the voices are English); the fit reports them.
  if (!english.length) throw englishOnlyError(targets.map((s) => s.id));
  const dir = episodeDir(project, n);
  let wav: string | null = null;
  try {
    await o.speaker.prepare({ onStep: o.onStep, signal: o.signal });
    const started = Date.now();
    const spoken: SpokenLine[] = [];
    const spedUp: SpeakResult['spedUp'] = [];
    let rate = 0;
    const read = async (line: string, speed: number) => {
      const out: SpokenLine['sentences'] = [];
      for (const text of lineSentences(line)) {
        o.signal?.throwIfAborted();
        const a = await o.speaker.speak(text, { voice: o.voice, speed, signal: o.signal });
        if (rate && a.sampleRate !== rate) throw new MirageError('BAD_INPUT', 'The voice changed sample rate mid-way', 'Run speak again.');
        rate = a.sampleRate;
        out.push({ text, samples: a.samples });
      }
      return out;
    };
    const spokenSec = (s: SpokenLine['sentences']) => {
      const voiced = s.map((x) => voicedSpan(x.samples, rate)).filter((v) => v !== null);
      return voiced.reduce((t, v) => t + (v.end - v.start) / rate, 0) + Math.max(0, voiced.length - 1) * NARRATION_GAPS.sentence;
    };
    o.onStep?.(`Reading ${english.length} line${english.length === 1 ? '' : 's'} with ${o.voice}…`);
    for (const [i, slot] of english.entries()) {
      let sentences = await read(slot.line, o.speed);
      // The fit starts a line 0.15 s into its slot and lets it run 0.2 s past the end; vo pads its cut by 0.15 s.
      const room = slot.end - slot.start - 0.1;
      const sec = spokenSec(sentences);
      if (sec > room && room > 0) {
        const faster = Math.round(Math.min(o.speed * MAX_SPEEDUP, (o.speed * sec) / room + 0.01) * 100) / 100;
        sentences = await read(slot.line, faster);
        spedUp.push({ slot: slot.id, speed: faster });
      }
      spoken.push({ slot: slot.id, sentences });
      o.onProgress?.(((i + 1) / english.length) * 0.9);
    }
    const synthSec = (Date.now() - started) / 1000;
    const joined = assembleNarration(spoken, rate);
    o.signal?.throwIfAborted();
    const name = await nextNarrationFile(dir);
    // wx: never over another run's recording, even one started at the same moment.
    await writeFile(join(dir, name), wavBytes(joined.samples, rate), { flag: 'wx' });
    wav = join(dir, name);
    const fit = await fitRecording({ project, episode: n, recording: wav, tools: o.tools, add: !!o.slots?.length, slots: o.slots, transcript: joined.transcript, onStep: o.onStep, signal: o.signal });
    o.onProgress?.(1);
    const audioSec = r3(joined.lines.reduce((t, l) => t + l.end - l.start, 0));
    return { recording: `episodes/${n}/${name}`, report: fit.report, episode: fit.episode, audioSec, synthSec: r3(synthSec), spedUp };
  } catch (e) {
    // A recording nothing was fitted to is only clutter.
    if (wav && existsSync(wav)) await rm(wav, { force: true });
    throw asCancelled(e, o.signal);
  }
}
