import { EpisodeSchema, type Catalog, type Episode, type Transcript, type VoiceLine } from '@wordedits/shared';
import { isFiller, sentenceTokens, similarity, splitSentences, textTokens } from '../autoedit/takes.js';
import { MirageError } from './errors.js';
import { keptSegments } from './overlays.js';
import { itemFrames, layoutTimeline, shiftAfter, timelineDuration } from './timeline.js';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** The schema's limit on an item's frozen frame. */
const MAX_HOLD = 10;
const HOLD_HINT = 'Shorten the line, or give it a longer slot by extending the picture';

function checkHold(item: Episode['items'][number]): typeof item {
  if (item.hold > MAX_HOLD + 1e-9) {
    throw new MirageError('BAD_ITEM', `item ${item.id} would freeze its frame for ${r3(item.hold)}s (more than ${MAX_HOLD} s)`, HOLD_HINT);
  }
  return item;
}

export interface FitLine {
  slot: string;
  status: 'placed' | 'missing';
  takes: number;
  overrunSec: number;
}

export interface FitReport {
  lines: FitLine[];
  extendedSec: number;
}

/**
 * Opens `delta` seconds at output time `t`. At an item boundary the item ending there grows (unused source first,
 * then frozen frames); inside an item, the item splits at `t` and its frame there is held. Everything after `t` shifts.
 */
export function holdAt(ep: Episode, catalog: Catalog, t: number, delta: number): Episode {
  const fps = ep.output.fps;
  const laid = layoutTimeline(ep);
  const l = laid.find((x) => t > x.start + 1e-9 && t <= x.end + 1e-9) ?? laid[laid.length - 1];
  const item = l.item;
  const items = [...ep.items];
  const half = 0.5 / fps;
  const srcEnd = l.start + l.srcFrames / fps;
  const atBoundary = Math.abs(l.end - t) < half || t > l.end;
  const splitFrames = Math.max(1, Math.round((t - l.start) * fps));

  if (atBoundary) {
    const clipDur = catalog.clips.find((c) => c.id === item.clip)?.probe.durationSec ?? item.src.out;
    const available = Math.max(0, (clipDur - item.src.out) / item.speed);
    const useSource = Math.min(delta, available);
    const next = checkHold({ ...item, src: { in: item.src.in, out: r6(item.src.out + useSource * item.speed) }, hold: r6(item.hold + (delta - useSource)) });
    items[l.index] = next;
    const grown = itemFrames(next, fps).frames / fps - l.frames / fps;
    return { ...shiftAfter(ep, l.end, grown), items };
  }

  if (t >= srcEnd - 1e-9 || splitFrames >= l.srcFrames) {
    // Inside the item's frozen tail: it is already a held frame, so just hold longer.
    const next = checkHold({ ...item, hold: r6(item.hold + delta) });
    items[l.index] = next;
    const grown = itemFrames(next, fps).frames / fps - l.frames / fps;
    return { ...shiftAfter(ep, t, grown), items };
  }

  const splitSrc = r6(item.src.in + (splitFrames / fps) * item.speed);
  const ids = new Set(ep.items.map((x) => x.id));
  let suffix = 'b';
  while (ids.has(`${item.id}-${suffix}`)) suffix = String.fromCharCode(suffix.charCodeAt(0) + 1);
  const first = checkHold({ ...item, src: { in: item.src.in, out: splitSrc }, hold: r6(delta) });
  const second = { ...item, id: `${item.id}-${suffix}`, src: { in: splitSrc, out: item.src.out } };
  items.splice(l.index, 1, first, second);
  return { ...shiftAfter(ep, l.start + splitFrames / fps, delta), items };
}

function lcsLength(a: string[], b: string[]): number {
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (const x of a) {
    let prev = 0;
    for (let j = 1; j < b.length + 1; j++) {
      const tmp = dp[j];
      dp[j] = x === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

function mergeCuts(cuts: [number, number][]): [number, number][] {
  const sorted = [...cuts].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]);
    else out.push([c[0], c[1]]);
  }
  return out;
}

export function fitVoiceover(o: { episode: Episode; catalog: Catalog; recording: string; transcript: Transcript }): { episode: Episode; report: FitReport } {
  const words = o.transcript.words;
  const sentences = splitSentences(words);
  const sTokens = sentences.map((s) => sentenceTokens(s, words));
  const written = o.episode.slots.filter((s) => s.line.trim()).sort((a, b) => a.start - b.start);
  const fps = o.episode.output.fps;

  type Cand = { from: number; to: number; score: number };
  const cands: Cand[][] = written.map((slot) => {
    const lineTokens = textTokens(slot.line);
    // A span must start and end on sentences that belong to the line (at least half of the sentence's words appear in
    // order in the line), so retakes of a neighbour or "Um." never edge a span, even when neighbours share a word like "the".
    const belongs = sTokens.map((t) => t.length > 0 && lcsLength(t, lineTokens) / t.length >= 0.5);
    const out: Cand[] = [];
    for (let i = 0; i < sentences.length; i++) {
      if (!belongs[i]) continue;
      let tokens: string[] = [];
      for (let j = i; j < Math.min(sentences.length, i + 4); j++) {
        tokens = tokens.concat(sTokens[j]);
        if (!belongs[j]) continue;
        const score = similarity(tokens, lineTokens);
        if (score >= 0.6) out.push({ from: i, to: j, score });
      }
    }
    return out;
  });

  if (written.length === 0) {
    throw new MirageError('NOTHING_MATCHED', 'No narration lines are written yet', 'Run slots and write a line for each slot first.');
  }

  let ep = o.episode;
  const lines: VoiceLine[] = [];
  const report: FitReport = { lines: [], extendedSec: 0 };
  let prevEnd = -1;

  for (let k = 0; k < written.length; k++) {
    const after = cands[k].filter((c) => c.from > prevEnd);
    // The earliest first match of any later line caps this line, so a skipped line cannot let a retake land after a later one.
    let nextFirst = Infinity;
    for (let m = k + 1; m < written.length; m++) for (const c of cands[m]) if (c.from > prevEnd && c.from < nextFirst) nextFirst = c.from;
    let pool = after.filter((c) => c.to < nextFirst);
    // Only takes past a later line's first read: a line re-read at the end. Place it (placement is by slot), but keep
    // the recording cursor where it was so the later lines it jumped over can still be found.
    const reReadLate = pool.length === 0;
    if (reReadLate) pool = after;
    if (pool.length === 0) {
      report.lines.push({ slot: written[k].id, status: 'missing', takes: 0, overrunSec: 0 });
      continue;
    }
    const best = Math.max(...pool.map((c) => c.score));
    const good = pool.filter((c) => c.score >= best - 0.15);
    const chosen = good.reduce((a, b) => (b.from > a.from ? b : a));
    const takes = new Set(good.map((c) => c.from)).size;
    if (!reReadLate) prevEnd = chosen.to;

    const span = words.slice(sentences[chosen.from].from, sentences[chosen.to].to + 1);
    const spoken = span.filter((w) => !isFiller(w));
    const srcIn = Math.max(0, spoken[0].start - 0.05);
    const srcOut = spoken[spoken.length - 1].end + 0.1;
    const cuts: [number, number][] = [];
    for (const w of span) if (isFiller(w) && w.start > srcIn && w.end < srcOut) cuts.push([r3(w.start - 0.02), r3(w.end + 0.02)]);
    for (let i = 1; i < spoken.length; i++) {
      const a = spoken[i - 1].end;
      const b = spoken[i].start;
      if (b - a > 0.6) cuts.push([r3(a + 0.15), r3(b - 0.15)]);
    }
    const draft: VoiceLine = { slot: written[k].id, at: 0, src: { in: r3(srcIn), out: r3(srcOut) }, cuts: mergeCuts(cuts) };
    const duration = keptSegments(draft).reduce((s, g) => s + g.out - g.in, 0);

    const slot = ep.slots.find((s) => s.id === written[k].id)!;
    const at = r3(slot.start + 0.15);
    let overrun = at + duration - (slot.end + 0.2);
    if (overrun > 1e-3) {
      overrun = Math.ceil(overrun * fps - 1e-9) / fps;
      if (overrun > MAX_HOLD + 1e-9) throw new MirageError('BAD_ITEM', `Line ${slot.id} runs ${r3(overrun)}s past its slot (more than ${MAX_HOLD} s)`, HOLD_HINT);
      const before = timelineDuration(ep);
      const held = holdAt(ep, o.catalog, slot.end, overrun);
      const grown = timelineDuration(held) - before;
      // The narration stretch really grew; keep the slot in step so a re-fit finds no overrun left.
      ep = { ...held, slots: held.slots.map((x) => (x.id === slot.id ? { ...x, end: r6(slot.end + grown) } : x)) };
      report.extendedSec = r6(report.extendedSec + grown);
    } else {
      overrun = 0;
    }
    lines.push({ ...draft, at });
    report.lines.push({ slot: slot.id, status: 'placed', takes, overrunSec: r3(overrun) });
  }

  if (!report.lines.some((l) => l.status === 'placed')) {
    throw new MirageError('NOTHING_MATCHED', 'None of the script lines were found in the recording', 'Check that you read the current lines; re-run slots and guide if the cut changed.');
  }
  return { episode: EpisodeSchema.parse({ ...ep, voiceover: { recording: o.recording, lines } }), report };
}
