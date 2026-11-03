// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { access, constants, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { isAbsolute, join } from 'node:path';
import {
  addNote, deleteNote, describeError, episodeDir, listVersions, MirageError, readNotes, readVideo, restoreVersion, sendNotes,
  updateNote, videoStage, writeControl, readControl, JsonFileError, type MediaTools,
} from '@wordedits/core';
import { SidecarError } from '@wordedits/sidecars';
import { z } from 'zod';
import { noteViews } from './events.js';

/** An error that becomes this HTTP status and `{ error }`. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type ApiContext = {
  project: string;
  pluginData: string;
  tools: MediaTools;
  /** Prints one line to stdout: Claude's notification. */
  say: (line: string) => void;
};
export type ApiResult = { status: number; body: unknown };

const JSON_LIMIT = 1 << 20;
const AUDIO_LIMIT = 25 << 20;
const TEXT_LIMIT = 2000;
const SAY_LIMIT = 1000;
const SPEECH_NOT_READY = 'Speech recognition is still being set up. Try again in a minute, or type the note.';

/** A person's text as it goes into a line to Claude: one line, short, and unable to close its own quotes. */
export function oneLine(text: string, max = SAY_LIMIT): string {
  const flat = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** How an error is answered: our own with their status; the engine's by kind; the rest 500. */
export function errorResult(e: unknown): ApiResult {
  if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
  if (e instanceof z.ZodError) return { status: 400, body: { error: describeError(e).message } };
  if (e instanceof MirageError) {
    const status = e.code === 'BUSY' ? 409 : e.code === 'NO_EPISODE' || e.code === 'NO_PROJECT' ? 404 : 400;
    return { status, body: { error: [e.message, e.hint].filter(Boolean).join(' ') } };
  }
  if (e instanceof JsonFileError) return { status: 500, body: { error: `${e.message} ${e.hint}` } };
  return { status: 500, body: { error: describeError(e).message } };
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'That is too large.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = (await readBody(req, JSON_LIMIT)).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'The request is not valid JSON.');
  }
}

const VideoNumber = z.number().int().positive();
const Box = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).strict();

const parseVideoParam = (v: string | null): number => {
  if (v === null || !/^[1-9]\d*$/.test(v)) throw new HttpError(400, 'Say which video: ?video=<number>.');
  return Number(v);
};

async function requireVideo(project: string, n: number): Promise<void> {
  const ok = await stat(episodeDir(project, n)).then((s) => s.isDirectory(), () => false);
  if (!ok) throw new HttpError(404, `There is no video ${n}.`);
}

/** The numbers of the video folders in episodes/, ascending. */
export async function videoNumbers(project: string): Promise<number[]> {
  const names = await readdir(join(project, 'episodes')).catch(() => [] as string[]);
  return names.filter((f) => /^[1-9]\d*$/.test(f)).map(Number).sort((a, b) => a - b);
}

async function listVideos(project: string) {
  return Promise.all(
    (await videoNumbers(project)).map(async (number) => {
      const title = (await readVideo(project, number).catch(() => null))?.title ?? `Video ${number}`;
      return { number, title, ...(await videoStage(project, number)) };
    }),
  );
}

const note = z.object({ video: VideoNumber, versionId: z.string().min(1), t: z.number(), text: z.string(), box: Box.nullish() });
const notePatch = z.object({ video: VideoNumber.optional(), text: z.string().optional(), box: Box.nullable().optional() });
const controlBody = z.object({
  video: VideoNumber,
  pause: z.enum(['after-step', 'now']).optional(),
  resume: z.object({ correction: z.string().max(TEXT_LIMIT).optional() }).optional(),
  stop: z.literal(true).optional(),
});

async function control(ctx: ApiContext, req: IncomingMessage): Promise<ApiResult> {
  const b = controlBody.parse(await readJson(req));
  await requireVideo(ctx.project, b.video);
  const { project } = ctx;
  if (b.stop) return { status: 200, body: await writeControl(project, b.video, { stop: { at: new Date().toISOString() }, paused: false }) };
  if (b.pause) return { status: 200, body: await writeControl(project, b.video, { paused: true, pauseNow: b.pause === 'now' }) };
  if (!b.resume) throw new HttpError(400, 'Say what to do: pause, resume or stop.');
  const correction = b.resume.correction?.trim() || null;
  const current = await readControl(project, b.video);
  if (current.paused) return { status: 200, body: await writeControl(project, b.video, { paused: false, pauseNow: false, correction }) };
  // Not paused, so Claude is not about to meet a hook that would hand it the correction: tell Claude directly.
  if (correction) ctx.say(`Mirage viewer: the person says about video ${b.video}: “${oneLine(correction)}”`);
  return { status: 200, body: current };
}

async function addVideoNote(ctx: ApiContext, req: IncomingMessage): Promise<ApiResult> {
  const b = note.parse(await readJson(req));
  await requireVideo(ctx.project, b.video);
  const version = (await listVersions(ctx.project, b.video)).find((v) => v.id === b.versionId);
  if (!version?.render) throw new HttpError(400, 'Notes go on a version that has a video.');
  const videoPath = join(episodeDir(ctx.project, b.video), 'versions', version.id, version.render.file);
  const added = await addNote(ctx.project, b.video, { versionId: version.id, videoPath, t: b.t, text: b.text, box: b.box ?? null, tools: ctx.tools });
  return { status: 200, body: added };
}

async function sendVideoNotes(ctx: ApiContext, req: IncomingMessage): Promise<ApiResult> {
  const { video } = z.object({ video: VideoNumber }).parse(await readJson(req));
  await requireVideo(ctx.project, video);
  const sent = await sendNotes(ctx.project, video);
  if (!sent.length) return { status: 200, body: { sent: 0, round: null } };
  const versions = await listVersions(ctx.project, video);
  const labels = [...new Set(sent.map((x) => oneLine(versions.find((v) => v.id === x.versionId)?.label ?? x.versionId, 200)))];
  ctx.say(`Mirage viewer: the person sent ${sent.length} note(s) on video ${video} (${labels.join(', ')}). Use the mirage:notes skill for video ${video}.`);
  return { status: 200, body: { sent: sent.length, round: sent[0]!.round } };
}

async function voiceNote(ctx: ApiContext, req: IncomingMessage, url: URL): Promise<ApiResult> {
  const n = parseVideoParam(url.searchParams.get('video'));
  await requireVideo(ctx.project, n);
  const audio = await readBody(req, AUDIO_LIMIT);
  if (!audio.length) throw new HttpError(400, 'The recording is empty.');
  const notReady = new HttpError(503, SPEECH_NOT_READY);
  await access(join(ctx.pluginData, 'bin', 'wordedits-transcribe'), constants.X_OK).catch(() => {
    throw notReady;
  });
  const dir = join(episodeDir(ctx.project, n), 'notes');
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const webm = join(dir, `voice-${id}.webm`);
  const wav = join(dir, `voice-${id}.wav`);
  await writeFile(webm, audio);
  try {
    await ctx.tools.extractWav(webm, wav);
    const transcript = await ctx.tools.transcribe(wav);
    return { status: 200, body: { text: transcript.segments.map((s) => s.text.trim()).filter(Boolean).join(' ') } };
  } catch (e) {
    if (e instanceof SidecarError && e.code === 'NOT_FOUND') throw notReady;
    throw e;
  } finally {
    await rm(wav, { force: true });
  }
}

async function voiceover(ctx: ApiContext, req: IncomingMessage): Promise<ApiResult> {
  const b = z.object({ video: VideoNumber, path: z.string().min(1) }).parse(await readJson(req));
  await requireVideo(ctx.project, b.video);
  if (!isAbsolute(b.path) || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(b.path)) throw new HttpError(400, 'Give the full path of the recording.');
  if (!(await stat(b.path).then((s) => s.isFile(), () => false))) throw new HttpError(400, `There is no recording at ${b.path}.`);
  ctx.say(`Mirage viewer: the person dropped a voice-over recording for video ${b.video}: ${b.path}. Use the mirage:voiceover skill.`);
  return { status: 200, body: { ok: true } };
}

async function overnight(ctx: ApiContext, req: IncomingMessage): Promise<ApiResult> {
  const b = z.object({ videos: z.array(VideoNumber).min(1).max(100) }).parse(await readJson(req));
  const videos = [...new Set(b.videos)];
  for (const n of videos) await requireVideo(ctx.project, n);
  ctx.say(`Mirage viewer: the person wants videos ${videos.join(', ')} edited overnight. Use the mirage:overnight skill.`);
  return { status: 200, body: { ok: true } };
}

async function restore(ctx: ApiContext, req: IncomingMessage): Promise<ApiResult> {
  const b = z.object({ video: VideoNumber, id: z.string().min(1) }).parse(await readJson(req));
  await requireVideo(ctx.project, b.video);
  return { status: 200, body: await restoreVersion(ctx.project, b.video, b.id, { waitMs: 10_000 }) };
}

/** `/api/notes/<id>`: change (PATCH) or delete (DELETE) an unsent note; the video is `?video=` or in the body. */
async function noteById(ctx: ApiContext, req: IncomingMessage, url: URL, id: string): Promise<ApiResult> {
  if (req.method !== 'PATCH' && req.method !== 'DELETE') throw new HttpError(405, 'Use PATCH or DELETE.');
  const body = req.method === 'PATCH' ? notePatch.parse(await readJson(req)) : {};
  const fromQuery = url.searchParams.get('video');
  const n = fromQuery !== null ? parseVideoParam(fromQuery) : ((body as { video?: number }).video ?? parseVideoParam(null));
  await requireVideo(ctx.project, n);
  if (req.method === 'DELETE') {
    await deleteNote(ctx.project, n, id);
    return { status: 200, body: { ok: true } };
  }
  const { text, box } = body as z.infer<typeof notePatch>;
  if (text === undefined && box === undefined) throw new HttpError(400, 'Say what to change: text or box.');
  return { status: 200, body: await updateNote(ctx.project, n, id, { ...(text !== undefined && { text }), ...(box !== undefined && { box }) }) };
}

const NOTE_ID = /^\/api\/notes\/(n[1-9]\d*)$/;

/** The JSON routes under /api/ (the event stream and media are the server's own). */
export async function handleApi(ctx: ApiContext, req: IncomingMessage, url: URL): Promise<ApiResult> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const only = (...allowed: string[]) => {
    if (!allowed.includes(method)) throw new HttpError(405, `Use ${allowed.join(' or ')}.`);
  };
  const noteId = NOTE_ID.exec(path)?.[1];
  if (noteId) return noteById(ctx, req, url, noteId);
  switch (path) {
    case '/api/videos':
      only('GET');
      return { status: 200, body: await listVideos(ctx.project) };
    case '/api/control':
      only('POST');
      return control(ctx, req);
    case '/api/notes': {
      only('GET', 'POST');
      if (method === 'POST') return addVideoNote(ctx, req);
      const n = parseVideoParam(url.searchParams.get('video'));
      await requireVideo(ctx.project, n);
      return { status: 200, body: await noteViews(ctx.project, n) };
    }
    case '/api/notes/send':
      only('POST');
      return sendVideoNotes(ctx, req);
    case '/api/voice-note':
      only('POST');
      return voiceNote(ctx, req, url);
    case '/api/voiceover':
      only('POST');
      return voiceover(ctx, req);
    case '/api/overnight':
      only('POST');
      return overnight(ctx, req);
    case '/api/restore':
      only('POST');
      return restore(ctx, req);
    default:
      throw new HttpError(404, 'No such call.');
  }
}
