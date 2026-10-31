import type { Word } from '@wordedits/shared';

export const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'ahh', 'hmm', 'mm', 'mhm']);

/** Curly and other look-alike apostrophes, folded to ' so "it’s" and "it's" match. */
const APOSTROPHES = /[‘’ʼ`´]/g;

export function normalizeWord(w: string): string {
  return w
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(APOSTROPHES, "'")
    .replace(/[^a-z0-9']/g, '')
    .replace(/^'+|'+$/g, '');
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ORDINAL: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
/** Units read out after a number they are glued to ("80ms", "15x"); alone they are ordinary words. */
const UNITS: Record<string, string> = { ms: 'milliseconds', s: 'seconds', sec: 'seconds', secs: 'seconds', min: 'minutes', mins: 'minutes', hr: 'hours', hrs: 'hours', x: 'times', k: 'thousand' };
const CURRENCY: Record<string, string> = { $: 'dollars', '€': 'euros', '£': 'pounds' };
const MULTIPLIER: Record<string, string> = { k: 'thousand', m: 'million', bn: 'billion' };

function under1000(n: number): string[] {
  const out: string[] = [];
  if (n >= 100) {
    out.push(ONES[Math.floor(n / 100)], 'hundred');
    n %= 100;
  }
  if (n >= 20) {
    out.push(TENS[Math.floor(n / 10)]);
    n %= 10;
  }
  if (n > 0) out.push(ONES[n]);
  return out;
}

/** A whole number as it is spoken: 1200 → one thousand two hundred. Very long digit runs are read digit by digit. */
export function numberWords(digits: string): string[] {
  if (digits.length > 12) return [...digits].map((d) => ONES[Number(d)]);
  let n = Number(digits);
  if (n === 0) return ['zero'];
  const out: string[] = [];
  for (const [v, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']] as const) {
    if (n >= v) {
      out.push(...under1000(Math.floor(n / v)), name);
      n %= v;
    }
  }
  return [...out, ...under1000(n)];
}

const ordinal = (w: string) => ORDINAL[w] ?? (w.endsWith('y') ? `${w.slice(0, -1)}ieth` : `${w}th`);

/**
 * One written or spoken word as the words a reader says, for matching a line against its transcript: digits become
 * number words (1,200ms → one thousand two hundred milliseconds; $5k → five thousand dollars; 3/14 → march fourteenth;
 * 2.5 → two point five), glued units are read out (ms, s, x, k, %), and hyphens split words.
 */
export function matchTokens(raw: string): string[] {
  let t = raw.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(APOSTROPHES, "'");
  t = t.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  t = t.replace(/^(1[0-2]|0?[1-9])\/(3[01]|[12]\d|0?[1-9])(?!\d)/, (_, m: string, d: string) => `${MONTHS[Number(m) - 1]} ${d}th`);
  const parts = t.match(/[$€£]|\d+(?:\.\d+)?|[a-z']+|%/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (Object.hasOwn(CURRENCY, p) && /^\d/.test(parts[i + 1] ?? '')) {
      const [int, frac] = parts[++i].split('.');
      out.push(...numberWords(int));
      if (frac) out.push('point', ...[...frac].map((d) => ONES[Number(d)]));
      if (Object.hasOwn(MULTIPLIER, parts[i + 1] ?? '')) out.push(MULTIPLIER[parts[++i]]);
      out.push(CURRENCY[p]);
    } else if (/^\d/.test(p)) {
      const [int, frac] = p.split('.');
      const words = numberWords(int);
      const next = parts[i + 1];
      if (!frac && next && /^(st|nd|rd|th)$/.test(next)) {
        words.push(ordinal(words.pop()!));
        i++;
      }
      out.push(...words);
      if (frac) out.push('point', ...[...frac].map((d) => ONES[Number(d)]));
      if (next && Object.hasOwn(UNITS, next) && parts[i + 1] === next) {
        out.push(UNITS[next]);
        i++;
      }
    } else if (p === '%') {
      out.push('percent');
    } else {
      const w = p.replace(/^'+|'+$/g, '');
      if (w) out.push(w);
    }
  }
  return out;
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
  return words.slice(s.from, s.to + 1).filter((w) => !isFiller(w)).flatMap((w) => matchTokens(w.w)).filter((t) => !FILLERS.has(t));
}

export function textTokens(text: string): string[] {
  return text.split(/\s+/).flatMap(matchTokens).filter((t) => !FILLERS.has(t));
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
