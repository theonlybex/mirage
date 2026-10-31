import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Slot } from '@wordedits/shared';
import {
  analyzeLibrary, checkEpisode, computeSlots, describeError, fitRecording, formatTime, ingestClips, initProject, layoutTimeline, loadCatalog,
  loadEpisode, mergeSlots, MirageError, realMediaTools, renderEpisode, requireProject, resolveUserPath, saveEpisode, timelineDuration, type EpisodeMode,
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

/** A mistake in how the command was typed: printed with the usage. */
class UsageError extends Error {}

/** The positional arguments each command takes after its name. */
const ARGS: Record<string, string[]> = {
  init: ['project path'],
  ingest: ['project path', 'clips folder'],
  music: ['project path'],
  check: ['project path', 'episode number'],
  cut: ['project path', 'episode number'],
  slots: ['project path', 'episode number'],
  guide: ['project path', 'episode number'],
  render: ['project path', 'episode number'],
  vo: ['project path', 'episode number', 'recording'],
};

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: OPTIONS });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { positionals, values } = parsed;
  const [cmd, ...args] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  const wanted = ARGS[cmd];
  if (!wanted) throw new UsageError(`unknown command "${cmd}"`);
  if (args.length < wanted.length) throw new UsageError(`missing ${wanted[args.length]}`);
  if (args.length > wanted.length) throw new UsageError(`unexpected argument "${args[wanted.length]}"`);
  if (values.slots && !values.add) throw new UsageError('--slots only works with --add');
  const [projectArg, third, fourth] = args;
  const project = resolveUserPath(projectArg);
  const episodeNumber = () => {
    if (!/^[1-9]\d*$/.test(third)) throw new UsageError('episode must be a whole number like 1');
    return Number(third);
  };
  if (cmd === 'init') {
    await initProject(project, values.title ?? 'Untitled build');
    console.log(`created ${project}`);
    return;
  }
  const n = wanted[1] === 'episode number' ? episodeNumber() : 0;
  requireProject(project);
  const tools = await realMediaTools();
  switch (cmd) {
    case 'ingest': {
      const r = await ingestClips({ project, clipsDir: resolveUserPath(third), tools, onStep: (m) => console.log(`• ${m}`) });
      for (const s of r.skipped) console.log(s.reason === 'already in the catalog' ? `  skipped ${s.file}: ${s.reason}` : `⚠ skipped ${s.file}: ${s.reason}`);
      for (const w of r.warnings) console.log(`⚠ ${w}`);
      console.log(`✓ ${r.added.length} clips added${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`);
      break;
    }
    case 'music': {
      const dir = join(project, 'music');
      if (!existsSync(dir)) throw new MirageError('NO_MUSIC_TRACK', `${dir} does not exist`, 'Create it and put your music tracks in it.');
      const { tracks, warnings } = await analyzeLibrary(dir, tools);
      if (!tracks.length) console.log(`  no tracks in ${dir}`);
      for (const t of tracks) {
        const tempo = t.bpm === null ? 'no clear beat' : `${t.bpm.toFixed(1)} BPM`;
        console.log(`  ${t.file}  ${t.mood}  ${tempo}${t.durationSec === null ? '' : `  ${t.durationSec.toFixed(0)} s`}`);
      }
      for (const w of warnings) console.log(`⚠ ${w}`);
      break;
    }
    case 'check':
      await check(project, n);
      break;
    case 'cut':
    case 'guide':
    case 'render': {
      const mode: EpisodeMode = cmd === 'cut' ? 'rough' : cmd === 'guide' ? 'guide' : 'final';
      // cut checks under the episode's lock: during a vo it says busy without touching episode.json.
      const r = await renderEpisode({ project, episode: n, mode, tools, onProgress: progress, beforeRender: cmd === 'cut' ? () => check(project, n) : undefined });
      console.log(`\n✓ ${r.outputPath} (${formatTime(r.durationSec)})${r.srtPath ? `\n  captions: ${r.srtPath}` : ''}`);
      break;
    }
    case 'slots': {
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
      const slots = values.slots?.split(',').map((s) => s.trim()).filter(Boolean);
      const { report } = await fitRecording({ project, episode: n, recording: resolveUserPath(fourth), tools, add: values.add, slots, onStep: (m) => console.log(`• ${m}`) });
      for (const l of report.lines) console.log(`  ${l.slot}  ${l.status}${l.takes > 1 ? `  (${l.takes} takes, used the last)` : ''}${l.overrunSec ? `  held picture +${l.overrunSec}s` : ''}`);
      const missing = report.lines.filter((l) => l.status === 'missing').map((l) => l.slot);
      console.log(`✓ voice-over fitted${report.extendedSec ? `, episode ${report.extendedSec.toFixed(2)} s longer` : ''}`);
      if (missing.length) console.log(`⚠ not found: ${missing.join(', ')} — record just those lines, then: pnpm mirage vo <project> ${n} <new recording> --add`);
      break;
    }
  }
}

main().catch((e: unknown) => {
  if (e instanceof UsageError) {
    console.error(`✖ ${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  const { message, hint } = describeError(e);
  console.error(`\n✖ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
});
