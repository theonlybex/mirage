// SPDX-License-Identifier: MIT
// The playbook, measured: each number a format states in its front matter (`playbook`, see PlaybookSchema), held against
// a cut. `check` prints the results as its `Playbook (<format>):` section and `predict` scores them. A miss is never an
// error: the person may break a rule on purpose (the video's `experiment`). What can't be measured honestly from the
// timeline, the catalog's transcripts and the narration lines is said to be not measured, never guessed.
import { isCard, type Catalog, type Episode, type Series, type Video } from '@wordedits/shared';
import { describeError } from './errors.js';
import { shortKind, type Format, type Playbook } from './formats.js';
import { mineId, type Formula } from './formulas.js';
import { cutParts, titleFeatures, type CutParts } from './learn.js';
import { formatTime } from './timeline.js';
import { readVideo } from './video.js';
import { hasWords } from './voiceover.js';

/**
 * The rules, in the order they are printed. `opening`, `ending`, `loop`, `length` and `series` need no number: a cut opens
 * on the picture, a short has no outro and no end card, a standalone short ends on its loop, a format with a target
 * length warns past its limit, and a series keeps an open question for its next episode.
 */
export type PlaybookRule = 'opening' | 'firstWord' | 'idea' | 'title' | 'empty' | 'pace' | 'words' | 'answerPlace' | 'answer' | 'ending' | 'loop' | 'length' | 'series';

export interface PlaybookResult {
  rule: PlaybookRule;
  status: 'met' | 'missed' | 'unmeasured';
  /** The line as `check` and `predict` print it after its mark: the measured number, then the target. */
  text: string;
  /** For a miss: where it happens (a time, a stretch, an item) and the one change to make there; the worst place first. */
  moments?: { where: string; change: string }[];
  /** The ⚠ lines of `check` that say this same miss: `check` prints those and leaves this line out of its section. */
  warnings?: string[];
}

export interface PlaybookReport {
  format: string;
  /** The keys the person's own `<format>-mine` formula sets, replacing the format's. */
  overrides: string[];
  results: PlaybookResult[];
}

const EPS = 1e-6;
/** 0:12.4 — a moment of the cut, to a tenth of a second. */
const at = (sec: number) => {
  const t = Math.round(sec * 10) / 10;
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
};
const span = (from: number, to: number) => `${at(from)}–${at(to)}`;
const pct = (share: number) => `${Math.round(share * 100)}%`;
/** A range as its target reads: `145–200`, `29 or more`, `25 or fewer`. */
const rangeText = (r: { min?: number; max?: number }) => (r.min !== undefined && r.max !== undefined ? `${r.min}–${r.max}` : r.min !== undefined ? `${r.min} or more` : `${r.max} or fewer`);

/**
 * The playbook a video of this format is held to in this project: the format's own, with each key the person's
 * `<format>-mine` formula has in its front matter replacing the format's. `overrides` names those keys.
 */
export function playbookFor(format: Format, formulas: Formula[]): { playbook: Playbook; overrides: string[] } {
  const mine = formulas.find((f) => f.origin === 'yours' && f.id === mineId(format.id))?.playbook;
  return { playbook: { ...format.playbook, ...mine }, overrides: mine ? Object.keys(mine) : [] };
}

/**
 * The limit past which a video of this format is too long, and whose it is. The playbook's `targetSec` and `warnPastSec`
 * (a person's `<format>-mine` formula sets them: `mine`) replace the format's own; a target without a limit warns past
 * 1.5 × the target. A video's own target scales the limit: a vlog aiming at 15 min instead of 4:20 is warned past
 * 400 s × 900 / 260. A short's limit never goes past its format's, the longest the platforms take. Null when nothing sets a limit.
 */
export function lengthLimit(format: Format, video: Video | null, playbook: Playbook = {}, mine = false): { limit: number; whose: string; aim: number | null } | null {
  const target = playbook.targetSec ?? format.targetSec;
  const warn = playbook.warnPastSec ?? (playbook.targetSec !== undefined ? playbook.targetSec * 1.5 : format.warnPastSec);
  if (warn === undefined) return null;
  const own = video?.targetSec !== undefined && target !== undefined;
  let limit = own ? (warn * video!.targetSec!) / target! : warn;
  const stated = playbook.targetSec !== undefined || playbook.warnPastSec !== undefined;
  let whose = own ? `this video's ${formatTime(limit)} limit` : stated && mine ? `your ${mineId(format.id)} formula's ${formatTime(limit)}` : `the ${format.name} format's ${formatTime(limit)}`;
  if (format.short && format.warnPastSec !== undefined && limit >= format.warnPastSec) {
    limit = format.warnPastSec;
    whose = `the ${format.name} format's ${formatTime(limit)}`;
  }
  return { limit, whose, aim: own ? video!.targetSec! : (target ?? null) };
}

/** The ⚠ of a video longer than its limit (see lengthLimit); null when it isn't. */
export function lengthWarning(lengthSec: number, format: Format, video: Video | null, playbook: Playbook = {}, mine = false): string | null {
  const l = lengthLimit(format, video, playbook, mine);
  if (!l || lengthSec <= l.limit + EPS) return null;
  return `the video is ${formatTime(lengthSec)}, longer than ${l.whose} — ${format.short ? 'cut whole moments' : 'cut whole bits rather than thinning laughs'}`;
}

/** A stretch of the cut in which something is said: a word, or a written narration line not recorded yet. */
interface Said { start: number; end: number }

/**
 * The cut's words for the playbook: the spoken ones, and, while no voice-over is fitted, the narration lines written
 * into the slots (each line's words spread over its slot at the slot's own budget). So a rough cut whose lines are
 * written but not recorded yet is not called silent. `written` says that happened.
 */
function saidIn(ep: Episode, parts: CutParts): { said: Said[]; written: boolean } | null {
  if (!parts.said) return null;
  const said: Said[] = parts.said.map((w) => ({ start: w.start, end: Math.min(w.end, parts.lengthSec) }));
  let written = false;
  if (!ep.voiceover) {
    for (const slot of ep.slots) {
      if (!hasWords(slot.line) || slot.start >= parts.lengthSec) continue;
      const count = slot.line.split(/\s+/).filter(Boolean).length;
      const each = (slot.end - slot.start) / Math.max(count, slot.maxWords);
      for (let i = 0; i < count; i++) said.push({ start: slot.start + i * each, end: slot.start + (i + 1) * each });
      written = true;
    }
  }
  return { said: said.sort((a, b) => a.start - b.start), written };
}

/** The stretches of [0, length] that none of these cover, longest first. A point (start = end) only ends one stretch and starts the next. */
function gaps(covered: Said[], length: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let until = 0;
  for (const c of [...covered].sort((a, b) => a.start - b.start)) {
    if (c.start > until + EPS) out.push({ from: until, to: c.start });
    until = Math.max(until, c.end);
  }
  if (length > until + EPS) out.push({ from: until, to: length });
  return out.sort((a, b) => b.to - b.from - (a.to - a.from));
}

/**
 * Measures video `n`'s cut against a playbook (see playbookFor). The rules a format has no number for are left out; the
 * ones that can't be measured come back `unmeasured`, with the reason in their text:
 * - the three word rules (first word, empty stretches, words a minute) when an item keeps the sound of a clip that has
 *   no transcript, or the fitted voice-over's transcript can't be read;
 * - the idea and the title, when the video has no video.json; the title also while no title is chosen (`titles.chosen`).
 * `series` is the series the video belongs to, when it has one: its open question is held to be on record.
 * Cuts are the timeline's own: a cut that is already inside a source clip is not seen. A stretch is empty only when
 * nothing is said AND nothing cuts AND no overlay starts in it: silence over changing pictures is not empty.
 */
export async function measurePlaybook(
  project: string,
  n: number,
  o: { episode: Episode; catalog: Catalog; video: Video | null; format: Format; playbook: Playbook; overrides?: string[]; series?: Series | null },
): Promise<PlaybookReport> {
  const { episode: ep, catalog, video, format, playbook } = o;
  const results: PlaybookResult[] = [];
  const report: PlaybookReport = { format: format.id, overrides: o.overrides ?? [], results };
  if (!ep.items.length) return report;

  // A voice-over whose transcript is gone must not stop a check: its words are then not known.
  let unknownWords: string | null = null;
  let parts: CutParts;
  try {
    parts = await cutParts(project, ep, catalog);
  } catch (e) {
    unknownWords = describeError(e).message;
    parts = { ...(await cutParts(project, { ...ep, voiceover: null }, catalog)), said: null };
  }
  if (parts.unheard) unknownWords = `item ${parts.unheard.item} keeps the sound of ${parts.unheard.clip}, which has no transcript`;
  const { laid, lengthSec: length, shots } = parts;
  const words = saidIn(ep, parts);
  const playing = (sec: number) => (laid.find((l) => sec >= l.start - EPS && sec < l.end) ?? laid.at(-1)!).item.id;
  const kind = shortKind(format, video);
  const first = laid[0]!;
  const last = laid.at(-1)!;
  const notMeasured = (rule: PlaybookRule, label: string, why: string) => results.push({ rule, status: 'unmeasured', text: `${label}: not measured — ${why}` });

  // ---- Chosen: the first seconds, and the idea ----
  if (kind && (first.item.beat === 'title' || first.item.beat === 'cold-open')) {
    const text = `a short opens on its hook, not a ${first.item.beat}: item ${first.item.id}`;
    results.push({ rule: 'opening', status: 'missed', text, warnings: [text], moments: [{ where: `${at(0)} (item ${first.item.id})`, change: `open on the hook: rename item ${first.item.id}'s beat to hook if it is the hook, else drop it or move it later` }] });
  } else if (isCard(first.item)) {
    results.push({
      rule: 'opening', status: 'missed', text: `opens on a full-screen card (item ${first.item.id}) — the playbook opens on the picture`,
      moments: [{ where: `${span(first.start, first.end)} (item ${first.item.id})`, change: `open on the picture: move item ${first.item.id} after the opening, or drop it` }],
    });
  } else {
    results.push({ rule: 'opening', status: 'met', text: `opens on the picture (item ${first.item.id})` });
  }

  if (playbook.firstWordSec !== undefined) {
    const target = `the playbook asks for one within ${playbook.firstWordSec} s`;
    if (!words) notMeasured('firstWord', 'first word', unknownWords!);
    else if (!words.said.length) {
      results.push({ rule: 'firstWord', status: 'missed', text: `no word is spoken — ${target}`, moments: [{ where: `${at(0)} (item ${first.item.id})`, change: 'open on a line said out loud; a hook that is seen rather than heard is the person\'s call' }] });
    } else {
      const t = words.said[0]!.start;
      const met = t <= playbook.firstWordSec + EPS;
      results.push({
        rule: 'firstWord', status: met ? 'met' : 'missed', text: `first word at ${t.toFixed(1)} s${met ? '' : ` (the cut opens on item ${first.item.id})`} — ${target}`,
        ...(met ? {} : { moments: [{ where: `${span(0, t)} (item ${first.item.id})`, change: `start item ${first.item.id} later in its clip, so the first word comes straight away` }] }),
      });
    }
  }

  if (playbook.ideaNeeded) {
    if (!video) notMeasured('idea', 'the idea', 'the video has no video.json');
    else {
      // A teaser's question is the big video's: what the short itself has on record comes first.
      const big = kind === 'teaser' && video.from !== undefined ? await readVideo(project, video.from).catch(() => null) : null;
      const idea = { ...big?.idea, ...video.idea };
      const keys = ['gap', 'question', 'doubt', 'stake'] as const;
      const have = keys.filter((k) => idea[k] !== undefined);
      const lack = keys.filter((k) => idea[k] === undefined);
      const from = big?.idea && keys.some((k) => video.idea?.[k] === undefined && big.idea![k] !== undefined) ? `, the big video's (video ${video.from}) where the short has none` : '';
      if (idea.gap !== undefined && idea.question !== undefined) {
        results.push({ rule: 'idea', status: 'met', text: `the idea is on record: ${have.join(', ')}${lack.length ? ` (no ${lack.join(', no ')})` : ''}${from}` });
      } else {
        const missing = (['gap', 'question'] as const).filter((k) => idea[k] === undefined);
        results.push({
          rule: 'idea', status: 'missed', text: `the idea has no ${missing.join(' and no ')} on record — the playbook asks for the gap and the question before cutting`,
          moments: [{ where: `episodes/${n}/video.json`, change: `ask the person for the ${missing.join(' and the ')} and write ${missing.length === 1 ? 'it' : 'them'} into the video's idea — never invent one` }],
        });
      }
    }
  }

  if (playbook.title) {
    const chosen = video?.titles?.chosen;
    if (!video) notMeasured('title', 'the title', 'the video has no video.json');
    else if (!chosen) notMeasured('title', 'the title', `no title is chosen yet (titles.chosen in episodes/${n}/video.json)`);
    else {
      const t = playbook.title;
      const f = titleFeatures(chosen);
      const fits: string[] = [];
      const misses: string[] = [];
      const wanted: string[] = [];
      const hold = (want: boolean | undefined, has: boolean, yes: string, no: string) => {
        if (want === undefined) return;
        (want === has ? fits : misses).push(has ? yes : no);
        wanted.push(want ? yes : no);
      };
      hold(t.allCaps, f.allCaps, 'in capitals', 'not in capitals');
      hold(t.hasNumber, f.hasNumber, 'has a number', 'no number');
      hold(t.firstPerson, f.firstPerson, 'in the first person', 'not in the first person');
      if (t.endsWith) hold(true, chosen.replace(/[([][^)\]]+[)\]]\s*$/, '').trimEnd().endsWith(t.endsWith), `ends with ${t.endsWith}`, `doesn't end with ${t.endsWith}`);
      if (t.words) {
        const ok = (t.words.min === undefined || f.words >= t.words.min) && (t.words.max === undefined || f.words <= t.words.max);
        (ok ? fits : misses).push(ok ? `${f.words} words` : `${f.words} words, not ${rangeText(t.words)}`);
        wanted.push(`${rangeText(t.words)} words`);
      }
      results.push(misses.length
        ? {
          rule: 'title', status: 'missed', text: `the chosen title “${chosen}” misses the format's title shape: ${misses.join('; ')}${fits.length ? ` (it is ${fits.join(', ')})` : ''} — the title shape is ${wanted.join(', ')}`,
          moments: [{ where: `episodes/${n}/video.json (titles.chosen)`, change: `offer the person a title that is ${wanted.join(', ')}, and never a claim the video does not deliver; when they keep this one on purpose, it is the video's experiment` }],
        }
        : { rule: 'title', status: 'met', text: `the chosen title “${chosen}” fits the format's title shape: ${fits.join(', ')}` });
    }
  }

  // ---- Stayed: empty stretches, pace, words, where the answer starts ----
  if (playbook.emptySec !== undefined) {
    if (!words) notMeasured('empty', 'longest stretch with nothing new', unknownWords!);
    else {
      const cuts = shots.map((s) => ({ start: s.start, end: s.start }));
      const overlays = ep.overlays.filter((v) => v.start < length).map((v) => ({ start: v.start, end: v.start }));
      const empty = gaps([...words.said, ...cuts, ...overlays], length);
      const longest = empty[0] ?? { from: 0, to: 0 };
      const over = empty.filter((g) => g.to - g.from > playbook.emptySec! + EPS);
      const sec = (longest.to - longest.from).toFixed(1);
      results.push(over.length
        ? {
          rule: 'empty', status: 'missed',
          text: `longest stretch with nothing new ${sec} s, ${span(longest.from, longest.to)} (item ${playing(longest.from)})${over.length > 1 ? `, and ${over.length - 1} more` : ''} — the playbook allows ${playbook.emptySec} s`,
          moments: over.slice(0, 3).map((g) => ({ where: `${span(g.from, g.to)} (item ${playing(g.from)})`, change: `nothing new for ${(g.to - g.from).toFixed(1)} s: cut into it, or put a line, a cut or an overlay there` })),
        }
        : { rule: 'empty', status: 'met', text: `longest stretch with nothing new ${sec} s — the playbook allows ${playbook.emptySec} s` });
    }
  }

  if (playbook.cutsPerMin) {
    const except = playbook.cutsPerMin.except ?? [];
    const counted = shots.filter((s) => !except.includes(laid[s.from]!.item.beat));
    const minutes = counted.reduce((sum, s) => sum + s.end - s.start, 0) / 60;
    const outside = except.length ? ` outside ${except.join(', ')}` : '';
    if (!counted.length) notMeasured('pace', 'cuts a minute', `every shot is in ${except.join(', ')}, which the playbook leaves out`);
    else {
      // A shot that opens the video has no cut into it.
      const rate = counted.filter((s) => s.start > EPS).length / minutes;
      const target = `the playbook asks for ${rangeText(playbook.cutsPerMin)}`;
      const slow = playbook.cutsPerMin.min !== undefined && rate < playbook.cutsPerMin.min - EPS;
      const fast = playbook.cutsPerMin.max !== undefined && rate > playbook.cutsPerMin.max + EPS;
      const longest = [...counted].sort((a, b) => b.end - b.start - (a.end - a.start));
      const shot = (s: (typeof counted)[number]) => `item ${laid[s.from]!.item.id}, ${(s.end - s.start).toFixed(1)} s (${span(s.start, s.end)})`;
      // The pace the playbook states for particular beats, and for what comes after one: each over its own shots only.
      const groups: { label: string; of: typeof shots; range: { min?: number; max?: number } }[] = Object.entries(playbook.cutsPerMin.beats ?? {})
        .map(([b, range]) => ({ label: `in ${b}`, of: shots.filter((s) => laid[s.from]!.item.beat === b), range }));
      const after = playbook.cutsPerMin.after;
      const from = after ? Math.max(-1, ...laid.flatMap((l) => (l.item.beat === after.beat ? [l.end] : []))) : -1;
      if (after && from >= 0) groups.push({ label: `after the ${after.beat}`, of: shots.filter((s) => s.start >= from - EPS && !(after.except ?? []).includes(laid[s.from]!.item.beat)), range: after });
      const parts: string[] = [];
      const moments: { where: string; change: string }[] = [];
      if (slow) moments.push(...longest.slice(0, 2).map((s) => ({ where: `${span(s.start, s.end)} (item ${laid[s.from]!.item.id})`, change: `a ${(s.end - s.start).toFixed(1)} s shot: cut inside it, or trim it` })));
      if (fast) moments.push({ where: 'the whole cut', change: 'let the strongest shots run longer' });
      let off = false;
      for (const g of groups) {
        if (!g.of.length) continue;
        const r = g.of.filter((s) => s.start > EPS).length / (g.of.reduce((sum, s) => sum + s.end - s.start, 0) / 60);
        const under = g.range.min !== undefined && r < g.range.min - EPS;
        const over = g.range.max !== undefined && r > g.range.max + EPS;
        parts.push(`${g.label} ${r.toFixed(1)}${under || over ? `, ${under ? 'under' : 'over'} its ${rangeText(g.range)}` : ` (${rangeText(g.range)})`}`);
        off ||= under || over;
        const long = [...g.of].sort((a, b) => b.end - b.start - (a.end - a.start))[0]!;
        if (under) moments.push({ where: `${span(long.start, long.end)} (item ${laid[long.from]!.item.id})`, change: `${g.label}, the longest shot is ${(long.end - long.start).toFixed(1)} s: cut inside it, or trim it` });
        if (over) moments.push({ where: g.label, change: 'let the strongest shots there run longer' });
      }
      results.push({
        rule: 'pace', status: slow || fast || off ? 'missed' : 'met',
        text: `${rate.toFixed(1)} cuts a minute${outside} — ${target}${slow ? `; the longest shot is ${shot(longest[0]!)}` : ''}${parts.length ? `; ${parts.join('; ')}` : ''}`,
        ...(moments.length ? { moments } : {}),
      });
    }
  }

  if (playbook.wordsPerMin) {
    if (!words) notMeasured('words', 'words a minute', unknownWords!);
    else {
      const rate = words.said.length / (length / 60);
      const low = playbook.wordsPerMin.min !== undefined && rate < playbook.wordsPerMin.min - EPS;
      const high = playbook.wordsPerMin.max !== undefined && rate > playbook.wordsPerMin.max + EPS;
      const quiet = gaps(words.said, length);
      const counting = words.written ? ' (counting the written narration lines, not recorded yet)' : '';
      results.push({
        rule: 'words', status: low || high ? 'missed' : 'met',
        text: `${Math.round(rate)} words a minute${counting} — the playbook asks for ${rangeText(playbook.wordsPerMin)}${low && quiet[0] ? `; the longest stretch without words is ${span(quiet[0].from, quiet[0].to)} (item ${playing(quiet[0].from)})` : ''}`,
        ...(low ? { moments: quiet.slice(0, 2).map((g) => ({ where: `${span(g.from, g.to)} (item ${playing(g.from)})`, change: `no words for ${(g.to - g.from).toFixed(1)} s: write narration over it, or cut it shorter` })) } : {}),
        ...(high ? { moments: [{ where: 'the whole cut', change: 'thin the narration where the picture already tells it' }] } : {}),
      });
    }
  }

  // ---- Satisfied: the answer, the ending, the length ----
  // A short's answer is its payoff whether or not its playbook places it: a teaser pays off one small question too.
  const beat = playbook.answer?.beat ?? (kind ? 'payoff' : null);
  if (beat) {
    const found = laid.find((l) => l.item.beat === beat);
    if (found && playbook.answer && kind !== 'teaser') {
      const share = found.start / length;
      const { fromShare, toShare } = playbook.answer;
      const early = share < fromShare - EPS;
      const late = share > toShare + EPS;
      const where = `the answer (${beat}, item ${found.item.id}) starts ${pct(share)} of the way through`;
      const target = `the playbook asks for ${Math.round(fromShare * 100)}–${pct(toShare)}`;
      results.push(early || late
        ? {
          rule: 'answerPlace', status: 'missed', text: `${where}, at ${at(found.start)} — ${target}`,
          moments: [{
            where: `${at(found.start)} (item ${found.item.id})`,
            change: early ? `the answer comes early: hold it back by moving what follows item ${found.item.id} before it, or cut what follows` : `the answer comes late: bring item ${found.item.id} earlier, or trim what comes before it`,
          }],
        }
        : { rule: 'answerPlace', status: 'met', text: `${where} — ${target}` });
    }
    if (found) {
      results.push({ rule: 'answer', status: 'met', text: kind === 'teaser' ? `pays off one small question: a ${beat} beat (item ${found.item.id})` : `has its answer: a ${beat} beat (item ${found.item.id})` });
    } else {
      const warning = kind === 'teaser' ? `a teaser short answers one small question and leaves the big one open: add a ${beat} beat`
        : kind === 'standalone' ? `a standalone short pays off its hook: add a ${beat} beat`
        : null;
      results.push({
        rule: 'answer', status: 'missed', text: warning ?? `no ${beat} beat in the cut — the playbook asks for the answer on screen`, ...(warning ? { warnings: [warning] } : {}),
        moments: [{ where: 'the whole cut', change: kind === 'teaser' ? `add a ${beat} beat that answers one small question the short raised; the big video's answer stays in the big video` : `add the ${beat} beat: the moment that answers the question` }],
      });
    }
  }

  if (kind) {
    const warnings = ep.items.filter((i) => i.beat === 'outro').map((i) => `a short has no outro: item ${i.id}`);
    if (isCard(last.item)) warnings.push(`a short never ends on a full-screen card: item ${last.item.id} — end on the last shot, with at most an overlay over it`);
    results.push(warnings.length
      ? {
        rule: 'ending', status: 'missed', text: warnings.join('; '), warnings,
        moments: [{ where: `${span(last.start, last.end)} (item ${last.item.id})`, change: 'end on the last shot of the story: remove the outro or the end card (the platform\'s own link points to the full video)' }],
      }
      : { rule: 'ending', status: 'met', text: `ends on the picture, with no outro (item ${last.item.id})` });
  } else if (playbook.endsOn) {
    const met = playbook.endsOn.includes(last.item.beat);
    results.push(met
      ? { rule: 'ending', status: 'met', text: `ends on its ${last.item.beat} (item ${last.item.id})` }
      : {
        rule: 'ending', status: 'missed', text: `ends on ${last.item.beat} (item ${last.item.id}), not on ${playbook.endsOn.join(' or ')}`,
        moments: [{ where: `${span(last.start, last.end)} (item ${last.item.id})`, change: `end on ${playbook.endsOn[0]}: add it after item ${last.item.id}, or move item ${last.item.id} before it` }],
      });
  }

  // A standalone short's loop, as far as a timeline shows it: it ends on its `loop` beat, and the last music cue runs to
  // the end without fading. Whether the last line leads back into the first shot is not something Mirage can hear.
  if (kind === 'standalone') {
    const cue = [...ep.music].sort((a, b) => b.end - a.end)[0];
    const toEnd = cue !== undefined && cue.end >= length - 0.5 / ep.output.fps;
    if (toEnd && cue.fadeOut > 0) {
      const warning = 'a standalone short loops: the last music cue fades out at the end — set its fadeOut to 0';
      results.push({ rule: 'loop', status: 'missed', text: warning, warnings: [warning], moments: [{ where: `${span(Math.max(cue.start, length - cue.fadeOut), length)} (the last music cue)`, change: "set the cue's fadeOut to 0, so the music runs straight into the restart" }] });
    }
    results.push(last.item.beat === 'loop'
      ? { rule: 'loop', status: 'met', text: `ends on its loop beat (item ${last.item.id})${toEnd && cue.fadeOut === 0 ? ', the music running to the end without fading' : ''} — whether its last line leads back into the first shot is not measured: Mirage can't hear that` }
      : {
        rule: 'loop', status: 'missed', text: `ends on ${last.item.beat} (item ${last.item.id}), not on a loop beat — a standalone short ends where the restart flows into the hook`,
        moments: [{ where: `${span(last.start, last.end)} (item ${last.item.id})`, change: `end on a loop: a last line or motion that leads back into the first shot (rename item ${last.item.id}'s beat to loop when it already does)` }],
      });
  }

  const mine = (o.overrides ?? []).some((k) => k === 'targetSec' || k === 'warnPastSec');
  const limit = lengthLimit(format, video, playbook, mine);
  if (limit && limit.aim !== null) {
    const warning = lengthWarning(length, format, video, playbook, mine);
    results.push(warning
      ? { rule: 'length', status: 'missed', text: warning, warnings: [warning], moments: [{ where: 'the whole cut', change: format.short ? 'cut whole moments' : 'drop the weakest whole bit rather than thinning every laugh' }] }
      : { rule: 'length', status: 'met', text: `${formatTime(length)} long — it aims for ${formatTime(limit.aim)} and warns past ${formatTime(limit.limit)}` });
  }

  if (o.series) {
    const { name, slug, openQuestion, openQuestionFrom: left } = o.series;
    results.push(openQuestion
      ? { rule: 'series', status: 'met', text: `the series “${name}” has an open question on record${left === n ? ', left by this episode for the next one' : left ? `, left by video ${left}` : ''}: “${openQuestion}”` }
      : {
        rule: 'series', status: 'missed', text: `the series “${name}” has no open question on record for the next episode — every episode's outro leaves one`,
        moments: [{ where: `series/${slug}/series.json`, change: 'after the final render, ask the person which question this episode leaves open and record it with the series tool — never invent one' }],
      });
  }
  return report;
}

/** A result as one line: ✓ met, ✗ missed, – not measured. */
export const playbookLine = (r: Pick<PlaybookResult, 'status' | 'text'>) => `${r.status === 'met' ? '✓' : r.status === 'missed' ? '✗' : '–'} ${r.text}`;

/**
 * The `Playbook (<format>):` section of `check`: one line per rule, with the measured number and the target, and for a
 * miss where it happens. A miss `check` already prints as a ⚠ is not said twice. Empty when there is nothing to say.
 */
export function playbookSection(report: PlaybookReport): string[] {
  const lines = report.results.filter((r) => !r.warnings?.length).map((r) => `  ${playbookLine(r)}`);
  if (!lines.length) return [];
  const yours = report.overrides.length ? `, with your ${mineId(report.format)} formula's ${report.overrides.join(', ')}` : '';
  return [`Playbook (${report.format}${yours}):`, ...lines];
}
