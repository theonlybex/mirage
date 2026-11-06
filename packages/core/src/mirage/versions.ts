// SPDX-License-Identifier: MIT
import { randomBytes, randomUUID } from 'node:crypto';
import { access, copyFile, link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VersionMetaSchema, type VersionKind, type VersionMeta } from '@wordedits/shared';
import { MirageError } from './errors.js';
import { readJsonFile, writeJsonFile } from './json-file.js';
import { episodeDir, lockEpisode, type EpisodeMode } from './render-episode.js';

/** Checkpoints kept per episode; older ones are deleted. Before-versions and deliveries are kept forever. */
export const MAX_CHECKPOINTS = 50;
/** Backups (what was there before a go-back) kept per episode; older ones are deleted. */
export const MAX_BACKUPS = 20;

const DEFAULT_WAIT_MS = 30_000;
const RETRY_MS = 250;
/** Saved: the two files an edit changes. Renders, the catalog, notes and footage are never copied or touched. */
const STATE_FILES = ['episode.json', 'summary.md'] as const;
const ID_PATTERN = /^\d{8}-\d{6}-\d{3}-(before|checkpoint|delivery|backup)-[0-9a-f]{4}$/;

const versionsDir = (project: string, n: number) => join(episodeDir(project, n), 'versions');

/** A file's raw bytes, or null when it is not there. */
async function readBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Writes bytes so a reader sees the old file or the new one, never half of it (temp file, then rename). */
async function writeBytesAtomic(path: string, bytes: Buffer): Promise<void> {
  const tmpPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, bytes);
  await rename(tmpPath, path);
}

/** Hard-links `from` as `to` (the version keeps the render's bytes even after the render is replaced); copies where linking is not possible. */
async function linkOrCopy(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP') throw e;
    await copyFile(from, to);
  }
}

const pad = (v: number, w: number) => String(v).padStart(w, '0');

function newId(kind: VersionKind, at: Date): string {
  const d = `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1, 2)}${pad(at.getUTCDate(), 2)}`;
  const t = `${pad(at.getUTCHours(), 2)}${pad(at.getUTCMinutes(), 2)}${pad(at.getUTCSeconds(), 2)}`;
  return `${d}-${t}-${pad(at.getUTCMilliseconds(), 3)}-${kind}-${randomBytes(2).toString('hex')}`;
}

/** Runs `fn` holding episode `n`'s lock; while another command holds it, tries again every 250 ms for up to `waitMs`. */
async function withEpisodeLock<T>(project: string, n: number, waitMs: number | undefined, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + (waitMs ?? DEFAULT_WAIT_MS);
  for (;;) {
    try {
      const lock = await lockEpisode(project, n, 'versions');
      try {
        return await fn();
      } finally {
        await lock.release();
      }
    } catch (e) {
      if (!(e instanceof MirageError) || e.code !== 'BUSY' || Date.now() >= deadline) throw e;
    }
    await new Promise((r) => setTimeout(r, Math.min(RETRY_MS, Math.max(0, deadline - Date.now()))));
  }
}

async function listLocked(project: string, n: number): Promise<VersionMeta[]> {
  const root = versionsDir(project, n);
  const names = await readdir(root).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return [] as string[];
    throw e;
  });
  const metas: VersionMeta[] = [];
  for (const name of names.filter((f) => ID_PATTERN.test(f)).sort()) {
    try {
      const meta = await readJsonFile(join(root, name, 'meta.json'), VersionMetaSchema);
      if (meta.id === name) metas.push(meta);
    } catch {
      // A folder without a readable meta.json is not a version.
    }
  }
  return metas;
}

async function snapshotLocked(
  project: string,
  n: number,
  o: { kind: VersionKind; label: string; sessionId?: string; render?: EpisodeMode },
): Promise<VersionMeta> {
  const dir = episodeDir(project, n);
  const root = versionsDir(project, n);
  if (o.render && !(await access(join(dir, `${o.render}.mp4`)).then(() => true, () => false))) {
    throw new MirageError('BAD_INPUT', `episodes/${n}/${o.render}.mp4 does not exist`, 'Render it first.');
  }
  await mkdir(root, { recursive: true });
  // Folders of snapshots a killed command left half-made (we hold the lock, so none is in progress).
  for (const f of await readdir(root)) if (f.startsWith('.tmp-')) await rm(join(root, f), { recursive: true, force: true }).catch(() => {});
  const existing = await listLocked(project, n);
  const now = new Date();
  const id = newId(o.kind, now);
  const tmp = join(root, `.tmp-${randomUUID()}`);
  await mkdir(tmp);
  try {
    const [episode, summary] = await Promise.all(STATE_FILES.map((f) => readBytes(join(dir, f))));
    if (episode) await writeFile(join(tmp, 'episode.json'), episode);
    if (summary) await writeFile(join(tmp, 'summary.md'), summary);
    let render: VersionMeta['render'] = null;
    if (o.render) {
      // Hard link: safe only because renders are replaced by rename (a new inode), never rewritten in place.
      await linkOrCopy(join(dir, `${o.render}.mp4`), join(tmp, 'video.mp4'));
      let captions: 'captions.srt' | null = null;
      if (o.render === 'final' && (await readBytes(join(dir, 'final.srt'))) !== null) {
        // Copied, not linked: the renderer rewrites final.srt in place, which would change this version's captions.
        await copyFile(join(dir, 'final.srt'), join(tmp, 'captions.srt'));
        captions = 'captions.srt';
      }
      render = { mode: o.render, file: 'video.mp4', captions };
    }
    const delivery = o.kind === 'delivery' ? Math.max(0, ...existing.map((v) => v.delivery ?? 0)) + 1 : null;
    const meta: VersionMeta = {
      version: 1,
      id,
      kind: o.kind,
      label: o.label,
      createdAt: now.toISOString(),
      sessionId: o.sessionId ?? null,
      delivery,
      render,
      hasEpisode: episode !== null,
      hasSummary: summary !== null,
    };
    await writeJsonFile(join(tmp, 'meta.json'), VersionMetaSchema, meta, `episodes/${n}/versions/${id}/meta.json`);
    await rename(tmp, join(root, id));
    if (o.kind === 'checkpoint') await prune(project, n, 'checkpoint', MAX_CHECKPOINTS);
    if (o.kind === 'backup') await prune(project, n, 'backup', MAX_BACKUPS);
    return meta;
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/** Deletes all but the newest `keep` versions of `kind`. */
async function prune(project: string, n: number, kind: VersionKind, keep: number): Promise<void> {
  const ofKind = (await listLocked(project, n)).filter((v) => v.kind === kind);
  for (const old of ofKind.slice(0, Math.max(0, ofKind.length - keep))) {
    await rm(join(versionsDir(project, n), old.id), { recursive: true, force: true });
  }
}

/**
 * Saves episode `n`'s episode.json and summary.md (raw bytes, never parsed, so a file that does not parse is saved too) as a
 * new version. With `render`, that render's video (and a final's captions) are linked into the version too. Waits up to
 * `waitMs` (default 30 s) for a command that holds the episode.
 */
export async function snapshotVersion(
  project: string,
  n: number,
  o: { kind: VersionKind; label: string; sessionId?: string; render?: EpisodeMode; waitMs?: number },
): Promise<VersionMeta> {
  return withEpisodeLock(project, n, o.waitMs, () => snapshotLocked(project, n, o));
}

/** Episode `n`'s saved versions, oldest first. Folders without a valid meta.json are skipped. */
export async function listVersions(project: string, n: number): Promise<VersionMeta[]> {
  return listLocked(project, n);
}

/**
 * Puts a saved version's episode.json and summary.md back (a file the version did not have is removed). What is there now
 * is saved first, as a backup, so going back can itself be undone. Renders, the catalog, notes, footage and other versions are not touched.
 */
export async function restoreVersion(
  project: string,
  n: number,
  id: string,
  o: { waitMs?: number } = {},
): Promise<{ restored: VersionMeta; backup: VersionMeta }> {
  return withEpisodeLock(project, n, o.waitMs, async () => {
    const restored = (await listLocked(project, n)).find((v) => v.id === id);
    if (!restored) throw new MirageError('BAD_INPUT', `episodes/${n} has no saved version "${id}"`, 'List the versions and pick one of those.');
    const from = join(versionsDir(project, n), id);
    // Read before saving the backup: that save can delete this very version when it is the oldest checkpoint.
    const bytes = await Promise.all(STATE_FILES.map((f) => readBytes(join(from, f))));
    const backup = await snapshotLocked(project, n, { kind: 'backup', label: `Before going back to “${restored.label}”` });
    const dir = episodeDir(project, n);
    for (const [i, f] of STATE_FILES.entries()) {
      const b = bytes[i];
      if (b) await writeBytesAtomic(join(dir, f), b);
      else await rm(join(dir, f), { force: true });
    }
    return { restored, backup };
  });
}
