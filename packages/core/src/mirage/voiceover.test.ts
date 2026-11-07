import { EpisodeSchema, isCard, type Catalog, type ClipItem, type Episode, type Move, type TimelineItem, type Transcript, type Word } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { moveFrames } from './move.js';
import { keptSegments } from './overlays.js';
import { cutOf } from './slots.js';
import { cutChanged, fitVoiceover, hasWords, holdAt, lineChanges, lineChangeWarnings, missingSlots, notEnglish, revertHolds } from './voiceover.js';
import { itemsFingerprint, layoutTimeline, timelineDuration } from './timeline.js';

/** The item as a clip item (a card here is a mistake in the test). */
const clip = (i: TimelineItem): ClipItem => {
  if (isCard(i)) throw new Error(`item ${i.id} is a card`);
  return i;
};

function said(text: string, t0: number, per = 0.3): Word[] {
  return text.split(' ').map((w, i) => ({ w, start: +(t0 + i * per).toFixed(3), end: +(t0 + i * per + 0.25).toFixed(3), conf: 1 }));
}
const tx = (words: Word[]): Transcript => ({ words, segments: [], speech: [] });
const catalog = (dur: number): Catalog => ({
  version: 1,
  clips: [{ id: 'c001', path: '/s.mp4', sha256: 'a'.repeat(64), probe: { durationSec: dur, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: false, videoCodec: 'h264', audioCodec: null, colorTransfer: null }, kind: 'screen', transcript: null, frames: [], notes: '', moments: [] }],
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
    expect(clip(held.items[0]).src.out).toBeCloseTo(6);
    expect(held.items[0].hold).toBeCloseTo(1);
    expect(layoutTimeline(held)[0].end).toBeCloseTo(7);
  });
  it('splits an item and freezes its frame when the point is inside it', () => {
    const ep = EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 10 } }], overlays: [{ kind: 'label', text: 'x', start: 6, end: 7 }] });
    const held = holdAt(ep, catalog(20), 4, 1);
    expect(held.items.map((i) => [i.id, clip(i).src.in, clip(i).src.out, i.hold])).toEqual([['a', 0, 4, 1], ['a-b', 4, 10, 0]]);
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
    // It starts again from the cut before the voice-over, so it holds exactly as much as the first fit did.
    expect(second.report.extendedSec).toBeCloseTo(first.report.extendedSec, 6);
    expect(second.episode.items).toEqual(first.episode.items);
    expect(timelineDuration(second.episode)).toBeCloseTo(timelineDuration(first.episode), 6);
    expect(second.episode.voiceover!.lines).toEqual(first.episode.voiceover!.lines);
  });

  it('rounds dips and sound effect times to 6 places when it closes the holds, as it does cues and ranges', () => {
    const fitted = fitVoiceover({ episode: episode(SLOTS), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING }).episode;
    const hold = fitted.voiceover!.holds![0]!;
    const noisy = (x: number) => Math.round(x * 1e6) / 1e6 !== x;
    // A time after the hold whose shift back by the hold leaves float noise (sums like 0.1 + 0.2).
    const at = [...Array(100).keys()].map((k) => hold.at + hold.sec + 1 + k * 0.1).find((t) => noisy(t - hold.sec) && noisy(t + 0.7 - hold.sec))!;
    const withSound = {
      ...fitted,
      music: [{ track: 'm.wav', start: 0, end: at + 4, offset: 0, gainDb: -5, fadeIn: 0, fadeOut: 0, dips: [{ start: at, end: at + 0.7 }] }],
      sfx: [{ sound: 'hit', at, gainDb: -6 }],
    } as Episode;
    const back = revertHolds(withSound).episode;
    const [dip] = back.music[0]!.dips!;
    for (const x of [dip!.start, dip!.end, back.sfx![0]!.at]) expect(noisy(x)).toBe(false);
    expect(back.sfx![0]!.at).toBeCloseTo(at - hold.sec, 6);
    expect(dip!.end - dip!.start).toBeCloseTo(0.7, 6);
    // An episode without sound effects or dips gets none.
    const plain = revertHolds({ ...fitted, music: [{ track: 'm.wav', start: 0, end: at + 4, offset: 0, gainDb: -5, fadeIn: 0, fadeOut: 0 }] } as Episode).episode;
    expect('sfx' in plain).toBe(false);
    expect('dips' in plain.music[0]!).toBe(false);
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

describe('fitVoiceover sentence containment', () => {
  const slotsOf = (...s: [string, number, number, string][]) => s.map(([id, start, end, line]) => ({ id, start, end, maxWords: 8, line }));

  it('does not let a shared word like "the" attach a retake to the next line', () => {
    const rec = tx([...said('Open the settings.', 0), ...said('Open the settings.', 2), ...said('Then toggle the dark mode on.', 4)]);
    const slots = slotsOf(['n1', 0, 3, 'Open the settings.'], ['n2', 6, 9, 'Then toggle the dark mode on.']);
    const { episode: ep, report } = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    expect(ep.voiceover!.lines.find((l) => l.slot === 'n1')!.src.in).toBeCloseTo(1.95);
    expect(report.lines[0]).toMatchObject({ slot: 'n1', status: 'placed', takes: 2 });
    expect(report.lines[1]).toMatchObject({ slot: 'n2', status: 'placed', takes: 1 });
  });

  it('places a line whose first sentence is a short spoken "So."', () => {
    const rec = tx([...said('So.', 0), ...said('Open the settings now.', 1)]);
    const slots = slotsOf(['n1', 0, 5, 'So. Open the settings now.']);
    const { episode: ep, report } = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    expect(report.lines[0]).toMatchObject({ slot: 'n1', status: 'placed', takes: 1 });
    expect(ep.voiceover!.lines[0].src.in).toBeCloseTo(0, 1);
  });
});

describe('fitVoiceover span choice', () => {
  const slotsOf = (...s: [string, number, number, string][]) => s.map(([id, start, end, line]) => ({ id, start, end, maxWords: 20, line }));

  it('keeps a line\'s short opening sentence instead of a later sub-span that scores nearly as well', () => {
    const line = 'Seven days. Last week I tried to ship a brand new weather app on iOS and Android.';
    const rec = tx(said(line, 1));
    const { episode: ep, report } = fitVoiceover({ episode: episode(slotsOf(['n1', 0, 8, line])), catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    expect(ep.voiceover!.lines[0].src.in).toBeCloseTo(0.95);
    expect(report.lines[0]).toMatchObject({ status: 'placed', takes: 1 });
  });

  it('counts one take when a single read splits into sentences, and two when the whole line is read twice', () => {
    const line = 'I spent. A whole week rewriting the backend in Rust for nothing at all, honestly.';
    const once = fitVoiceover({ episode: episode(slotsOf(['n1', 0, 8, line])), catalog: catalog(20), recording: 'vo.m4a', transcript: tx(said(line, 0)) });
    expect(once.report.lines[0]).toMatchObject({ status: 'placed', takes: 1 });
    expect(once.episode.voiceover!.lines[0].src.in).toBe(0);
    const twice = fitVoiceover({ episode: episode(slotsOf(['n1', 0, 8, line])), catalog: catalog(20), recording: 'vo.m4a', transcript: tx([...said(line, 0), ...said(line, 6)]) });
    expect(twice.report.lines[0]).toMatchObject({ status: 'placed', takes: 2 });
    expect(twice.episode.voiceover!.lines[0].src.in).toBeCloseTo(5.95);
  });

  it('uses a full re-read, not a later re-read of only the line\'s second half', () => {
    const line = 'Seven days. Last week I tried to ship a brand new weather app on iOS and Android.';
    const rec = tx([...said(line, 0), ...said('Last week I tried to ship a brand new weather app on iOS and Android.', 6)]);
    const { episode: ep, report } = fitVoiceover({ episode: episode(slotsOf(['n1', 0, 8, line])), catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    expect(ep.voiceover!.lines[0].src.in).toBe(0);
    expect(report.lines[0]).toMatchObject({ status: 'placed', takes: 1 });
  });
});

describe('fitVoiceover with a false start', () => {
  it('plays only the re-read when the false start and the re-read were transcribed differently', () => {
    const line = 'The Supabase migration broke. I spent a thousand dollars and rewrote the whole app.';
    const rec = tx([...said('The Supabase migration broke.', 0), ...said('The super base migration broke.', 3), ...said('I spent a thousand dollars and rewrote the whole app.', 4.8)]);
    const slots = [{ id: 'n1', start: 0, end: 8, maxWords: 20, line }];
    const { episode: ep } = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    expect(ep.voiceover!.lines[0].src.in).toBeCloseTo(2.95);
  });

  it('keeps the whole line and cuts a sentence flubbed and re-read in the middle of it', () => {
    const line = 'I shipped an app. Everything broke on every single request today.';
    const rec = tx([...said('I shipped an app.', 0), ...said('Everything broke on every', 1.5), { w: 'uh.', start: 2.8, end: 3, conf: 1 }, ...said('Everything broke on every single request today.', 3.5)]);
    const slots = [{ id: 'n1', start: 0, end: 12, maxWords: 20, line }];
    const { episode: ep, report } = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    const l = ep.voiceover!.lines[0];
    expect(l.src.in).toBe(0);
    expect(report.lines[0]).toMatchObject({ status: 'placed', takes: 1 });
    // The flub (1.5–3.0 s, with its "uh") is cut; what plays is "I shipped an app." then the re-read.
    const kept = keptSegments(l);
    expect(kept.some((g) => g.in < 2.7 && g.out > 1.6)).toBe(false);
    expect(kept[0].in).toBe(0);
    expect(kept[kept.length - 1].out).toBeCloseTo(5.65);
  });

  it('cuts an abandoned attempt that the restart reads differently, and keeps the line to its end', () => {
    // Real transcript (hunt final repro): the second attempt restarts with "So I cashed the forecast" but then differs.
    const T: [string, number, number][] = [
      ['Um,', 0, 0.48], ['every', 0.6, 0.84], ['request', 0.84, 1.26], ['was', 1.26, 1.74], ['waiting', 1.74, 2.16], ['on', 2.16, 2.46], ['a', 2.46, 2.64], ['slow', 2.64, 2.76],
      ['weather', 2.76, 3.12], ['API.', 3.12, 4.38], ['So', 5.12, 5.34], ['I', 5.34, 5.52], ['cashed', 5.52, 5.94], ['the', 5.94, 6.06], ['forecast', 6.06, 6.24], ['and', 6.24, 6.72],
      ['rewrote', 6.72, 7.38], ['the', 7.4, 7.56], ['back.', 7.56, 7.92], ['So', 8.61, 8.82], ['I', 8.82, 9.0], ['cashed', 9.0, 9.42], ['the', 9.42, 9.54], ['forecast', 9.54, 9.66],
      ['in,', 9.66, 10.38], ['rewrote', 10.38, 10.86], ['the', 10.86, 11.04], ['back', 11.04, 11.16], ['end', 11.16, 11.34], ['in', 11.34, 11.58], ['one', 11.58, 11.76], ['long', 11.76, 11.94], ['night.', 11.94, 12.24],
    ];
    const rec = tx(T.map(([w, start, end]) => ({ w, start, end, conf: 1 })));
    const line = 'Every request was waiting on a slow weather API, so I cached the forecast and rewrote the backend in one long night.';
    const ep0 = { ...episode([{ id: 'n1', start: 0, end: 18, maxWords: 25, line }]), overlays: [] };
    const { episode: ep, report } = fitVoiceover({ episode: ep0, catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    const l = ep.voiceover!.lines[0];
    expect(report.lines[0]).toMatchObject({ status: 'placed' });
    expect(l.src.in).toBeCloseTo(0.55);
    expect(l.src.out).toBeCloseTo(12.34);
    const kept = keptSegments(l);
    // Nothing of the abandoned attempt (5.12–7.92) plays; the restart from 8.61 plays to the end.
    expect(kept.some((g) => g.out > 5.0 && g.in < 8.0)).toBe(false);
    expect(kept.some((g) => g.in <= 8.61 && g.out >= 12.24)).toBe(true);
  });

  it('says so when the line\'s ending is in the recording right after the span used', () => {
    const line = 'One two three. Four five. Six seven. Eight nine. Ten eleven. Twelve thirteen.';
    const rec = tx(said(line, 0));
    const { episode: ep, report } = fitVoiceover({ episode: episode([{ id: 'n1', start: 0, end: 12, maxWords: 20, line }]), catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    // Six sentences read straight through are one span: placed whole, to the last word.
    expect(report.lines[0].status).toBe('placed');
    expect(ep.voiceover!.lines[0].src.out).toBeCloseTo(rec.words[rec.words.length - 1].end + 0.1);
    // Read in more pieces than a span takes, the end can't be reached: reported, not placed cleanly.
    const choppy = 'One two three four. Five. Six. Seven. Eight nine. Ten. Eleven. Twelve thirteen.';
    const r2 = fitVoiceover({ episode: episode([{ id: 'n1', start: 0, end: 12, maxWords: 20, line: choppy }]), catalog: catalog(20), recording: 'vo.m4a', transcript: tx(said(choppy, 0)) });
    expect(r2.episode.voiceover!.lines[0].src.in).toBe(0);
    expect(r2.report.lines[0].status).toBe('partial');
  });

  it('cuts a flub that runs on into other words when the re-read starts with the same three words', () => {
    const line = 'I shipped an app. Everything broke on every single request today.';
    const rec = tx([...said('I shipped an app.', 0), ...said('Everything broke on every, no wait, that is wrong, hold on.', 1.5), ...said('Everything broke on every single request today.', 6)]);
    const { episode: ep, report } = fitVoiceover({ episode: episode([{ id: 'n1', start: 0, end: 12, maxWords: 20, line }]), catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    expect(report.lines[0].status).toBe('placed');
    const kept = keptSegments(ep.voiceover!.lines[0]);
    expect(kept[0].in).toBe(0);
    expect(kept.some((g) => g.in < 5.5 && g.out > 1.6)).toBe(false);
  });

  it('cuts every earlier reading of a sentence, keeping the last', () => {
    const line = 'Open the settings. Then toggle dark mode on and wait.';
    const rec = tx([...said('Open the settings.', 0), ...said('Then toggle', 1.2), ...said('Then toggle dark', 2.4), ...said('Then toggle dark mode on and wait.', 3.6)]);
    const { episode: ep } = fitVoiceover({ episode: episode([{ id: 'n1', start: 0, end: 12, maxWords: 20, line }]), catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    const kept = keptSegments(ep.voiceover!.lines[0]);
    expect(kept[0].in).toBe(0);
    expect(kept.some((g) => g.in < 3.3 && g.out > 1.3)).toBe(false);
  });

  it('leaves a line that really repeats words alone', () => {
    const line = 'Wait. Wait for it.';
    const { episode: ep } = fitVoiceover({ episode: episode([{ id: 'n1', start: 0, end: 6, maxWords: 8, line }]), catalog: catalog(20), recording: 'vo.m4a', transcript: tx(said(line, 0)) });
    expect(ep.voiceover!.lines[0].cuts).toEqual([]);
  });

  it('says so when only part of the line was found, instead of reporting it placed cleanly', () => {
    const line = 'I shipped an app. Everything broke on every single request today.';
    // The flub runs on into other words and shares only two words with the re-read, so it can't be cut: only the re-read is used.
    const rec = tx([...said('I shipped an app.', 0), ...said('Everything broke, no wait, that is wrong, hold on.', 1.5), ...said('Everything broke on every single request today.', 6)]);
    const { report } = fitVoiceover({ episode: episode([{ id: 'n1', start: 0, end: 12, maxWords: 20, line }]), catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    expect(report.lines[0]).toMatchObject({ slot: 'n1', status: 'partial' });
  });
});

describe('fitVoiceover with the same line in two slots', () => {
  it('gives each slot its own reading, in order', () => {
    const slots = [
      { id: 'n1', start: 0, end: 3, maxWords: 8, line: 'Ship it today.' },
      { id: 'n2', start: 5, end: 8, maxWords: 8, line: 'Then it broke.' },
      { id: 'n3', start: 10, end: 13, maxWords: 8, line: 'Ship it today.' },
    ];
    const rec = tx([...said('Ship it today.', 0), ...said('Then it broke.', 2), ...said('Ship it today.', 4)]);
    const { episode: ep, report } = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    expect(ep.voiceover!.lines.map((l) => [l.slot, l.src.in])).toEqual([['n1', 0], ['n2', 1.95], ['n3', 3.95]]);
    expect(report.lines.map((l) => l.takes)).toEqual([1, 1, 1]);
  });
});

describe('holdAt in the frozen tail', () => {
  const held = (extra: object) => EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, overlays: [{ kind: 'label', text: 'x', start: 6.5, end: 7 }], ...extra });
  it('adds hold only when the point is inside an existing hold', () => {
    const ep = held({ items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 5 }, hold: 2 }] });
    const out = holdAt(ep, catalog(20), 6, 1);
    expect(out.items.map((i) => [i.id, clip(i).src.in, clip(i).src.out, i.hold])).toEqual([['a', 0, 5, 3]]);
    expect(timelineDuration(out)).toBeCloseTo(8);
    expect(out.overlays[0].start).toBeCloseTo(7.5);
  });
  it('never splits into an empty or inverted source range', () => {
    const ep = held({ items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 4.99 }, hold: 1 }] });
    const out = holdAt(ep, catalog(20), 4.99, 1);
    expect(out.items.map((i) => [i.id, clip(i).src.in, clip(i).src.out, i.hold])).toEqual([['a', 0, 4.99, 2]]);
    expect(timelineDuration(out)).toBeCloseTo(layoutDur(ep) + 1);
  });
});
function layoutDur(ep: ReturnType<typeof EpisodeSchema.parse>) {
  return timelineDuration(ep);
}

describe('fitVoiceover with a line re-read at the end', () => {
  const slotsOf = (...s: [string, number, number, string][]) => s.map(([id, start, end, line]) => ({ id, start, end, maxWords: 8, line }));
  it('places a line read after later lines without consuming them', () => {
    const rec = tx([...said('Open settings.', 0), ...said('Pick a nice accent colour.', 2), ...said('Save and close the window.', 4.5), ...said('Then toggle dark mode on.', 7)]);
    const slots = slotsOf(['n1', 0, 3, 'Open settings.'], ['n2', 4, 7, 'Then toggle dark mode on.'], ['n3', 8, 11, 'Pick a nice accent colour.'], ['n4', 12, 15, 'Save and close the window.']);
    const { episode: ep, report } = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    expect(report.lines.map((l) => [l.slot, l.status])).toEqual([['n1', 'placed'], ['n2', 'placed'], ['n3', 'placed'], ['n4', 'placed']]);
    expect(ep.voiceover!.lines.find((l) => l.slot === 'n2')!.src.in).toBeCloseTo(6.95);
    expect(ep.voiceover!.lines.find((l) => l.slot === 'n3')!.src.in).toBeCloseTo(1.95);
  });
});

describe('over-long lines', () => {
  it('fitVoiceover names the line when it runs more than 10 s past its slot', () => {
    const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.';
    const rec = tx(said(long, 0, 0.7));
    const slots = [{ id: 'n1', start: 1, end: 3, maxWords: 4, line: long }];
    expect(() => fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: rec })).toThrow(
      expect.objectContaining({ code: 'BAD_ITEM', message: expect.stringMatching(/^Line n1 runs 1[0-9.]+s past its slot \(more than 10 s\)$/), hint: 'Shorten the line, or give it a longer slot by extending the picture' }),
    );
  });
  it('holdAt refuses a frozen frame longer than 10 s with a MirageError, not a schema error', () => {
    const ep = EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 5 }, hold: 4 }] });
    expect(() => holdAt(ep, catalog(5), 9, 7)).toThrow(expect.objectContaining({ name: 'MirageError', code: 'BAD_ITEM' }));
  });
});

describe('fitVoiceover records what it fitted to', () => {
  it('stores the written line, the approved cut and the fitted items as fingerprints', () => {
    const before = episode(SLOTS);
    const { episode: ep } = fitVoiceover({ episode: before, catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    expect(ep.voiceover!.lines.map((l) => l.text)).toEqual(['This is the first line.', 'And here is the second one.']);
    expect(ep.voiceover!.cutFingerprint).toBe(itemsFingerprint(before.items));
    expect(ep.voiceover!.fittedItemsFingerprint).toBe(itemsFingerprint(ep.items));
    expect(ep.voiceover!.fittedItemsFingerprint).not.toBe(ep.voiceover!.cutFingerprint); // n2 held the picture
    expect(itemsFingerprint(before.items)).toMatch(/^[0-9a-f]{16}$/);
    expect(cutChanged(ep)).toBe(false);
    expect(cutChanged({ ...ep, items: [{ ...ep.items[0], src: { in: 0, out: 19 } }] })).toBe(true);
    expect(cutChanged(before)).toBe(false);
  });
});

describe('fitVoiceover adding re-recorded lines', () => {
  const slotsOf = (...s: [string, number, number, string][]) => s.map(([id, start, end, line]) => ({ id, start, end, maxWords: 8, line }));
  const slots = slotsOf(['n1', 0, 3, 'Open settings.'], ['n2', 5, 7, 'Then toggle dark mode on and wait for it.'], ['n3', 10, 13, 'Pick a nice accent colour.']);
  const full = tx([...said('Open settings.', 0), ...said('Pick a nice accent colour.', 2)]);
  const retake = tx(said('Then toggle dark mode on and wait for it.', 1));

  it('fits only the missing lines from the new recording and keeps the placed ones', () => {
    const first = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: full });
    expect(first.report.lines.map((l) => l.status)).toEqual(['placed', 'missing', 'placed']);
    expect(missingSlots(first.episode)).toEqual(['n2']);
    const second = fitVoiceover({ episode: first.episode, catalog: catalog(20), recording: 'n2.m4a', transcript: retake, only: missingSlots(first.episode) });
    expect(second.report.lines.map((l) => [l.slot, l.status])).toEqual([['n2', 'placed']]);
    const vo = second.episode.voiceover!;
    expect(vo.recording).toBe('vo.m4a');
    expect(vo.lines.map((l) => [l.slot, l.recording])).toEqual([['n1', undefined], ['n2', 'n2.m4a'], ['n3', undefined]]);
    const was = (id: string) => first.episode.voiceover!.lines.find((l) => l.slot === id)!;
    const now = (id: string) => vo.lines.find((l) => l.slot === id)!;
    expect(now('n1')).toEqual(was('n1'));
    // n2 ran past its slot, so the picture held and n3 moved later by exactly that much, with the same audio.
    expect(second.report.extendedSec).toBeGreaterThan(0);
    expect(now('n3')).toEqual({ ...was('n3'), at: expect.closeTo(was('n3').at + second.report.extendedSec, 6) });
    expect(vo.cutFingerprint).toBe(first.episode.voiceover!.cutFingerprint);
    expect(vo.fittedItemsFingerprint).toBe(itemsFingerprint(second.episode.items));
  });

  it('keeps the earlier take of a listed line that the new recording does not have', () => {
    const all = tx([...said('Open settings.', 0), ...said('Then toggle dark mode on and wait for it.', 2), ...said('Pick a nice accent colour.', 6)]);
    const first = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: all });
    const second = fitVoiceover({ episode: first.episode, catalog: catalog(20), recording: 'n2.m4a', transcript: retake, only: ['n1', 'n2'] });
    expect(second.report.lines.map((l) => [l.slot, l.status])).toEqual([['n1', 'kept'], ['n2', 'placed']]);
    const n1 = second.episode.voiceover!.lines.find((l) => l.slot === 'n1')!;
    expect(n1).toEqual(first.episode.voiceover!.lines.find((l) => l.slot === 'n1'));
    expect(second.episode.voiceover!.lines.map((l) => l.slot)).toEqual(['n1', 'n2', 'n3']);
  });

  it('refuses to add lines once the cut has changed', () => {
    const first = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: full });
    const recut = { ...first.episode, items: [{ ...first.episode.items[0], src: { in: 1, out: 20 } }] };
    expect(() => fitVoiceover({ episode: recut, catalog: catalog(20), recording: 'n2.m4a', transcript: retake, only: ['n2'] })).toThrow(
      expect.objectContaining({ code: 'BAD_ITEM', message: 'The cut changed after the voice-over was fitted' }),
    );
  });
});

describe('fitVoiceover and the cut the slots were written for', () => {
  it('refuses when the items changed since slots, and keeps the slots in step with the holds it adds', () => {
    const ep = { ...episode(SLOTS), slotsCut: cutOf(episode(SLOTS)) };
    const recut = { ...ep, items: [{ ...ep.items[0], src: { in: 1, out: 20 } }] };
    expect(() => fitVoiceover({ episode: recut, catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING })).toThrow(
      expect.objectContaining({ code: 'BAD_ITEM', message: 'The cut changed since slots were written — run slots first' }),
    );
    const { episode: fitted, report } = fitVoiceover({ episode: ep, catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    expect(report.extendedSec).toBeGreaterThan(0);
    expect(fitted.slotsCut).toEqual(cutOf(fitted));
    expect(() => fitVoiceover({ episode: fitted, catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING })).not.toThrow();
  });

  it('refuses a re-fit after a re-cut of an episode from before slotsCut, until slots runs', () => {
    const { episode: fitted } = fitVoiceover({ episode: episode(SLOTS), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    const old = { ...fitted, slotsCut: undefined, items: [{ ...fitted.items[0], src: { in: 1, out: 20 } }] };
    expect(() => fitVoiceover({ episode: old, catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING })).toThrow(expect.objectContaining({ message: 'The cut changed since slots were written — run slots first' }));
  });
});

describe('fitVoiceover from the cut before the voice-over', () => {
  const short = tx([...said('This is the first line.', 2), ...said('And here is the second one.', 4, 0.2)]);

  it('a full re-fit undoes the holds and splits of the earlier fit before fitting again', () => {
    const before = { ...episode(SLOTS), items: [{ ...episode(SLOTS).items[0], src: { in: 0, out: 11 } }, { id: 'b', beat: 'problem' as const, clip: 'c001', src: { in: 11, out: 20 }, speed: 1, audio: 'mute' as const, zoom: 1, frame: 'fit' as const, focus: { x: 0.5, y: 0.5 }, hold: 0, quiet: false, onBeat: false }] };
    const first = fitVoiceover({ episode: before, catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    expect(first.report.extendedSec).toBeGreaterThan(0.5);
    expect(first.episode.items.length).toBe(3); // n2 ends inside item a: split and held
    const again = fitVoiceover({ episode: first.episode, catalog: catalog(20), recording: 'short.m4a', transcript: short });
    expect(again.report.extendedSec).toBe(0);
    expect(again.episode.items).toEqual(before.items);
    expect(again.episode.overlays).toEqual(before.overlays);
    expect(again.episode.slots).toEqual(before.slots);
    expect(timelineDuration(again.episode)).toBeCloseTo(20, 6);
    expect(again.episode.voiceover!.cutFingerprint).toBe(itemsFingerprint(before.items));
  });

  it('holds never pile up across re-fits, also after lines were added', () => {
    const first = fitVoiceover({ episode: episode(SLOTS), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    const added = fitVoiceover({ episode: first.episode, catalog: catalog(20), recording: 'n2.m4a', transcript: tx(said('And here is the second one.', 0, 0.6)), only: ['n2'] });
    expect(timelineDuration(added.episode)).toBeGreaterThan(timelineDuration(first.episode));
    const refit = fitVoiceover({ episode: added.episode, catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    expect(refit.episode.items).toEqual(first.episode.items);
    expect(refit.episode.overlays).toEqual(first.episode.overlays);
    expect(refit.episode.voiceover!.lines).toEqual(first.episode.voiceover!.lines);
    expect(refit.report.extendedSec).toBeCloseTo(first.report.extendedSec, 6);
  });

  it('after a re-cut, a full fit still undoes the freezes and splits earlier fits added (re-cut → slots → vo)', () => {
    const first = fitVoiceover({ episode: episode(SLOTS), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    expect(first.episode.items.map((i) => i.id)).toEqual(['a', 'a-b']); // n2 ends inside a: split and frozen
    const tail = { id: 'c', beat: 'outro' as const, clip: 'c001', src: { in: 0, out: 2 }, speed: 1, audio: 'mute' as const, zoom: 1, frame: 'fit' as const, focus: { x: 0.5, y: 0.5 }, hold: 0, quiet: false, onBeat: false };
    const recut = { ...first.episode, items: [...first.episode.items, tail] };
    const refit = fitVoiceover({ episode: { ...recut, slotsCut: cutOf(recut) }, catalog: catalog(20), recording: 'short.m4a', transcript: short });
    expect(refit.report.extendedSec).toBe(0);
    expect(refit.episode.items).toEqual([episode(SLOTS).items[0], tail]);
    expect(refit.episode.overlays).toEqual(episode(SLOTS).overlays);
    expect(refit.episode.voiceover!.cutFingerprint).toBe(itemsFingerprint(refit.episode.items));
  });

  it('after a re-cut, keeps a hold the user wrote and undoes only what the fit added to it', () => {
    const LONG = 'This one is a much longer line than the slot can hold.';
    const items = [
      { id: 'a', beat: 'problem', clip: 'c001', src: { in: 15, out: 20 }, hold: 1 },
      { id: 'b', beat: 'problem', clip: 'c001', src: { in: 0, out: 10 } },
    ];
    const ep0 = EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items, slots: [{ id: 'n1', start: 1, end: 6, maxWords: 8, line: LONG }] });
    const first = fitVoiceover({ episode: ep0, catalog: catalog(20), recording: 'vo.m4a', transcript: tx(said(LONG, 0, 0.55)) });
    expect(first.episode.items[0].hold).toBeGreaterThan(2);
    const recut = { ...first.episode, items: [first.episode.items[0], { ...first.episode.items[1], src: { in: 0, out: 9 } }] };
    const refit = fitVoiceover({ episode: { ...recut, slotsCut: cutOf(recut) }, catalog: catalog(20), recording: 'short.m4a', transcript: tx(said(LONG, 0, 0.3)) });
    expect(refit.episode.items.map((i) => [i.id, clip(i).src.in, clip(i).src.out, i.hold])).toEqual([['a', 15, 20, 1], ['b', 0, 9, 0]]);
  });
});

describe('a move across voice-over fits', () => {
  const ep30 = (items: object[]) => EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items });
  /** The zoom and focus of every output frame, as render plays them. */
  const played = (e: Episode) => layoutTimeline(e).flatMap((l) => moveFrames(clip(l.item), l.frames, 30, l.clock));
  /** The largest change of zoom, x or y from one frame to the next. */
  const maxStep = (f: { zoom: number; x: number; y: number }[]) => Math.max(...f.slice(1).map((p, i) => Math.max(Math.abs(p.zoom - f[i].zoom), Math.abs(p.x - f[i].x), Math.abs(p.y - f[i].y))));
  const same = (got: ReturnType<typeof played>, want: ReturnType<typeof played>) => {
    expect(got).toHaveLength(want.length);
    got.forEach((g, i) => {
      expect(g.zoom).toBeCloseTo(want[i].zoom, 9);
      expect(g.x).toBeCloseTo(want[i].x, 9);
      expect(g.y).toBeCloseTo(want[i].y, 9);
    });
  };
  const shot = { id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 6 }, focus: { x: 0.4, y: 0.6 } };

  it('a split shot plays its move on through the frozen frame, on one clock, with no jump at the seam', () => {
    // A 6 s shot frozen for 1 s at 3 s: the move plays as on a 7 s shot whose times after 3 s come 1 s later (a move
    // starting at 3 s starts after the freeze; one ending at 3 s has arrived before it).
    const later = (t: number | undefined, after: boolean) => (t !== undefined && (after ? t >= 3 : t > 3) ? t + 1 : t);
    const moves: Partial<Move>[] = [
      { zoom: 1.2 },
      { zoom: 1.3, ease: 'in', focus: { x: 0.2, y: 0.8 }, start: 2, end: 4 },
      { zoom: 1.3, ease: 'out', start: 0.5, end: 2 },
      { zoom: 1.3, ease: 'linear', focus: { y: 0.1 }, start: 4, end: 5.5 },
      { zoom: 1.5, start: 1, end: 6 },
      { zoom: 1.5, start: 3, end: 4 },
      { zoom: 1.5, start: 1, end: 3 },
      { zoom: 1.5, start: 2.9, end: 3.1 },
    ];
    for (const move of moves) {
      const ep = ep30([{ ...shot, move }]);
      const held = holdAt(ep, catalog(20), 3, 1);
      expect(held.items.map((i) => [i.id, clip(i).src.in, clip(i).src.out, i.hold, clip(i).splitFrom?.item])).toEqual([['a', 0, 3, 1, 'a'], ['a-b', 3, 6, 0, 'a']]);
      const m = clip(ep.items[0]).move!;
      const want = moveFrames(clip(ep30([{ ...shot, move: { ...m, start: later(m.start, true), end: later(m.end, false) } }]).items[0]), 210, 30);
      const got = played(held);
      same(got, want);
      // No jump: no step between frames bigger than the unsplit shot's largest.
      expect(maxStep(got)).toBeLessThanOrEqual(maxStep(moveFrames(clip(ep.items[0]), 180, 30)) + 1e-12);
    }
  });

  it('keeps one clock across a second split, a freeze inside a frozen frame and source added at the end', () => {
    const ep = ep30([{ ...shot, move: { zoom: 1.2 } }]);
    let held = holdAt(ep, catalog(20), 3, 1); // a | freeze | a-b
    held = holdAt(held, catalog(20), 5.5, 0.5); // a-b split at 1.5 s into it
    held = holdAt(held, catalog(20), 3.5, 0.5); // inside a's freeze: it freezes longer
    held = holdAt(held, catalog(20), timelineDuration(held), 0.5); // the end: the last part gets more source
    expect(held.items.map((i) => [i.id, clip(i).src.in, clip(i).src.out, i.hold])).toEqual([['a', 0, 3, 1.5], ['a-b', 3, 4.5, 0.5], ['a-b-b', 4.5, 6.5, 0]]);
    same(played(held), moveFrames(clip(ep.items[0]), 255, 30));
  });

  it('still arrives at the end of a shot that fitting gave more source or a frozen end', () => {
    const ep = ep30([{ ...shot, src: { in: 0, out: 5 }, move: { zoom: 1.2 } }]);
    for (const [clipSec, out, hold] of [[5.5, 5.5, 0.5], [5, 5, 1]] as const) {
      const held = holdAt(ep, catalog(clipSec), 5, 1);
      expect([clip(held.items[0]).src.out, held.items[0].hold]).toEqual([out, hold]);
      const got = played(held);
      expect(got).toHaveLength(180);
      expect(got[179].zoom).toBe(1.2);
      same(got, moveFrames(clip(ep.items[0]), 180, 30));
    }
  });

  const withMove = (move: object) => EpisodeSchema.parse({ ...episode(SLOTS), items: [{ ...episode(SLOTS).items[0], move }] });
  const tail = { id: 'c', beat: 'outro' as const, clip: 'c001', src: { in: 0, out: 2 }, speed: 1, audio: 'mute' as const, zoom: 1, frame: 'fit' as const, focus: { x: 0.5, y: 0.5 }, hold: 0, quiet: false, onBeat: false };
  const short = tx([...said('This is the first line.', 2), ...said('And here is the second one.', 4, 0.2)]);
  const recutAndRefit = (e: Episode) => {
    const recut = { ...e, items: [...e.items, tail] };
    return fitVoiceover({ episode: { ...recut, slotsCut: cutOf(recut) }, catalog: catalog(20), recording: 'short.m4a', transcript: short }).episode;
  };

  it('a fit that splits a moving item plays the move on, and a full re-fit gives back the item exactly', () => {
    const ep0 = withMove({ zoom: 1.3, focus: { x: 0.7 }, start: 4, end: 14 });
    const first = fitVoiceover({ episode: ep0, catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING }).episode;
    expect(first.items.map((i) => [i.id, clip(i).splitFrom?.item])).toEqual([['a', 'a'], ['a-b', 'a']]);
    expect(maxStep(played(first))).toBeLessThanOrEqual(maxStep(moveFrames(clip(ep0.items[0]), 600, 30)) + 1e-12);
    // No re-cut: the items before the fit.
    const again = fitVoiceover({ episode: first, catalog: catalog(20), recording: 'short.m4a', transcript: short }).episode;
    expect(again.items).toStrictEqual(ep0.items);
    // After a re-cut: the split undone, the halves merged into the item with its move.
    const refit = recutAndRefit(first);
    expect(refit.items[0]).toStrictEqual(ep0.items[0]);
    expect(refit.items).toEqual([ep0.items[0], tail]);
  });

  it('a full re-fit after a re-cut leaves apart the halves of a split whose move the person changed', () => {
    const ep0 = withMove({ zoom: 1.3 });
    const first = fitVoiceover({ episode: ep0, catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING }).episode;
    const edits: [string, (x: ClipItem) => ClipItem][] = [
      ['the second half', (x) => (x.id === 'a-b' ? { ...x, move: { ...x.move!, zoom: 1.4 } } : x)],
      ['both halves alike', (x) => ({ ...x, move: { ...x.move!, zoom: 1.4 } })],
      ['the move removed from both', ({ move: _, ...x }) => x],
    ];
    for (const [, edit] of edits) {
      const edited = { ...first, items: first.items.map((i) => edit(clip(i))) };
      const refit = recutAndRefit(edited);
      expect(refit.items.map((i) => [i.id, i.hold, clip(i).move?.zoom])).toEqual([['a', 0, clip(edited.items[0]).move?.zoom], ['a-b', 0, clip(edited.items[1]).move?.zoom], ['c', 0, undefined]]);
    }    // A move the person added to both halves of a split item that had none.
    const plain = fitVoiceover({ episode: episode(SLOTS), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING }).episode;
    const added = { ...plain, items: plain.items.map((x) => ({ ...x, move: { zoom: 1.2, ease: 'inOut' as const } })) };
    expect(recutAndRefit(added).items.map((i) => [i.id, i.hold, clip(i).move?.zoom])).toEqual([['a', 0, 1.2], ['a-b', 0, 1.2], ['c', 0, undefined]]);
  });

  it('a full re-fit keeps a move, zoom, focus and frame the person gave an item after the first fit', () => {
    const first = fitVoiceover({ episode: episode(SLOTS), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING }).episode;
    expect(first.items.map((i) => i.id)).toEqual(['a', 'a-b']);
    const look = { move: { zoom: 1.4, ease: 'out' as const, start: 1 }, zoom: 1.1, focus: { x: 0.3, y: 0.2 }, frame: 'fill' as const };
    const edited = { ...first, items: first.items.map((x) => (x.id === 'a' ? { ...x, ...look } : x)) };
    const again = fitVoiceover({ episode: edited, catalog: catalog(20), recording: 'short.m4a', transcript: short }).episode;
    expect(again.items).toStrictEqual([{ ...episode(SLOTS).items[0], ...look }]);
    // Fitted again with the long line: split again, and the new move plays across the parts.
    const refit = fitVoiceover({ episode: edited, catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING }).episode;
    expect(refit.items.map((i) => [i.id, clip(i).move, clip(i).splitFrom?.item])).toEqual([['a', look.move, 'a'], ['a-b', look.move, 'a']]);
    // And a move the person removed stays removed.
    const removed = fitVoiceover({ episode: { ...refit, items: refit.items.map((i) => { const { move: _, ...x } = clip(i); return x; }) }, catalog: catalog(20), recording: 'short.m4a', transcript: short }).episode;
    expect(clip(removed.items[0]).move).toBeUndefined();
    expect('move' in removed.items[0]).toBe(false);
  });
});

describe('lines with no words', () => {
  it('count as unwritten: not missing, not fitted', () => {
    const slots = [SLOTS[0], { id: 'n2', start: 10, end: 12, maxWords: 4, line: '🚀🚀 …' }, { id: 'n3', start: 14, end: 18, maxWords: 4, line: 'Um.' }];
    expect(hasWords('🚀🚀 …')).toBe(false);
    expect(hasWords('Ship it 🚀')).toBe(true);
    const { episode: ep, report } = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    expect(report.lines.map((l) => l.slot)).toEqual(['n1']);
    expect(missingSlots(ep)).toEqual([]);
    expect(() => fitVoiceover({ episode: episode(slots.slice(1)), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING })).toThrow(expect.objectContaining({ message: 'No narration lines are written yet' }));
  });
});

describe('lines edited after vo', () => {
  it('names each fitted line whose slot line changed or was cleared since', () => {
    const { episode: ep } = fitVoiceover({ episode: episode(SLOTS), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    expect(lineChanges(ep)).toEqual([]);
    const edited = { ...ep, slots: ep.slots.map((s) => (s.id === 'n1' ? { ...s, line: 'This is the very first line.' } : { ...s, line: '' })) };
    expect(lineChanges(edited)).toEqual([
      { slot: 'n1', cleared: false, fitted: 'This is the first line.' },
      { slot: 'n2', cleared: true, fitted: 'And here is the second one.' },
    ]);
    expect(lineChangeWarnings(edited, 'check')).toEqual([
      "n1's line changed since vo — re-record it with vo --add --slots n1",
      "n2's line was cleared since vo, but its voice-over still plays — run vo again without --add to drop it",
    ]);
    expect(lineChangeWarnings(edited, 'render')[0]).toBe('n1\'s line changed since vo — it plays and is captioned as fitted ("This is the first line."); re-record it with vo --add --slots n1');
    // Whitespace alone is no change.
    expect(lineChanges({ ...ep, slots: ep.slots.map((s) => ({ ...s, line: ` ${s.line}  ` })) })).toEqual([]);
  });
});

describe('fitVoiceover at the edges', () => {
  it('never lets the last line run past the end of the episode: it holds the picture instead', () => {
    const slots = [{ id: 'n1', start: 17, end: 20, maxWords: 8, line: 'And here is the second one.' }];
    const rec = tx(said('And here is the second one.', 0, 0.52)); // 2.95 s from 0.15 into the 3 s slot: ends 0.1 s past it
    const { episode: ep, report } = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    const line = ep.voiceover!.lines[0];
    const end = line.at + line.src.out - line.src.in;
    expect(report.lines[0].overrunSec).toBeGreaterThan(0);
    expect(end).toBeLessThanOrEqual(timelineDuration(ep) + 1e-6);
  });

  it('skips a line too long for its slot, reporting it, and places the rest', () => {
    const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.';
    const rec = tx([...said(long, 0, 0.7), ...said('And here is the second one.', 15)]);
    const slots = [{ id: 'n1', start: 1, end: 3, maxWords: 4, line: long }, { id: 'n2', start: 10, end: 13, maxWords: 8, line: 'And here is the second one.' }];
    const { episode: ep, report } = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: rec });
    expect(report.lines.map((l) => [l.slot, l.status])).toEqual([['n1', 'too long'], ['n2', 'placed']]);
    expect(report.lines[0].overrunSec).toBeGreaterThan(10);
    expect(ep.voiceover!.lines.map((l) => l.slot)).toEqual(['n2']);
    expect(timelineDuration(ep)).toBe(20);
  });

  it('counts the clip\'s unused footage before calling a line too long', () => {
    const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.';
    const slots = [{ id: 'n1', start: 18, end: 20, maxWords: 4, line: long }];
    const { episode: ep, report } = fitVoiceover({ episode: episode(slots), catalog: catalog(30), recording: 'vo.m4a', transcript: tx(said(long, 0, 0.7)) });
    expect(report.lines[0]).toMatchObject({ status: 'placed' });
    expect(report.lines[0].overrunSec).toBeGreaterThan(10);
    expect(clip(ep.items[0]).src.out).toBe(30);
    expect(ep.items[0].hold).toBeLessThan(10);
  });

  it('says no speech was heard in a silent recording', () => {
    expect(() => fitVoiceover({ episode: episode(SLOTS), catalog: catalog(20), recording: 'vo/silent.m4a', transcript: tx([{ w: 'Um.', start: 1, end: 1.3, conf: 1 }]) })).toThrow(
      expect.objectContaining({ code: 'NOTHING_MATCHED', message: 'No speech was heard in vo/silent.m4a' }),
    );
  });
});

describe('lines not in English', () => {
  it('says plainly that voice-over matching supports English only, instead of calling the line empty', () => {
    expect(notEnglish('Привет, мир.')).toBe(true);
    expect(notEnglish('🚀🚀 …')).toBe(false);
    expect(notEnglish('Café time.')).toBe(false);
    expect(notEnglish('Um.')).toBe(false);
    expect(notEnglish('東京へ行く')).toBe(true);
    const ru = { id: 'n2', start: 10, end: 12, maxWords: 4, line: 'Привет, мир.' };
    const { report } = fitVoiceover({ episode: episode([SLOTS[0], ru]), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    expect(report.warnings).toContain("n2's line isn't in English — voice-over matching supports English only for now, so it was left out");
    expect(() => fitVoiceover({ episode: episode([ru]), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING })).toThrow(
      expect.objectContaining({ code: 'NOTHING_MATCHED', message: 'Voice-over matching supports English only for now' }),
    );
  });
});

describe('hyphenated words', () => {
  it('match a transcript that writes them closed or split', () => {
    const slots = [{ id: 'n1', start: 0, end: 5, maxWords: 8, line: 'We re-cut it.' }];
    for (const spoken of ['We recut it.', 'We re cut it.']) {
      const { report } = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: tx(said(spoken, 0)) });
      expect(report.lines[0].status).toBe('placed');
    }
  });
});

describe('slots from before slotsCut', () => {
  it('warns once that it cannot tell whether they are current', () => {
    const first = fitVoiceover({ episode: episode(SLOTS), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    expect(first.report.warnings).toEqual([
      "The slots were written before Mirage recorded which cut they belong to, so vo can't tell whether they are current — if the cut changed since slots ran, run: pnpm mirage slots <project> 1, check the lines, then vo again",
    ]);
    expect(fitVoiceover({ episode: first.episode, catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING }).report.warnings).toEqual([]);
    expect(fitVoiceover({ episode: { ...episode(SLOTS), slotsCut: cutOf(episode(SLOTS)) }, catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING }).report.warnings).toEqual([]);
  });
});

describe('a narration line over a card', () => {
  const LONG = 'This one is a much longer line than the slot can hold.';
  const card = { id: 'k', beat: 'title', card: { style: 'bold', text: 'Day 3', sec: 6 } };
  const ep0 = EpisodeSchema.parse({
    version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
    items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 4 } }, card, { id: 'b', beat: 'problem', clip: 'c001', src: { in: 4, out: 8 } }],
    overlays: [{ kind: 'label', text: 'x', start: 7, end: 8 }],
    slots: [{ id: 'n1', start: 4.5, end: 6.5, maxWords: 5, line: LONG }],
  });
  const kHold = (e: Episode) => e.items.find((i) => i.id === 'k')!.hold;

  it('holds a card longer instead of splitting it, inside it or at its end', () => {
    const inside = holdAt(ep0, catalog(20), 6, 1.5);
    expect(inside.items.map((i) => [i.id, i.hold])).toEqual([['a', 0], ['k', 1.5], ['b', 0]]);
    expect(inside.overlays[0]).toMatchObject({ start: 8.5, end: 9.5 });
    expect(timelineDuration(inside)).toBeCloseTo(timelineDuration(ep0) + 1.5, 6);
    const atEnd = holdAt(ep0, catalog(20), 10, 1);
    expect(atEnd.items.map((i) => [i.id, i.hold])).toEqual([['a', 0], ['k', 1], ['b', 0]]);
  });

  it('fitting adds the overrun to the card’s hold, records it, and a full re-fit undoes it', () => {
    const first = fitVoiceover({ episode: ep0, catalog: catalog(20), recording: 'vo.m4a', transcript: tx(said(LONG, 0, 0.55)) }).episode;
    expect(first.items.map((i) => i.id)).toEqual(['a', 'k', 'b']);
    expect(kHold(first)).toBeGreaterThan(2);
    expect(first.voiceover!.holds).toEqual([expect.objectContaining({ item: 'k', at: 6.5, hold: kHold(first) })]);
    // No re-cut: back to the items before the fit.
    const short = tx(said('This one.', 0));
    const again = fitVoiceover({ episode: { ...first, slots: first.slots.map((s) => ({ ...s, line: 'This one.' })) }, catalog: catalog(20), recording: 'short.m4a', transcript: short }).episode;
    expect(again.items).toStrictEqual(ep0.items);
    // After a re-cut (a clip added at the end): what the fit added to the card is undone.
    const tail = EpisodeSchema.parse({ ...ep0, items: [{ id: 'c', beat: 'outro', clip: 'c001', src: { in: 0, out: 2 } }] }).items[0]!;
    const recut = { ...first, items: [...first.items, tail], slots: first.slots.map((s) => ({ ...s, line: 'This one.' })) };
    const refit = fitVoiceover({ episode: { ...recut, slotsCut: cutOf(recut) }, catalog: catalog(20), recording: 'short.m4a', transcript: short }).episode;
    expect(refit.items).toEqual([...ep0.items, tail]);
    // The label on the card after where the time opened is back where it was (closed there, not at the card's end).
    expect(refit.overlays).toEqual([{ ...ep0.overlays[0], start: expect.closeTo(7, 6), end: expect.closeTo(8, 6) }]);
  });

  it('a full re-fit with no re-cut keeps the text, style, picture, beat and quiet the person gave the card since', () => {
    const first = fitVoiceover({ episode: ep0, catalog: catalog(20), recording: 'vo.m4a', transcript: tx(said(LONG, 0, 0.55)) }).episode;
    const looks = { text: 'Tokyo', style: 'image' as const, image: 'pics/tokyo.jpg' };
    const edited = {
      ...first,
      items: first.items.map((i) => (isCard(i) ? { ...i, beat: 'twist' as const, quiet: true, card: { ...i.card, ...looks } } : i)),
      slots: first.slots.map((s) => ({ ...s, line: 'This one.' })),
    };
    // Text, style and picture aren't part of the cut: no re-cut, and the fit's hold on the card is undone.
    expect(cutChanged(edited)).toBe(false);
    const again = fitVoiceover({ episode: edited, catalog: catalog(20), recording: 'short.m4a', transcript: tx(said('This one.', 0)) }).episode;
    expect(again.items.find((i) => i.id === 'k')).toStrictEqual({ ...ep0.items[1], beat: 'twist', quiet: true, card: { ...looks, sec: 6 } });
    expect(again.items.filter((i) => i.id !== 'k')).toStrictEqual(ep0.items.filter((i) => i.id !== 'k'));
    // The card's length stays the one it had before the fit (a changed sec is a re-cut, which slots and vo handle).
    const longer = revertHolds({ ...edited, items: edited.items.map((i) => (isCard(i) ? { ...i, card: { ...i.card, sec: 9 } } : i)) }).episode;
    expect(longer.items.find((i) => i.id === 'k')).toMatchObject({ card: { ...looks, sec: 6 }, hold: 0 });
  });

  it('a re-fit keeps the item from before the fit when its kind changed since (a card became a clip, a clip a card)', () => {
    const first = fitVoiceover({ episode: ep0, catalog: catalog(20), recording: 'vo.m4a', transcript: tx(said(LONG, 0, 0.55)) }).episode;
    const swapped = {
      ...first,
      items: first.items.map((i) => {
        if (i.id === 'k') return EpisodeSchema.parse({ ...ep0, items: [{ id: 'k', beat: 'problem', clip: 'c001', src: { in: 8, out: 10 }, zoom: 1.2 }] }).items[0]!;
        if (i.id === 'b') return EpisodeSchema.parse({ ...ep0, items: [{ id: 'b', beat: 'title', card: { style: 'mono', text: 'Later', sec: 2 } }] }).items[0]!;
        return i;
      }),
    };
    expect(revertHolds(swapped).episode.items).toStrictEqual(ep0.items);
  });
});
