import type { Word } from '@wordedits/shared';

export const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'ahh', 'hmm', 'mm', 'mhm']);

export function normalizeWord(w: string): string {
  return w
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9']/g, '')
    .replace(/^'+|'+$/g, '');
}

export const isFiller = (w: Word): boolean => FILLERS.has(normalizeWord(w.w));

export interface Sentence {
  index: number;
  /** First word index, inclusive. */
  from: number;
  /** Last word index, inclusive. */
  to: number;
  text: string;
  start: number;
  end: number;
}

const SENTENCE_END = /[.?!]["'”’)\]]*$/;

export function splitSentences(words: Word[]): Sentence[] {
  const out: Sentence[] = [];
  let from = 0;
  words.forEach((word, i) => {
    if (SENTENCE_END.test(word.w.trim()) || i === words.length - 1) {
      const slice = words.slice(from, i + 1);
      out.push({
        index: out.length,
        from,
        to: i,
        text: slice.map((x) => x.w.trim()).join(' '),
        start: slice[0].start,
        end: slice[slice.length - 1].end,
      });
      from = i + 1;
    }
  });
  return out;
}

export function sentenceTokens(s: Sentence, words: Word[]): string[] {
  return words.slice(s.from, s.to + 1).filter((w) => !isFiller(w)).map((w) => normalizeWord(w.w)).filter(Boolean);
}

export function textTokens(text: string): string[] {
  return text.split(/\s+/).map(normalizeWord).filter((t) => t && !FILLERS.has(t));
}

/** Longest-common-subsequence length divided by the longer sequence's length. */
export function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (const x of a) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = x === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length] / Math.max(a.length, b.length);
}

export function splitScript(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const RESTART_CUES = [
  /\b(let me|lemme|i'll|i will|i'm gonna|im gonna) (say|try|do|start|read)( that| this| it)? (again|over)\b/,
  /\bscratch that\b/,
  /\bstart(ing)? over\b/,
  /\bone more time\b/,
  /\btake (two|three|four|2|3|4)\b/,
];
/** Cue phrases inside longer sentences are content, not cues. */
const MAX_CUE_TOKENS = 8;

export interface RetakeDecision {
  sentence: number;
  reason: string;
}

export interface RetakeOptions {
  scriptText?: string;
  /** How many following sentences to compare against (cue sentences do not count). */
  lookahead?: number;
  /** Similarity at or above which two sentences are takes of the same line. */
  threshold?: number;
}

export function detectRetakes(sentences: Sentence[], words: Word[], opts: RetakeOptions = {}): RetakeDecision[] {
  const lookahead = opts.lookahead ?? 3;
  const threshold = opts.threshold ?? 0.8;
  const tokens = sentences.map((s) => sentenceTokens(s, words));
  const dropped = new Map<number, string>();
  const cue = new Set<number>();

  tokens.forEach((t, i) => {
    if (t.length === 0) {
      dropped.set(i, `filler only: "${sentences[i].text}"`);
    } else if (t.length <= MAX_CUE_TOKENS && RESTART_CUES.some((r) => r.test(t.join(' ')))) {
      dropped.set(i, `restart cue: "${sentences[i].text}"`);
      cue.add(i);
    }
  });

  for (let i = 0; i < sentences.length; i++) {
    if (dropped.has(i)) continue;
    let compared = 0;
    for (let j = i + 1; j < sentences.length && compared < lookahead; j++) {
      if (cue.has(j)) continue;
      compared++;
      const a = tokens[i];
      const b = tokens[j];
      const falseStart = a.length >= 2 && a.length < b.length && b.slice(0, a.length).join(' ') === a.join(' ');
      if (falseStart || similarity(a, b) >= threshold) {
        dropped.set(i, `retake: kept the later take "${sentences[j].text}"`);
        break;
      }
    }
  }

  if (opts.scriptText) {
    const script = splitScript(opts.scriptText).map(textTokens);
    const lastTakeOf = new Map<number, number>();
    tokens.forEach((t, i) => {
      if (dropped.has(i)) return;
      let best = -1;
      let bestScore = 0;
      script.forEach((line, k) => {
        const score = similarity(t, line);
        if (score > bestScore) {
          bestScore = score;
          best = k;
        }
      });
      if (best < 0 || bestScore < 0.6) return;
      const previous = lastTakeOf.get(best);
      if (previous !== undefined) {
        dropped.set(previous, `retake of script line ${best + 1}: kept the later take "${sentences[i].text}"`);
      }
      lastTakeOf.set(best, i);
    });
  }

  return [...dropped.entries()].sort((a, b) => a[0] - b[0]).map(([sentence, reason]) => ({ sentence, reason }));
}
