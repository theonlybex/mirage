// SPDX-License-Identifier: MIT
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { ViewerInfoSchema } from '@wordedits/shared';
import { LATER_DAYS, writeSetupState } from '@wordedits/shared/setup-state';
import {
  addEpisode, analyzeLibrary, appendLog, findSeries, listSeries, planSeries, seriesLine, seriesReport, seriesSlug, updateSeries, candidatesReport, channelCaptions, channelPatterns, channelThumbnails, checkEpisode, checkReport, describeError, episodeDir, fitRecording, formatsDir, formulaLine, formulasDir, gatherChannel, ingestClips, ingestReport, initProject, learnResults, listVersions, loadFormats, loadFormulas, markPosted, predictVideo,
  MirageError, musicReport, newVideo, planVideo, readClaudeProcess, readJsonFile, realChannelDeps, readNotes, readProject, readSessionState, readVideo, renderEpisode, renderReport, requireProject, resolveUserPath, restoreVersion, resultsLine,
  sessionDir, slotsReport, speakNarration, speakReport, thumbnailReport, updateSlots, videoStage, voReport, writeCandidates, writeSessionState, writeThumbnail, DEFAULT_VIDEOS, MAX_VIDEOS, type ChannelDeps, type EpisodeMode, type MediaTools,
} from '@wordedits/core';
import { DEFAULT_VOICE, KOKORO_VOICES, kokoroSpeaker, type Speaker } from '@wordedits/sidecars';
import { preflight, realPreflightDeps, startCaffeinate, type PreflightDeps } from './preflight.js';
import { runLong } from './run-long.js';

export const TOOL_NAMES: readonly string[] = [
  'new_project', 'new_video', 'ingest', 'music', 'check', 'cut', 'slots', 'guide', 'vo', 'speak', 'render', 'versions', 'restore', 'get_notes', 'note_status', 'log', 'overnight', 'status', 'setup_later', 'formats', 'thumbnail', 'formulas', 'channel', 'posted', 'learn', 'predict', 'series',
];

export interface EngineContext {
  /** The project folder (it may not hold a mirage.json yet: new_project makes one). */
  project: string;
  tools: MediaTools;
  /**
   * The Claude session this server belongs to; null when unknown. Default: the session the hooks recorded for the Claude
   * Code process that started this server (`.mirage/claude/<ppid>.json`), else newestSessionId(project).
   */
  sessionId?: () => string | null;
  /** The Claude Code process that started this server (through the `scripts/node` launcher, which execs). Default: process.ppid. */
  ppid?: number;
  /** Machine checks for `overnight` and `status`. Default: the real machine. */
  preflightDeps?: PreflightDeps;
  /** Keeps the Mac awake; returns the pid of what does. Default: caffeinate. */
  startAwake?: () => number | null;
  /** The AI narration voice for `speak`. Default: Kokoro in the plugin's data folder. */
  speaker?: Speaker;
  /** Mirage's data folder, where it remembers things across sessions. Default: MIRAGE_PLUGIN_DATA. */
  pluginData?: string;
  /** The folder of format files (tests). Default: the plugin's own `formats` folder. */
  formatsDir?: string;
  /** The folder of Mirage's own formula files (tests). Default: the plugin's own `formulas` folder. */
  formulasDir?: string;
  /** What `channel` and `learn` run and fetch (tests: nothing reaches the network). Default: yt-dlp, fetch, and the tools' ffmpeg. */
  channel?: ChannelDeps;
  /** The clock for `setup_later`, `posted`, `learn`, `predict` and the `Results:` line of `status`. Default: the real time. */
  now?: () => Date;
}

const SESSION_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.json$/;

/**
 * The best guess at the Claude session in charge when the hooks have not said which one this process runs: the
 * `<project>/.mirage/sessions/<id>.json` touched last (the hooks touch it at every step). Null when there is none.
 * `unknown.json` (state kept for a session nobody could name) is not a session.
 */
export function newestSessionId(project: string): string | null {
  const dir = join(resolve(project), '.mirage', 'sessions');
  let best: { id: string; mtime: number } | null = null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const id = SESSION_FILE.exec(name)?.[1];
    if (!id || id === 'unknown' || id.includes('..')) continue;
    let mtime: number;
    try {
      mtime = statSync(join(dir, name)).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) best = { id, mtime };
  }
  return best?.id ?? null;
}

/**
 * Why `folder` can't be a video's footage, or null when it can: it must be a folder, and neither the project nor a folder
 * holding it (footage is read-only, and the engine writes inside the project). Symlinks are followed.
 */
function footageProblem(folder: string, project: string): string | null {
  if (!existsSync(folder)) return `✖ ${folder} does not exist`;
  if (!statSync(folder).isDirectory()) return `✖ ${folder} isn't a folder.`;
  const rel = relative(realpathSync(folder), realpathSync(project));
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    return `✖ ${folder} holds this project. Make a new folder for the series, open Claude Code there, and add the clips folder from there.`;
  }
  return null;
}

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (lines: string | string[]): Result => ({ content: [{ type: 'text', text: Array.isArray(lines) ? lines.join('\n') : lines }] });
const STOPPED = '✖ Stopped by the person before it finished. Nothing was changed.';
/** Ingest keeps the clips it catalogued before it was stopped. */
const STOPPED_INGEST = '✖ Stopped by the person before it finished. Clips catalogued so far are kept.';
/** Learn keeps the snapshots of the videos it read before it was stopped. */
const STOPPED_LEARN = '✖ Stopped by the person before it finished. The numbers read so far are kept.';
const isStopped = (e: unknown) => (e instanceof MirageError && e.code === 'CANCELLED') || (e as { name?: unknown } | null)?.name === 'AbortError';

/** An error as the person would read it: the message with its hint indented under it. */
function failed(e: unknown, stoppedText: string = STOPPED): Result {
  if (isStopped(e)) return { content: [{ type: 'text', text: stoppedText }], isError: true };
  const { message, hint } = describeError(e);
  return { content: [{ type: 'text', text: `✖ ${message}${hint ? `\n  ${hint}` : ''}` }], isError: true };
}

const stamp = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const video = z.number().int().positive().describe('The video number, e.g. 1');
const focusPoint = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
/** One source of a two-source thumbnail. */
const thumbPart = z.object({
  at: z.number().optional().describe('A second of the video: the source frame shown there'),
  image: z.string().min(1).optional().describe('Instead of at: a picture inside the project (a PNG or JPEG the person gave), as a path from the project folder'),
  focus: focusPoint.optional().describe('The point its crop keeps in view, 0–1 from the left and from the top'),
});
/** What a series carries from episode to episode, as `new_video` and `series` take it. */
const seriesFields = {
  question: z.string().optional().describe('The big question the whole series asks, in the person\'s words'),
  openQuestion: z.string().optional().describe('The question the latest episode\'s outro left open, which the next episode\'s recap starts from; an empty text clears it'),
  counts: z.record(z.string().min(1), z.object({ value: z.number(), unit: z.string().min(1).optional() }).nullable()).optional()
    .describe('Running counts by name, e.g. { "cost so far": { "value": 1250, "unit": "£" }, "attempts used": { "value": 3 } }: numbers from the person or the catalog only; null removes one'),
  signOff: z.string().optional().describe('The line every episode ends on'),
  titleShape: z.string().optional().describe('How the series\' titles are shaped, in words'),
  thumbnail: z.object({ face: z.enum(['left', 'right']), share: z.number().min(0.2).max(0.5).optional() }).optional()
    .describe('The thumbnail layout every episode keeps: the side the face is on, and its share of the width (default about a third)'),
};
const MODES: Record<'cut' | 'guide' | 'render', EpisodeMode> = { cut: 'rough', guide: 'guide', render: 'final' };

/** The Mirage engine as MCP tools. */
export function createEngineServer(ctx: EngineContext): McpServer {
  const project = resolve(ctx.project);
  const { tools } = ctx;
  const deps = ctx.preflightDeps ?? realPreflightDeps();
  const startAwake = ctx.startAwake ?? startCaffeinate;
  const speaker = ctx.speaker ?? kokoroSpeaker();
  const ppid = ctx.ppid ?? process.ppid;
  const now = ctx.now ?? (() => new Date());
  const formatFiles = () => ctx.formatsDir ?? formatsDir();
  /** Mirage's own formulas, then the person's from the project's `formulas` folder (a folder that is no project has none). */
  const formulas = () => loadFormulas(ctx.formulasDir ?? formulasDir(), existsSync(join(project, 'mirage.json')) ? project : undefined);
  const channelDeps = (): ChannelDeps => ({ now, ...(ctx.channel ?? realChannelDeps(tools)) });
  const knownSession = ctx.sessionId ?? (() => readClaudeProcess(project, ppid) ?? newestSessionId(project));
  const sid = () => knownSession() ?? 'unknown';
  const server = new McpServer({ name: 'engine', version: '0.0.1' });

  /** Registers a tool whose errors come back as `✖ …` results. `needsProject` (default) refuses a folder without mirage.json. */
  function tool<S extends ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    run: (args: z.infer<z.ZodObject<S>>, extra: { signal: AbortSignal }) => Promise<Result>,
    needsProject = true,
  ) {
    server.registerTool(name, { description, inputSchema }, (async (args: z.infer<z.ZodObject<S>>, extra: { signal: AbortSignal }) => {
      try {
        if (needsProject) requireProject(project);
        return await run(args, extra);
      } catch (e) {
        return failed(e);
      }
    }) as never);
  }

  /** The newest video of the project (the highest number): where warnings of a command that belongs to no video are logged. */
  async function newestVideo(): Promise<number | null> {
    const numbers = (await readdir(join(project, 'episodes')).catch(() => [] as string[])).filter((f) => /^[1-9]\d*$/.test(f)).map(Number);
    return numbers.length ? Math.max(...numbers) : null;
  }

  /**
   * Writes every ⚠ warning of a report into the session log as a warning (the text from the marker on), then returns the
   * report. So do the ✖ lines a report carries without failing (check's unknown format or broken format file, with their
   * hint), so the morning report shows them. With no video (ingest or music before the session has one) they go to the
   * newest video's session folder; a project with no video yet has nowhere to log them, so they are dropped (the report
   * still shows them).
   */
  async function report(n: number | null, lines: string[]): Promise<Result> {
    const warnings = lines.flatMap((l) => (l.includes('⚠ ') ? [l.slice(l.indexOf('⚠ ') + 2)] : l.startsWith('✖ ') ? [l.slice(2)] : []));
    const target = warnings.length ? (n ?? (await newestVideo())) : null;
    if (target !== null) {
      for (const text of warnings) await appendLog(sessionDir(project, target, sid()), { at: new Date().toISOString(), kind: 'warning', text });
    }
    return ok(lines);
  }

  /** A command that can run for minutes: stoppable, with progress. Video-less commands follow the session's video. */
  const long = async <T>(command: string, n: number | null, signal: AbortSignal, work: (h: { signal: AbortSignal; progress: (f: number) => void }) => Promise<T>) =>
    runLong({ project, video: n, dir: n === null ? null : sessionDir(project, n, sid()), command, requestSignal: signal, work });

  const sessionVideo = async () => (await readSessionState(project, sid())).video;

  tool('new_project', 'Start a Mirage project in this folder. Does nothing if there already is one.', { title: z.string().min(1).describe('What the series is called') }, async ({ title }) => {
    const existing = await readProject(project);
    if (existing) return ok(`already a Mirage project: ${existing.title}`);
    await initProject(project, title);
    return ok(`created ${project}`);
  }, false);

  tool(
    'new_video',
    'Start a new video in the project: what it is about, what to mention or hide, the folders its footage is in, and its format (see formats). With from, a short made from a big video: its footage and answers are copied.',
    {
      title: z.string().min(1).max(200),
      about: z.string().optional().describe('What the video is about, in the person\'s words (needed unless from is given)'),
      mention: z.string().optional().describe('Things the person wants mentioned'),
      hide: z.string().optional().describe('Things that must not show (keys, names, private windows)'),
      footage: z.array(z.string()).optional().describe('Folders with the footage for this video (needed unless from is given)'),
      format: z.string().min(1).optional().describe('The format id from formats, e.g. short or vlog (default build-story, or short with from)'),
      from: z.number().int().positive().optional().describe('The big video this one is made from: its footage, about, mention and hide are copied (what you pass is added)'),
      vlog: z.object({
        name: z.string().min(1).describe('The vlog series, e.g. Ibiza'),
        number: z.number().int().positive().optional().describe('Which vlog this is (default: one more than the highest so far)'),
        date: z.string().min(1).describe('The date the vlog covers, as the person confirmed it'),
      }).optional(),
      targetSec: z.number().positive().optional().describe('The length to aim for, in seconds, when the person asks for one (overrides the format\'s)'),
      idea: z.object({
        gap: z.string().optional().describe('What the thing should be and what it is now'),
        question: z.string().optional().describe('The one question the video asks, with an answer the camera can see'),
        doubt: z.string().optional().describe('Who or what says it will fail'),
        stake: z.string().optional().describe('What the viewer can count as lost'),
      }).optional().describe('The question the video is built on, in the person\'s words, for formats whose rules ask for it; leave out what they did not say'),
      experiment: z.object({
        rule: z.string().min(1).describe('The rule of the format\'s formula the video departs from'),
        change: z.string().min(1).describe('What this video does differently'),
        expect: z.string().min(1).describe('The number that should move, in words learn can find: click rate, viewed vs swiped, percentage viewed, average view, likes, comments, or views'),
      }).optional().describe('The one deliberate change this video makes against its format\'s formula, chosen with the mirage:learn skill, so its effect can be read once it is posted'),
      series: z.object({ name: z.string().min(1).describe('The series: its slug or its name. A new name starts a series, in series/<slug>/'), ...seriesFields }).optional()
        .describe('The series this video is an episode of. A new series is made with the fields given; on one that exists only name is read (the series tool changes it)'),
    },
    async (a) => {
      const folders = (a.footage ?? []).map((f) => resolveUserPath(f, project));
      const refused = folders.flatMap((f) => {
        const why = footageProblem(f, project);
        return why ? [why] : [];
      });
      if (refused.length) return { content: [{ type: 'text', text: refused.join('\n') }], isError: true };
      const { series: joins, ...request } = a;
      const { name: seriesName, ...fields } = joins ?? { name: undefined };
      const { video: v, format } = await planVideo(project, { ...request, footage: a.footage && folders, ...(seriesName !== undefined ? { series: seriesSlug(seriesName) } : {}) }, loadFormats(formatFiles()));
      // The series is read (and a new one planned) before the video gets its number, so a broken series.json stops nothing half-made.
      const planned = seriesName === undefined ? null : await planSeries(project, seriesName, fields, format?.id ?? v.format ?? 'build-story', now());
      const n = await newVideo(project, planned ? { ...v, series: planned.series.slug } : v);
      await writeSessionState(project, sid(), { video: n });
      const lines = [`video ${n} created${format ? ` (format ${format.id}: ${format.beats.join(' → ')})` : ''}`];
      if (planned) {
        const s = await addEpisode(project, planned.series, n);
        lines.push(`${planned.created ? 'started the series' : 'added to the series'} “${s.name}” (series/${s.slug}/) as episode ${s.episodes.indexOf(n) + 1} · ${s.openQuestion ? `open question: “${s.openQuestion}”` : 'no open question on record'}`);
        if (planned.ignored.length) lines.push(`⚠ the series “${s.name}” already exists, so ${planned.ignored.join(', ')} ${planned.ignored.length === 1 ? 'was' : 'were'} not applied — change a series with the series tool`);
      }
      return report(n, lines);
    },
  );

  tool('ingest', 'Catalog a folder of clips: probe, transcribe and add them to the project.', { folder: z.string().describe('The folder with the clips') }, async ({ folder }, { signal }) => {
    const n = await sessionVideo();
    const steps: string[] = [];
    try {
      const r = await long('ingest', n, signal, (h) => ingestClips({ project, clipsDir: resolveUserPath(folder, project), tools, onStep: (m) => steps.push(`• ${m}`), signal: h.signal }));
      return await report(n, [...steps, ...ingestReport(r)]);
    } catch (e) {
      return failed(e, STOPPED_INGEST);
    }
  });

  tool('music', 'Find the tempo and mood of the tracks in the project\'s music folder.', {}, async () => {
    const dir = join(project, 'music');
    if (!existsSync(dir)) throw new MirageError('NO_MUSIC_TRACK', `${dir} does not exist`, 'Create it and put your music tracks in it.');
    return report(await sessionVideo(), musicReport(dir, await analyzeLibrary(dir, tools)));
  });

  tool('check', 'Check the timeline of a video against the catalog and music, snap montages to the beat, and list it.', { video }, async ({ video: n }) => report(n, checkReport(await checkEpisode(project, n, tools, { formatsDir: formatFiles(), formulasDir: ctx.formulasDir }))));

  for (const [name, mode] of Object.entries(MODES) as ['cut' | 'guide' | 'render', EpisodeMode][]) {
    const what = { cut: 'Check the timeline, then render the rough cut (picture, music, overlays).', guide: 'Render the guide video, with the narration lines on screen to record against.', render: 'Render the final video with captions.' }[name];
    tool(name, what, { video }, async ({ video: n }, { signal }) => {
      const lines: string[] = [];
      const r = await long(name, n, signal, (h) =>
        renderEpisode({
          project, episode: n, mode, tools, signal: h.signal, onProgress: h.progress,
          // As the CLI's cut: the check runs under the episode's lock.
          beforeRender: name === 'cut' ? async () => { lines.push(...checkReport(await checkEpisode(project, n, tools, { formatsDir: formatFiles(), formulasDir: ctx.formulasDir }))); } : undefined,
        }),
      );
      return report(n, [...lines, ...renderReport(r)]);
    });
  }

  tool('slots', 'Find where narration fits in a video and how many words each slot holds.', { video }, async ({ video: n }) => report(n, slotsReport(await updateSlots(project, n))));

  tool(
    'vo',
    'Fit the person\'s voice-over recording to the video.',
    {
      video,
      recording: z.string().describe('The recording file'),
      add: z.boolean().optional().describe('Add a recording of just the missing (or listed) lines, keeping the rest'),
      slots: z.array(z.string()).optional().describe('With add: the slots this recording is for, e.g. ["n2"]'),
    },
    async (a, { signal }) => {
      const steps: string[] = [];
      const { report: fit } = await long('vo', a.video, signal, (h) =>
        fitRecording({ project, episode: a.video, recording: resolveUserPath(a.recording, project), tools, add: a.add, slots: a.slots, onStep: (m) => steps.push(`• ${m}`), signal: h.signal }),
      );
      return report(a.video, [...steps, ...voReport(fit, a.video)]);
    },
  );

  tool(
    'speak',
    'Read the written narration lines aloud with an AI voice (Kokoro, free and local) and fit them as the voice-over, for footage without a voice of its own. Downloads Kokoro the first time.',
    {
      video,
      voice: z.string().optional().describe(`The Kokoro voice (default ${DEFAULT_VOICE}): ${KOKORO_VOICES.join(', ')}`),
      speed: z.number().optional().describe('Speaking speed from 0.5 to 2 (default 1)'),
      slots: z.array(z.string()).optional().describe('Read just these slots again (e.g. ["n2"]), keeping the other lines'),
    },
    async (a, { signal }) => {
      const steps: string[] = [];
      const voice = a.voice ?? DEFAULT_VOICE;
      const r = await long('speak', a.video, signal, (h) =>
        speakNarration({ project, episode: a.video, tools, speaker, voice, speed: a.speed ?? 1, slots: a.slots, onStep: (m) => steps.push(`• ${m}`), onProgress: h.progress, signal: h.signal }),
      );
      return report(a.video, [...steps, ...speakReport(r, a.video, voice)]);
    },
  );

  tool(
    'thumbnail',
    'Thumbnails for a video. Without at: writes candidate frames from its last cut (the strongest moments, loud shots, reveals, evenly spaced) to episodes/<n>/thumbs/ to choose from, each listed with the at that writes it. ' +
      'With at: writes episodes/<n>/thumbnail.jpg at full quality from the source frame the video shows at that second, framed as the video frames it there (1280×720, or the 1080×1920 cover for a vertical video), with optional text. ' +
      'With face and subject instead of at: builds it from two sources side by side (each a second of the video or a picture inside the project), for when the face and the subject are never in one good frame; the layout is the one the video\'s series keeps unless side or share is given. Nothing is cut out.',
    {
      video,
      at: z.number().optional().describe('The second of the video the thumbnail shows: a candidate frame\'s `at` gives that frame'),
      text: z.string().optional().describe('With at: up to 4 words drawn on the thumbnail in capitals'),
      focus: focusPoint.optional().describe('With at: the point kept in view when the picture is cropped, 0–1 from the left and from the top (default the focus the video shows there); footage the thumbnail\'s shape at zoom 1 has no room to move'),
      face: thumbPart.optional().describe('With subject, instead of at: the face, cropped to its side of the thumbnail'),
      subject: thumbPart.optional().describe('With face: the subject, filling the rest of the thumbnail'),
      side: z.enum(['left', 'right']).optional().describe('With face and subject: the side the face is on (default the series\' layout, else left)'),
      share: z.number().min(0.2).max(0.5).optional().describe('With face and subject: the face\'s share of the width (default the series\' layout, else about a third)'),
    },
    async ({ video: n, at, text, focus, face, subject, side, share }, { signal }) => {
      if (face !== undefined || subject !== undefined || side !== undefined || share !== undefined) {
        if (!face || !subject || at !== undefined || focus !== undefined) {
          throw new MirageError('BAD_INPUT', 'a thumbnail from two sources takes face and subject (each with at or image, and its own focus), and no at or focus of its own', 'Give both face and subject, or call thumbnail with at for one frame.');
        }
        const r = await long('thumbnail', n, signal, (h) => writeThumbnail(project, n, { text, two: { face, subject, side, share } }, tools, { signal: h.signal }));
        return report(n, [thumbnailReport(n, r), ...(r.warnings ?? []).map((w) => `⚠ ${w}`)]);
      }
      if (at === undefined) {
        if (text !== undefined || focus !== undefined) {
          throw new MirageError('BAD_INPUT', 'text and focus go with at (the second of the video the thumbnail shows)', 'Run thumbnail without them to pick a frame, then again with at.');
        }
        const r = await long('thumbnail', n, signal, (h) => writeCandidates(project, n, tools, { signal: h.signal }));
        return report(n, candidatesReport(n, r));
      }
      const r = await long('thumbnail', n, signal, (h) => writeThumbnail(project, n, { at, text, focus }, tools, { signal: h.signal }));
      return report(n, [thumbnailReport(n, r)]);
    },
  );

  tool('versions', 'List the saved versions of a video: deliveries as V1, V2 … and the other saves, each with its id.', { video }, async ({ video: n }) => {
    const all = await listVersions(project, n);
    if (!all.length) return ok('no saved versions yet');
    return ok(all.map((v) => `${v.delivery === null ? v.label : `V${v.delivery} · ${v.label}`} · ${stamp(v.createdAt)} · ${v.id}`));
  });

  tool('restore', 'Put a saved version of a video back. What is there now is kept, so this can be undone.', { video, id: z.string().describe('A version id from versions') }, async ({ video: n, id }) => {
    const { restored, backup } = await restoreVersion(project, n, id);
    return ok(`went back to “${restored.label}” (what was there is kept as “${backup.label}”)`);
  });

  tool('get_notes', 'The notes the person sent: the newest round, or a given one.', { video, round: z.number().int().positive().optional() }, async ({ video: n, round }) => {
    const notes = await readNotes(project, n);
    const sent = notes.filter((x) => x.round !== null);
    if (!sent.length) return ok('no notes have been sent yet');
    const wanted = round ?? Math.max(...sent.map((x) => x.round!));
    const inRound = sent.filter((x) => x.round === wanted);
    if (!inRound.length) return ok(`no notes in round ${wanted}`);
    const pct = (f: number) => Math.round(f * 100);
    return ok(
      inRound
        .map((x) => [
          `Note ${x.id} at ${x.t.toFixed(1)} s: ${x.text}`,
          ...(x.box ? [`(about the area ${pct(x.box.x)}%–${pct(x.box.x + x.box.w)}% across, ${pct(x.box.y)}%–${pct(x.box.y + x.box.h)}% down)`] : []),
          `Still: ${join(episodeDir(project, n), x.still)}`,
        ].join('\n'))
        .join('\n\n'),
    );
  });

  tool(
    'note_status',
    'Record what you did with a note: done, done differently, or could not (with the reason).',
    { video, noteId: z.string(), status: z.enum(['done', 'done-differently', 'could-not']), reason: z.string().optional() },
    async (a) => {
      if (a.status !== 'done' && !a.reason?.trim()) return failed(new Error('say why: reason is needed unless the note is done'));
      if (!(await readNotes(project, a.video)).some((x) => x.id === a.noteId)) return failed(new Error(`there is no note ${a.noteId}`));
      await appendLog(sessionDir(project, a.video, sid()), { at: new Date().toISOString(), kind: 'note-status', text: a.reason ?? '', noteId: a.noteId, status: a.status });
      return ok('noted');
    },
  );

  tool(
    'log',
    'Write down a guess you made, a question for the person, or a concern, so they see it when they are back.',
    { video, kind: z.enum(['guess', 'question', 'concern']), text: z.string().min(1).max(2000) },
    async (a) => {
      await appendLog(sessionDir(project, a.video, sid()), { at: new Date().toISOString(), kind: a.kind, text: a.text });
      return ok('noted');
    },
  );

  tool('overnight', 'Get ready to edit unattended overnight: checks the Mac and keeps it awake until this session ends.', { videos: z.array(z.number().int().positive()).min(1) }, async ({ videos }) => {
    const { ok: ready, problems, notes } = await preflight({ project, videos, deps });
    if (!ready) return { content: [{ type: 'text', text: problems.join('\n') }], isError: true };
    // A caffeinate this session already started and that still runs keeps the Mac awake: no second one.
    const earlier = (await readSessionState(project, sid())).awakePid;
    const awakePid = earlier !== null && alive(earlier) ? earlier : startAwake();
    await writeSessionState(project, sid(), { overnight: { videos, startedAt: new Date().toISOString() }, awakePid });
    return ok([`ready: ${videos.length} videos, Mac kept awake until this session ends`, ...notes]);
  });

  tool('status', 'Where the project stands: its title, each video\'s stage and deliveries, the viewer, and whether the tools are installed.', {}, async () => {
    const lines: string[] = [];
    const meta = await readProject(project).catch((e: unknown) => {
      lines.push(`✖ ${describeError(e).message}`);
      return undefined;
    });
    if (meta === null) lines.push(`No Mirage project here yet (${project}). Use new_project to start one.`);
    else if (meta) lines.push(`Project: ${meta.title}`);
    const numbers = (await readdir(join(project, 'episodes')).catch(() => [] as string[])).filter((f) => /^[1-9]\d*$/.test(f)).map(Number).sort((a, b) => a - b);
    for (const n of numbers) {
      const { stage, deliveries } = await videoStage(project, n);
      const title = (await readVideo(project, n).catch(() => null))?.title;
      lines.push(`Video ${n}${title ? ` “${title}”` : ''}: ${stage} · ${deliveries} ${deliveries === 1 ? 'delivery' : 'deliveries'}`);
    }
    const grouped = await listSeries(project);
    lines.push(...grouped.series.map(seriesLine), ...grouped.problems);
    // A missing or broken viewer.json, or a pid that is gone (the viewer died without cleaning up), means it is not running.
    const viewer = await readJsonFile(join(project, '.mirage', 'viewer.json'), ViewerInfoSchema, '.mirage/viewer.json').catch(() => null);
    lines.push(viewer && alive(viewer.pid) ? `Viewer: running at ${viewer.url}` : 'Viewer: not running');
    const { formats, problems } = loadFormats(formatFiles());
    lines.push(`Formats: ${formats.map((f) => f.id).join(', ') || 'none'}`, ...problems);
    const known = formulas();
    const yours = known.formulas.filter((f) => f.origin === 'yours').map((f) => f.id);
    lines.push(`Formulas: ${known.formulas.filter((f) => f.origin === 'mirage').map((f) => f.id).join(', ') || 'none'}${yours.length ? `; yours: ${yours.join(', ')}` : ''}`, ...known.problems);
    if (meta) lines.push(await resultsLine(project, now()));
    for (const t of ['ffmpeg', 'ffprobe']) {
      const found = await deps.which(t);
      const captions = t === 'ffmpeg' && found ? await deps.captions() : null;
      lines.push(captions && !captions.ok ? `ffmpeg: can't draw captions — ${captions.path} was built without libass. ${captions.hint}` : `${t}: ${found ? 'ok' : 'missing'}`);
    }
    const speech = await deps.transcriber();
    lines.push(speech ? `transcriber: missing — ${speech}` : 'transcriber: ok');
    const tts = await deps.tts();
    lines.push(tts.state === 'ok' ? 'tts: ok' : `tts: ${tts.state === 'missing' ? 'missing — ' : ''}${tts.text}`);
    lines.push(Number(process.versions.node.split('.')[0]) >= 22 ? `Node: ${process.version} ok` : `Node: ${process.version} is too old, Mirage needs 22 or newer`);
    return ok(lines);
  }, false);

  tool(
    'formats',
    'The kinds of video Mirage knows (build story, short, vlog …): with no id, one line each with the words people use for it; with an id, that format\'s whole file: its beats, length and the rules to follow. Works without a project.',
    { id: z.string().min(1).optional().describe('A format id, e.g. short') },
    async ({ id }) => {
      const { formats, problems } = loadFormats(formatFiles());
      if (id === undefined) return ok([...formats.map((f) => `${f.id} — ${f.name}: ${f.describe} (words: ${f.words.join(', ')})`), ...problems]);
      const found = formats.find((f) => f.id === id);
      if (!found) throw new MirageError('BAD_INPUT', `unknown format "${id}"`, [`The formats are: ${formats.map((f) => f.id).join(', ') || 'none'}.`, ...problems].join('\n  '));
      return ok(readFileSync(join(formatFiles(), found.file), 'utf8'));
    },
    false,
  );

  tool(
    'formulas',
    'What makes videos do well, as measured: Mirage\'s own formulas (the general procedure, how YouTube recommends, and one per format; they can\'t be changed) and the ones the person saved in the project\'s formulas folder. ' +
      'With no id, one line each: what it is, the formats it is for, what it was measured on, and whose it is; with an id, that formula\'s whole file. Works without a project (Mirage\'s own only).',
    { id: z.string().min(1).optional().describe('A formula id, e.g. algorithm') },
    async ({ id }) => {
      const { formulas: all, problems } = formulas();
      if (id === undefined) return ok([...all.map(formulaLine), ...problems]);
      const found = all.find((f) => f.id === id);
      if (!found) throw new MirageError('BAD_INPUT', `unknown formula "${id}"`, [`The formulas are: ${all.map((f) => f.id).join(', ') || 'none'}.`, ...problems].join('\n  '));
      return ok(readFileSync(found.path, 'utf8'));
    },
    false,
  );

  const CHANNEL_SHAPES = 'One of: { url, videos? } · { name, patterns: [{ label, regex }] } · { name, thumbnails: "top" | "newest" | "lowest" } · { name, captions: [ids] }.';
  tool(
    'channel',
    'Gathers a YouTube channel\'s public data into analysis/<name>/ for the mirage:analyse skill; it never downloads a video. One thing per call. ' +
      'With url: lists the channel\'s newest videos (titles, lengths, views) and reports medians, lengths, title habits and the most viewed, newest and least viewed. ' +
      'With name and patterns: how many titles match each pattern and the median views with against without. ' +
      'With name and thumbnails: a contact sheet of 12 thumbnails. With name and captions: each video\'s transcript, pace, most replayed points, opening and ending. Needs yt-dlp.',
    {
      url: z.string().min(1).optional().describe('The channel: its YouTube address, or @handle'),
      name: z.string().min(1).optional().describe('The channel\'s name in this project, as the url call reported it'),
      videos: z.number().int().min(1).max(MAX_VIDEOS).optional().describe(`With url: how many of the newest videos to list (default ${DEFAULT_VIDEOS})`),
      patterns: z.array(z.object({ label: z.string().min(1).describe('What the pattern is, e.g. opens with I BOUGHT'), regex: z.string().min(1).describe('A regular expression tried on each title, ignoring case') })).min(1).max(40).optional(),
      thumbnails: z.enum(['top', 'newest', 'lowest']).optional().describe('Which 12: the most viewed, the newest, or the least viewed of the latest 60'),
      captions: z.array(z.string().min(1)).min(1).max(5).optional().describe('1–5 video ids from the lists'),
    },
    async (a, { signal }) => {
      const modes = [a.url, a.patterns, a.thumbnails, a.captions].filter((m) => m !== undefined).length;
      if (modes !== 1) throw new MirageError('BAD_INPUT', 'channel does one thing per call', CHANNEL_SHAPES);
      if (a.url !== undefined) {
        if (a.name !== undefined) throw new MirageError('BAD_INPUT', 'give url or name, not both: the name comes from the url', CHANNEL_SHAPES);
        return report(null, await long('channel', null, signal, (h) => gatherChannel(project, { url: a.url!, videos: a.videos }, channelDeps(), h.signal)));
      }
      if (a.name === undefined) throw new MirageError('BAD_INPUT', 'name is needed: which gathered channel this is about', `Run channel with the channel's url first; its report says the name to use. ${CHANNEL_SHAPES}`);
      if (a.videos !== undefined) throw new MirageError('BAD_INPUT', 'videos goes with url (how many videos to list)', CHANNEL_SHAPES);
      const name = a.name;
      if (a.patterns) return ok(await channelPatterns(project, name, a.patterns));
      if (a.thumbnails) return report(null, await long('channel', null, signal, (h) => channelThumbnails(project, name, a.thumbnails!, channelDeps(), h.signal)));
      return report(null, await long('channel', null, signal, (h) => channelCaptions(project, name, a.captions!, channelDeps(), h.signal)));
    },
  );

  tool(
    'posted',
    'Record that a finished video is live at a YouTube address, when the person says it is posted (Mirage never uploads). Keeps the address in the video\'s video.json and writes episodes/<n>/features.json, ' +
      'a snapshot of what the cut was made of (length, pace, words, music, where the answer lands), for learn to hold the results against. Needs the final render. Called again, it replaces the address and takes the snapshot again.',
    {
      video,
      url: z.string().min(1).describe('The video\'s YouTube address: a watch, youtu.be or Shorts link'),
      also: z.array(z.object({ platform: z.enum(['instagram', 'tiktok']), url: z.string().min(1).describe('The same video\'s address on that platform') })).max(2).optional()
        .describe('Where else the same short went, so the record is complete; Mirage reads no numbers there'),
    },
    async ({ video: n, url, also }) => report(n, await markPosted(project, n, url, { tools, formatsDir: formatFiles(), now, also })),
  );

  tool(
    'learn',
    'Read how the posted videos did, for the mirage:learn skill: each one\'s public numbers (views, likes, comments, the "most replayed" graph) with yt-dlp, never the video, kept by day in results/<n>.json. ' +
      'Reports per format: each video\'s numbers, which item of the cut viewers replay, the videos ranked fairly across ages, the better half against the weaker half on each feature of the cut and the title (4 or more videos), which read each video is at (early, main, late), how a video\'s experiment did, and how far to trust it. ' +
      'The same evidence goes to results/evidence.json. With studio, also keeps the numbers only the owner sees in YouTube Studio for one video. Needs yt-dlp and a posted video (see posted).',
    {
      studio: z.object({
        video,
        platform: z.enum(['youtube', 'instagram', 'tiktok']).optional().describe('Where the numbers are from (default youtube). Instagram\'s and TikTok\'s are only ever typed by the person: Mirage reads nothing there'),
        views: z.number().min(0).optional().describe('For instagram or tiktok: the views (plays) the app shows'),
        likes: z.number().min(0).optional().describe('For instagram or tiktok'),
        comments: z.number().min(0).optional().describe('For instagram or tiktok'),
        shares: z.number().min(0).optional().describe('For instagram or tiktok: shares, or Instagram\'s sends'),
        saves: z.number().min(0).optional().describe('For instagram or tiktok'),
        clickRate: z.number().min(0).max(100).optional().describe('The click rate on impressions, as a percentage (4.2 for 4.2%)'),
        percentViewed: z.number().min(0).max(100).optional().describe('The average percentage viewed, 0–100'),
        avgViewSec: z.number().min(0).optional().describe('The average view duration, in seconds'),
        viewedVsSwiped: z.number().min(0).max(100).optional().describe('For a short: the percentage that viewed rather than swiped away'),
        drops: z.array(z.object({ at: z.number().min(0).describe('Seconds into the video'), note: z.string().min(1).optional() })).max(20).optional().describe('Where the retention graph falls or viewers skip, as the person read it off'),
        spikes: z.array(z.object({ at: z.number().min(0).describe('Seconds into the video') })).max(20).optional().describe('Where the retention graph rises: viewers rewatch'),
      }).optional().describe('Numbers from YouTube Studio for one posted video (or, with platform, from Instagram\'s or TikTok\'s own insights), as the person gave them; several calls add up'),
    },
    async ({ studio }, { signal }) => {
      try {
        return await report(null, await long('learn', null, signal, (h) => learnResults(project, { studio }, channelDeps(), { signal: h.signal, onProgress: h.progress })));
      } catch (e) {
        return failed(e, STOPPED_LEARN);
      }
    },
  );

  tool(
    'predict',
    'An approximate forecast of a video\'s cut, run after the final render and before posting (it reads a rough cut too, and says which it read): a forecast, not a promise, and never a view count. ' +
      'Scores the cut out of 10 on the three steps YouTube judges a video in (chosen, stayed, satisfied) from the format\'s playbook as check measures it, names the weakest step and up to five moments behind it with one change each, ' +
      'and, once 4 videos of the format are posted and read by learn, says where the cut sits against them: below, around or above the person\'s usual. Writes episodes/<n>/prediction.json, which learn later holds against the result. Changes nothing in the video.',
    { video },
    async ({ video: n }) => report(n, await predictVideo(project, n, { tools, formatsDir: formatFiles(), formulasDir: ctx.formulasDir, now })),
  );

  tool(
    'series',
    'The series of the project: folders in series/ that group their episodes and carry, from one episode to the next, the open question, the running counts (cost so far, attempts used), the sign-off, the title shape and the thumbnail layout. ' +
      'With no name, one line per series. With a name, that series in full (and its README.md, the grouped view of its episodes, is written afresh). With a name and fields, sets those fields: after an episode\'s final render, the question its outro leaves open (with video, the episode that left it) and the counts. ' +
      'new_video with series starts a series or adds a video to one. Never invent a question or a number.',
    {
      name: z.string().min(1).optional().describe('The series: its slug or its name'),
      video: video.optional().describe('With openQuestion: the episode whose outro left it'),
      ...seriesFields,
    },
    async ({ name, ...fields }) => {
      const given = Object.values(fields).some((v) => v !== undefined);
      if (name === undefined) {
        if (given) throw new MirageError('BAD_INPUT', 'name is needed: which series to change', 'Run series with no input to list them.');
        const { series, problems } = await listSeries(project);
        return ok([...(series.length ? series.map(seriesLine) : ['no series yet — new_video with series starts one']), ...problems]);
      }
      if (fields.video !== undefined && fields.openQuestion === undefined) throw new MirageError('BAD_INPUT', 'video goes with openQuestion (the episode whose outro left it)', '');
      const s = given ? await updateSeries(project, name, fields) : await findSeries(project, name);
      return ok([...(given ? [`saved series/${s.slug}/series.json`] : []), ...(await seriesReport(project, s))]);
    },
  );

  tool('setup_later', 'The person said "not now" to installing the tools Mirage needs: stop asking about setup for 7 days.', {}, async () => {
    const dataDir = ctx.pluginData ?? process.env.MIRAGE_PLUGIN_DATA;
    if (!dataDir) throw new MirageError('BAD_INPUT', "Mirage has no data folder here, so it can't remember that.", 'It will ask again next session.');
    const until = new Date(now().getTime() + LATER_DAYS * 24 * 60 * 60 * 1000);
    writeSetupState(dataDir, { laterUntil: until.toISOString() });
    return ok(`OK — Mirage won't ask about setup again until ${until.toISOString().slice(0, 10)}. /mirage:setup installs the tools any time.`);
  }, false);

  return server;
}
