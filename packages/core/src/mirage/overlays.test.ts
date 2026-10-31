import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type Catalog, type Transcript, type Word } from '@wordedits/shared';
import { run } from '@wordedits/sidecars';
import { describe, expect, it } from 'vitest';
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
