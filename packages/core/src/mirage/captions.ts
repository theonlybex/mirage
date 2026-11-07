// SPDX-License-Identifier: MIT
import type { Captions, Word } from '@wordedits/shared';
import { normalizeWord } from '../autoedit/takes.js';
import { groupSpans, groupWords, type GroupedWord } from './overlays.js';

export { groupWords };

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const EPS = 1e-6;

/** The default colour of highlighted (pop) and current (karaoke) words. */
export const HIGHLIGHT_COLOR = '#C6FF3D';

/** One word of a caption line, as plain text: `buildAss` does the ASS escaping, emoji removal and font switches. */
export interface CaptionPart {
  text: string;
  /** A highlighted word (pop style). */
  key?: boolean;
  /** The word that just appeared: it pops in. */
  pop?: boolean;
  /** The word being said (karaoke style). */
  lit?: boolean;
  /** A word of the group not said yet (pop style): laid out but not drawn, so the words before it never move. */
  hidden?: boolean;
}

/** What is on screen from `start` to `end` (output seconds). */
export interface CaptionLine {
  start: number;
  end: number;
  parts: CaptionPart[];
}

/**
 * Indexes into `words` of the highlighted words: a string lights every saying of that word; `{ word, at }` only the
 * saying whose start is nearest output time `at`.
 */
export function keyWords(words: Word[], highlight: Captions['highlight']): Set<number> {
  const keys = new Set<number>();
  for (const h of highlight) {
    const target = normalizeWord(typeof h === 'string' ? h : h.word);
    if (!target) continue;
    const said = words.flatMap((x, i) => (normalizeWord(x.w) === target ? [i] : []));
    if (typeof h === 'string') {
      for (const i of said) keys.add(i);
      continue;
    }
    let best = -1;
    for (const i of said) if (best < 0 || Math.abs(words[i].start - h.at) < Math.abs(words[best].start - h.at)) best = i;
    if (best >= 0) keys.add(best);
  }
  return keys;
}

/**
 * One line per word of a group: line k runs from the start of word k (the first from the group's start) until the next
 * line starts (the last until the group's end); `parts(k)` says what it shows. Empty or inverted lines are left out.
 */
function wordLines(span: { start: number; end: number }, group: GroupedWord[], parts: (k: number) => CaptionPart[]): CaptionLine[] {
  const starts: number[] = [];
  for (const [k, x] of group.entries()) starts.push(k === 0 ? span.start : Math.min(span.end, Math.max(x.start, starts[k - 1])));
  const lines: CaptionLine[] = [];
  for (const [k, start] of starts.entries()) {
    const end = r3(k + 1 < starts.length ? starts[k + 1] : span.end);
    if (end <= start + EPS) continue;
    lines.push({ start: r3(start), end, parts: parts(k) });
  }
  return lines;
}

/**
 * Pop captions: groups of 1–3 words (16 characters at most), in capitals. Each word appears at its own start (the first of
 * a group 0.1 s early) and the group stays at least 0.5 s, but never past the next group. The first highlighted word of a
 * group is `key`; the newest word of every line is `pop`. Every line of a group carries all its words, those not said yet
 * `hidden`, so the line is laid out the same from its first word to its last.
 */
export function popLines(words: Word[], o: { durationSec: number; highlight: Captions['highlight'] }): CaptionLine[] {
  const keys = keyWords(words, o.highlight);
  const groups = groupWords(words, { maxChars: 16, maxWords: 3, maxGap: 0.6, wordsOnly: true });
  return groupSpans(groups, { durationSec: o.durationSec, lead: 0.1, minDur: 0.5 }).flatMap((span) => {
    const firstKey = span.group.find((x) => keys.has(x.index));
    return wordLines(span, span.group, (k) =>
      span.group.map((x, j) => ({
        text: x.text.toUpperCase(),
        ...(x === firstKey ? { key: true } : {}),
        ...(j === k ? { pop: true } : {}),
        ...(j > k ? { hidden: true } : {}),
      })),
    );
  });
}

/**
 * Karaoke captions: phrase groups as in `groupCaptions`, one line per word, the word being said `lit` from its start until
 * the next word's start (the first from the phrase's start, the last until its end).
 */
export function karaokeLines(words: Word[], o: { durationSec: number }): CaptionLine[] {
  const groups = groupWords(words, { maxChars: 38, maxGap: 0.6, wordsOnly: true });
  return groupSpans(groups, { durationSec: o.durationSec, lead: 0.15, minDur: 0.8 }).flatMap((span) =>
    wordLines(span, span.group, (k) => span.group.map((x, j) => ({ text: x.text, ...(j === k ? { lit: true } : {}) }))),
  );
}

/** Problems with the captions setting worth telling the person (printed by `cut` and `render`). */
export function captionWarnings(words: Word[], captions: Captions | undefined): string[] {
  if (!captions || !captions.highlight.length) return [];
  if (captions.style !== 'pop') return [`captions.highlight only works with the "pop" style — it does nothing with "${captions.style}"`];
  const said = new Set(words.map((x) => normalizeWord(x.w)));
  const out: string[] = [];
  for (const h of captions.highlight) {
    const word = typeof h === 'string' ? h : h.word;
    const msg = `captions.highlight "${word}" is never said in this video — check the spelling or remove it`;
    if (!said.has(normalizeWord(word)) && !out.includes(msg)) out.push(msg);
  }
  return out;
}
