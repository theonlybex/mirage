// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, link, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  ClaudeProcessSchema, ControlSchema, LogEntrySchema, ProgressSchema, SessionStateSchema, StepLineSchema,
  type Control, type LogEntry, type Progress, type SessionState, type StepLine,
} from '@wordedits/shared';
import type { ZodType } from 'zod';
import { MirageError } from './errors.js';
import { readJsonFile, writeJsonFile } from './json-file.js';
import { episodeDir } from './render-episode.js';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkSessionId(id: string): string {
  if (!SESSION_ID.test(id) || id.includes('..')) throw new MirageError('BAD_INPUT', `"${id}" is not a session id`, 'A session id is letters, digits, dots, dashes and underscores.');
  return id;
}

/** The folder of one Claude session working on video `n`: episodes/<n>/sessions/<sessionId>/. */
export const sessionDir = (project: string, n: number, sessionId: string): string => join(episodeDir(project, n), 'sessions', checkSessionId(sessionId));

/** The lines of a JSON-lines file that parse and match `schema`; a missing file, a half-written last line or a stray line is skipped. */
async function readLines<T>(path: string, schema: ZodType<T>): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const r = schema.safeParse(raw);
    if (r.success) out.push(r.data);
  }
  return out;
}

/** Appends one validated line. A single small append is atomic enough for hooks in separate processes. */
async function appendLine<T>(path: string, schema: ZodType<T>, value: T): Promise<void> {
  const parsed = schema.parse(value);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(parsed) + '\n', 'utf8');
}

const stepsPath = (dir: string) => join(dir, 'steps.jsonl');
const logPath = (dir: string) => join(dir, 'log.jsonl');
const progressPath = (dir: string) => join(dir, 'progress.json');

export const appendStep = (dir: string, line: StepLine): Promise<void> => appendLine(stepsPath(dir), StepLineSchema, line);
export const readSteps = (dir: string): Promise<StepLine[]> => readLines(stepsPath(dir), StepLineSchema);

export const appendLog = (dir: string, entry: LogEntry): Promise<void> => appendLine(logPath(dir), LogEntrySchema, entry);
export const readLog = (dir: string): Promise<LogEntry[]> => readLines(logPath(dir), LogEntrySchema);

export async function writeProgress(dir: string, p: Progress): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeJsonFile(progressPath(dir), ProgressSchema, p, 'progress.json');
}

/** The running command's progress, or null when there is none (or the file is unreadable: it is only a display). */
export async function readProgress(dir: string): Promise<Progress | null> {
  try {
    return await readJsonFile(progressPath(dir), ProgressSchema, 'progress.json');
  } catch {
    return null;
  }
}

export const clearProgress = (dir: string): Promise<void> => rm(progressPath(dir), { force: true });

// --- control -----------------------------------------------------------------------------------------------------------

const controlPath = (project: string, n: number) => join(episodeDir(project, n), 'control.json');
const CLAIM = 'control.json.take-';

const defaultControl = (): Control => ({ version: 1, paused: false, pauseNow: false, stop: null, correction: null, updatedAt: new Date().toISOString() });

async function readControlFile(path: string): Promise<Control | null> {
  try {
    return await readJsonFile(path, ControlSchema, 'control.json');
  } catch {
    return null;
  }
}

/** A claim older than this was left by a take that died (a take holds its claim for milliseconds). */
const CLAIM_STALE_MS = 60_000;
/** A claim's name holds when it was made: renaming keeps the file's mtime, which is when control.json was last written. */
const claimName = () => `${CLAIM}${Date.now()}-${randomUUID()}`;
const claimedAt = (name: string, mtime: number): number => {
  const m = /^control\.json\.take-(\d{13})-/.exec(name);
  return m ? Number(m[1]) : mtime;
};

/** Writes `control` as control.json only if there is none: never replaces one somebody wrote meanwhile. */
async function writeControlIfNone(path: string, control: Control): Promise<void> {
  try {
    await writeFile(path, JSON.stringify(ControlSchema.parse(control), null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

/**
 * The newest control file a take has claimed and not yet written back, as it will be once the take is done (no
 * correction). While a take is in flight (or if its process died), control.json is missing and this is the real state.
 * Claims older than 60 s (their take died) are removed; when control.json is missing and no take is in flight, the newest
 * claim is first written back as control.json (if nobody wrote one meanwhile), so the state isn't lost.
 */
async function claimedControl(project: string, n: number, written: boolean): Promise<Control | null> {
  const dir = episodeDir(project, n);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith(CLAIM));
  let best: { control: Control; mtime: number } | null = null;
  const stale: string[] = [];
  for (const name of names) {
    const info = await stat(join(dir, name)).catch(() => null);
    if (!info) continue;
    if (Date.now() - claimedAt(name, info.mtimeMs) > CLAIM_STALE_MS) stale.push(name);
    if (written) continue;
    const control = await readControlFile(join(dir, name));
    if (control && (!best || info.mtimeMs > best.mtime)) best = { control, mtime: info.mtimeMs };
  }
  const claimed = best ? { ...best.control, correction: null } : null;
  if (stale.length) {
    try {
      if (claimed && stale.length === names.length) await writeControlIfNone(controlPath(project, n), claimed);
      for (const name of stale) await rm(join(dir, name), { force: true });
    } catch {
      // Tidying only: the next read tries again.
    }
  }
  return claimed;
}

/**
 * The control of video `n` as somebody wrote it: control.json, or a claimed one while a correction is being taken. Null when
 * there is none or it is broken, i.e. when readControl falls back to "all off".
 */
export async function readWrittenControl(project: string, n: number): Promise<Control | null> {
  const written = await readControlFile(controlPath(project, n));
  const claimed = await claimedControl(project, n, written !== null);
  return written ?? claimed;
}

/** The user's control of video `n`. All off when the file is missing or broken: a bad file must never stop or pause a video. */
export async function readControl(project: string, n: number): Promise<Control> {
  return (await readWrittenControl(project, n)) ?? defaultControl();
}

/** Merges `patch` into the control of video `n` and writes it atomically, setting `updatedAt`. */
export async function writeControl(project: string, n: number, patch: Partial<Control>): Promise<Control> {
  const next = ControlSchema.parse({ ...(await readControl(project, n)), ...patch, version: 1, updatedAt: new Date().toISOString() });
  await mkdir(episodeDir(project, n), { recursive: true });
  await writeJsonFile(controlPath(project, n), ControlSchema, next, 'control.json');
  return next;
}

/**
 * Returns the pending correction and clears it, once, however many hooks ask at the same time. The control file is
 * claimed by renaming it to a unique name (only one rename can succeed); the winner reads it, writes the control back
 * without the correction and removes the claim. The write-back never replaces a control.json somebody wrote meanwhile: a
 * hard link, or an exclusive create where the volume has no hard links. `o.link` is for tests.
 */
export async function takeCorrection(project: string, n: number, o: { link?: typeof link } = {}): Promise<string | null> {
  const path = controlPath(project, n);
  // The usual case, no correction: leave the file alone (a rename would hide it from other readers for a moment).
  const peek = await readControlFile(path);
  if (!peek || peek.correction === null) return null;
  const claim = join(episodeDir(project, n), claimName());
  try {
    await rename(path, claim);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const claimed = await readControlFile(claim);
  const text = claimed?.correction ?? null;
  if (claimed) {
    const rest = ControlSchema.parse({ ...claimed, correction: null, updatedAt: text === null ? claimed.updatedAt : new Date().toISOString() });
    const tmp = `${path}.tmp-${randomUUID()}`;
    await writeJsonFile(tmp, ControlSchema, rest, 'control.json');
    try {
      await (o.link ?? link)(tmp, path); // fails when someone has written a newer control.json: theirs stays
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // exFAT and network volumes have no hard links: an exclusive create keeps the same rule.
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EXDEV' || code === 'ENOSYS') await writeControlIfNone(path, rest);
      else if (code !== 'EEXIST') throw e;
    } finally {
      await rm(tmp, { force: true });
    }
  }
  await rm(claim, { force: true });
  return text;
}

// --- session state -----------------------------------------------------------------------------------------------------

const sessionStatePath = (project: string, sessionId: string) => join(resolve(project), '.mirage', 'sessions', `${checkSessionId(sessionId)}.json`);
const emptySession = (): SessionState => ({ video: null, overnight: null, awakePid: null });

/** Which video a Claude session works on. Empty when the session has no file yet or it is broken. */
export async function readSessionState(project: string, sessionId: string): Promise<SessionState> {
  try {
    return await readJsonFile(sessionStatePath(project, sessionId), SessionStateSchema, `.mirage/sessions/${sessionId}.json`);
  } catch (e) {
    if (e instanceof MirageError) throw e;
    return emptySession();
  }
}

export async function writeSessionState(project: string, sessionId: string, patch: Partial<SessionState>): Promise<SessionState> {
  const path = sessionStatePath(project, sessionId);
  const next = SessionStateSchema.parse({ ...(await readSessionState(project, sessionId)), ...patch });
  await mkdir(dirname(path), { recursive: true });
  await writeJsonFile(path, SessionStateSchema, next, `.mirage/sessions/${sessionId}.json`);
  return next;
}

/** Marks a session's state file as just used, so the engine's fallback guess picks it; writes an empty one when there is none. */
export async function touchSessionState(project: string, sessionId: string): Promise<void> {
  const now = new Date();
  try {
    await utimes(sessionStatePath(project, sessionId), now, now);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await writeSessionState(project, sessionId, {});
  }
}

// --- which session a Claude Code process runs ---------------------------------------------------------------------------

function claudeProcessPath(project: string, pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new MirageError('BAD_INPUT', `"${pid}" is not a process id`, 'A process id is a whole number above 0.');
  return join(resolve(project), '.mirage', 'claude', `${pid}.json`);
}

/**
 * Records that the Claude Code process `pid` runs session `sessionId`: `<project>/.mirage/claude/<pid>.json`. The hooks
 * write it on every event; the engine that process started reads it with readClaudeProcess.
 */
export async function writeClaudeProcess(project: string, pid: number, sessionId: string, at: Date = new Date()): Promise<void> {
  const path = claudeProcessPath(project, pid);
  await mkdir(dirname(path), { recursive: true });
  await writeJsonFile(path, ClaudeProcessSchema, { sessionId: checkSessionId(sessionId), updatedAt: at.toISOString() }, `.mirage/claude/${pid}.json`);
}

/** The session the Claude Code process `pid` runs, or null when its file is missing or broken. Synchronous: the engine asks on every call. */
export function readClaudeProcess(project: string, pid: number): string | null {
  try {
    const r = ClaudeProcessSchema.safeParse(JSON.parse(readFileSync(claudeProcessPath(project, pid), 'utf8')));
    return r.success ? r.data.sessionId : null;
  } catch {
    return null;
  }
}
