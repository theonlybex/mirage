import { EpisodeSchema, type Catalog, type Episode, type Transcript, type VoiceLine } from '@wordedits/shared';
import { isFiller, sentenceTokens, similarity, splitSentences, textTokens } from '../autoedit/takes.js';
import { MirageError } from './errors.js';
import { keptSegments } from './overlays.js';
import { cutOf, slotsStale, slotsStaleError } from './slots.js';
import { dropCollapsed, itemFrames, itemsFingerprint, layoutTimeline, shiftAfter, timelineDuration } from './timeline.js';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** True when the episode's items are no longer the ones its voice-over was fitted to. */
export function cutChanged(ep: Episode): boolean {
  const fp = ep.voiceover?.fittedItemsFingerprint;
  return fp !== undefined && fp !== itemsFingerprint(ep.items);
}

export function cutChangedError(): MirageError {
  return new MirageError(
    'BAD_ITEM',
    'The cut changed after the voice-over was fitted',
    'Run: pnpm mirage slots <project> <n>, then pnpm mirage vo <project> <n> <recording> (it reuses the saved transcript)',
  );
}

/**
 * The sha256 `recording` had when the voice-over was fitted from it: the full hash, or for episodes from before
 * recordingSha256, the 16-hex prefix in its transcript file's name. Undefined when unknown.
 */
export function fittedRecordingSha(vo: NonNullable<Episode['voiceover']>, recording: string): string | undefined {
  return vo.recordingSha256?.[recording] ?? /^voiceover\.([0-9a-f]{16})\.transcript\.json$/.exec(vo.transcripts[recording] ?? '')?.[1];
}

/** Slots with a written line but no fitted voice-over line. */
export function missingSlots(ep: Episode): string[] {
  const placed = new Set(ep.voiceover?.lines.map((l) => l.slot) ?? []);
  return ep.slots
    .filter((s) => s.line.trim() && !placed.has(s.id))
    .sort((a, b) => a.start - b.start)
    .map((s) => s.id);
}

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
  /** kept: re-recording was asked for (--add --slots) but the new recording lacks it, so the earlier take stays. */
  status: 'placed' | 'missing' | 'kept';
  takes: number;
  overrunSec: number;
}

export interface FitReport {
  lines: FitLine[];
  extendedSec: number;
  /** Things the user should hear about (printed with ⚠). */
  warnings: string[];
}

/**
 * Opens `delta` seconds at output time `t`. At an item boundary the item ending there grows (unused source first,
 * then frozen frames); inside an item, the item splits at `t` and its frame there is held. Everything after `t` shifts.
 */
export function holdAt(ep: Episode, catalog: Catalog, t: number, delta: number): Episode {
  return openAt(ep, catalog, t, delta).episode;
}

/** holdAt, also saying where the time opened and by how much everything after it moved (so it can be closed again). */
function openAt(ep: Episode, catalog: Catalog, t: number, delta: number): { episode: Episode; at: number; shift: number } {
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
    return { episode: { ...shiftAfter(ep, l.end, grown), items }, at: l.end, shift: grown };
  }

  if (t >= srcEnd - 1e-9 || splitFrames >= l.srcFrames) {
    // Inside the item's frozen tail: it is already a held frame, so just hold longer.
    const next = checkHold({ ...item, hold: r6(item.hold + delta) });
    items[l.index] = next;
    const grown = itemFrames(next, fps).frames / fps - l.frames / fps;
    return { episode: { ...shiftAfter(ep, t, grown), items }, at: t, shift: grown };
  }

  const splitSrc = r6(item.src.in + (splitFrames / fps) * item.speed);
  const ids = new Set(ep.items.map((x) => x.id));
  let suffix = 'b';
  while (ids.has(`${item.id}-${suffix}`)) suffix = String.fromCharCode(suffix.charCodeAt(0) + 1);
  const first = checkHold({ ...item, src: { in: item.src.in, out: splitSrc }, hold: r6(delta) });
  const second = { ...item, id: `${item.id}-${suffix}`, src: { in: splitSrc, out: item.src.out } };
  items.splice(l.index, 1, first, second);
  const at = l.start + splitFrames / fps;
  return { episode: { ...shiftAfter(ep, at, delta), items }, at, shift: delta };
}

/**
 * The episode as it was before its voice-over's fits held the picture: the items before the first fit, and every
 * overlay, cue and slot moved back by closing the time each hold opened (newest first). Ranges that were inside a
 * frozen frame shrink to nothing and are dropped (named in `dropped`). The voice-over is cleared.
 */
export function revertHolds(ep: Episode): { episode: Episode; dropped: string[] } {
  const vo = ep.voiceover;
  if (!vo?.baseItems) return { episode: ep, dropped: [] };
  let out: Episode = ep;
  for (const h of [...(vo.holds ?? [])].reverse()) out = shiftAfter(out, h.at + h.sec, -h.sec);
  const r6s = <T extends { start: number; end: number }>(x: T): T => ({ ...x, start: r6(x.start), end: r6(x.end) });
  out = { ...out, items: vo.baseItems, overlays: out.overlays.map(r6s), music: out.music.map(r6s), slots: out.slots.map(r6s), voiceover: null };
  return dropCollapsed(out, ep);
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

/** A run of sentences [from, to] that reads a line: `matched` of the line's words, in order. */
type Cand = { from: number; to: number; score: number; matched: number };

/**
 * The separate readings of a line among its candidate spans, in recording order. Overlapping spans are one reading: the
 * one covering most of the line wins (then the best score), so a later sub-span never drops the line's opening. A reading
 * counts as a take only when it covers about as much of the line as the best one (a re-read of just its second half
 * does not replace a full read).
 */
function takesOf(pool: Cand[], lineLength: number): Cand[] {
  const best = Math.max(...pool.map((c) => c.score));
  const ranked = pool.filter((c) => c.score >= best - 0.15).sort((a, b) => b.matched - a.matched || b.score - a.score || b.from - a.from);
  const picked: Cand[] = [];
  for (const c of ranked) if (!picked.some((p) => c.from <= p.to && p.from <= c.to)) picked.push(c);
  const most = Math.max(...picked.map((c) => c.matched));
  const slack = Math.max(1, Math.floor(0.1 * lineLength));
  return picked.filter((c) => c.matched >= most - slack).sort((a, b) => a.from - b.from);
}

/**
 * Fits the lines read in `recording` into their slots. With `only`, fits just those slots (lines re-recorded in a new
 * take) and keeps every other placed line; without it, replaces the whole voice-over.
 */
export function fitVoiceover(o: { episode: Episode; catalog: Catalog; recording: string; transcript: Transcript; only?: string[] }): { episode: Episode; report: FitReport } {
  const words = o.transcript.words;
  const sentences = splitSentences(words);
  const sTokens = sentences.map((s) => sentenceTokens(s, words));
  const prev = o.only ? o.episode.voiceover : null;
  if (prev && cutChanged(o.episode)) throw cutChangedError();
  // Slots of another cut would put the lines over the wrong picture (or past the end).
  if (slotsStale(o.episode)) throw slotsStaleError(o.episode.number);
  const report: FitReport = { lines: [], extendedSec: 0, warnings: [] };
  // A full fit starts from the cut before the voice-over, so holds never pile up across re-fits. After a re-cut the
  // cut as it is now is the starting point (its slots were computed for it).
  let start = o.episode;
  if (!o.only && !cutChanged(o.episode)) {
    const reverted = revertHolds(o.episode);
    start = reverted.episode;
    for (const d of reverted.dropped) report.warnings.push(`${d} was inside a frozen frame the earlier fit added, so it was dropped — place it again`);
  }
  const allWritten = start.slots.filter((s) => s.line.trim()).sort((a, b) => a.start - b.start);
  const targets = o.only ? new Set(o.only) : null;
  const written = targets ? allWritten.filter((s) => targets.has(s.id)) : allWritten;
  const fps = start.output.fps;

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
        if (score >= 0.6) out.push({ from: i, to: j, score, matched: lcsLength(tokens, lineTokens) });
      }
    }
    return out;
  });

  if (allWritten.length === 0) {
    throw new MirageError('NOTHING_MATCHED', 'No narration lines are written yet', 'Run slots and write a line for each slot first.');
  }
  if (written.length === 0) {
    throw new MirageError('NOTHING_MATCHED', 'None of those slots has a written line', 'List slots that have a line (see pnpm mirage slots).');
  }

  // Placed lines live in ep.voiceover while fitting, so a later hold shifts every line after it (kept ones included).
  const recording = prev ? prev.recording : o.recording;
  const lineRecording = o.recording === recording ? {} : { recording: o.recording };
  let ep: Episode = {
    ...start,
    voiceover: {
      recording,
      // Every earlier line stays until its slot gets a new take: a listed line the new recording lacks keeps its old one.
      lines: prev ? prev.lines : [],
      transcripts: prev ? prev.transcripts : {},
      cutFingerprint: prev?.cutFingerprint ?? itemsFingerprint(start.items),
      baseItems: prev ? prev.baseItems : start.items,
      holds: prev?.holds ?? [],
    },
  };
  let prevEnd = -1;

  const lineKeys = written.map((s) => textTokens(s.line).join(' '));
  for (let k = 0; k < written.length; k++) {
    const after = cands[k].filter((c) => c.from > prevEnd);
    // The earliest first match of any later line caps this line, so a skipped line cannot let a retake land after a later one.
    // A later slot with the same words is read later in the recording, so it caps nothing: it takes a later reading.
    let nextFirst = Infinity;
    let sameLater = 0;
    for (let m = k + 1; m < written.length; m++) {
      if (lineKeys[m] === lineKeys[k]) {
        sameLater++;
        continue;
      }
      for (const c of cands[m]) if (c.from > prevEnd && c.from < nextFirst) nextFirst = c.from;
    }
    let pool = after.filter((c) => c.to < nextFirst);
    // Only takes past a later line's first read: a line re-read at the end. Place it (placement is by slot), but keep
    // the recording cursor where it was so the later lines it jumped over can still be found.
    const reReadLate = pool.length === 0;
    if (reReadLate) pool = after;
    if (pool.length === 0) {
      const kept = ep.voiceover!.lines.some((l) => l.slot === written[k].id);
      report.lines.push({ slot: written[k].id, status: kept ? 'kept' : 'missing', takes: 0, overrunSec: 0 });
      continue;
    }
    const readings = takesOf(pool, textTokens(written[k].line).length);
    // Leave one reading for each later slot with the same words: this slot gets the last take before those.
    const own = Math.max(1, readings.length - sameLater);
    const chosen = readings[own - 1];
    const takes = own;
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
    const draft: VoiceLine = { slot: written[k].id, at: 0, src: { in: r3(srcIn), out: r3(srcOut) }, cuts: mergeCuts(cuts), ...lineRecording, text: written[k].line };
    const duration = keptSegments(draft).reduce((s, g) => s + g.out - g.in, 0);

    ep = { ...ep, voiceover: { ...ep.voiceover!, lines: ep.voiceover!.lines.filter((l) => l.slot !== written[k].id) } };
    const slot = ep.slots.find((s) => s.id === written[k].id)!;
    const at = r3(slot.start + 0.15);
    let overrun = at + duration - (slot.end + 0.2);
    if (overrun > 1e-3) {
      overrun = Math.ceil(overrun * fps - 1e-9) / fps;
      if (overrun > MAX_HOLD + 1e-9) throw new MirageError('BAD_ITEM', `Line ${slot.id} runs ${r3(overrun)}s past its slot (more than ${MAX_HOLD} s)`, HOLD_HINT);
      const before = timelineDuration(ep);
      const opened = openAt(ep, o.catalog, slot.end, overrun);
      const held = opened.episode;
      const grown = timelineDuration(held) - before;
      // The narration stretch really grew; keep the slot in step so a re-fit finds no overrun left.
      const holds = [...(held.voiceover!.holds ?? []), { at: r6(opened.at), sec: r6(opened.shift) }];
      ep = { ...held, slots: held.slots.map((x) => (x.id === slot.id ? { ...x, end: r6(slot.end + grown) } : x)), voiceover: { ...held.voiceover!, holds } };
      report.extendedSec = r6(report.extendedSec + grown);
    } else {
      overrun = 0;
    }
    ep = { ...ep, voiceover: { ...ep.voiceover!, lines: [...ep.voiceover!.lines, { ...draft, at }] } };
    report.lines.push({ slot: slot.id, status: 'placed', takes, overrunSec: r3(overrun) });
  }

  if (!report.lines.some((l) => l.status === 'placed')) {
    throw new MirageError('NOTHING_MATCHED', 'None of the script lines were found in the recording', 'Check that you read the current lines; re-run slots and guide if the cut changed.');
  }
  const vo = ep.voiceover!;
  const lines = [...vo.lines].sort((a, b) => a.at - b.at);
  // The holds moved the slots with the picture, so they now belong to the held cut.
  return { episode: EpisodeSchema.parse({ ...ep, slotsCut: cutOf(ep), voiceover: { ...vo, lines, fittedItemsFingerprint: itemsFingerprint(ep.items) } }), report };
}
