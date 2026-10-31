import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock, clearLeftovers, LOCK_FILE } from './lock.js';

/** Above any pid macOS or Linux hands out by default. */
const DEAD_PID = 4_194_305;

describe('acquireLock', () => {
  it('refuses while a live process holds the lock, and frees it on release', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-lock-'));
    const a = await acquireLock(dir, 'render', 'episode 1');
    await expect(acquireLock(dir, 'cut', 'episode 1')).rejects.toMatchObject({ code: 'BUSY', message: expect.stringMatching(new RegExp(`^episode 1 is busy: render \\(pid ${process.pid}\\) has been running since `)) });
    await a.release();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    await (await acquireLock(dir, 'cut', 'episode 1')).release();
  });

  it('takes over a lock left by a process that is gone, or one that is unreadable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-lock-'));
    await writeFile(join(dir, LOCK_FILE), JSON.stringify({ pid: DEAD_PID, command: 'render', startedAt: new Date().toISOString(), token: 'x' }));
    const a = await acquireLock(dir, 'render', 'episode 1');
    await a.release();
    await writeFile(join(dir, LOCK_FILE), 'garbage');
    await (await acquireLock(dir, 'render', 'episode 1')).release();
  });

  it('never releases a lock someone else took over', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-lock-'));
    const a = await acquireLock(dir, 'render', 'episode 1');
    await writeFile(join(dir, LOCK_FILE), JSON.stringify({ pid: process.pid, command: 'vo', startedAt: new Date().toISOString(), token: 'other' }));
    await a.release();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
  });
});

describe('clearLeftovers', () => {
  it("removes the lock holders' own leftovers, and atomic-write temp files only once they are old", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-lock-'));
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    await mkdir(join(dir, '.work-x'));
    for (const f of ['.vo-x.wav', `episode.json.tmp-${uuid}`, `old.json.tmp-${uuid}`, 'episode.json', 'notes.tmp-keep']) await writeFile(join(dir, f), 'x');
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(join(dir, `old.json.tmp-${uuid}`), old, old);
    const lock = await acquireLock(dir, 'render', 'episode 1');
    await clearLeftovers(dir, lock, (f) => f.startsWith('.work-') || f.startsWith('.vo-'));
    expect((await readdir(dir)).sort()).toEqual([LOCK_FILE, 'episode.json', `episode.json.tmp-${uuid}`, 'notes.tmp-keep']);
    await lock.release();
  });
});
