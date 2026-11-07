import { EpisodeSchema, isCard, type Catalog, type ClipItem, type Episode, type TimelineItem, type Transcript, type VoiceLine } from '@wordedits/shared';
import { isFiller, joinCompounds, matchTokens, normalizeWord, sentenceTokens, similarity, splitSentences, textTokens } from '../autoedit/takes.js';
import { MirageError } from './errors.js';
import { sameMove } from './move.js';
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

/** True when a line has words to read: a line of only punctuation, emoji or "um" counts as not written. */
export const hasWords = (line: string): boolean => textTokens(line).length > 0;

/** True when a line has letters but none that matching reads (Cyrillic, CJK, …): only English lines can be matched for now. */
export const notEnglish = (line: string): boolean => !hasWords(line) && /(?=\p{L})\P{Script=Latin}/u.test(line);

/** The error vo gives when every written line is in a language matching can't read. */
export function englishOnlyError(slots: string[]): MirageError {
  return new MirageError('NOTHING_MATCHED', 'Voice-over matching supports English only for now', `${slots.join(', ')} ${slots.length === 1 ? 'is' : 'are'} not in English: write the lines in English to fit a voice-over to them.`);
}

/** Slots with a written line but no fitted voice-over line. */
export function missingSlots(ep: Episode): string[] {
  const placed = new Set(ep.voiceover?.lines.map((l) => l.slot) ?? []);
  return ep.slots
    .filter((s) => hasWords(s.line) && !placed.has(s.id))
    .sort((a, b) => a.start - b.start)
    .map((s) => s.id);
}

/** Fitted lines whose slot's written line changed (or was cleared) since the fit, on an unchanged cut; `fitted` is what the voice-over says. */
export function lineChanges(ep: Episode): { slot: string; cleared: boolean; fitted: string }[] {
  // After a re-cut slots are renumbered and the next full vo replaces every line: only the cut-change advice applies.
  if (cutChanged(ep)) return [];
  const tidy = (t: string) => t.trim().replace(/\s+/g, ' ');
  const out: { slot: string; cleared: boolean; fitted: string }[] = [];
  for (const l of ep.voiceover?.lines ?? []) {
    if (l.text === undefined) continue;
    const line = ep.slots.find((s) => s.id === l.slot)?.line ?? '';
    if (!hasWords(line)) out.push({ slot: l.slot, cleared: true, fitted: l.text });
    else if (tidy(line) !== tidy(l.text)) out.push({ slot: l.slot, cleared: false, fitted: l.text });
  }
  return out;
}

/** lineChanges as ⚠ warnings: `check` says what to do; `render` also says the line plays and is captioned as fitted. */
export function lineChangeWarnings(ep: Episode, command: 'check' | 'render'): string[] {
  return lineChanges(ep).map(({ slot, cleared, fitted }) => {
    const asFitted = command === 'render' ? ` (captioned as fitted: "${fitted}")` : '';
    if (cleared) return `${slot}'s line was cleared since vo, but its voice-over still plays${asFitted} — run vo again without --add to drop it`;
    return command === 'render'
      ? `${slot}'s line changed since vo — it plays and is captioned as fitted ("${fitted}"); re-record it with vo --add --slots ${slot}`
      : `${slot}'s line changed since vo — re-record it with vo --add --slots ${slot}`;
  });
}

/** The schema's limit on an item's frozen frame. */
const MAX_HOLD = 10;
const HOLD_HINT = 'Shorten the line, or give it a longer slot by extending the picture';

function checkHold<T extends TimelineItem>(item: T): T {
  if (item.hold > MAX_HOLD + 1e-9) {
    throw new MirageError('BAD_ITEM', `item ${item.id} would freeze its frame for ${r3(item.hold)}s (more than ${MAX_HOLD} s)`, HOLD_HINT);
  }
  return item;
}

export interface FitLine {
  slot: string;
  /** kept: re-recording was asked for (--add --slots) but the new recording lacks it, so the earlier take stays. */
  /** partial: placed, but part of the written line was not found in the take (it should be re-read). */
  status: 'placed' | 'partial' | 'missing' | 'kept' | 'too long';
  takes: number;
  overrunSec: number;
}

/** The line got a new take from this recording (whole or partial). */
export const placedStatus = (s: FitLine['status']): boolean => s === 'placed' || s === 'partial';

export interface FitReport {
  lines: FitLine[];
  extendedSec: number;
  /** Things the user should hear about (printed with ⚠). */
  warnings: string[];
}

/**
 * Opens `delta` seconds at output time `t`. At an item boundary the item ending there grows (unused source first,
 * then frozen frames); inside an item, the item splits at `t` and its frame there is held. A card is never split: it
 * stays on longer (its hold grows). Everything after `t` shifts.
 */
export function holdAt(ep: Episode, catalog: Catalog, t: number, delta: number): Episode {
  return openAt(ep, catalog, t, delta).episode;
}

/** holdAt, also saying where the time opened and by how much everything after it moved (so it can be closed again). */
type Hold = NonNullable<NonNullable<Episode['voiceover']>['holds']>[number];

function openAt(ep: Episode, catalog: Catalog, t: number, delta: number): { episode: Episode; hold: Hold } {
  const fps = ep.output.fps;
  const laid = layoutTimeline(ep);
  const l = laid.find((x) => t > x.start + 1e-9 && t <= x.end + 1e-9) ?? laid[laid.length - 1];
  const item = l.item;
  const items = [...ep.items];
  const half = 0.5 / fps;
  const srcEnd = l.start + l.srcFrames / fps;
  const atBoundary = Math.abs(l.end - t) < half || t > l.end;
  const splitFrames = Math.max(1, Math.round((t - l.start) * fps));

  if (isCard(item)) {
    // A card has no source to run on and is never split: it holds longer, the time opening where it was asked for.
    const at = atBoundary ? l.end : t;
    const next = checkHold({ ...item, hold: r6(item.hold + delta) });
    items[l.index] = next;
    const grown = itemFrames(next, fps).frames / fps - l.frames / fps;
    return { episode: { ...shiftAfter(ep, at, grown), items }, hold: { at: r6(at), sec: r6(grown), item: item.id, hold: r6(next.hold - item.hold) } };
  }

  if (atBoundary) {
    const clipDur = catalog.clips.find((c) => c.id === item.clip)?.probe.durationSec ?? item.src.out;
    const available = Math.max(0, (clipDur - item.src.out) / item.speed);
    const useSource = Math.min(delta, available);
    const next = checkHold({ ...item, src: { in: item.src.in, out: r6(item.src.out + useSource * item.speed) }, hold: r6(item.hold + (delta - useSource)) });
    items[l.index] = next;
    const grown = itemFrames(next, fps).frames / fps - l.frames / fps;
    const source = useSource > 0 ? { out: next.src.out, outAdded: r6(next.src.out - item.src.out) } : {};
    return { episode: { ...shiftAfter(ep, l.end, grown), items }, hold: { at: r6(l.end), sec: r6(grown), item: item.id, hold: r6(next.hold - item.hold), ...source } };
  }

  if (t >= srcEnd - 1e-9 || splitFrames >= l.srcFrames) {
    // Inside the item's frozen tail: it is already a held frame, so just hold longer.
    const next = checkHold({ ...item, hold: r6(item.hold + delta) });
    items[l.index] = next;
    const grown = itemFrames(next, fps).frames / fps - l.frames / fps;
    return { episode: { ...shiftAfter(ep, t, grown), items }, hold: { at: r6(t), sec: r6(grown), item: item.id, hold: r6(delta) } };
  }

  const splitSrc = r6(item.src.in + (splitFrames / fps) * item.speed);
  const ids = new Set(ep.items.map((x) => x.id));
  let suffix = 'b';
  while (ids.has(`${item.id}-${suffix}`)) suffix = String.fromCharCode(suffix.charCodeAt(0) + 1);
  // A shot with a move plays it across its parts on one clock (layoutTimeline's clocks), so it carries on through the
  // frozen frame instead of starting again after it. A part of a split shot stays a part of it; a part whose move the
  // person changed is a shot of its own.
  const own = item.move && !(item.splitFrom && sameMove(item.move, item.splitFrom.move));
  const parts = own ? { splitFrom: { item: item.id, move: item.move! } } : {};
  const first = checkHold({ ...item, ...parts, src: { in: item.src.in, out: splitSrc }, hold: r6(delta) });
  const second = { ...item, ...parts, id: `${item.id}-${suffix}`, src: { in: splitSrc, out: item.src.out } };
  items.splice(l.index, 1, first, second);
  const at = l.start + splitFrames / fps;
  return { episode: { ...shiftAfter(ep, at, delta), items }, hold: { at: r6(at), sec: r6(delta), item: item.id, hold: first.hold, split: second.id } };
}

/**
 * After a re-cut, undoes what earlier fits did to items that are still there (newest first): the frozen frames they
 * added (never more than the item still has, so a hold the user wrote stays), source they added (when the item still
 * ends where the fit left it), and splits (merged back when both halves are still side by side and unchanged at the
 * seam, their moves included: a split shot's parts merge back into the item with the move it had, and parts whose move
 * the person changed stay apart). The time removed closes at the item's end, moving everything after it back.
 */
export function undoFitEdits(ep: Episode): { episode: Episode; dropped: string[] } {
  const fps = ep.output.fps;
  let out: Episode = ep;
  for (const h of [...(ep.voiceover?.holds ?? [])].reverse()) {
    const i = out.items.findIndex((x) => x.id === h.item);
    if (i < 0) continue;
    const laid = layoutTimeline(out);
    const it = out.items[i];
    if (isCard(it)) {
      // A card only ever got more time (fitting never splits one), opened at `at` inside it: closed there again while
      // that is still inside the card, so what sits on the card after it stays where it was; else at its end.
      const next = { ...it, hold: r6(Math.max(0, it.hold - (h.hold ?? 0))) };
      const removed = (laid[i].frames - itemFrames(next, fps).frames) / fps;
      const items = [...out.items];
      items[i] = next;
      const { start, end } = laid[i];
      const close = h.at >= start - 1e-6 && h.at + removed <= end + 1e-6 ? h.at + removed : end;
      out = { ...(removed > 1e-9 ? shiftAfter(out, close, -removed) : out), items };
      continue;
    }
    const item = it;
    let next = { ...item, hold: r6(Math.max(0, item.hold - (h.hold ?? 0))) };
    if (h.outAdded && h.out !== undefined && Math.abs(item.src.out - h.out) < 1e-6 && item.src.out - h.outAdded > item.src.in) {
      next = { ...next, src: { in: item.src.in, out: r6(item.src.out - h.outAdded) } };
    }
    const items = [...out.items];
    // The frozen frame (and added source) sit at the end of this item, also when it was the first half of a split.
    const end = laid[i].end;
    let frames = laid[i].frames;
    const after = out.items[i + 1];
    const b = after && !isCard(after) ? after : undefined;
    const same = (k: 'clip' | 'speed' | 'audio' | 'zoom' | 'frame' | 'quiet' | 'onBeat' | 'beat') => b !== undefined && b[k] === item[k];
    const sameFocus = b !== undefined && b.focus.x === item.focus.x && b.focus.y === item.focus.y;
    // The halves' moves are as the split left them: the split shot's move, or none when the item had none (a move the
    // person changed or added on either half keeps them apart, like a changed zoom on one).
    const asSplit = (x: typeof item) => sameMove(x.move, x.splitFrom?.move);
    const sameMoves = b !== undefined && b.splitFrom?.item === item.splitFrom?.item && sameMove(b.splitFrom?.move, item.splitFrom?.move) && asSplit(item) && asSplit(b);
    if (h.split && next.hold === 0 && b?.id === h.split && Math.abs(b.src.in - next.src.out) < 1e-6 && sameFocus && sameMoves && (['clip', 'speed', 'audio', 'zoom', 'frame', 'quiet', 'onBeat', 'beat'] as const).every(same)) {
      next = { ...next, src: { in: next.src.in, out: b.src.out }, hold: b.hold };
      items.splice(i + 1, 1);
      frames += laid[i + 1].frames;
    }
    items[i] = next;
    const removed = (frames - itemFrames(next, fps).frames) / fps;
    out = { ...(removed > 1e-9 ? shiftAfter(out, end, -removed) : out), items };
  }
  // A split shot merged back whole is the item it was: no part of anything.
  const items = out.items;
  const shot = (x: TimelineItem | undefined) => (x && !isCard(x) ? x.splitFrom?.item : undefined);
  const alone = (i: number) => ![items[i - 1], items[i + 1]].some((x) => shot(x) === shot(items[i]));
  out = { ...out, items: items.map((x, i) => (!isCard(x) && x.splitFrom && alone(i) ? withoutSplit(x) : x)) };
  return dropCollapsed(out, ep);
}

function withoutSplit(item: ClipItem): ClipItem {
  const { splitFrom: _, ...rest } = item;
  return rest;
}

/**
 * The item fields that don't change the timing (the schema's others: id, clip, src, speed, audio and hold do, and
 * splitFrom is fitting's): a full re-fit keeps the person's current ones.
 */
const LOOK = ['beat', 'zoom', 'frame', 'focus', 'move', 'quiet', 'onBeat'] as const;

/**
 * `base` with the LOOK fields of `now` (a field absent from `now` is removed). A card keeps its length (`sec`) from
 * `base` and takes the rest from `now`; an item that became a card, or a card that became a clip item, stays `base`.
 */
function withLook(base: TimelineItem, now: TimelineItem): TimelineItem {
  if (isCard(base) || isCard(now)) {
    return isCard(base) && isCard(now) ? { ...base, beat: now.beat, quiet: now.quiet, card: { ...now.card, sec: base.card.sec } } : base;
  }
  const out: Record<string, unknown> = { ...base };
  for (const k of LOOK) {
    if (now[k] === undefined) delete out[k];
    else out[k] = now[k];
  }
  return out as typeof base;
}

/**
 * The episode as it was before its voice-over's fits held the picture: the items before the first fit, and every
 * overlay, cue and slot moved back by closing the time each hold opened (newest first). Ranges that were inside a
 * frozen frame shrink to nothing and are dropped (named in `dropped`). The voice-over is cleared. Each item keeps the
 * look the person gave it since (LOOK: move, zoom, focus, frame, …, from the item with its id now — for a split
 * item, its first part).
 */
export function revertHolds(ep: Episode): { episode: Episode; dropped: string[] } {
  const vo = ep.voiceover;
  if (!vo?.baseItems) return { episode: ep, dropped: [] };
  let out: Episode = ep;
  for (const h of [...(vo.holds ?? [])].reverse()) out = shiftAfter(out, h.at + h.sec, -h.sec);
  const r6s = <T extends { start: number; end: number }>(x: T): T => ({ ...x, start: r6(x.start), end: r6(x.end) });
  const now = new Map(ep.items.map((x) => [x.id, x]));
  const items = vo.baseItems.map((x) => (now.has(x.id) ? withLook(x, now.get(x.id)!) : x));
  const music = out.music.map((c) => {
    const m = r6s(c);
    return c.dips ? { ...m, dips: c.dips.map(r6s) } : m;
  });
  out = { ...out, items, overlays: out.overlays.map(r6s), music, slots: out.slots.map(r6s), ...(out.sfx ? { sfx: out.sfx.map((x) => ({ ...x, at: r6(x.at) })) } : {}), voiceover: null };
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

/**
 * A run of sentences [from, to] that reads a line: `matched` of the line's words, in order, among its `length` words;
 * `drop` holds the indices of words cut from it (earlier readings of what is re-read inside it).
 */
type Cand = { from: number; to: number; score: number; matched: number; length: number; endsLine: boolean; drop?: Set<number> };

/** Words a restarted sentence must begin with again, and how far (in words) the restart may come after the attempt. */
const RESTART_WORDS = 3;
const MAX_RESTART_GAP = 25;
/** Sentences with words that one span may cover (filler-only sentences don't count). */
const MAX_SPAN_SENTENCES = 6;

/** Coverage minus extra speech. */
const worth = (c: Cand) => 2 * c.matched - c.length;

/**
 * The separate readings of a line among its candidate spans, in recording order. Overlapping spans are one reading: the
 * one covering most of the line with least extra speech wins (then the best score), so a later sub-span never drops
 * the line's opening and a false start before a re-read is never played with it. A reading
 * counts as a take only when it covers about as much of the line as the best one (a re-read of just its second half
 * does not replace a full read).
 */
function takesOf(pool: Cand[], lineLength: number): Cand[] {
  const best = Math.max(...pool.map((c) => c.score));
  // Coverage minus extra speech: a span reaching back over a false start gains a word at most (a transcription
  // difference between the reads) but carries the whole false start.
  const ranked = pool.filter((c) => c.score >= best - 0.15).sort((a, b) => worth(b) - worth(a) || Number(b.endsLine) - Number(a.endsLine) || b.score - a.score || b.from - a.from);
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
export function fitVoiceover(o: { episode: Episode; catalog: Catalog; recording: string; transcript: Transcript; only?: string[]; keepPauses?: boolean }): { episode: Episode; report: FitReport } {
  const words = o.transcript.words;
  const sentences = splitSentences(words);
  const sTokens = sentences.map((s) => sentenceTokens(s, words));
  /**
   * Word indices in [from, to] read and then restarted: a run of words followed straight away (fillers aside) by the same
   * words again, its last word allowed to differ (a cut-off word) when the run has three or more; or an attempt whose
   * first three words start a later run within MAX_RESTART_GAP words. Earlier readings go, so the last reading of each
   * sentence or phrase wins.
   */
  const restarts = (from: number, to: number): Set<number> => {
    const idx: number[] = [];
    for (let x = from; x <= to; x++) if (!isFiller(words[x]) && normalizeWord(words[x].w)) idx.push(x);
    const a = idx.map((x) => normalizeWord(words[x].w));
    const drop = new Set<number>();
    for (let p = 0; p < a.length; ) {
      let len = 1;
      for (; len <= (a.length - p) / 2; len++) {
        let same = true;
        for (let t = 0; t < len && same; t++) same = a[p + t] === a[p + len + t] || (t === len - 1 && len >= 3);
        if (same) break;
      }
      if (len <= (a.length - p) / 2) {
        for (let t = 0; t < len; t++) drop.add(idx[p + t]);
        p += len;
        continue;
      }
      // A sentence restarted: a later run starts with the same three words, and the attempts may then differ ("and" vs
      // "in", a cut-off "back" vs "back end"). Everything from this attempt up to the last restart goes.
      let q = -1;
      for (let r = p + RESTART_WORDS; r <= Math.min(a.length - RESTART_WORDS, p + MAX_RESTART_GAP); r++) {
        if (a.slice(p, p + RESTART_WORDS).every((x, t) => x === a[r + t])) q = r;
      }
      if (q < 0) {
        p++;
        continue;
      }
      for (let t = p; t < q; t++) drop.add(idx[t]);
      p = q;
    }
    return drop;
  };
  const prev = o.only ? o.episode.voiceover : null;
  if (prev && cutChanged(o.episode)) throw cutChangedError();
  // Slots of another cut would put the lines over the wrong picture (or past the end).
  if (slotsStale(o.episode)) throw slotsStaleError(o.episode.number);
  const report: FitReport = { lines: [], extendedSec: 0, warnings: [] };
  // Nothing to compare the cut with (slots from before slotsCut, no voice-over yet): say so once; the fit records the cut.
  if (!o.episode.slotsCut && !o.episode.voiceover?.fittedItemsFingerprint) {
    report.warnings.push(
      `The slots were written before Mirage recorded which cut they belong to, so vo can't tell whether they are current — if the cut changed since slots ran, run: pnpm mirage slots <project> ${o.episode.number}, check the lines, then vo again`,
    );
  }
  // A full fit starts from the cut before the voice-over, so holds never pile up across re-fits. After a re-cut (its
  // slots were computed for the cut as it is now) it undoes what earlier fits did to the items still there.
  let start = o.episode;
  if (!o.only) {
    const reverted = cutChanged(o.episode) ? undoFitEdits(o.episode) : revertHolds(o.episode);
    start = { ...reverted.episode, voiceover: null };
    for (const d of reverted.dropped) report.warnings.push(`${d} was inside a frozen frame the earlier fit added, so it was dropped — place it again`);
  }
  const allWritten = start.slots.filter((s) => hasWords(s.line)).sort((a, b) => a.start - b.start);
  const targets = o.only ? new Set(o.only) : null;
  const written = targets ? allWritten.filter((s) => targets.has(s.id)) : allWritten;
  const fps = start.output.fps;

  const spokenVocab = new Set(sTokens.flat());
  const belongsOf: boolean[][] = [];
  const spansOf: string[][][] = [];
  const lineTokensOf = written.map((slot) => joinCompounds(textTokens(slot.line), spokenVocab));
  const cands: Cand[][] = written.map((slot, k) => {
    const lineTokens = lineTokensOf[k];
    const lineVocab = new Set(lineTokens);
    const spans = sTokens.map((t) => joinCompounds(t, lineVocab));
    // A span must start and end on sentences that belong to the line (at least half of the sentence's words appear in
    // order in the line), so retakes of a neighbour or "Um." never edge a span, even when neighbours share a word like "the".
    const belongs = spans.map((t) => t.length > 0 && lcsLength(t, lineTokens) / t.length >= 0.5);
    belongsOf.push(belongs);
    spansOf.push(spans);
    const out: Cand[] = [];
    for (let i = 0; i < sentences.length; i++) {
      if (!belongs[i]) continue;
      let tokens: string[] = [];
      const ends = (t: string[]) => lineTokens.length > 0 && t.length > 0 && lineTokens.slice(-2).every((x, n, all) => x === t[t.length - all.length + n]);
      for (let j = i, counted = 0; j < sentences.length && counted < MAX_SPAN_SENTENCES; j++) {
        if (spans[j].length) counted++;
        tokens = tokens.concat(spans[j]);
        if (!belongs[j]) continue;
        const raw: Cand = { from: i, to: j, score: similarity(tokens, lineTokens), matched: lcsLength(tokens, lineTokens), length: tokens.length, endsLine: ends(tokens) };
        // The same span with every reading that is restarted inside it cut (a sentence flubbed and re-read), when that
        // reads the line better — a line that really repeats words keeps them.
        const drop = restarts(sentences[i].from, sentences[j].to);
        let best: Cand = raw;
        if (drop.size) {
          const kept = joinCompounds(words.slice(sentences[i].from, sentences[j].to + 1).filter((w, x) => !isFiller(w) && !drop.has(sentences[i].from + x)).flatMap((w) => matchTokens(w.w)), lineVocab);
          const clean: Cand = { from: i, to: j, score: similarity(kept, lineTokens), matched: lcsLength(kept, lineTokens), length: kept.length, endsLine: ends(kept), drop };
          if (worth(clean) > worth(raw)) best = clean;
        }
        if (best.score >= 0.6) out.push(best);
      }
    }
    return out;
  });

  const foreign = start.slots.filter((s) => notEnglish(s.line)).map((s) => s.id);
  if (allWritten.length === 0) {
    if (foreign.length) throw englishOnlyError(foreign);
    throw new MirageError('NOTHING_MATCHED', 'No narration lines are written yet', 'Run slots and write a line for each slot first.');
  }
  for (const id of foreign) if (!targets || targets.has(id)) report.warnings.push(`${id}'s line isn't in English — voice-over matching supports English only for now, so it was left out`);
  if (written.length === 0) {
    throw new MirageError('NOTHING_MATCHED', 'None of those slots has a written line', 'List slots that have a line (see pnpm mirage slots).');
  }
  if (!words.some((w) => !isFiller(w))) {
    throw new MirageError('NOTHING_MATCHED', `No speech was heard in ${o.recording}`, 'Check that the microphone was on and that this is the right file.');
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
    const readings = takesOf(pool, lineTokensOf[k].length);
    // Leave one reading for each later slot with the same words: this slot gets the last take before those.
    const own = Math.max(1, readings.length - sameLater);
    const chosen = readings[own - 1];
    const takes = own;
    // Safety net: the line's sentences read just before or just after the chosen span (up to the next line's first read)
    // cover more of it — a flub that couldn't be cut cleanly, or an ending the span doesn't reach — so part of the line
    // would be lost: say so rather than report it placed.
    let near: string[] = [];
    const last = Math.min(sentences.length - 1, chosen.to + 3, nextFirst - 1);
    for (let m = Math.max(prevEnd + 1, chosen.from - 3); m <= Math.max(chosen.to, last); m++) if (belongsOf[k][m]) near = near.concat(spansOf[k][m]);
    const partial = chosen.matched < lcsLength(near, lineTokensOf[k]) - Math.max(1, Math.floor(0.1 * lineTokensOf[k].length));
    if (!reReadLate) prevEnd = chosen.to;

    const first = sentences[chosen.from].from;
    const span = words.slice(first, sentences[chosen.to].to + 1);
    const dropped = (x: number) => chosen.drop?.has(first + x) ?? false;
    const spoken = span.filter((w, x) => !isFiller(w) && !dropped(x));
    const srcIn = Math.max(0, spoken[0].start - 0.05);
    const srcOut = spoken[spoken.length - 1].end + 0.1;
    const cuts: [number, number][] = [];
    for (const w of span) if (isFiller(w) && w.start > srcIn && w.end < srcOut) cuts.push([r3(w.start - 0.02), r3(w.end + 0.02)]);
    // Each restarted reading goes, with the pause around it, keeping 0.15 s of air on either side.
    for (let x = 0; x < span.length; x++) {
      if (!dropped(x)) continue;
      let y = x;
      while (y + 1 < span.length && (dropped(y + 1) || isFiller(span[y + 1]))) y++;
      const before = span.slice(0, x).filter((w, z) => !isFiller(w) && !dropped(z)).pop();
      const after = span.slice(y + 1).find((w, z) => !isFiller(w) && !dropped(y + 1 + z));
      const a = before ? Math.max(before.end, Math.min(span[x].start, before.end + 0.15)) : span[x].start;
      const b = after ? Math.min(after.start, Math.max(span[y].end, after.start - 0.15)) : span[y].end;
      cuts.push([r3(a), r3(b)]);
      x = y;
    }
    for (let i = 1; i < spoken.length && !o.keepPauses; i++) {
      const a = spoken[i - 1].end;
      const b = spoken[i].start;
      if (b - a > 0.6) cuts.push([r3(a + 0.15), r3(b - 0.15)]);
    }
    const draft: VoiceLine = { slot: written[k].id, at: 0, src: { in: r3(srcIn), out: r3(srcOut) }, cuts: mergeCuts(cuts), ...lineRecording, text: written[k].line };
    const duration = keptSegments(draft).reduce((s, g) => s + g.out - g.in, 0);

    const slot = ep.slots.find((s) => s.id === written[k].id)!;
    const at = r3(slot.start + 0.15);
    // A line may run a little past its slot, but never past the end of the episode.
    let overrun = at + duration - Math.min(slot.end + 0.2, timelineDuration(ep));
    let opened: ReturnType<typeof openAt> | null = null;
    if (overrun > 1e-3) {
      overrun = Math.ceil(overrun * fps - 1e-9) / fps;
      try {
        opened = openAt(ep, o.catalog, slot.end, overrun);
      } catch (e) {
        // More frozen frame than an item can hold: report this line and place the others.
        if (!(e instanceof MirageError)) throw e;
        report.lines.push({ slot: slot.id, status: 'too long', takes, overrunSec: r3(overrun) });
        continue;
      }
    }
    // The slot's earlier take (--add --slots) gives way to the new one.
    const withoutOld = (e: Episode): Episode => ({ ...e, voiceover: { ...e.voiceover!, lines: e.voiceover!.lines.filter((l) => l.slot !== slot.id) } });
    if (opened) {
      const before = timelineDuration(ep);
      const held = withoutOld(opened.episode);
      const grown = timelineDuration(held) - before;
      // The narration stretch really grew; keep the slot in step so a re-fit finds no overrun left.
      const holds = [...(held.voiceover!.holds ?? []), opened.hold];
      ep = { ...held, slots: held.slots.map((x) => (x.id === slot.id ? { ...x, end: r6(slot.end + grown) } : x)), voiceover: { ...held.voiceover!, holds } };
      report.extendedSec = r6(report.extendedSec + grown);
    } else {
      ep = withoutOld(ep);
      overrun = 0;
    }
    ep = { ...ep, voiceover: { ...ep.voiceover!, lines: [...ep.voiceover!.lines, { ...draft, at }] } };
    report.lines.push({ slot: slot.id, status: partial ? 'partial' : 'placed', takes, overrunSec: r3(overrun) });
  }

  if (!report.lines.some((l) => placedStatus(l.status))) {
    const long = report.lines.find((l) => l.status === 'too long');
    if (long) throw new MirageError('BAD_ITEM', `Line ${long.slot} runs ${long.overrunSec}s past its slot (more than ${MAX_HOLD} s)`, HOLD_HINT);
    throw new MirageError('NOTHING_MATCHED', 'None of the script lines were found in the recording', 'Check that you read the current lines; re-run slots and guide if the cut changed.');
  }
  const vo = ep.voiceover!;
  const lines = [...vo.lines].sort((a, b) => a.at - b.at);
  // The holds moved the slots with the picture, so they now belong to the held cut.
  return { episode: EpisodeSchema.parse({ ...ep, slotsCut: cutOf(ep), voiceover: { ...vo, lines, fittedItemsFingerprint: itemsFingerprint(ep.items) } }), report };
}
