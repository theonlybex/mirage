import { EpisodeSchema, type Catalog, type Transcript, type Word } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { fitVoiceover, holdAt } from './voiceover.js';
import { layoutTimeline, timelineDuration } from './timeline.js';

function said(text: string, t0: number, per = 0.3): Word[] {
  return text.split(' ').map((w, i) => ({ w, start: +(t0 + i * per).toFixed(3), end: +(t0 + i * per + 0.25).toFixed(3), conf: 1 }));
}
const tx = (words: Word[]): Transcript => ({ words, segments: [], speech: [] });
const catalog = (dur: number): Catalog => ({
  version: 1,
  clips: [{ id: 'c001', path: '/s.mp4', sha256: 'a'.repeat(64), probe: { durationSec: dur, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: false, videoCodec: 'h264', audioCodec: null }, kind: 'screen', transcript: null, frames: [], notes: '', moments: [] }],
});
const episode = (slots: object[]) =>
  EpisodeSchema.parse({
    version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
    items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 20 } }],
    overlays: [{ kind: 'badge', text: 'LIVE', start: 15, end: 18, tone: 'live' }],
    slots,
  });

const SLOTS = [
  { id: 'n1', start: 2, end: 5, maxWords: 7, line: 'This is the first line.' },
  { id: 'n2', start: 10, end: 12, maxWords: 4, line: 'And here is the second one.' },
];
const RECORDING = tx([
  ...said('This is the first line.', 0),
  ...said('This is the first line.', 2),
  { w: 'Um,', start: 3.6, end: 3.9, conf: 1 },
  ...said('And here is the second one.', 4, 0.45),
]);

describe('fitVoiceover', () => {
  it('keeps the last take, places it at the slot start and reports the takes', () => {
    const { episode: ep, report } = fitVoiceover({ episode: episode(SLOTS), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    const n1 = ep.voiceover!.lines.find((l) => l.slot === 'n1')!;
    expect(n1.src.in).toBeCloseTo(1.95);
    expect(n1.src.out).toBeCloseTo(3.55);
    expect(n1.at).toBeCloseTo(2.15);
    expect(report.lines[0]).toMatchObject({ slot: 'n1', status: 'placed', takes: 2, overrunSec: 0 });
  });

  it('holds the picture when a line runs past its slot, shifting what follows', () => {
    const { episode: ep, report } = fitVoiceover({ episode: episode(SLOTS), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    expect(report.lines[1].status).toBe('placed');
    expect(report.lines[1].overrunSec).toBeGreaterThan(0.5);
    expect(timelineDuration(ep)).toBeCloseTo(20 + report.extendedSec, 3);
    expect(ep.items[0].hold).toBeCloseTo(report.extendedSec, 3);
    expect(ep.overlays[0].start).toBeCloseTo(15 + report.extendedSec, 3);
    expect(ep.voiceover!.recording).toBe('vo.m4a');
  });

  it('reports a line it cannot find as missing, without moving anything', () => {
    const slots = [SLOTS[0], { id: 'n3', start: 14, end: 18, maxWords: 11, line: 'Completely different words appear here.' }];
    const { episode: ep, report } = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    expect(report.lines.map((l) => [l.slot, l.status])).toEqual([['n1', 'placed'], ['n3', 'missing']]);
    expect(ep.voiceover!.lines.map((l) => l.slot)).toEqual(['n1']);
  });

  it('cuts fillers and long pauses inside a line', () => {
    const rec = tx([...said('So the build', 0), { w: 'uh', start: 1.0, end: 1.3, conf: 1 }, ...said('kept failing.', 2.5)]);
    const slots = [{ id: 'n1', start: 0, end: 6, maxWords: 15, line: 'So the build kept failing.' }];
    const line = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: rec }).episode.voiceover!.lines[0];
    expect(line.cuts).toEqual([[0.98, 2.35]]);
  });

  it('throws NOTHING_MATCHED when no line is found', () => {
    expect(() => fitVoiceover({ episode: episode(SLOTS), catalog: catalog(20), recording: 'vo.m4a', transcript: tx(said('Totally unrelated speech.', 0)) })).toThrow(expect.objectContaining({ code: 'NOTHING_MATCHED' }));
  });
});

describe('holdAt', () => {
  it('uses unused source before freezing frames', () => {
    const ep = EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 5 } }] });
    const held = holdAt(ep, catalog(6), 5, 2);
    expect(held.items[0].src.out).toBeCloseTo(6);
    expect(held.items[0].hold).toBeCloseTo(1);
    expect(layoutTimeline(held)[0].end).toBeCloseTo(7);
  });
  it('splits an item and freezes its frame when the point is inside it', () => {
    const ep = EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 10 } }], overlays: [{ kind: 'label', text: 'x', start: 6, end: 7 }] });
    const held = holdAt(ep, catalog(20), 4, 1);
    expect(held.items.map((i) => [i.id, i.src.in, i.src.out, i.hold])).toEqual([['a', 0, 4, 1], ['a-b', 4, 10, 0]]);
    expect(timelineDuration(held)).toBeCloseTo(11);
    expect(held.overlays[0].start).toBeCloseTo(7);
  });
});

describe('fitVoiceover fixes', () => {
  const slotsOf = (...s: [string, number, number, string][]) => s.map(([id, start, end, line]) => ({ id, start, end, maxWords: 8, line }));

  it('keeps the last take of a short line that is re-read before a longer line', () => {
    const rec = tx([...said('Open settings.', 0), ...said('Open settings.', 2), ...said('Then toggle dark mode on.', 4)]);
    const slots = slotsOf(['n1', 0, 3, 'Open settings.'], ['n2', 6, 9, 'Then toggle dark mode on.']);
    const { episode: ep, report } = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    const n1 = ep.voiceover!.lines.find((l) => l.slot === 'n1')!;
    expect(n1.src.in).toBeCloseTo(1.95);
    expect(report.lines[0]).toMatchObject({ slot: 'n1', status: 'placed', takes: 2 });
    expect(report.lines[1]).toMatchObject({ slot: 'n2', status: 'placed', takes: 1 });
  });

  it('does not count a filler-only sentence as an extra take', () => {
    const rec = tx([{ w: 'Um.', start: 0, end: 0.3, conf: 1 }, ...said('This is the first line.', 1)]);
    const slots = slotsOf(['n1', 0, 5, 'This is the first line.']);
    const { report } = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    expect(report.lines[0]).toMatchObject({ status: 'placed', takes: 1 });
  });

  it('is stable when the result is fitted again with the same transcript', () => {
    const first = fitVoiceover({ episode: episode(SLOTS), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    expect(first.report.extendedSec).toBeGreaterThan(0);
    const second = fitVoiceover({ episode: first.episode, catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    expect(second.report.extendedSec).toBe(0);
    expect(second.report.lines.map((l) => l.overrunSec)).toEqual([0, 0]);
    expect(timelineDuration(second.episode)).toBeCloseTo(timelineDuration(first.episode), 6);
    expect(second.episode.voiceover!.lines).toEqual(first.episode.voiceover!.lines);
  });

  it('reports the growth holdAt actually applied', () => {
    const { episode: ep, report } = fitVoiceover({ episode: episode(SLOTS), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    expect(report.extendedSec).toBeCloseTo(timelineDuration(ep) - 20, 6);
  });

  it('caps a line by the earliest match of any later line, even when the next line is missing', () => {
    // n2 is never spoken; n3's first read comes after n1's retake, so n1's retake before it wins, not one after it.
    const rec = tx([...said('Open settings.', 0), ...said('Open settings.', 2), ...said('Then toggle dark mode on.', 4), ...said('Open settings.', 7)]);
    const slots = slotsOf(['n1', 0, 3, 'Open settings.'], ['n2', 4, 5, 'Nothing like anything here at all.'], ['n3', 6, 9, 'Then toggle dark mode on.']);
    const { episode: ep, report } = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    expect(report.lines.map((l) => l.status)).toEqual(['placed', 'missing', 'placed']);
    expect(ep.voiceover!.lines.find((l) => l.slot === 'n1')!.src.in).toBeCloseTo(1.95);
  });

  it('throws a distinct NOTHING_MATCHED when no narration lines are written', () => {
    const slots = slotsOf(['n1', 0, 3, '']);
    expect(() => fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING })).toThrow(expect.objectContaining({ code: 'NOTHING_MATCHED', message: expect.stringContaining('No narration lines') }));
  });
});

describe('holdAt in the frozen tail', () => {
  const held = (extra: object) => EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, overlays: [{ kind: 'label', text: 'x', start: 6.5, end: 7 }], ...extra });
  it('adds hold only when the point is inside an existing hold', () => {
    const ep = held({ items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 5 }, hold: 2 }] });
    const out = holdAt(ep, catalog(20), 6, 1);
    expect(out.items.map((i) => [i.id, i.src.in, i.src.out, i.hold])).toEqual([['a', 0, 5, 3]]);
    expect(timelineDuration(out)).toBeCloseTo(8);
    expect(out.overlays[0].start).toBeCloseTo(7.5);
  });
  it('never splits into an empty or inverted source range', () => {
    const ep = held({ items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 4.99 }, hold: 1 }] });
    const out = holdAt(ep, catalog(20), 4.99, 1);
    expect(out.items.map((i) => [i.id, i.src.in, i.src.out, i.hold])).toEqual([['a', 0, 4.99, 2]]);
    expect(timelineDuration(out)).toBeCloseTo(layoutDur(ep) + 1);
  });
});
function layoutDur(ep: ReturnType<typeof EpisodeSchema.parse>) {
  return timelineDuration(ep);
}
