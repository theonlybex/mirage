// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DELIVERY_LABEL } from './labels.js';
import { lockEpisode } from './render-episode.js';
import { listVersions, MAX_BACKUPS, MAX_CHECKPOINTS, restoreVersion, snapshotVersion } from './versions.js';

async function project(): Promise<{ dir: string; ep: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'mirage-versions-'));
  const ep = join(dir, 'episodes', '1');
  await mkdir(ep, { recursive: true });
  return { dir, ep };
}

describe('versions', () => {
  it('snapshots episode.json and summary.md and lists versions oldest first', async () => {
    const { dir, ep } = await project();
    await writeFile(join(ep, 'episode.json'), '{"a":1}\n');
    await writeFile(join(ep, 'summary.md'), '# Summary\n');
    const a = await snapshotVersion(dir, 1, { kind: 'before', label: 'Before edit', sessionId: 's1' });
    await writeFile(join(ep, 'episode.json'), '{"a":2}\n');
    const b = await snapshotVersion(dir, 1, { kind: 'checkpoint', label: 'Timeline written' });
    expect(a).toMatchObject({ version: 1, kind: 'before', label: 'Before edit', sessionId: 's1', delivery: null, render: null, hasEpisode: true, hasSummary: true });
    expect(a.id).toMatch(/^\d{8}-\d{6}-\d{3}-before-[0-9a-f]{4}$/);
    expect(b.sessionId).toBeNull();
    expect(await readFile(join(ep, 'versions', a.id, 'episode.json'), 'utf8')).toBe('{"a":1}\n');
    expect(await readFile(join(ep, 'versions', a.id, 'summary.md'), 'utf8')).toBe('# Summary\n');
    expect(await readFile(join(ep, 'versions', b.id, 'episode.json'), 'utf8')).toBe('{"a":2}\n');
    expect((await listVersions(dir, 1)).map((v) => v.id)).toEqual([a.id, b.id]);
    expect((await readdir(join(ep, 'versions'))).filter((f) => f.startsWith('.'))).toEqual([]);
    expect(existsSync(join(ep, '.mirage.lock'))).toBe(false);
  });

  it('numbers deliveries 1, 2, … and links the render as video.mp4', async () => {
    const { dir, ep } = await project();
    await writeFile(join(ep, 'episode.json'), '{}\n');
    await writeFile(join(ep, 'rough.mp4'), 'rough-one');
    const v1 = await snapshotVersion(dir, 1, { kind: 'delivery', label: DELIVERY_LABEL.rough, render: 'rough' });
    await writeFile(join(ep, 'rough.mp4.new'), 'rough-two');
    await rename(join(ep, 'rough.mp4.new'), join(ep, 'rough.mp4'));
    const v2 = await snapshotVersion(dir, 1, { kind: 'delivery', label: DELIVERY_LABEL.rough, render: 'rough' });
    expect([v1.delivery, v2.delivery]).toEqual([1, 2]);
    expect(v1.render).toEqual({ mode: 'rough', file: 'video.mp4', captions: null });
    expect(await readFile(join(ep, 'versions', v1.id, 'video.mp4'), 'utf8')).toBe('rough-one');
    expect(await readFile(join(ep, 'versions', v2.id, 'video.mp4'), 'utf8')).toBe('rough-two');
    await writeFile(join(ep, 'final.mp4'), 'final');
    await writeFile(join(ep, 'final.srt'), '1\n');
    const v3 = await snapshotVersion(dir, 1, { kind: 'delivery', label: DELIVERY_LABEL.final, render: 'final' });
    expect(v3.delivery).toBe(3);
    expect(v3.render).toEqual({ mode: 'final', file: 'video.mp4', captions: 'captions.srt' });
    expect(await readFile(join(ep, 'versions', v3.id, 'captions.srt'), 'utf8')).toBe('1\n');
    // The renderer rewrites final.srt in place: an earlier delivery's captions must not change.
    await writeFile(join(ep, 'final.srt'), '2\n');
    expect(await readFile(join(ep, 'versions', v3.id, 'captions.srt'), 'utf8')).toBe('1\n');
  });

  it('fails clearly when the render to deliver does not exist', async () => {
    const { dir } = await project();
    await expect(snapshotVersion(dir, 1, { kind: 'delivery', label: 'x', render: 'final' })).rejects.toMatchObject({
      code: 'BAD_INPUT',
      message: 'episodes/1/final.mp4 does not exist',
      hint: 'Render it first.',
    });
    expect(await listVersions(dir, 1)).toEqual([]);
    expect(await readdir(join(dir, 'episodes', '1', 'versions')).catch(() => [])).toEqual([]);
  });

  it('restores a version and keeps a backup of what was there', async () => {
    const { dir, ep } = await project();
    await writeFile(join(ep, 'episode.json'), 'old\n');
    await writeFile(join(ep, 'summary.md'), 'old summary\n');
    await writeFile(join(ep, 'rough.mp4'), 'render');
    const old = await snapshotVersion(dir, 1, { kind: 'checkpoint', label: 'Rough ready' });
    await writeFile(join(ep, 'episode.json'), 'new\n');
    await rm(join(ep, 'summary.md'));
    const { restored, backup } = await restoreVersion(dir, 1, old.id);
    expect(restored.id).toBe(old.id);
    expect(backup).toMatchObject({ kind: 'backup', label: 'Before going back to “Rough ready”', hasEpisode: true, hasSummary: false, sessionId: null });
    expect(backup.id).toMatch(/-backup-[0-9a-f]{4}$/);
    expect(await readFile(join(ep, 'episode.json'), 'utf8')).toBe('old\n');
    expect(await readFile(join(ep, 'summary.md'), 'utf8')).toBe('old summary\n');
    expect(await readFile(join(ep, 'rough.mp4'), 'utf8')).toBe('render');
    expect(await readFile(join(ep, 'versions', backup.id, 'episode.json'), 'utf8')).toBe('new\n');
    expect(existsSync(join(ep, 'versions', backup.id, 'summary.md'))).toBe(false);
    expect((await listVersions(dir, 1)).map((v) => v.id)).toEqual([old.id, backup.id]);
    expect((await readdir(ep)).filter((f) => f.includes('.tmp-'))).toEqual([]);
    // Going forward again restores the backup.
    await restoreVersion(dir, 1, backup.id);
    expect(await readFile(join(ep, 'episode.json'), 'utf8')).toBe('new\n');
    expect(existsSync(join(ep, 'summary.md'))).toBe(false);
  });

  it('rejects an unknown version id', async () => {
    const { dir, ep } = await project();
    await writeFile(join(ep, 'episode.json'), 'x');
    await expect(restoreVersion(dir, 1, 'nope')).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(restoreVersion(dir, 1, '../../x')).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(await listVersions(dir, 1)).toEqual([]);
  });

  it('restoring a version made before episode.json existed removes it', async () => {
    const { dir, ep } = await project();
    const empty = await snapshotVersion(dir, 1, { kind: 'before', label: 'Before the first edit' });
    expect(empty).toMatchObject({ hasEpisode: false, hasSummary: false });
    await writeFile(join(ep, 'episode.json'), '{"x":1}\n');
    await writeFile(join(ep, 'summary.md'), 'hi');
    const { backup } = await restoreVersion(dir, 1, empty.id);
    expect(existsSync(join(ep, 'episode.json'))).toBe(false);
    expect(existsSync(join(ep, 'summary.md'))).toBe(false);
    expect(await readFile(join(ep, 'versions', backup.id, 'episode.json'), 'utf8')).toBe('{"x":1}\n');
  });

  it('snapshots and restores an episode.json that does not parse', async () => {
    const { dir, ep } = await project();
    const broken = '{"version": 2, "items": [';
    await writeFile(join(ep, 'episode.json'), broken);
    const v = await snapshotVersion(dir, 1, { kind: 'before', label: 'Before edit' });
    expect(await readFile(join(ep, 'versions', v.id, 'episode.json'), 'utf8')).toBe(broken);
    await writeFile(join(ep, 'episode.json'), '{}\n');
    await restoreVersion(dir, 1, v.id);
    expect(await readFile(join(ep, 'episode.json'), 'utf8')).toBe(broken);
  });

  it('waits for a busy episode and then snapshots', async () => {
    const { dir, ep } = await project();
    await writeFile(join(ep, 'episode.json'), '{}\n');
    const lock = await lockEpisode(dir, 1, 'render');
    const started = Date.now();
    let done = false;
    const p = snapshotVersion(dir, 1, { kind: 'checkpoint', label: 'After render', waitMs: 5000 }).then((v) => {
      done = true;
      return v;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    await lock.release();
    const v = await p;
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(v.hasEpisode).toBe(true);
  });

  it('gives up with BUSY once waitMs has passed', async () => {
    const { dir, ep } = await project();
    await writeFile(join(ep, 'episode.json'), '{}\n');
    const lock = await lockEpisode(dir, 1, 'render');
    await expect(snapshotVersion(dir, 1, { kind: 'checkpoint', label: 'x', waitMs: 100 })).rejects.toMatchObject({ code: 'BUSY' });
    await lock.release();
  });

  it('keeps only the newest 50 checkpoints but every delivery and before-version', async () => {
    const { dir, ep } = await project();
    await writeFile(join(ep, 'episode.json'), '{}\n');
    await writeFile(join(ep, 'rough.mp4'), 'r');
    const before = await snapshotVersion(dir, 1, { kind: 'before', label: 'b' });
    const delivery = await snapshotVersion(dir, 1, { kind: 'delivery', label: 'd', render: 'rough' });
    const cps: string[] = [];
    for (let i = 0; i < MAX_CHECKPOINTS + 3; i++) cps.push((await snapshotVersion(dir, 1, { kind: 'checkpoint', label: `c${i}` })).id);
    const ids = (await listVersions(dir, 1)).map((v) => v.id);
    expect(ids).toHaveLength(2 + MAX_CHECKPOINTS);
    expect(ids).toContain(before.id);
    expect(ids).toContain(delivery.id);
    expect(ids).not.toContain(cps[0]);
    expect(ids).not.toContain(cps[2]);
    expect(ids).toContain(cps[3]);
    expect(ids).toContain(cps[cps.length - 1]);
    expect(await readdir(join(ep, 'versions'))).toHaveLength(2 + MAX_CHECKPOINTS);
  });

  it('saves a go-back\'s backup as a backup, never a checkpoint, and keeps only the newest 20 backups', async () => {
    const { dir, ep } = await project();
    await writeFile(join(ep, 'episode.json'), '{}\n');
    const cp = await snapshotVersion(dir, 1, { kind: 'checkpoint', label: 'Timeline checked' });
    const backups: string[] = [];
    for (let i = 0; i < MAX_BACKUPS + 2; i++) backups.push((await restoreVersion(dir, 1, cp.id)).backup.id);
    expect(MAX_BACKUPS).toBe(20);
    const all = await listVersions(dir, 1);
    expect(all.filter((v) => v.kind === 'checkpoint').map((v) => v.id)).toEqual([cp.id]);
    expect(all.filter((v) => v.kind === 'backup').map((v) => v.id)).toEqual(backups.slice(2));
  });

  it('can restore the oldest checkpoint even when that prunes it', async () => {
    const { dir, ep } = await project();
    await writeFile(join(ep, 'episode.json'), 'first\n');
    const first = await snapshotVersion(dir, 1, { kind: 'checkpoint', label: 'first' });
    await writeFile(join(ep, 'episode.json'), 'later\n');
    for (let i = 0; i < MAX_CHECKPOINTS - 1; i++) await snapshotVersion(dir, 1, { kind: 'checkpoint', label: `c${i}` });
    await restoreVersion(dir, 1, first.id);
    expect(await readFile(join(ep, 'episode.json'), 'utf8')).toBe('first\n');
    expect((await listVersions(dir, 1)).filter((v) => v.kind === 'checkpoint')).toHaveLength(MAX_CHECKPOINTS);
  });

  it('ignores a version folder with a broken meta.json', async () => {
    const { dir, ep } = await project();
    await writeFile(join(ep, 'episode.json'), '{}\n');
    const good = await snapshotVersion(dir, 1, { kind: 'before', label: 'ok' });
    await mkdir(join(ep, 'versions', '20200101-000000-000-before-abcd'));
    await writeFile(join(ep, 'versions', '20200101-000000-000-before-abcd', 'meta.json'), '{ nope');
    await mkdir(join(ep, 'versions', '20200102-000000-000-before-abcd'));
    await mkdir(join(ep, 'versions', '20200103-000000-000-before-abcd'));
    await writeFile(join(ep, 'versions', '20200103-000000-000-before-abcd', 'meta.json'), '{"version":1}');
    expect((await listVersions(dir, 1)).map((v) => v.id)).toEqual([good.id]);
    expect((await stat(join(ep, 'versions'))).isDirectory()).toBe(true);
  });

  it('lists nothing for an episode with no versions', async () => {
    const { dir } = await project();
    expect(await listVersions(dir, 1)).toEqual([]);
  });
});
