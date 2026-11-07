import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type Catalog, type Transcript, type Word } from '@wordedits/shared';
import { run } from '@wordedits/sidecars';
import { describe, expect, it } from 'vitest';
import type { CaptionLine } from './captions.js';
import { buildAss, groupCaptions, keptSegments, speechWords, toSrt, undrawable } from './overlays.js';

const w = (text: string, start: number, end: number): Word => ({ w: text, start, end, conf: 1 });
const tx = (words: Word[]): Transcript => ({ words, segments: [], speech: [] });
const catalog: Catalog = {
  version: 1,
  clips: [
    { id: 'c001', path: '/t.mov', sha256: 'a'.repeat(64), probe: { durationSec: 10, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', colorTransfer: null }, kind: 'talking', transcript: tx([w('Hello', 1, 1.4), w('um', 1.5, 1.8), w('world.', 2, 2.5), w('later', 6, 6.5)]), frames: [], notes: '', moments: [] },
  ],
};
const ep = EpisodeSchema.parse({
  version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
  items: [
    { id: 'a', beat: 'cold-open', clip: 'c001', src: { in: 1, out: 3 }, audio: 'keep' },
    { id: 'b', beat: 'montage', clip: 'c001', src: { in: 5, out: 7 } },
  ],
  voiceover: { recording: 'vo.m4a', lines: [{ slot: 'n1', at: 2.5, src: { in: 10, out: 12 }, cuts: [[10.5, 11]] }] },
});

describe('speechWords', () => {
  it('keeps a voice-over word whose start falls just inside a cut (filler padding) but whose body is kept', () => {
    // The line cuts [10.5, 11]; "cached" starts 20 ms before the cut ends.
    const vo = tx([w('Narration', 10.1, 10.4), w('cached', 10.98, 11.4), w('here.', 11.5, 11.8)]);
    const words = speechWords(ep, catalog, vo).filter((x) => x.start >= 2.5);
    expect(words.map((x) => [x.w, x.start, x.end])).toEqual([
      ['Narration', 2.6, 2.9],
      ['cached', 3, 3.4],
      ['here.', 3.5, 3.8],
    ]);
  });

  it('maps kept live words and voice-over words to output time, dropping fillers and muted items', () => {
    const vo = tx([w('Narration', 10.1, 10.4), w('uh', 10.6, 10.9), w('here.', 11.2, 11.8)]);
    expect(speechWords(ep, catalog, vo).map((x) => [x.w, x.start, x.end])).toEqual([
      ['Hello', 0, 0.4],
      ['world.', 1, 1.5],
      ['Narration', 2.6, 2.9],
      ['here.', 3.2, 3.8],
    ]);
  });
});

describe('keptSegments', () => {
  it('splits a line around its cuts with running output offsets', () => {
    expect(keptSegments({ slot: 'n1', at: 0, src: { in: 10, out: 12 }, cuts: [[10.5, 11]] })).toEqual([
      { in: 10, out: 10.5, offset: 0 },
      { in: 11, out: 12, offset: 0.5 },
    ]);
  });
  it('clamps cuts to the line so a cut past the end cannot extend a segment', () => {
    expect(keptSegments({ slot: 'n1', at: 0, src: { in: 10, out: 12 }, cuts: [[13, 14]] })).toEqual([{ in: 10, out: 12, offset: 0 }]);
    expect(keptSegments({ slot: 'n1', at: 0, src: { in: 10, out: 12 }, cuts: [[9, 10.5]] })).toEqual([{ in: 10.5, out: 12, offset: 0 }]);
  });
});

describe('groupCaptions and toSrt', () => {
  it('breaks at sentence ends and maxChars, never overlapping', () => {
    const cues = groupCaptions([w('Hello', 0.5, 0.8), w('there.', 0.8, 1.2), w('Next', 2.2, 2.5), w('bit.', 2.5, 2.9)], { durationSec: 10 });
    expect(cues.map((c) => c.text)).toEqual(['Hello there.', 'Next bit.']);
    expect(cues[0].start).toBeCloseTo(0.35);
    expect(cues[1].start).toBeGreaterThanOrEqual(cues[0].end);
    expect(toSrt(cues.slice(0, 1))).toBe('1\n00:00:00,350 --> 00:00:01,200\nHello there.\n');
  });
  it('never emits a cue that ends before it starts, and keeps starts monotonic, for overlapping words', () => {
    const cues = groupCaptions([w('one', 1.0, 1.4), w('two.', 1.2, 3.0), w('three four.', 1.5, 2.2), w('five', 2.3, 2.6)], { durationSec: 10 });
    expect(cues.length).toBeGreaterThan(0);
    for (const [i, c] of cues.entries()) {
      expect(c.end).toBeGreaterThan(c.start);
      if (i > 0) {
        expect(c.start).toBeGreaterThanOrEqual(cues[i - 1].start);
        expect(c.start).toBeGreaterThanOrEqual(cues[i - 1].end);
      }
    }
  });
});

describe('buildAss', () => {
  const ass = buildAss({
    width: 1920, height: 1080, font: 'Helvetica Neue',
    captions: [{ start: 0.05, end: 1.3, text: 'Hi {there}' }],
    overlays: [
      { kind: 'callout', text: '3 DAYS', start: 1, end: 2.5, tone: 'neutral' },
      { kind: 'badge', text: 'FAILED', start: 3, end: 5, tone: 'fail' },
      { kind: 'counter', text: '12 h · 48 commits', start: 0, end: 10, tone: 'neutral' },
    ],
    prompts: [{ id: 'n1', start: 4, end: 9, maxWords: 12, line: 'Every request took ten seconds.' }],
  });
  it('declares one style per overlay kind sized to the frame', () => {
    expect(ass).toContain('PlayResX: 1920');
    for (const s of ['Caption', 'Callout', 'BadgeFail', 'BadgePass', 'BadgeLive', 'BadgeNeutral', 'Counter', 'Label', 'Chapter', 'Before', 'Prompt', 'PromptNext']) {
      expect(ass).toMatch(new RegExp(`^Style: ${s},`, 'm'));
    }
    expect(ass).toContain('Style: Caption,Helvetica Neue,64,');
  });
  it('writes events for captions, overlays and prompts, escaping braces', () => {
    expect(ass).toContain('Dialogue: 2,0:00:00.05,0:00:01.30,Caption,,0,0,0,,Hi (there)');
    expect(ass).toMatch(/Dialogue: 5,0:00:01\.00,0:00:02\.50,Callout,,0,0,0,,\{\\fad\(120,200\)[^}]*\}3 DAYS/);
    expect(ass).toContain(',BadgeFail,,0,0,0,,{\\fad(100,150)}FAILED');
    expect(ass).toContain('Dialogue: 6,0:00:02.50,0:00:04.00,PromptNext,,0,0,0,,Next: Every request took ten seconds.');
    expect(ass).toContain('Dialogue: 6,0:00:04.00,0:00:09.00,Prompt,,0,0,0,,Every request took ten seconds.');
  });
});

describe('buildAss without captions settings', () => {
  it('writes exactly what it always has (no Pop or Karaoke style, the caption at the bottom)', () => {
    const o = { width: 1920, height: 1080, font: 'Helvetica Neue', cjkFont: null, captions: [{ start: 0.05, end: 1.3, text: 'Hi {there}' }], overlays: [{ kind: 'badge' as const, text: 'FAILED', start: 3, end: 5, tone: 'fail' as const }], prompts: [] };
    const today =
      '[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n' +
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
      'Style: Caption,Helvetica Neue,64,&H00FFFFFF,&H00FFFFFF,&H4D000000,&H4D000000,-1,0,0,0,100,100,0,0,3,18,0,2,96,96,90,1\n' +
      'Style: Callout,Helvetica Neue,150,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,5,96,96,0,1\n' +
      'Style: BadgeFail,Helvetica Neue,48,&H00FFFFFF,&H00FFFFFF,&H002A2AE0,&H002A2AE0,-1,0,0,0,100,100,0,0,3,14,0,9,96,96,60,1\n' +
      'Style: BadgePass,Helvetica Neue,48,&H00FFFFFF,&H00FFFFFF,&H004EAA2E,&H004EAA2E,-1,0,0,0,100,100,0,0,3,14,0,9,96,96,60,1\n' +
      'Style: BadgeLive,Helvetica Neue,48,&H00FFFFFF,&H00FFFFFF,&H00E37100,&H00E37100,-1,0,0,0,100,100,0,0,3,14,0,9,96,96,60,1\n' +
      'Style: BadgeNeutral,Helvetica Neue,48,&H00FFFFFF,&H00FFFFFF,&H00333333,&H00333333,-1,0,0,0,100,100,0,0,3,14,0,9,96,96,60,1\n' +
      'Style: Counter,Helvetica Neue,40,&H00FFFFFF,&H00FFFFFF,&H4D000000,&H4D000000,-1,0,0,0,100,100,0,0,3,12,0,7,96,96,60,1\n' +
      'Style: Label,Helvetica Neue,48,&H00FFFFFF,&H00FFFFFF,&H4D000000,&H4D000000,-1,0,0,0,100,100,0,0,3,14,0,1,96,96,220,1\n' +
      'Style: Chapter,Helvetica Neue,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,5,96,96,0,1\n' +
      'Style: Before,Helvetica Neue,56,&H00FFFFFF,&H00FFFFFF,&H4D000000,&H4D000000,-1,0,0,0,100,100,0,0,3,14,0,8,96,96,60,1\n' +
      'Style: Prompt,Helvetica Neue,54,&H0000D7FF,&H0000D7FF,&H4D000000,&H4D000000,-1,0,0,0,100,100,0,0,3,16,0,8,96,96,150,1\n' +
      'Style: PromptNext,Helvetica Neue,44,&H00B4B4B4,&H00B4B4B4,&H4D000000,&H4D000000,0,0,0,0,100,100,0,0,3,14,0,8,96,96,150,1\n\n' +
      '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
      'Dialogue: 2,0:00:00.05,0:00:01.30,Caption,,0,0,0,,Hi (there)\nDialogue: 4,0:00:03.00,0:00:05.00,BadgeFail,,0,0,0,,{\\fad(100,150)}FAILED\n';
    expect(buildAss(o)).toBe(today);
    // A phrase caption at the bottom, said out loud, is the same file.
    expect(buildAss({ ...o, position: 'bottom' })).toBe(today);
  });
});

describe('buildAss pop and karaoke captions', () => {
  const base = { width: 1080, height: 1920, cjkFont: null, captions: [], overlays: [], prompts: [] };
  const pop: CaptionLine[] = [
    { start: 0.9, end: 1.3, parts: [{ text: 'SO', pop: true }, { text: 'HE', hidden: true }, { text: 'QUIETLY', hidden: true }] },
    { start: 1.3, end: 1.5, parts: [{ text: 'SO' }, { text: 'HE', pop: true }, { text: 'QUIETLY', hidden: true }] },
    { start: 1.5, end: 1.9, parts: [{ text: 'SO' }, { text: 'HE' }, { text: 'QUIETLY', pop: true }] },
    { start: 1.9, end: 2.4, parts: [{ text: 'GULP', key: true }, { text: 'IT', pop: true }] },
    { start: 2.4, end: 2.9, parts: [{ text: 'GULP', key: true, pop: true }] },
  ];
  const lines = (ass: string, style: string, layer = 2) => ass.split('\n').filter((l) => l.startsWith(`Dialogue: ${layer},`) && l.split(',')[3] === style);
  const style = (ass: string, name: string) => ass.split('\n').find((l) => l.startsWith(`Style: ${name},`))!.split(',');

  it('declares a Pop style in Montserrat ExtraBold and pops in the newest word', () => {
    const ass = buildAss({ ...base, captionLines: { style: 'pop', lines: pop } });
    // Name, Fontname, Fontsize, Primary, Secondary, Outline, Back, Bold, …, BorderStyle, Outline, Shadow, Alignment, L, R, MarginV
    expect(style(ass, 'Pop')).toEqual(['Style: Pop', 'Montserrat ExtraBold', '84', '&H00FFFFFF', '&H00FFFFFF', '&H00000000', '&H00000000', '0', '0', '0', '0', '100', '100', '0', '0', '1', '7', '0', '2', '54', '54', '120', '1']);
    expect(ass).not.toMatch(/^Style: Karaoke,/m);
    // The newest word pops in on a layer of its own (the rest of the line drawn there invisibly, for the same layout),
    // so its growing never moves the words already shown; the line under it (layer 1) holds the newest word's place
    // invisibly, and the popping copy is layer 2 so the newest word draws over its neighbours.
    expect(ass).toContain('Dialogue: 2,0:00:01.50,0:00:01.90,Pop,,0,0,0,,{\\alpha&HFF&}SO{\\r} {\\alpha&HFF&}HE{\\r} {\\fscx115\\fscy115\\t(0,120,\\fscx100\\fscy100)}QUIETLY');
    expect(ass).toContain('Dialogue: 1,0:00:01.50,0:00:01.90,Pop,,0,0,0,,SO HE {\\alpha&HFF&}QUIETLY{\\r}');
    expect(lines(ass, 'Pop', 1)).toHaveLength(5);
    expect(lines(ass, 'Pop')).toHaveLength(5);
    expect(lines(ass, 'Caption')).toEqual([]);
  });

  it('draws the words of the group not said yet fully transparent, outline too, at their own size', () => {
    const ass = buildAss({ ...base, captionLines: { style: 'pop', lines: pop } });
    expect(lines(ass, 'Pop', 1)[0]).toMatch(/,,\{\\alpha&HFF&\}SO\{\\r\} \{\\alpha&HFF&\}HE\{\\r\} \{\\alpha&HFF&\}QUIETLY\{\\r\}$/);
    expect(lines(ass, 'Pop')[0]).toMatch(/,,\{\\fscx115\\fscy115\\t\(0,120,\\fscx100\\fscy100\)\}SO\{\\r\} \{\\alpha&HFF&\}HE\{\\r\} \{\\alpha&HFF&\}QUIETLY\{\\r\}$/);
    // A hidden key word keeps its 112% so the words around it sit where they will.
    const hiddenKey = buildAss({ ...base, captionLines: { style: 'pop', lines: [{ start: 0, end: 1, parts: [{ text: 'A', pop: true }, { text: 'GULP', key: true, hidden: true }] }] } });
    expect(lines(hiddenKey, 'Pop', 1)[0]).toMatch(/\{\\alpha&HFF&\\fscx112\\fscy112\}GULP\{\\r\}$/);
  });

  it('draws a key word in the highlight colour at 112%, then goes back to the style', () => {
    const ass = buildAss({ ...base, captionLines: { style: 'pop', lines: pop } });
    expect(lines(ass, 'Pop', 1)[3]).toMatch(/,,\{\\c&H003DFFC6&\\fscx112\\fscy112\}GULP\{\\r\} \{\\alpha&HFF&\}IT\{\\r\}$/);
    expect(lines(ass, 'Pop')[3]).toMatch(/,,\{\\alpha&HFF&\\fscx112\\fscy112\}GULP\{\\r\} \{\\fscx115\\fscy115\\t\(0,120,\\fscx100\\fscy100\)\}IT$/);
    // A key word that is also the newest pops in from 115% of its 112%.
    expect(lines(ass, 'Pop')[4]).toMatch(/,,\{\\c&H003DFFC6&\\fscx129\\fscy129\\t\(0,120,\\fscx112\\fscy112\)\}GULP\{\\r\}$/);
    expect(buildAss({ ...base, captionLines: { style: 'pop', lines: pop }, highlightColor: '#FF0000' })).toContain('{\\c&H000000FF&\\fscx112\\fscy112}GULP{\\r}');
  });

  it('declares a Karaoke style and lights the word being said', () => {
    const ass = buildAss({ ...base, captionLines: { style: 'karaoke', lines: [{ start: 0, end: 1, parts: [{ text: 'Every' }, { text: 'request', lit: true }, { text: 'took' }] }] } });
    expect(style(ass, 'Karaoke')).toEqual(['Style: Karaoke', 'Montserrat ExtraBold', '64', '&H00FFFFFF', '&H00FFFFFF', '&H00000000', '&H00000000', '0', '0', '0', '0', '100', '100', '0', '0', '1', '5', '0', '2', '54', '54', '120', '1']);
    expect(ass).not.toMatch(/^Style: Pop,/m);
    expect(lines(ass, 'Karaoke')).toEqual(['Dialogue: 2,0:00:00.00,0:00:01.00,Karaoke,,0,0,0,,Every {\\c&H003DFFC6&}request{\\r} took']);
  });

  it('escapes, drops emoji and switches font for CJK in caption parts, as everywhere else', () => {
    const ass = buildAss({ ...base, cjkFont: 'Hiragino Sans GB', captionLines: { style: 'pop', lines: [{ start: 0, end: 1, parts: [{ text: '{HI}' }, { text: '漢字', key: true }, { text: '🚀' }, { text: 'GO', pop: true }] }] } });
    expect(lines(ass, 'Pop', 1)).toEqual(['Dialogue: 1,0:00:00.00,0:00:01.00,Pop,,0,0,0,,(HI) {\\c&H003DFFC6&\\fscx112\\fscy112}{\\fnHiragino Sans GB}漢字{\\fn}{\\r} {\\alpha&HFF&}GO{\\r}']);
    expect(lines(ass, 'Pop')).toEqual(['Dialogue: 2,0:00:00.00,0:00:01.00,Pop,,0,0,0,,{\\alpha&HFF&}(HI){\\r} {\\alpha&HFF&\\fscx112\\fscy112}{\\fnHiragino Sans GB}漢字{\\fn}{\\r} {\\fscx115\\fscy115\\t(0,120,\\fscx100\\fscy100)}GO']);
  });

  it('puts every caption style in the middle of the frame for position middle', () => {
    expect(style(buildAss({ ...base, position: 'middle', captionLines: { style: 'pop', lines: pop } }), 'Pop').slice(18, 22)).toEqual(['2', '54', '54', '730']);
    expect(style(buildAss({ ...base, position: 'middle', captionLines: { style: 'karaoke', lines: [] } }), 'Karaoke')[21]).toBe('730');
    expect(style(buildAss({ ...base, position: 'middle' }), 'Caption')[21]).toBe('730');
    expect(style(buildAss({ ...base, position: 'bottom' }), 'Caption')[21]).toBe('90');
    // Sizes scale with the frame: the rough cut of a vertical video is 540×960.
    const small = buildAss({ ...base, width: 540, height: 960, position: 'middle', captionLines: { style: 'pop', lines: pop } });
    expect(style(small, 'Pop').slice(2, 3).concat(style(small, 'Pop').slice(16, 17), style(small, 'Pop').slice(21, 22))).toEqual(['42', '4', '365']);
  });
});

describe('speechWords with the written line', () => {
  const said = (text: string, t0: number) => text.split(' ').map((x, i) => w(x, +(t0 + i * 0.4).toFixed(3), +(t0 + i * 0.4 + 0.3).toFixed(3)));
  const withLine = (text: string, src: { in: number; out: number }) =>
    EpisodeSchema.parse({ ...ep, items: [{ id: 'b', beat: 'montage', clip: 'c001', src: { in: 5, out: 10 } }], voiceover: { recording: 'vo.m4a', lines: [{ slot: 'n1', at: 1, src, cuts: [], text }] } });

  it('captions voice-over in the written spelling, with the transcribed timing', () => {
    const vo = tx(said('Every request took 10 seconds so I rewrote the back end.', 20));
    const words = speechWords(withLine('Every request took ten seconds, so I rewrote the backend.', { in: 19.95, out: 24.5 }), catalog, vo);
    expect(words.map((x) => x.w)).toEqual(['Every', 'request', 'took', 'ten', 'seconds,', 'so', 'I', 'rewrote', 'the', 'backend.']);
    const ten = words[3];
    expect([ten.start, ten.end]).toEqual([2.25, 2.55]);
    const backend = words[9];
    expect(backend.start).toBeCloseTo(1 + 0.05 + 3.6, 3);
    expect(backend.end).toBeCloseTo(1 + 0.05 + 4.3, 3);
    for (const x of words) {
      expect(x.start).toBeGreaterThanOrEqual(1);
      expect(x.end).toBeLessThanOrEqual(1 + 4.55);
    }
  });

  it('never captions written words the kept audio does not have', () => {
    // The take stops at "the back." — the written line goes on to "backend in one long night".
    const vo = tx(said('So I cashed the forecast and rewrote the back.', 20));
    const words = speechWords(withLine('So I cached the forecast and rewrote the backend in one long night.', { in: 19.95, out: 23.95 }), catalog, vo);
    expect(words.map((x) => x.w)).toEqual(['So', 'I', 'cached', 'the', 'forecast', 'and', 'rewrote', 'the', 'back.']);
    expect(words[words.length - 1].end).toBeCloseTo(1 + 0.05 + 3.5, 3);
  });

  it('keeps extra spoken words and drops written words that were never said', () => {
    const vo = tx(said('So the build really kept failing.', 20));
    const words = speechWords(withLine('So the build kept failing badly.', { in: 19.95, out: 23 }), catalog, vo);
    expect(words.map((x) => x.w)).toEqual(['So', 'the', 'build', 'really', 'kept', 'failing']);
  });
});

describe('speechWords with several recordings', () => {
  it('reads each line\'s words from its own recording\'s transcript', () => {
    const e = EpisodeSchema.parse({ ...ep, items: [{ id: 'b', beat: 'montage', clip: 'c001', src: { in: 5, out: 10 } }], voiceover: { recording: 'vo.m4a', lines: [
      { slot: 'n1', at: 0, src: { in: 0, out: 1 }, cuts: [] },
      { slot: 'n2', at: 2, src: { in: 0, out: 1 }, cuts: [], recording: 'n2.m4a' },
    ] } });
    const map = new Map([['vo.m4a', tx([w('First.', 0.1, 0.5)])], ['n2.m4a', tx([w('Second.', 0.2, 0.6)])]]);
    expect(speechWords(e, catalog, map).map((x) => [x.w, x.start])).toEqual([['First.', 0.1], ['Second.', 2.2]]);
  });
});

describe('buildAss text the fonts can draw', () => {
  const one = (text: string, o: { font?: string; cjkFont?: string | null } = {}, kind: 'label' | 'counter' = 'label') =>
    buildAss({ width: 640, height: 360, captions: [], overlays: [{ kind, text, start: 0, end: 2, tone: 'neutral' }], prompts: [], ...o });
  const dialogue = (ass: string) => ass.split('\n').find((l) => l.startsWith('Dialogue:'))!;

  it('leaves emoji out of overlay text, as captions do', () => {
    expect(dialogue(one('Shipped 🚀 it ✅', { cjkFont: null }))).toMatch(/,\{\\fad\(150,150\)\}Shipped it$/);
  });

  it('sets CJK runs in a font that has them', () => {
    expect(dialogue(one('Day 3 漢字かな done', { cjkFont: 'Hiragino Sans GB' }))).toMatch(/Day 3 \{\\fnHiragino Sans GB\}漢字かな\{\\fn\} done$/);
    expect(dialogue(one('Day 3 漢字', { cjkFont: null }))).toMatch(/Day 3 漢字$/);
  });

  it('names overlay text that has characters which cannot be drawn', () => {
    expect(undrawable('Ship it 🚀')).toBe(true);
    expect(undrawable('漢字 עברית')).toBe(false);
  });

  it('keeps symbols the fonts draw (©, ®, ™, ⚠, ▶, ✔, ↔), leaving out only colour emoji', () => {
    expect(dialogue(one('Mirage™ © 2026 ▶ ⚠ ✔ ↔ ®', { cjkFont: null }))).toMatch(/\}Mirage™ © 2026 ▶ ⚠ ✔ ↔ ®$/);
    expect(undrawable('Mirage™ © 2026 ▶ ⚠ ✔ ↔ ®')).toBe(false);
    // An emoji-style variation selector is dropped and the symbol kept; ZWJ sequences, flags and skin tones go whole.
    expect(dialogue(one('Careful ⚠️ 1️⃣ dev 👩🏽‍💻 🇫🇷 ❤️‍🔥 done ✅ ⌚', { cjkFont: null }))).toMatch(/\}Careful ⚠ 1 dev done$/);
    expect(undrawable('Careful ⚠️')).toBe(false);
    expect(undrawable('👩🏽‍💻')).toBe(true);
    expect(undrawable('❤️‍🔥')).toBe(true);
    expect(undrawable('🕶')).toBe(true);
  });

  it('keeps drawable symbols in captions too', () => {
    const cues = groupCaptions([{ w: 'Mirage™', start: 0, end: 0.4, conf: 1 }, { w: '▶', start: 0.5, end: 0.6, conf: 1 }, { w: '🚀', start: 0.7, end: 0.8, conf: 1 }], { durationSec: 2 });
    expect(cues.map((c) => c.text)).toEqual(['Mirage™ ▶']);
  });

  it.runIf(process.platform === 'darwin')('draws Han characters on macOS instead of empty boxes (real frame)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-ass-'));
    const frame = async (name: string, ass: string) => {
      await writeFile(join(dir, `${name}.ass`), ass);
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=gray:s=640x360:d=1', '-vf', `ass=${name}.ass,format=gray`, '-frames:v', '1', '-f', 'rawvideo', `${name}.gray`], { cwd: dir });
      return readFile(join(dir, `${name}.gray`));
    };
    const diff = (a: Buffer, b: Buffer) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
    // A counter has no fade-in, so it is fully drawn on the first frame.
    const drawn = await frame('drawn', one('漢字', {}, 'counter'));
    // The same text set in the CJK font throughout is the reference; the style font alone shows boxes.
    const reference = await frame('reference', one('漢字', { font: 'Hiragino Sans GB', cjkFont: null }, 'counter'));
    const boxes = await frame('boxes', one('漢字', { cjkFont: null }, 'counter'));
    expect(diff(drawn, reference)).toBeLessThan(0.01);
    expect(diff(boxes, reference)).toBeGreaterThan(0.05);
  }, 60_000);
});

describe('buildAss cards', () => {
  const base = { cjkFont: null, captions: [], overlays: [], prompts: [] };
  const style = (ass: string, name: string) => ass.split('\n').find((l) => l.startsWith(`Style: ${name},`))?.split(',');
  const lines = (ass: string, name: string) => ass.split('\n').filter((l) => l.startsWith('Dialogue:') && l.split(',')[3] === name);
  const mono = { text: 'Sam\nVlog #3\n11-6-26', style: 'mono' as const, sec: 2 };
  const bold = { text: 'Day 3', style: 'bold' as const, sec: 1.5 };

  it('draws a mono card in the bundled monospace, 72 px at 1080, centred, its lines as written, fading in and out over 150 ms', () => {
    const ass = buildAss({ ...base, width: 1920, height: 1080, cards: [{ start: 0, end: 2, card: mono }] });
    // White, no outline or faux bold, centred (5), the usual 5% side margins.
    expect(style(ass, 'CardMono')).toEqual(['Style: CardMono', 'JetBrains Mono', '72', '&H00FFFFFF', '&H00FFFFFF', '&H00000000', '&H00000000', '0', '0', '0', '0', '100', '100', '0', '0', '1', '0', '0', '5', '96', '96', '0', '1']);
    expect(lines(ass, 'CardMono')).toEqual(['Dialogue: 0,0:00:00.00,0:00:02.00,CardMono,,0,0,0,,{\\fad(150,150)}Sam\\NVlog #3\\N11-6-26']);
    expect(style(ass, 'CardBold')).toBeUndefined();
  });

  it('draws a bold card in Montserrat ExtraBold, 110 px at 1080, centred, wrapping inside 80% of the width', () => {
    const ass = buildAss({ ...base, width: 1920, height: 1080, cards: [{ start: 3.5, end: 5, card: bold }] });
    expect(style(ass, 'CardBold')).toEqual(['Style: CardBold', 'Montserrat ExtraBold', '110', '&H00FFFFFF', '&H00FFFFFF', '&H00000000', '&H00000000', '0', '0', '0', '0', '100', '100', '0', '0', '1', '0', '0', '5', '192', '192', '0', '1']);
    expect(lines(ass, 'CardBold')).toEqual(['Dialogue: 0,0:00:03.50,0:00:05.00,CardBold,,0,0,0,,{\\fad(150,150)}Day 3']);
    expect(style(ass, 'CardMono')).toBeUndefined();
  });

  it("draws an image card's text like a bold card with an 8 px black outline, and nothing for one without text", () => {
    const pic = (text: string) => ({ text, style: 'image' as const, sec: 2, image: 'pics/a.png' });
    const ass = buildAss({ ...base, width: 1920, height: 1080, cards: [{ start: 0, end: 2, card: pic('Tokyo') }, { start: 2, end: 4, card: pic('') }] });
    expect(lines(ass, 'CardBold')).toEqual(['Dialogue: 0,0:00:00.00,0:00:02.00,CardBold,,0,0,0,,{\\fad(150,150)\\bord8}Tokyo']);
    expect(ass.split('\n').filter((l) => l.startsWith('Dialogue:'))).toHaveLength(1);
    // A picture alone declares no card style.
    expect(style(buildAss({ ...base, width: 1920, height: 1080, cards: [{ start: 0, end: 2, card: pic('') }] }), 'CardBold')).toBeUndefined();
  });

  it('scales with the frame (a vertical rough cut at 540 × 960)', () => {
    const ass = buildAss({ ...base, width: 540, height: 960, cards: [{ start: 0, end: 2, card: mono }, { start: 2, end: 3.5, card: bold }, { start: 3.5, end: 5, card: { text: 'x', style: 'image', sec: 1.5, image: 'a.png' } }] });
    expect(style(ass, 'CardMono')!.slice(2, 3)).toEqual(['36']);
    expect(style(ass, 'CardMono')!.slice(19, 22)).toEqual(['27', '27', '0']);
    expect(style(ass, 'CardBold')!.slice(2, 3)).toEqual(['55']);
    expect(style(ass, 'CardBold')!.slice(19, 22)).toEqual(['54', '54', '0']);
    expect(lines(ass, 'CardBold')[1]).toMatch(/\{\\fad\(150,150\)\\bord4\}x$/);
  });

  it('draws card text as other text is drawn: braces escaped, emoji left out, CJK in a font that has it, each line trimmed', () => {
    const ass = buildAss({ ...base, cjkFont: 'Hiragino Sans GB', width: 1920, height: 1080, cards: [{ start: 0, end: 2, card: { text: ' {Day} 3 🚀 \n 東京 ', style: 'bold', sec: 2 } }] });
    expect(lines(ass, 'CardBold')).toEqual(['Dialogue: 0,0:00:00.00,0:00:02.00,CardBold,,0,0,0,,{\\fad(150,150)}(Day) 3\\N{\\fnHiragino Sans GB}東京{\\fn}']);
  });

  it('writes exactly what it always has without cards', () => {
    const o = { ...base, width: 1920, height: 1080, font: 'Helvetica Neue' };
    expect(buildAss({ ...o, cards: [] })).toBe(buildAss(o));
    expect(buildAss(o)).not.toContain('Card');
  });
});
