import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Slot } from '@wordedits/shared';
import {
  analyzeLibrary, checkEpisode, computeSlots, fitRecording, formatTime, ingestClips, layoutTimeline, loadCatalog, loadEpisode,
  mergeSlots, MirageError, realMediaTools, renderEpisode, saveEpisode, timelineDuration, type EpisodeMode,
} from '@wordedits/core';

const USAGE = `usage: pnpm mirage <command> ...

  init <project> --title "<title>"     create a project folder
  ingest <project> <clips-folder>      catalog a batch of clips
  music <project>                      detect tempo of tracks in <project>/music
  check <project> <episode>            validate the timeline, snap montages to the beat, list it
  cut <project> <episode>              render the rough cut (picture, music, overlays)
  slots <project> <episode>            find narration slots and their word budgets
  guide <project> <episode>            render the guide video with lines on screen
  vo <project> <episode> <recording>   fit the voice-over you recorded
       [--add [--slots n2,n5]]          ...or add a recording of just the missing (or listed) lines
  render <project> <episode>           render the final episode with captions
`;

const OPTIONS = {
  title: { type: 'string' },
  add: { type: 'boolean' },
  slots: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;
let last = -1;
const progress = (f: number) => {
  const pct = Math.floor(f * 100);
  if (pct !== last) {
    last = pct;
    process.stdout.write(`\r  ${pct}%`);
  }
};
const range = (s: { start: number; end: number }) => `${s.start.toFixed(1)}–${s.end.toFixed(1)}`;
const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Written lines in `prev` that `merged` no longer carries (counted per text, so duplicate lines are matched one to one). */
function droppedLines(prev: Slot[], merged: Slot[]): Slot[] {
  const kept = new Map<string, number>();
  for (const s of merged) if (s.line.trim()) kept.set(s.line, (kept.get(s.line) ?? 0) + 1);
  return prev.filter((s) => {
    if (!s.line.trim()) return false;
    const n = kept.get(s.line) ?? 0;
    if (n > 0) {
      kept.set(s.line, n - 1);
      return false;
    }
    return true;
  });
}

async function check(project: string, n: number) {
  const { episode: ep, warnings, notes } = await checkEpisode(project, n);
  for (const l of layoutTimeline(ep)) {
    const it = l.item;
    console.log(`${String(l.index + 1).padStart(3)}  ${it.beat.padEnd(9)} ${it.id.padEnd(12)} ${it.clip}  ${it.src.in.toFixed(2)}–${it.src.out.toFixed(2)}  ×${it.speed}  ${l.start.toFixed(2)}–${l.end.toFixed(2)}${it.quiet ? '  quiet' : ''}`);
  }
  console.log(`total ${formatTime(timelineDuration(ep))} · ${ep.items.length} items · ${ep.overlays.length} overlays · ${ep.music.length} music cues`);
  for (const m of notes) console.log(`• ${m}`);
  for (const w of warnings) console.log(`⚠ ${w}`);
  return ep;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: OPTIONS });
  } catch (e) {
    throw Object.assign(new Error((e as Error).message), { hint: USAGE });
  }
  const { positionals, values } = parsed;
  const [cmd, projectArg, third, fourth] = positionals;
  if (values.help || !cmd || !projectArg) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  const project = resolve(projectArg);
  const episodeNumber = () => {
    const n = Number(third);
    if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error('episode must be a number like 1'), { hint: USAGE });
    return n;
  };
  const tools = await realMediaTools();
  switch (cmd) {
    case 'init': {
      await mkdir(join(project, 'episodes'), { recursive: true });
      await mkdir(join(project, 'music'), { recursive: true });
      await writeFile(join(project, 'mirage.json'), JSON.stringify({ version: 1, title: values.title ?? 'Untitled build', createdAt: new Date().toISOString() }, null, 2) + '\n');
      console.log(`created ${project}`);
      break;
    }
    case 'ingest': {
      if (!third) throw Object.assign(new Error('missing clips folder'), { hint: USAGE });
      const r = await ingestClips({ project, clipsDir: third, tools, onStep: (m) => console.log(`• ${m}`) });
      for (const s of r.skipped) console.log(s.reason === 'already in the catalog' ? `  skipped ${s.file}: ${s.reason}` : `⚠ skipped ${s.file}: ${s.reason}`);
      for (const w of r.warnings) console.log(`⚠ ${w}`);
      console.log(`✓ ${r.added.length} clips added${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`);
      break;
    }
    case 'music': {
      const dir = join(project, 'music');
      if (!existsSync(dir)) throw new MirageError('NO_MUSIC_TRACK', `${dir} does not exist`, 'Create it and put your music tracks in it.');
      const lib = await analyzeLibrary(dir, tools);
      if (!lib.tracks.length) console.log(`  no tracks in ${dir}`);
      for (const t of lib.tracks) {
        const tempo = t.bpm === null ? 'no clear beat' : `${t.bpm.toFixed(1)} BPM`;
        console.log(`  ${t.file}  ${t.mood}  ${tempo}${t.durationSec === null ? '' : `  ${t.durationSec.toFixed(0)} s`}`);
      }
      break;
    }
    case 'check':
      await check(project, episodeNumber());
      break;
    case 'cut':
    case 'guide':
    case 'render': {
      const n = episodeNumber();
      if (cmd === 'cut') await check(project, n);
      const mode: EpisodeMode = cmd === 'cut' ? 'rough' : cmd === 'guide' ? 'guide' : 'final';
      const r = await renderEpisode({ project, episode: n, mode, tools, onProgress: progress });
      console.log(`\n✓ ${r.outputPath} (${formatTime(r.durationSec)})${r.srtPath ? `\n  captions: ${r.srtPath}` : ''}`);
      break;
    }
    case 'slots': {
      const n = episodeNumber();
      const ep = await loadEpisode(project, n);
      const slots = mergeSlots(ep.slots, computeSlots(ep, await loadCatalog(project)));
      await saveEpisode(project, { ...ep, slots }, n);
      for (const s of slots) {
        const words = wordCount(s.line);
        const over = words > s.maxWords ? `  ⚠ over budget (${words} > ${s.maxWords} words)` : '';
        console.log(`  ${s.id}  ${range(s)} s  ≤${s.maxWords} words  ${s.line || '(no line yet)'}${over}`);
      }
      const dropped = droppedLines(ep.slots, slots);
      for (const s of dropped) console.log(`⚠ dropped line (was ${s.id} ${range(s)}): "${s.line}"`);
      const written = slots.filter((s) => s.line.trim()).length;
      console.log(`✓ ${slots.length} slot${slots.length === 1 ? '' : 's'}, ${written} with lines${dropped.length ? `, ${dropped.length} dropped` : ''}`);
      break;
    }
    case 'vo': {
      const n = episodeNumber();
      if (!fourth) throw Object.assign(new Error('missing recording'), { hint: USAGE });
      if (values.slots && !values.add) throw Object.assign(new Error('--slots only works with --add'), { hint: USAGE });
      const slots = values.slots?.split(',').map((s) => s.trim()).filter(Boolean);
      const { report } = await fitRecording({ project, episode: n, recording: fourth, tools, add: values.add, slots, onStep: (m) => console.log(`• ${m}`) });
      for (const l of report.lines) console.log(`  ${l.slot}  ${l.status}${l.takes > 1 ? `  (${l.takes} takes, used the last)` : ''}${l.overrunSec ? `  held picture +${l.overrunSec}s` : ''}`);
      const missing = report.lines.filter((l) => l.status === 'missing').map((l) => l.slot);
      console.log(`✓ voice-over fitted${report.extendedSec ? `, episode ${report.extendedSec.toFixed(2)} s longer` : ''}`);
      if (missing.length) console.log(`⚠ not found: ${missing.join(', ')} — record just those lines, then: pnpm mirage vo <project> ${n} <new recording> --add`);
      break;
    }
    default:
      console.log(USAGE);
      process.exit(2);
  }
}

main().catch((e: { message?: string; hint?: string }) => {
  console.error(`\n✖ ${e.message ?? String(e)}`);
  if (e.hint) console.error(`  ${e.hint}`);
  process.exit(1);
});
