import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  analyzeLibrary, checkEpisode, checkReport, describeError, fitRecording, ingestClips, ingestReport, initProject, MirageError, musicReport, realMediaTools,
  renderEpisode, renderReport, requireProject, resolveUserPath, slotsReport, speakNarration, speakReport, updateSlots, voReport, type EpisodeMode,
} from '@wordedits/core';
import { DEFAULT_VOICE, kokoroSpeaker } from '@wordedits/sidecars';

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
  speak <project> <episode>            read the lines with Kokoro (AI voice) and fit them as a voice-over
       [--voice af_heart] [--speed 1] [--slots n2,n5]
  render <project> <episode>           render the final episode with captions
`;

const OPTIONS = {
  title: { type: 'string' },
  add: { type: 'boolean' },
  slots: { type: 'string' },
  voice: { type: 'string' },
  speed: { type: 'string' },
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
const print = (lines: string[]) => lines.forEach((l) => console.log(l));

async function check(project: string, n: number) {
  const r = await checkEpisode(project, n);
  print(checkReport(r));
  return r.episode;
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
  speak: ['project path', 'episode number'],
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
  if (values.slots && !values.add && cmd !== 'speak') throw new UsageError('--slots only works with --add');
  if ((values.voice || values.speed) && cmd !== 'speak') throw new UsageError('--voice and --speed only work with speak');
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
      print(ingestReport(r));
      break;
    }
    case 'music': {
      const dir = join(project, 'music');
      if (!existsSync(dir)) throw new MirageError('NO_MUSIC_TRACK', `${dir} does not exist`, 'Create it and put your music tracks in it.');
      print(musicReport(dir, await analyzeLibrary(dir, tools)));
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
      console.log(''); // ends the progress line
      print(renderReport(r));
      break;
    }
    case 'slots':
      print(slotsReport(await updateSlots(project, n)));
      break;
    case 'vo': {
      const slots = values.slots?.split(',').map((s) => s.trim()).filter(Boolean);
      const { report } = await fitRecording({ project, episode: n, recording: resolveUserPath(fourth), tools, add: values.add, slots, onStep: (m) => console.log(`• ${m}`) });
      print(voReport(report, n));
      break;
    }
    case 'speak': {
      const slots = values.slots?.split(',').map((s) => s.trim()).filter(Boolean);
      const voice = values.voice ?? DEFAULT_VOICE;
      const speed = values.speed === undefined ? 1 : Number(values.speed);
      const r = await speakNarration({ project, episode: n, tools, speaker: kokoroSpeaker(), voice, speed, slots, onStep: (m) => console.log(`• ${m}`) });
      print(speakReport(r, n, voice));
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
