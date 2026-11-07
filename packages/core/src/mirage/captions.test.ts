// SPDX-License-Identifier: MIT
import type { Word } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { captionWarnings, groupWords, karaokeLines, keyWords, popLines, subtitleWarnings } from './captions.js';
import { groupCaptions } from './overlays.js';

const w = (text: string, start: number, end: number): Word => ({ w: text, start, end, conf: 1 });
/** Each line's time and the words it shows (words laid out but not said yet are hidden). */
const shown = (lines: { start: number; end: number; parts: { text: string; hidden?: boolean }[] }[]) => lines.map((l) => [l.start, l.end, l.parts.filter((p) => !p.hidden).map((p) => p.text).join(' ')]);

describe('groupWords', () => {
  it('matches the grouping groupCaptions has always done, and stops at maxWords', () => {
    const words = [w('Hello', 0.5, 0.8), w('there.', 0.8, 1.2), w('Next', 2.2, 2.5), w('bit.', 2.5, 2.9)];
    expect(groupWords(words, { maxChars: 38, maxGap: 0.6 }).map((g) => g.map((x) => x.text))).toEqual([['Hello', 'there.'], ['Next', 'bit.']]);
    expect(groupWords([w('a', 0, 1), w('b', 1, 2), w('c', 2, 3)], { maxChars: 38, maxWords: 2, maxGap: 0.6 }).map((g) => g.length)).toEqual([2, 1]);
    expect(groupCaptions(words, { durationSec: 10 }).map((c) => c.text)).toEqual(['Hello there.', 'Next bit.']);
  });
});

describe('popLines', () => {
  it('pops 1–3 words at a time, each appearing at its own start, the first 0.1 s early', () => {
    const lines = popLines([w('so', 1, 1.2), w('he', 1.3, 1.4), w('quietly', 1.5, 1.9), w('pours', 2.0, 2.3)], { durationSec: 5, highlight: [] });
    expect(shown(lines)).toEqual([
      [0.9, 1.3, 'SO'],
      [1.3, 1.5, 'SO HE'],
      [1.5, 1.9, 'SO HE QUIETLY'],
      [1.9, 2.4, 'POURS'],
    ]);
    expect(lines.map((l) => l.parts.map((p) => !!p.pop))).toEqual([[true, false, false], [false, true, false], [false, false, true], [true]]);
  });

  it('lays the whole group out from its first line, the words not said yet hidden, so said words never move', () => {
    const lines = popLines([w('so', 1, 1.2), w('he', 1.3, 1.4), w('quietly', 1.5, 1.9), w('pours', 2.0, 2.3)], { durationSec: 5, highlight: [] });
    expect(lines.map((l) => l.parts.map((p) => p.text))).toEqual([['SO', 'HE', 'QUIETLY'], ['SO', 'HE', 'QUIETLY'], ['SO', 'HE', 'QUIETLY'], ['POURS']]);
    expect(lines.map((l) => l.parts.map((p) => !!p.hidden))).toEqual([[false, true, true], [false, false, true], [false, false, false], [false]]);
  });

  it('breaks pop groups at a sentence end and at a gap over 0.6 s', () => {
    const lines = popLines([w('awful.', 0, 0.4), w('then', 0.4, 0.7), w('later', 1.4, 1.7), w('on', 1.7, 1.9)], { durationSec: 5, highlight: [] });
    expect(shown(lines).map((l) => l[2])).toEqual(['AWFUL.', 'THEN', 'LATER', 'LATER ON']);
  });

  it('holds a group at least 0.5 s, but not past the next group', () => {
    const lines = popLines([w('hi', 1, 1.1), w('there.', 3, 3.1)], { durationSec: 9, highlight: [] });
    expect(shown(lines)).toEqual([[0.9, 1.4, 'HI'], [2.9, 3.4, 'THERE.']]);
    const tight = popLines([w('hi.', 1, 1.1), w('yo', 1.2, 1.3)], { durationSec: 9, highlight: [] });
    expect(tight[0].end).toBe(1.1);
  });

  it('lights the first key word of a group only, every time a string highlight is said', () => {
    const words = [w('gulp', 0, 0.3), w('gulp', 0.3, 0.6), w('ok.', 0.6, 0.9), w('big', 2, 2.3), w('gulp', 2.3, 2.6)];
    const lines = popLines(words, { durationSec: 9, highlight: ['Gulp!'] });
    const keys = lines.map((l) => l.parts.map((p) => !!p.key));
    expect(keys[0]).toEqual([true, false, false]);
    expect(keys[1]).toEqual([true, false, false]); // second "gulp" of the same group is not lit
    expect(keys[2]).toEqual([true, false, false]);
    expect(keys[keys.length - 1]).toEqual([false, true]); // lit again in the next group
  });

  it('lights only the saying nearest `at` for { word, at }', () => {
    const words = [w('money', 2.0, 2.3), w('is', 2.3, 2.5), w('money', 6.0, 6.3)];
    expect([...keyWords(words, [{ word: 'money', at: 4.5 }])]).toEqual([2]);
    expect([...keyWords(words, [{ word: 'Money', at: 3 }])]).toEqual([0]);
    expect([...keyWords(words, ['money'])].sort()).toEqual([0, 2]);
    expect(keyWords(words, ['nope']).size).toBe(0);
    const lines = popLines(words, { durationSec: 9, highlight: [{ word: 'money', at: 4.5 }] });
    expect(lines.flatMap((l) => l.parts).filter((p) => p.key).length).toBeGreaterThan(0);
    expect(lines[0].parts.some((p) => p.key)).toBe(false);
    expect(lines[lines.length - 1].parts.some((p) => p.key)).toBe(true);
  });
});

describe('karaokeLines', () => {
  it('shows the phrase with the word being said lit', () => {
    const words = [w('Drink', 1, 1.3), w('this', 1.4, 1.6), w('and', 1.7, 1.8), w('you', 1.9, 2.0), w('get', 2.1, 2.2), w('magic!', 2.3, 2.9)];
    const lines = karaokeLines(words, { durationSec: 9 });
    expect(lines).toHaveLength(6);
    for (const [i, l] of lines.entries()) {
      expect(l.parts.map((p) => p.text)).toEqual(['Drink', 'this', 'and', 'you', 'get', 'magic!']);
      expect(l.parts.map((p) => !!p.lit)).toEqual(words.map((_, j) => j === i));
    }
    const cue = groupCaptions(words, { durationSec: 9 })[0];
    expect(lines[0].start).toBe(cue.start);
    expect(lines[5].end).toBe(cue.end);
    for (let i = 1; i < lines.length; i++) expect(lines[i].start).toBe(lines[i - 1].end);
    expect(lines[1].start).toBe(1.4);
  });
});

describe('robustness', () => {
  it('never emits empty parts, inverted lines, or lines past the next group', () => {
    const words = [w('hello', 1, 1.5), w('🚀', 1.5, 1.6), w('—', 1.6, 1.7), w('there', 1.2, 2.5), w('x', 1.4, 1.45), w('more.', 2.0, 2.1), w('next', 2.05, 2.2), w('', 2.3, 2.4)];
    for (const lines of [popLines(words, { durationSec: 4, highlight: ['hello'] }), karaokeLines(words, { durationSec: 4 })]) {
      expect(lines.length).toBeGreaterThan(0);
      for (const [i, l] of lines.entries()) {
        expect(l.end).toBeGreaterThan(l.start);
        expect(l.parts.length).toBeGreaterThan(0);
        for (const p of l.parts) expect(p.text.trim()).not.toBe('');
        if (i > 0) {
          expect(l.start).toBeGreaterThanOrEqual(lines[i - 1].start);
          expect(l.start).toBeGreaterThanOrEqual(lines[i - 1].end - 1e-9);
        }
      }
    }
    expect(popLines([w('🚀', 0, 1)], { durationSec: 3, highlight: [] })).toEqual([]);
    expect(karaokeLines([], { durationSec: 3 })).toEqual([]);
  });
});

describe('words with no letters', () => {
  it('are no caption of their own: a lone "—" after a gap or a sentence end gets no line and moves no neighbour', () => {
    const base = [w('first.', 0, 0.4), w('second', 3, 3.4)];
    const withDash = [w('first.', 0, 0.4), w('—', 1.5, 1.6), w('second', 3, 3.4)];
    expect(popLines(withDash, { durationSec: 9, highlight: [] })).toEqual(popLines(base, { durationSec: 9, highlight: [] }));
    expect(karaokeLines(withDash, { durationSec: 9 })).toEqual(karaokeLines(base, { durationSec: 9 }));
    const lone = popLines([w('...', 0, 1), w('hi', 2, 2.2)], { durationSec: 9, highlight: [] });
    expect(lone.flatMap((l) => l.parts.map((p) => p.text))).toEqual(['HI']);
  });
  it('are no part when they sit inside a group', () => {
    const words = [w('wait', 0, 0.3), w('—', 0.3, 0.4), w('what', 0.4, 0.7)];
    expect(shown(popLines(words, { durationSec: 9, highlight: [] })).map((l) => l[2])).toEqual(['WAIT', 'WAIT WHAT']);
    const karaoke = karaokeLines(words, { durationSec: 9 });
    expect(karaoke.map((l) => l.parts.map((p) => p.text))).toEqual([['wait', 'what'], ['wait', 'what']]);
  });
  it('still show in phrase captions, as before', () => {
    expect(groupCaptions([w('wait', 0, 0.3), w('—', 0.3, 0.4)], { durationSec: 9 }).map((c) => c.text)).toEqual(['wait —']);
  });
});

describe('captionWarnings', () => {
  const words = [w('gulp', 0, 0.3), w('glug.', 0.3, 0.6)];
  it('warns about highlight words never said, and highlight outside pop', () => {
    expect(captionWarnings(words, { style: 'pop', position: 'bottom', highlight: ['gulp', 'yuck'] })).toEqual(['captions.highlight "yuck" is never said in this video — check the spelling or remove it']);
    expect(captionWarnings(words, { style: 'pop', position: 'bottom', highlight: [{ word: 'Glug', at: 0 }, { word: 'zzz', at: 1 }, 'zzz'] })).toEqual(['captions.highlight "zzz" is never said in this video — check the spelling or remove it']);
    expect(captionWarnings(words, { style: 'karaoke', position: 'bottom', highlight: ['gulp'] })).toEqual(['captions.highlight only works with the "pop" style — it does nothing with "karaoke"']);
    expect(captionWarnings(words, { style: 'pop', position: 'bottom', highlight: [] })).toEqual([]);
    expect(captionWarnings(words, { style: 'phrase', position: 'bottom', highlight: [] })).toEqual([]);
    expect(captionWarnings(words, undefined)).toEqual([]);
  });
});

describe('subtitleWarnings', () => {
  const said = [w('Hello,', 1, 1.3), w('world', 1.4, 1.8), w('this', 1.9, 2.1), w('is', 2.1, 2.2), w('Mirage.', 2.3, 2.9)];
  const sub = (text: string, start: number, end: number, kind: 'subtitle' | 'label' | 'name' = 'subtitle') => ({ kind, text, start, end, tone: 'neutral' as const });
  const msg = (k: number, text: string, a: string, b: string) => `subtitle overlay ${k} ("${text}") doesn't match what's said at ${a}–${b} s — copy the words from the transcript`;

  it('is quiet for a subtitle whose words are said in its time, however they are cased or punctuated', () => {
    expect(subtitleWarnings(said, [sub('hello world, THIS is Mirage!', 1, 3)])).toEqual([]);
  });
  it('wants 80% of the words: 4 of 5 is enough, 3 of 5 is not', () => {
    expect(subtitleWarnings(said, [sub('hello world this is Dave', 1, 3)])).toEqual([]);
    expect(subtitleWarnings(said, [sub('hello world this Dave Dave', 1, 3)])).toEqual([msg(1, 'hello world this Dave Dave', '1.00', '3.00')]);
  });
  it('looks half a second before the subtitle starts and after it ends, and no further', () => {
    expect(subtitleWarnings(said, [sub('Mirage', 3.3, 4)])).toEqual([]);
    expect(subtitleWarnings(said, [sub('Mirage', 3.5, 4)])).toEqual([msg(1, 'Mirage', '3.50', '4.00')]);
    expect(subtitleWarnings(said, [sub('Hello', 0, 0.6)])).toEqual([]);
    expect(subtitleWarnings(said, [sub('Hello', 0, 0.4)])).toEqual([msg(1, 'Hello', '0.00', '0.40')]);
  });
  it('numbers overlays from 1 across all kinds, and judges only subtitles', () => {
    expect(subtitleWarnings(said, [sub('nonsense', 1, 2, 'label'), sub('nonsense', 1, 2, 'name'), sub('nonsense', 1, 2)])).toEqual([msg(3, 'nonsense', '1.00', '2.00')]);
  });
  it('says nothing about a subtitle with no words to compare (only emoji or marks)', () => {
    expect(subtitleWarnings(said, [sub('🚀 —', 1, 2)])).toEqual([]);
    expect(subtitleWarnings([], [])).toEqual([]);
  });
  it('warns about every subtitle when nothing is said', () => {
    expect(subtitleWarnings([], [sub('anything', 1, 2)])).toEqual([msg(1, 'anything', '1.00', '2.00')]);
  });
});
