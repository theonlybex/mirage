import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import type { Word } from '@wordedits/shared';
import { SidecarError } from './errors.js';

/** The whisper.cpp command-line program (https://github.com/ggml-org/whisper.cpp). */
export const WHISPER = 'whisper-cli';
export const DEFAULT_MODEL = 'ggml-large-v3-turbo-q5_0.bin';
export const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${DEFAULT_MODEL}`;

const exe = () => (process.platform === 'win32' ? `${WHISPER}.exe` : WHISPER);

export function whisperInstallHint(): string {
  return `Install whisper.cpp (macOS: brew install whisper-cpp; Windows: unzip whisper-bin-x64.zip from github.com/ggml-org/whisper.cpp/releases into %LOCALAPPDATA%\\whisper-cpp) or set WORDEDITS_WHISPER_DIR to a folder containing ${exe()}.`;
}

export function modelHint(model: string): string {
  return `Download ${DEFAULT_MODEL} (about 574 MB) from ${MODEL_URL} to ${model}, or set WORDEDITS_WHISPER_MODEL to a whisper.cpp model file.`;
}

/** The model file: WORDEDITS_WHISPER_MODEL, else ~/.local/share/whisper-cpp/models/ggml-large-v3-turbo-q5_0.bin (on every platform). */
export function whisperModelPath(): string {
  return process.env.WORDEDITS_WHISPER_MODEL || join(homedir(), '.local', 'share', 'whisper-cpp', 'models', DEFAULT_MODEL);
}

async function exists(p: string, mode = constants.X_OK): Promise<boolean> {
  try {
    await access(p, mode);
    return true;
  } catch {
    return false;
  }
}

/** Where installers put whisper-cli outside PATH: the desktop app may not inherit the shell's PATH (Homebrew's is set in ~/.zprofile). */
function knownDirs(): string[] {
  if (process.platform === 'win32') {
    const base = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'whisper-cpp');
    return [base, join(base, 'Release')];
  }
  return ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin'];
}

/**
 * Resolution order: WORDEDITS_WHISPER_DIR (if set, it must contain whisper-cli), then PATH, then the folders installers use.
 * Not cached: /mirage:status should see an install made while the engine runs.
 */
export async function locateWhisper(): Promise<string> {
  const override = process.env.WORDEDITS_WHISPER_DIR;
  if (override) {
    const p = join(override, exe());
    if (await exists(p)) return p;
    throw new SidecarError(WHISPER, 'NOT_FOUND', `${WHISPER} not found in WORDEDITS_WHISPER_DIR (${override})`, `Put ${exe()} in that folder or unset WORDEDITS_WHISPER_DIR.`);
  }
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...knownDirs()];
  for (const dir of dirs) {
    const p = join(dir, exe());
    if (await exists(p)) return p;
  }
  throw new SidecarError(WHISPER, 'NOT_FOUND', `${WHISPER} was not found`, whisperInstallHint());
}

/** Both halves of speech recognition, or what is missing (naming each missing half, with how to get it). */
export async function whisperSetup(): Promise<{ ok: true; cli: string; model: string } | { ok: false; problem: string }> {
  const problems: string[] = [];
  const cli = await locateWhisper().catch((e: unknown) => {
    problems.push(e instanceof SidecarError ? `${e.message}. ${e.hint}` : String(e));
    return null;
  });
  const model = whisperModelPath();
  if (!(await exists(model, constants.R_OK))) problems.push(`The speech model is missing (${model}). ${modelHint(model)}`);
  return cli && !problems.length ? { ok: true, cli, model } : { ok: false, problem: problems.join(' ') };
}

/**
 * The --dtw alignment-heads preset for a model file, from its name (ggml-large-v3-turbo-q5_0.bin → large.v3.turbo); null for
 * a model whose heads whisper.cpp doesn't know, which is then transcribed without DTW timing.
 */
export function dtwPreset(model: string): string | null {
  const m = /^ggml-(tiny|base|small|medium|large-v[123](?:-turbo)?)(\.en)?(?:-q\d_\d|-f16|-f32)?\.bin$/i.exec(basename(model));
  return m ? `${m[1]!.toLowerCase().replace(/-/g, '.')}${m[2] ?? ''}` : null;
}

/** Mirage locales ('en-US', 'de_DE', 'auto') as whisper.cpp language codes ('en', 'de', 'auto'). */
export function whisperLanguage(locale?: string): string {
  if (!locale) return 'auto';
  return locale.split(/[-_]/)[0]!.toLowerCase() || 'auto';
}

interface WhisperToken {
  text?: unknown;
  p?: unknown;
  t_dtw?: unknown;
  offsets?: { from?: unknown; to?: unknown };
}
interface WhisperSegment {
  offsets?: { from?: unknown; to?: unknown };
  tokens?: WhisperToken[];
}

const SPECIAL = /^\[_[A-Z]+(?:_\d+)?_?\]$/; // [_BEG_], [_TT_368], [_SOT_]…
const CONTENT = /[\p{L}\p{N}]/u;
const CLAUSE_END = /[.,!?;:…。！？、，]["'”’)\]]*$/u;
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

interface RawWord {
  bytes: Buffer[];
  start: number;
  end: number;
  probs: number[];
  firstInSegment: boolean;
}

/**
 * The words of whisper-cli's --output-json-full (-ojf) result, read as latin1 so that each token's text is its raw bytes:
 * whisper.cpp writes tokens as byte sequences, and a character outside ASCII can be split across two tokens.
 *
 * A token starting with a space starts a word; others (sub-words, punctuation) join the word before. With DTW timing
 * (`t_dtw`, in 10 ms units, which marks where a token ends), a word ends where its last letter or digit token does and starts
 * where the token before it ends (the segment's start for its first word); a word at a clause or segment start that would
 * soak up a pause is cut to twice the median word length, as OpenAI's whisper does. Without DTW the tokens' own offsets
 * are used. `conf` is the mean probability of the word's letter and digit tokens.
 */
export function wordsFromWhisperJson(latin1Json: string): Word[] {
  const doc = JSON.parse(latin1Json) as { transcription?: WhisperSegment[] };
  const segments = Array.isArray(doc.transcription) ? doc.transcription : [];
  const dtw = segments.some((s) => (s.tokens ?? []).some((t) => num(t.t_dtw, -1) >= 0));
  const raw: RawWord[] = [];

  for (const seg of segments) {
    const segStart = num(seg.offsets?.from, 0) / 1000;
    let prevEnd = segStart;
    let word: RawWord | null = null;
    for (const tok of seg.tokens ?? []) {
      const text = typeof tok.text === 'string' ? tok.text : '';
      if (!text || SPECIAL.test(text)) continue;
      const bytes = Buffer.from(text, 'latin1');
      const decoded = bytes.toString('utf8');
      const content = CONTENT.test(decoded) || decoded.includes('\ufffd'); // a part of a split character is part of a letter
      const from = num(tok.offsets?.from, prevEnd * 1000) / 1000;
      const to = num(tok.offsets?.to, from * 1000) / 1000;
      const t = num(tok.t_dtw, -1);
      const end = dtw ? (t >= 0 ? t / 100 : prevEnd) : to;
      if (word === null || text.startsWith(' ')) {
        word = { bytes: [], start: dtw ? prevEnd : from, end: dtw ? prevEnd : to, probs: [], firstInSegment: word === null };
        raw.push(word);
      }
      word.bytes.push(bytes);
      if (content || word.probs.length === 0) {
        if (content) word.probs.push(num(tok.p, 1));
        word.end = Math.max(word.end, end);
      }
      prevEnd = Math.max(prevEnd, end);
    }
  }

  const words = raw.map((r) => ({
    w: Buffer.concat(r.bytes).toString('utf8').trim(),
    start: Math.max(0, r.start),
    end: Math.max(0, r.end),
    conf: r.probs.length ? r.probs.reduce((a, b) => a + b, 0) / r.probs.length : 1,
    clauseStart: r.firstInSegment,
  })).filter((x) => x.w.length > 0);
  for (let i = 1; i < words.length; i++) if (CLAUSE_END.test(words[i - 1]!.w)) words[i]!.clauseStart = true;

  if (dtw && words.length) {
    const durations = words.map((x) => x.end - x.start).filter((d) => d > 0).sort((a, b) => a - b);
    const median = Math.min(0.7, durations.length ? durations[Math.floor(durations.length / 2)]! : 0.7);
    const max = Math.max(0.2, median * 2);
    for (const x of words) if (x.clauseStart && x.end - x.start > max) x.start = x.end - max;
  }

  let last = 0;
  return words.map(({ w, start, end, conf }) => {
    const s = Math.max(start, last);
    const e = Math.max(s, end);
    last = s;
    return { w, start: s, end: e, conf: Math.min(1, Math.max(0, conf)) };
  });
}
