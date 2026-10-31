import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MirageError } from './errors.js';

export const LOCK_FILE = '.mirage.lock';
/** A lock older than this is stale even if its pid is alive again (the pid was reused, e.g. after a restart). */
const MAX_LOCK_AGE_MS = 24 * 3600_000;
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

async function readLock(path: string): Promise<LockInfo | null> {
  try {
    const info = JSON.parse(await readFile(path, 'utf8')) as Partial<LockInfo>;
    return typeof info.pid === 'number' && typeof info.startedAt === 'string' ? (info as LockInfo) : null;
  } catch {
    return null;
  }
}

/**
 * Takes the lock file in `dir` for `command`, so two commands never work in (and clean up) the same folder at once.
 * A lock whose process is gone (killed, Ctrl-C) is taken over; a live one refuses with BUSY naming `what` is busy.
 */
export async function acquireLock(dir: string, command: string, what: string): Promise<Lock> {
  const path = join(dir, LOCK_FILE);
  const now = Date.now();
  const mine: LockInfo = { pid: process.pid, command, startedAt: new Date(now).toISOString(), token: randomUUID() };
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(path, JSON.stringify(mine) + '\n', { flag: 'wx' });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 3) throw e;
    }
    const held = await readLock(path);
    if (held && alive(held.pid) && now - Date.parse(held.startedAt) < MAX_LOCK_AGE_MS) {
      const since = new Date(held.startedAt).toLocaleTimeString();
      throw new MirageError('BUSY', `${what} is busy: ${held.command} (pid ${held.pid}) has been running since ${since}`, 'Wait for it to finish, or stop it, then run this again.');
    }
    // Left by a command that was killed: take it over.
    await rm(path, { force: true });
  }
  return {
    startedAt: now,
    release: async () => {
      if ((await readLock(path))?.token === mine.token) await rm(path, { force: true });
    },
  };
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
