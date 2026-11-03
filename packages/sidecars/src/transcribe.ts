import { access, constants } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TranscriptSchema, type Transcript, type Word } from '@wordedits/shared';
import { SidecarError } from './errors.js';
import { runPath } from './run.js';

const NAME = 'wordedits-transcribe';
const SENTENCE_END = /[.?!]["'”’)\]]*$/;

/** Where the transcriber is: WORDEDITS_TRANSCRIBER when set (the plugin points it at its own copy), else the built one in bin/. */
export function transcriberPath(): string {
  if (process.env.WORDEDITS_TRANSCRIBER) return process.env.WORDEDITS_TRANSCRIBER;
  return fileURLToPath(new URL(`../bin/darwin/${NAME}`, import.meta.url));
}

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

interface RawWord {
  w?: unknown;
  start?: unknown;
  end?: unknown;
  conf?: unknown;
}

export async function transcribeAudio(audioPath: string, opts: { locale?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Transcript> {
  if (process.platform !== 'darwin') {
    throw new SidecarError(NAME, 'NOT_FOUND', 'On-device transcription is only available on macOS for now', 'Use a Mac with macOS 26 or later.');
  }
  const bin = transcriberPath();
  try {
    await access(bin, constants.X_OK);
  } catch {
    throw new SidecarError(NAME, 'NOT_FOUND', 'The transcriber has not been built', 'Run: pnpm build:native');
  }
  const { stdout } = await runPath(NAME, bin, [audioPath, '--locale', opts.locale ?? 'en-US'], {
    timeoutMs: opts.timeoutMs ?? 30 * 60_000,
    notFoundHint: 'Run: pnpm build:native',
    signal: opts.signal,
  });

  let raw: { words?: RawWord[] };
  try {
    raw = JSON.parse(stdout) as { words?: RawWord[] };
  } catch {
    throw new SidecarError(NAME, 'PARSE', 'The transcriber returned invalid JSON', 'Try again; if it persists, rebuild with pnpm build:native.', stdout);
  }
  const words: Word[] = (raw.words ?? [])
    .map((r) => {
      const start = Math.max(0, Number(r.start) || 0);
      const end = Math.max(start, Number(r.end) || start);
      const conf = Math.min(1, Math.max(0, Number(r.conf ?? 1)));
      return { w: String(r.w ?? '').trim(), start, end, conf };
    })
    .filter((x) => x.w.length > 0)
    .sort((a, b) => a.start - b.start);

  return TranscriptSchema.parse({ words, segments: sentenceSegments(words), speech: speechRanges(words) });
}
