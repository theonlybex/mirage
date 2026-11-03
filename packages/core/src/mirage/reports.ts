// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Episode } from '@wordedits/shared';
import type { IngestResult } from './ingest.js';
import { loadCatalog } from './ingest.js';
import type { LibraryReport } from './music.js';
import { loadEpisode, saveEpisode, type RenderResult } from './render-episode.js';
import { carrySlots, computeSlots, cutOf } from './slots.js';
import { formatTime, layoutTimeline, timelineDuration } from './timeline.js';
import { hasWords, notEnglish, type FitReport } from './voiceover.js';

// The lines the commands print. The CLI and the MCP server both print these, so the two always say the same thing.

const range = (s: { start: number; end: number }) => `${s.start.toFixed(1)}–${s.end.toFixed(1)}`;
const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** The timeline item by item, its total, then notes (•) and warnings (⚠). */
export function checkReport({ episode: ep, warnings, notes }: { episode: Episode; warnings: string[]; notes: string[] }): string[] {
  const lines: string[] = [];
  for (const l of layoutTimeline(ep)) {
    const it = l.item;
    lines.push(`${String(l.index + 1).padStart(3)}  ${it.beat.padEnd(9)} ${it.id.padEnd(12)} ${it.clip}  ${it.src.in.toFixed(2)}–${it.src.out.toFixed(2)}  ×${it.speed}  ${l.start.toFixed(2)}–${l.end.toFixed(2)}${it.quiet ? '  quiet' : ''}`);
  }
  lines.push(`total ${formatTime(timelineDuration(ep))} · ${ep.items.length} items · ${ep.overlays.length} overlays · ${ep.music.length} music cues`);
  for (const m of notes) lines.push(`• ${m}`);
  for (const w of warnings) lines.push(`⚠ ${w}`);
  return lines;
}

/** Skipped files, warnings, and how many clips were added. (The per-step • lines come live from `onStep`.) */
export function ingestReport(r: IngestResult): string[] {
  const lines: string[] = [];
  for (const s of r.skipped) lines.push(s.reason === 'already in the catalog' ? `  skipped ${s.file}: ${s.reason}` : `⚠ skipped ${s.file}: ${s.reason}`);
  for (const w of r.warnings) lines.push(`⚠ ${w}`);
  lines.push(`✓ ${r.added.length} clips added${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`);
  return lines;
}

/** The tracks of the music folder with their tempo, then warnings. */
export function musicReport(dir: string, { tracks, warnings }: Pick<LibraryReport, 'tracks' | 'warnings'>): string[] {
  const lines: string[] = [];
  if (!tracks.length) lines.push(`  no tracks in ${dir}`);
  for (const t of tracks) {
    const tempo = t.bpm === null ? 'no clear beat' : `${t.bpm.toFixed(1)} BPM`;
    lines.push(`  ${t.file}  ${t.mood}  ${tempo}${t.durationSec === null ? '' : `  ${t.durationSec.toFixed(0)} s`}`);
  }
  for (const w of warnings) lines.push(`⚠ ${w}`);
  return lines;
}

/** The finished render, its captions and warnings. */
export function renderReport(r: RenderResult): string[] {
  const lines = [`✓ ${r.outputPath} (${formatTime(r.durationSec)})`];
  if (r.srtPath) lines.push(`  captions: ${r.srtPath}`);
  for (const w of r.warnings) lines.push(`⚠ ${w}`);
  return lines;
}

export type SlotsUpdate = ReturnType<typeof carrySlots>;

/** Finds the narration slots of video `n`, keeps the lines already written, and saves them in episode.json. */
export async function updateSlots(project: string, n: number): Promise<SlotsUpdate> {
  const ep = await loadEpisode(project, n);
  const result = carrySlots(ep, computeSlots(ep, await loadCatalog(project)));
  await saveEpisode(project, { ...ep, slots: result.slots, slotsCut: cutOf(ep) }, n);
  return result;
}

/** Each slot with its word budget and line, lines that moved or were dropped, and the totals. */
export function slotsReport({ slots, moved, dropped }: SlotsUpdate): string[] {
  const lines: string[] = [];
  for (const s of slots) {
    const words = wordCount(s.line);
    const over = words > s.maxWords ? `  ⚠ over budget (${words} > ${s.maxWords} words)` : '';
    lines.push(`  ${s.id}  ${range(s)} s  ≤${s.maxWords} words  ${s.line || '(no line yet)'}${over}`);
  }
  for (const m of moved) lines.push(`⚠ moved line (was ${m.from.id} ${range(m.from)}, now ${m.to.id} ${range(m.to)}): "${m.line}" — it followed its picture; check it still fits`);
  for (const s of dropped) lines.push(`⚠ dropped line (was ${s.id} ${range(s)}): "${s.line}"`);
  for (const s of slots) {
    if (notEnglish(s.line)) lines.push(`⚠ ${s.id}'s line isn't in English — voice-over matching supports English only for now`);
    else if (s.line.trim() && !hasWords(s.line)) lines.push(`⚠ ${s.id}'s line has no words to read ("${s.line}") — write words, or leave it empty`);
  }
  const written = slots.filter((s) => hasWords(s.line)).length;
  lines.push(`✓ ${slots.length} slot${slots.length === 1 ? '' : 's'}, ${written} with lines${dropped.length ? `, ${dropped.length} dropped` : ''}`);
  return lines;
}

/** How each line of the voice-over fitted, what is missing, and warnings. `n` is the video's number, for the re-record hint. */
export function voReport(report: FitReport, n: number): string[] {
  const lines: string[] = [];
  for (const l of report.lines) {
    const status =
      l.status === 'kept' ? 'kept the earlier take (not found in this recording)'
      : l.status === 'too long' ? `too long: runs ${l.overrunSec}s past its slot, more than the picture can hold — shorten it or give it a longer slot, then vo --add`
      : l.status === 'partial' ? `⚠ only part of the line was found — re-read the whole line with vo --add --slots ${l.slot}`
      : l.status;
    lines.push(`  ${l.slot}  ${status}${l.takes > 1 ? `  (${l.takes} takes, used the last)` : ''}${l.overrunSec && (l.status === 'placed' || l.status === 'partial') ? `  held picture +${l.overrunSec}s` : ''}`);
  }
  const missing = report.lines.filter((l) => l.status === 'missing').map((l) => l.slot);
  lines.push(`✓ voice-over fitted${report.extendedSec ? `, episode ${report.extendedSec.toFixed(2)} s longer` : ''}`);
  if (missing.length) lines.push(`⚠ not found: ${missing.join(', ')} — record just those lines, then: pnpm mirage vo <project> ${n} <new recording> --add`);
  for (const w of report.warnings) lines.push(`⚠ ${w}`);
  return lines;
}
