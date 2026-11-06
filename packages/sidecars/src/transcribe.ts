import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptSchema, type Transcript, type Word } from '@wordedits/shared';
import { SidecarError } from './errors.js';
import { runPath } from './run.js';
import { dtwPreset, WHISPER, whisperInstallHint, whisperLanguage, whisperSetup, wordsFromWhisperJson } from './whisper.js';

const SENTENCE_END = /[.?!]["'”’)\]]*$/;

export function sentenceSegments(words: Word[]): Transcript['segments'] {
  const out: Transcript['segments'] = [];
  let from = 0;
  words.forEach((word, i) => {
    if (SENTENCE_END.test(word.w) || i === words.length - 1) {
      const slice = words.slice(from, i + 1);
      out.push({ start: slice[0].start, end: slice[slice.length - 1].end, text: slice.map((x) => x.w).join(' ') });
      from = i + 1;
    }
  });
  return out;
}

export function speechRanges(words: Word[], maxGapSec = 0.3): [number, number][] {
  const out: [number, number][] = [];
  for (const word of words) {
    const last = out[out.length - 1];
    if (last && word.start - last[1] < maxGapSec) last[1] = Math.max(last[1], word.end);
    else out.push([word.start, word.end]);
  }
  return out;
}

/**
 * Transcribes 16 kHz mono WAV with whisper.cpp: greedy decoding (it keeps punctuation, which sentence segments need, and is
 * the fastest on a CPU), DTW word timing when the model's alignment heads are known (DTW needs flash attention off), and
 * non-speech tokens (♪, [Music]) suppressed. `locale` 'en-US' → `-l en`; none → `-l auto`.
 */
export async function transcribeAudio(audioPath: string, opts: { locale?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Transcript> {
  const setup = await whisperSetup();
  if (!setup.ok) throw new SidecarError(WHISPER, 'NOT_FOUND', 'Speech recognition is not set up', setup.problem);
  const preset = dtwPreset(setup.model);
  const dir = await mkdtemp(join(tmpdir(), 'mirage-whisper-'));
  const out = join(dir, 'words');
  try {
    await runPath(WHISPER, setup.cli, [
      '-m', setup.model, '-f', audioPath, '-l', whisperLanguage(opts.locale),
      '-t', String(Math.max(1, Math.min(8, availableParallelism()))), '-bs', '1', '-sns',
      ...(preset ? ['-nfa', '--dtw', preset] : []),
      '-ojf', '-of', out, '-np',
    ], {
      timeoutMs: opts.timeoutMs ?? 30 * 60_000,
      keepStdout: false,
      notFoundHint: whisperInstallHint(),
      signal: opts.signal,
    }).catch((e: unknown) => {
      // whisper-cli follows an error with its whole usage text: the line that says what went wrong is the "error:" one.
      if (e instanceof SidecarError && e.code === 'EXIT') e.hint = e.stderr.split('\n').find((l) => /^error:/i.test(l.trim()))?.trim() ?? e.hint;
      throw e;
    });
    let json: string;
    try {
      json = await readFile(`${out}.json`, 'latin1');
    } catch {
      throw new SidecarError(WHISPER, 'PARSE', `${WHISPER} wrote no transcript`, 'Try again; if it persists, reinstall whisper.cpp.');
    }
    let words: Word[];
    try {
      words = wordsFromWhisperJson(json);
    } catch {
      throw new SidecarError(WHISPER, 'PARSE', `${WHISPER} returned invalid JSON`, 'Try again; if it persists, reinstall whisper.cpp.', json.slice(0, 2000));
    }
    return TranscriptSchema.parse({ words, segments: sentenceSegments(words), speech: speechRanges(words) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
