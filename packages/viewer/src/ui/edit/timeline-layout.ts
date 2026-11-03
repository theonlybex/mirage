// SPDX-License-Identifier: AGPL-3.0-or-later
// Where things go on the live timeline: ruler ticks, rows for overlapping pills, colours per beat, and times as text.

/** Seconds as m:ss (or h:mm:ss), for the ruler and labels. */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** Ruler ticks for `durationSec`: the smallest round step that gives at most `maxTicks` intervals. */
export function rulerTicks(durationSec: number, maxTicks = 10): number[] {
  if (!(durationSec > 0)) return [0];
  const step = STEPS.find((s) => durationSec / s <= maxTicks) ?? Math.ceil(durationSec / maxTicks / 3600) * 3600;
  const ticks: number[] = [];
  for (let t = 0; t <= durationSec + 1e-9; t += step) ticks.push(t);
  return ticks;
}

/** A row for each span so that spans in the same row don't overlap (greedy, by start). Returns rows in input order. */
export function assignRows(spans: readonly { start: number; end: number }[]): { rows: number[]; count: number } {
  const order = spans.map((s, i) => ({ ...s, i })).sort((a, b) => a.start - b.start || a.end - b.end);
  const ends: number[] = [];
  const rows = new Array<number>(spans.length).fill(0);
  for (const s of order) {
    let row = ends.findIndex((e) => e <= s.start + 1e-9);
    if (row < 0) row = ends.push(s.end) - 1;
    else ends[row] = s.end;
    rows[s.i] = row;
  }
  return { rows, count: Math.max(1, ends.length) };
}

/** The colour token of a story beat, for the top edge of its pictures. */
const BEAT_COLOURS: Record<string, string> = {
  'cold-open': 'amber',
  title: 'blue',
  recap: 'slate',
  'new-toy': 'teal',
  problem: 'coral',
  montage: 'violet',
  twist: 'pink',
  truth: 'green',
  outro: 'blue',
  blooper: 'amber',
};
export const beatColour = (beat: string): string => `var(--mirage-color-beat-${BEAT_COLOURS[beat] ?? 'slate'})`;

/** A beat's name in plain words ("cold-open" → "Cold open"). */
export const beatName = (beat: string): string => {
  const words = beat.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Past this many pictures the lanes scroll sideways instead of squeezing into the width. */
export const SCROLL_AFTER_ITEMS = 60;
/** How wide the lanes are per picture once they scroll. */
export const PX_PER_ITEM = 28;
