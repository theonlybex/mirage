import { randomUUID } from 'node:crypto';
import { open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MirageError } from './errors.js';

export const LOCK_FILE = '.mirage.lock';
/** A lock older than this is stale even if its pid is alive again (the pid was reused, e.g. after a restart). */
const MAX_LOCK_AGE_MS = 24 * 3600_000;
/** A lock file with no readable content yet is this young while its command writes it; older, it was abandoned half-written. */
const STARTING_GRACE_MS = 5_000;
/** Temp files written by commands that take no lock (check, slots) are only treated as leftovers once this old. */
export const TMP_GRACE_MS = 60_000;

interface LockInfo {
  pid: number;
  command: string;
  startedAt: string;
  token: string;
}

export interface Lock {
  /** When this lock was taken (ms since the epoch). */
  startedAt: number;
  release(): Promise<void>;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to another user.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseLock(text: string): LockInfo | null {
  try {
    const info = JSON.parse(text) as Partial<LockInfo>;
    return typeof info.pid === 'number' && typeof info.startedAt === 'string' && Number.isFinite(Date.parse(info.startedAt)) ? (info as LockInfo) : null;
  } catch {
    return null;
  }
}

async function readLock(path: string): Promise<LockInfo | null> {
  return parseLock(await readFile(path, 'utf8').catch(() => ''));
}

/** The lock file as one look: its text and modification time, read through one handle. Null when it is gone. */
async function lookAt(path: string): Promise<{ text: string; mtimeMs: number } | null> {
  const fh = await open(path, 'r').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (!fh) return null;
  try {
    const { mtimeMs } = await fh.stat();
    return { text: await fh.readFile('utf8'), mtimeMs };
  } finally {
    await fh.close();
  }
}

const busyHint = (path: string) => `Wait for it to finish, or stop it, then run this again. If no Mirage command is running, delete ${path} (a restart or crash left it behind).`;

/** Why the lock file seen as `seen` is live (the BUSY message), or null when it was abandoned and may be taken over. */
function liveHolder(seen: { text: string; mtimeMs: number }, what: string, now: number): string | null {
  const held = parseLock(seen.text);
  if (!held) return now - seen.mtimeMs < STARTING_GRACE_MS ? `${what} is busy: another Mirage command is starting in it` : null;
  if (alive(held.pid) && now - Date.parse(held.startedAt) < MAX_LOCK_AGE_MS) {
    return `${what} is busy: ${held.command} (pid ${held.pid}) has been running since ${new Date(held.startedAt).toLocaleString()}`;
  }
  return null;
}

/**
 * Removes an abandoned lock file, one command at a time: only the command holding `<lock>.takeover` (created exclusively)
 * may remove it, after looking again. The lock file can only appear while it is absent, so the file removed is exactly
 * the abandoned one looked at, never a lock another command just took. False when another command is taking over.
 */
async function removeAbandoned(path: string, what: string, now: number): Promise<boolean> {
  const guard = `${path}.takeover`;
  try {
    await writeFile(guard, `${process.pid}\n`, { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // A takeover takes milliseconds: an old guard was left by a command killed during one.
    const st = await stat(guard).catch(() => null);
    if (st && Date.now() - st.mtimeMs > STARTING_GRACE_MS) await rm(guard, { force: true });
    return false;
  }
  try {
    const seen = await lookAt(path);
    if (seen && !liveHolder(seen, what, now)) await rm(path, { force: true });
  } finally {
    await rm(guard, { force: true });
  }
  return true;
}

/**
 * Takes the lock file in `dir` for `command`, so two commands never work in (and clean up) the same folder at once.
 * A lock whose process is gone (killed, Ctrl-C) is taken over; a live one refuses with BUSY naming `what` is busy.
 * The file is created exclusively (`wx`) and then written: a lock with no readable content yet is live for
 * STARTING_GRACE_MS, so a command that looks at it in between never mistakes it for an abandoned one.
 */
export async function acquireLock(dir: string, command: string, what: string): Promise<Lock> {
  const path = join(dir, LOCK_FILE);
  const now = Date.now();
  const mine: LockInfo = { pid: process.pid, command, startedAt: new Date(now).toISOString(), token: randomUUID() };
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await writeFile(path, JSON.stringify(mine) + '\n', { flag: 'wx' });
      return {
        startedAt: now,
        release: async () => {
          if ((await readLock(path))?.token === mine.token) await rm(path, { force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const seen = await lookAt(path);
    if (!seen) continue;
    const busy = liveHolder(seen, what, now);
    if (busy) throw new MirageError('BUSY', busy, busyHint(path));
    // Left by a command that was killed: take it over (or let the command already doing so finish).
    if (!(await removeAbandoned(path, what, now))) await new Promise((r) => setTimeout(r, 10));
  }
  throw new MirageError('BUSY', `${what} is busy: another Mirage command is starting in it`, busyHint(path));
}

/**
 * Removes leftovers of killed commands from a folder whose lock `lock` holds: names matching `ours` (only lock holders
 * create them) always, `*.tmp-<uuid>` files of atomic writes only when older than TMP_GRACE_MS before the lock was taken
 * (commands without a lock write those too). Best effort.
 */
export async function clearLeftovers(dir: string, lock: Lock, ours: (name: string) => boolean): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const tmp = /\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  await Promise.all(
    names.map(async (f) => {
      const p = join(dir, f);
      if (!ours(f)) {
        if (!tmp.test(f)) return;
        const st = await stat(p).catch(() => null);
        if (!st || st.mtimeMs > lock.startedAt - TMP_GRACE_MS) return;
      }
      await rm(p, { recursive: true, force: true }).catch(() => {});
    }),
  );
}
