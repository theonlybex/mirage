// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { access, constants, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { extname, isAbsolute, join } from 'node:path';
import {
  addNote, deleteNote, describeError, episodeDir, listVersions, MirageError, readNotes, readVideo, restoreVersion, sendNotes,
  updateNote, videoStage, writeControl, readControl, JsonFileError, type MediaTools,
} from '@wordedits/core';
import { SidecarError } from '@wordedits/sidecars';
import { z } from 'zod';
import { noteStillUrl, noteViews } from './events.js';
import { HttpError } from './http-error.js';
import { multipartBoundary, readMultipart } from './multipart.js';
import type { VideoSummary } from '../view-types.js';

export { HttpError };

export type ApiContext = {
  project: string;
  /** The speech helper: checked before a voice note is taken and the one that transcribes it. */
  transcriber: string;
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

/** How much of an over-large body is read and thrown away (and for how long) so the sender gets the answer, not a reset. */
const DRAIN_BYTES = 64 << 20;
const DRAIN_MS = 10_000;

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const tooLarge = () => new HttpError(413, 'That is too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  let over = Number(req.headers['content-length']) > limit;
  const giveUp = Date.now() + DRAIN_MS;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) over = true;
    // Past the limit nothing more is kept: the rest is only read off the wire (up to a bound) so the answer can get through.
    if (over) {
      if (size > DRAIN_BYTES || Date.now() > giveUp) break;
      continue;
    }
    chunks.push(c as Buffer);
  }
  if (over) throw tooLarge();
  return Buffer.concat(chunks);
}

/** Reads and drops what is left of a body (up to the same bound) so the answer reaches a sender that is still sending. */
async function drain(req: IncomingMessage): Promise<void> {
  let size = 0;
  const giveUp = Date.now() + DRAIN_MS;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > DRAIN_BYTES || Date.now() > giveUp) break;
  }
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

async function listVideos(project: string): Promise<VideoSummary[]> {
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
  if (b.stop) return { status: 200, body: await writeControl(project, b.video, { stop: { at: new Date().toISOString() }, paused: false, pauseNow: false, correction: null }) };
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
  return { status: 200, body: { ...added, stillUrl: noteStillUrl(ctx.project, b.video, added) } };
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
  await access(ctx.transcriber, constants.X_OK).catch(() => {
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
    const transcript = await ctx.tools.transcribe(wav, { transcriber: ctx.transcriber });
    return { status: 200, body: { text: transcript.segments.map((s) => s.text.trim()).filter(Boolean).join(' ') } };
  } catch (e) {
    if (e instanceof SidecarError && e.code === 'NOT_FOUND') throw notReady;
    throw e;
  } finally {
    await rm(wav, { force: true });
  }
}

const sayVoiceover = (ctx: ApiContext, video: number, path: string) =>
  ctx.say(`Mirage viewer: the person dropped a voice-over recording for video ${video}: ${path}. Use the mirage:voiceover skill.`);

/** `/api/voiceover`: the path of a recording (JSON, for Claude's side), or the recording itself (form data, from the page). */
async function voiceover(ctx: ApiContext, req: IncomingMessage): Promise<ApiResult> {
  const boundary = multipartBoundary(req.headers['content-type']);
  if (boundary !== null) return voiceoverUpload(ctx, req, boundary);
  const b = z.object({ video: VideoNumber, path: z.string().min(1) }).parse(await readJson(req));
  await requireVideo(ctx.project, b.video);
  if (!isAbsolute(b.path) || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(b.path)) throw new HttpError(400, 'Give the full path of the recording.');
  if (!(await stat(b.path).then((s) => s.isFile(), () => false))) throw new HttpError(400, `There is no recording at ${b.path}.`);
  sayVoiceover(ctx, b.video, b.path);
  return { status: 200, body: { ok: true } };
}

/** The most a dropped recording may be (a long phone video still fits). */
export const VOICEOVER_LIMIT = 4 * 1024 ** 3;
/** What a voice-over recording can be: the audio and video files ffmpeg reads that people record with. */
export const RECORDING_EXTENSIONS = ['aac', 'aif', 'aiff', 'caf', 'flac', 'm4a', 'm4v', 'mov', 'mp3', 'mp4', 'ogg', 'opus', 'wav', 'webm'];
const NAME_LIMIT = 120;

/**
 * A file name from the browser made safe to save: its last path part, without control and format characters or the
 * characters other systems refuse, never hidden (no leading dot), at most 120 characters with its extension kept.
 */
export function safeFileName(name: string): string {
  let s = (name.split(/[/\\]/).pop() ?? '').normalize('NFC');
  s = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/[<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '');
  if (s.length > NAME_LIMIT) {
    const ext = extname(s).slice(0, 16);
    s = s.slice(0, NAME_LIMIT - ext.length).trimEnd() + ext;
  }
  return s || 'recording';
}

/** Takes the name `name` in `dir` (or `name (2)`, `name (3)`, …) by creating it empty, so two uploads never share one. */
async function claimName(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const path = join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    try {
      await writeFile(path, '', { flag: 'wx' });
      return path;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new HttpError(409, 'There are too many recordings with that name. Rename the file and drop it again.');
}

/**
 * The recording's bytes, as form data with the field `video` before the file: saved under
 * episodes/<n>/voiceover/<its name> (a new name if that is taken), then said to Claude like a path.
 */
async function voiceoverUpload(ctx: ApiContext, req: IncomingMessage, boundary: string): Promise<ApiResult> {
  if (Number(req.headers['content-length']) > VOICEOVER_LIMIT + 64 * 1024) throw new HttpError(413, 'That is too large.');
  let video = 0;
  let dir = '';
  let name = '';
  // Read without ending the request on a refusal: what is left is drained below, so the browser gets the answer.
  const read = readMultipart(req.iterator({ destroyOnReturn: false }), boundary, {
    fileLimit: VOICEOVER_LIMIT,
    open: async (fields, filename) => {
      if (fields.video === undefined) throw new HttpError(400, 'Say which video before the file: the form field “video”.');
      video = VideoNumber.parse(Number(fields.video));
      await requireVideo(ctx.project, video);
      name = safeFileName(filename);
      if (!RECORDING_EXTENSIONS.includes(extname(name).slice(1).toLowerCase())) {
        throw new HttpError(400, 'That doesn’t look like a recording. Drop an audio or video file, such as .m4a, .mp3, .wav or .mov.');
      }
      dir = join(episodeDir(ctx.project, video), 'voiceover');
      await mkdir(dir, { recursive: true });
      return join(dir, `.upload-${randomUUID()}`);
    },
  });
  const { file } = await read.catch(async (e: unknown) => {
    await drain(req).catch(() => {});
    throw e;
  });
  if (!file) throw new HttpError(400, 'There is no recording in the upload.');
  if (file.size === 0) {
    await rm(file.path, { force: true });
    throw new HttpError(400, 'The recording is empty.');
  }
  let path: string;
  try {
    path = await claimName(dir, name);
    await rename(file.path, path);
  } catch (e) {
    await rm(file.path, { force: true });
    throw e;
  }
  sayVoiceover(ctx, video, path);
  return { status: 200, body: { ok: true, path } };
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
  const updated = await updateNote(ctx.project, n, id, { ...(text !== undefined && { text }), ...(box !== undefined && { box }) });
  return { status: 200, body: { ...updated, stillUrl: noteStillUrl(ctx.project, n, updated) } };
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
