// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readdirSync, statSync } from 'node:fs';
import { access, constants, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { ViewerInfoSchema } from '@wordedits/shared';
import {
  analyzeLibrary, appendLog, checkEpisode, checkReport, describeError, episodeDir, fitRecording, ingestClips, ingestReport, initProject, listVersions,
  MirageError, musicReport, newVideo, readJsonFile, readNotes, readProject, readSessionState, readVideo, renderEpisode, renderReport, requireProject, resolveUserPath, restoreVersion,
  sessionDir, slotsReport, updateSlots, videoStage, voReport, writeSessionState, type EpisodeMode, type MediaTools,
} from '@wordedits/core';
import { transcriberPath } from '@wordedits/sidecars';
import { preflight, realPreflightDeps, startCaffeinate, type PreflightDeps } from './preflight.js';
import { runLong } from './run-long.js';

export const TOOL_NAMES: readonly string[] = [
  'new_project', 'new_video', 'ingest', 'music', 'check', 'cut', 'slots', 'guide', 'vo', 'render', 'versions', 'restore', 'get_notes', 'note_status', 'log', 'overnight', 'status',
];

export interface EngineContext {
  /** The project folder (it may not hold a mirage.json yet: new_project makes one). */
  project: string;
  tools: MediaTools;
  /** The Claude session this server belongs to; null when unknown. Default: newestSessionId(project). */
  sessionId?: () => string | null;
  /** Machine checks for `overnight` and `status`. Default: the real machine. */
  preflightDeps?: PreflightDeps;
  /** Keeps the Mac awake; returns the pid of what does. Default: caffeinate. */
  startAwake?: () => number | null;
}

const DAY_MS = 24 * 3600_000;
const SESSION_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.json$/;

/**
 * The Claude session in charge: the newest `<project>/.mirage/sessions/<id>.json` touched in the last 24 hours (the
 * SessionStart hook touches it). Null when there is none. `unknown.json` (state kept for a session nobody could name) is not a session.
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
    if (Date.now() - mtime > DAY_MS) continue;
    if (!best || mtime > best.mtime) best = { id, mtime };
  }
  return best?.id ?? null;
}

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (lines: string | string[]): Result => ({ content: [{ type: 'text', text: Array.isArray(lines) ? lines.join('\n') : lines }] });
const STOPPED = '✖ Stopped by the person before it finished. Nothing was changed.';
/** Ingest keeps the clips it catalogued before it was stopped. */
const STOPPED_INGEST = '✖ Stopped by the person before it finished. Clips catalogued so far are kept.';
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
const MODES: Record<'cut' | 'guide' | 'render', EpisodeMode> = { cut: 'rough', guide: 'guide', render: 'final' };

/** The Mirage engine as MCP tools. */
export function createEngineServer(ctx: EngineContext): McpServer {
  const project = resolve(ctx.project);
  const { tools } = ctx;
  const deps = ctx.preflightDeps ?? realPreflightDeps();
  const startAwake = ctx.startAwake ?? startCaffeinate;
  const knownSession = ctx.sessionId ?? (() => newestSessionId(project));
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
   * report. With no video (ingest or music before the session has one) they go to the newest video's session folder; a
   * project with no video yet has nowhere to log them, so they are dropped (the report still shows them).
   */
  async function report(n: number | null, lines: string[]): Promise<Result> {
    const warnings = lines.flatMap((l) => (l.includes('⚠ ') ? [l.slice(l.indexOf('⚠ ') + 2)] : []));
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
    'Start a new video in the project: what it is about, what to mention or hide, and the folders its footage is in.',
    {
      title: z.string().min(1).max(200),
      about: z.string().describe('What the video is about, in the person\'s words'),
      mention: z.string().optional().describe('Things the person wants mentioned'),
      hide: z.string().optional().describe('Things that must not show (keys, names, private windows)'),
      footage: z.array(z.string()).describe('Folders with the footage for this video'),
    },
    async (a) => {
      const folders = a.footage.map((f) => resolveUserPath(f, project));
      const missing = folders.filter((f) => !existsSync(f));
      if (missing.length) return { content: [{ type: 'text', text: missing.map((f) => `✖ ${f} does not exist`).join('\n') }], isError: true };
      const n = await newVideo(project, { title: a.title, about: a.about, mention: a.mention ?? '', hide: a.hide ?? '', footage: folders });
      await writeSessionState(project, sid(), { video: n });
      return ok(`video ${n} created`);
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

  tool('check', 'Check the timeline of a video against the catalog and music, snap montages to the beat, and list it.', { video }, async ({ video: n }) => report(n, checkReport(await checkEpisode(project, n))));

  for (const [name, mode] of Object.entries(MODES) as ['cut' | 'guide' | 'render', EpisodeMode][]) {
    const what = { cut: 'Check the timeline, then render the rough cut (picture, music, overlays).', guide: 'Render the guide video, with the narration lines on screen to record against.', render: 'Render the final video with captions.' }[name];
    tool(name, what, { video }, async ({ video: n }, { signal }) => {
      const lines: string[] = [];
      const r = await long(name, n, signal, (h) =>
        renderEpisode({
          project, episode: n, mode, tools, signal: h.signal, onProgress: h.progress,
          // As the CLI's cut: the check runs under the episode's lock.
          beforeRender: name === 'cut' ? async () => { lines.push(...checkReport(await checkEpisode(project, n))); } : undefined,
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
    const { ok: ready, problems } = await preflight({ project, videos, deps });
    if (!ready) return { content: [{ type: 'text', text: problems.join('\n') }], isError: true };
    // A caffeinate this session already started and that still runs keeps the Mac awake: no second one.
    const earlier = (await readSessionState(project, sid())).awakePid;
    const awakePid = earlier !== null && alive(earlier) ? earlier : startAwake();
    await writeSessionState(project, sid(), { overnight: { videos, startedAt: new Date().toISOString() }, awakePid });
    return ok(`ready: ${videos.length} videos, Mac kept awake until this session ends`);
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
    // A missing or broken viewer.json, or a pid that is gone (the viewer died without cleaning up), means it is not running.
    const viewer = await readJsonFile(join(project, '.mirage', 'viewer.json'), ViewerInfoSchema, '.mirage/viewer.json').catch(() => null);
    lines.push(viewer && alive(viewer.pid) ? `Viewer: running at ${viewer.url}` : 'Viewer: not running');
    for (const t of ['ffmpeg', 'ffprobe']) lines.push(`${t}: ${(await deps.which(t)) ? 'ok' : 'missing'}`);
    lines.push(`transcriber: ${(await access(transcriberPath(), constants.X_OK).then(() => true, () => false)) ? 'ok' : 'missing'}`);
    lines.push(Number(process.versions.node.split('.')[0]) >= 22 ? `Node: ${process.version} ok` : `Node: ${process.version} is too old, Mirage needs 22 or newer`);
    return ok(lines);
  }, false);

  return server;
}
