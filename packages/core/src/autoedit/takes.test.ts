import type { Word } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { detectRetakes, isFiller, normalizeWord, similarity, splitScript, splitSentences } from './takes.js';

/** Words from text, 0.3 s each, back to back. */
function words(text: string): Word[] {
  return text.split(/\s+/).filter(Boolean).map((w, i) => ({ w, start: i * 0.3, end: i * 0.3 + 0.25, conf: 1 }));
}
const dropped = (text: string, scriptText?: string) => {
  const ws = words(text);
  return detectRetakes(splitSentences(ws), ws, { scriptText }).map((d) => d.sentence);
};

describe('normalizeWord / isFiller', () => {
  it('lowercases and strips punctuation and accents', () => {
    expect(normalizeWord('  Café,')).toBe('cafe');
    expect(normalizeWord("Don't!")).toBe("don't");
  });
  it('recognises hesitation sounds only', () => {
    expect(isFiller({ w: 'Um,', start: 0, end: 1, conf: 1 })).toBe(true);
    expect(isFiller({ w: 'Ah.', start: 0, end: 1, conf: 1 })).toBe(true);
    expect(isFiller({ w: 'like', start: 0, end: 1, conf: 1 })).toBe(false);
  });
});

describe('splitSentences', () => {
  it('splits on . ? ! and keeps word index ranges', () => {
    const s = splitSentences(words('Hello there. How are you? Fine'));
    expect(s.map((x) => [x.from, x.to, x.text])).toEqual([[0, 1, 'Hello there.'], [2, 4, 'How are you?'], [5, 5, 'Fine']]);
    expect(s[1].start).toBeCloseTo(0.6);
    expect(s[1].end).toBeCloseTo(1.45);
  });
});

describe('similarity', () => {
  it('is LCS over the longer length', () => {
    expect(similarity(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
    expect(similarity(['a', 'x', 'c'], ['a', 'b', 'c'])).toBeCloseTo(2 / 3);
    expect(similarity([], ['a'])).toBe(0);
  });
});

describe('detectRetakes', () => {
  it('drops a restart cue and the earlier take of a repeated sentence', () => {
    expect(
      dropped('Welcome to WordEdits. Um, this is scene one, the hook. Uh, let me say that again. This is scene one, the hook. Now scene two explains how the app cuts your take.'),
    ).toEqual([1, 2]);
  });

  it('keeps parallel but different sentences', () => {
    expect(dropped('Step one is to open the app. Step two is to open the folder.')).toEqual([]);
  });

  it('drops a false start that the next sentence completes', () => {
    expect(dropped('So the main. So the main idea is speed.')).toEqual([0]);
  });

  it('drops a sentence made only of fillers', () => {
    expect(dropped('Hello there. Um. Uh. Next point.')).toEqual([1, 2]);
  });

  it('does not treat a whole unpunctuated take as retakes', () => {
    expect(dropped('so today we are going to talk about privacy and why it matters for every single user of the app')).toEqual([]);
  });

  it('uses the script to catch a retake beyond the lookahead', () => {
    const t = 'Our app is really fast. Wait. Okay. Hold on. Our app is really fast.';
    expect(dropped(t)).toEqual([]);
    expect(dropped(t, 'Our app is really fast.')).toEqual([0]);
  });

  it('gives each decision a readable reason', () => {
    const ws = words('So the main. So the main idea is speed.');
    const [d] = detectRetakes(splitSentences(ws), ws);
    expect(d.reason).toContain('So the main idea is speed.');
  });
});

describe('splitScript', () => {
  it('ignores markdown headings and splits sentences', () => {
    expect(splitScript('# Hook\nFirst line. Second line?\n\n## Body\nThird')).toEqual(['First line.', 'Second line?', 'Third']);
  });
});
