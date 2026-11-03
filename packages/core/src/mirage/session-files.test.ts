// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendLog, appendStep, clearProgress, readControl, readLog, readProgress, readSessionState, readSteps, sessionDir, takeCorrection, writeControl,
  writeProgress, writeSessionState,
} from './session-files.js';

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mirage-session-'));
  await mkdir(join(dir, 'episodes', '1'), { recursive: true });
  return dir;
}

describe('session folder files', () => {
  it('puts a session at episodes/<n>/sessions/<id>', async () => {
    const dir = await project();
    expect(sessionDir(dir, 1, 's1')).toBe(join(dir, 'episodes', '1', 'sessions', 's1'));
  });

  it('refuses a session id that would leave the folder', async () => {
    const dir = await project();
    expect(() => sessionDir(dir, 1, '../x')).toThrow(/session id/);
    await expect(readSessionState(dir, 'a/b')).rejects.toThrow(/session id/);
  });

  it('appends step lines and skips bad ones when reading', async () => {
    const dir = sessionDir(await project(), 1, 's1');
    await appendStep(dir, { at: '2026-11-02T10:00:00.000Z', id: 'tu1', tool: 'Bash', label: 'Checking the timeline', status: 'running' });
    await appendStep(dir, { at: '2026-11-02T10:00:01.000Z', id: 'tu1', tool: 'Bash', label: 'Checking the timeline', status: 'done', detail: 'ok' });
    await appendStep(dir, { at: '2026-11-02T10:00:02.000Z', type: 'turn-end' });
    await writeFile(join(dir, 'steps.jsonl'), (await readFile(join(dir, 'steps.jsonl'), 'utf8')) + 'not json\n{"at":"x","id":1}\n');
    const steps = await readSteps(dir);
    expect(steps).toHaveLength(3);
    expect(steps[1]).toMatchObject({ id: 'tu1', status: 'done', detail: 'ok' });
    expect(steps[2]).toEqual({ at: '2026-11-02T10:00:02.000Z', type: 'turn-end' });
  });

  it('reads nothing from a session that has no files', async () => {
    const dir = sessionDir(await project(), 1, 'none');
    expect(await readSteps(dir)).toEqual([]);
    expect(await readLog(dir)).toEqual([]);
    expect(await readProgress(dir)).toBeNull();
  });

  it('writes, reads and clears progress', async () => {
    const dir = sessionDir(await project(), 1, 's1');
    const p = { command: 'render', fraction: 0.4, startedAt: '2026-11-02T10:00:00.000Z', updatedAt: '2026-11-02T10:00:05.000Z' };
    await writeProgress(dir, p);
    expect(await readProgress(dir)).toEqual(p);
    expect((await readdir(dir)).filter((f) => f.includes('.tmp-'))).toEqual([]);
    await clearProgress(dir);
    expect(await readProgress(dir)).toBeNull();
    await clearProgress(dir);
  });

  it('treats a broken progress file as no progress', async () => {
    const dir = sessionDir(await project(), 1, 's1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'progress.json'), '{"command":');
    expect(await readProgress(dir)).toBeNull();
  });

  it('appends log entries and skips bad lines', async () => {
    const dir = sessionDir(await project(), 1, 's1');
    await appendLog(dir, { at: '2026-11-02T10:00:00.000Z', kind: 'guess', text: 'Assumed the intro is the first clip.' });
    await appendLog(dir, { at: '2026-11-02T10:00:01.000Z', kind: 'note-status', text: 'Trimmed.', noteId: 'n1', status: 'done' });
    await writeFile(join(dir, 'log.jsonl'), (await readFile(join(dir, 'log.jsonl'), 'utf8')) + '{oops\n');
    expect((await readLog(dir)).map((e) => e.kind)).toEqual(['guess', 'note-status']);
  });
});

describe('control', () => {
  it('is all off when there is no file', async () => {
    const dir = await project();
    expect(await readControl(dir, 1)).toMatchObject({ version: 1, paused: false, pauseNow: false, stop: null, correction: null });
  });

  it('is all off when the file is broken', async () => {
    const dir = await project();
    await writeFile(join(dir, 'episodes', '1', 'control.json'), '{"paused": tru');
    expect(await readControl(dir, 1)).toMatchObject({ paused: false, pauseNow: false, stop: null, correction: null });
    await writeFile(join(dir, 'episodes', '1', 'control.json'), '{"version":1,"paused":"yes"}');
    expect((await readControl(dir, 1)).paused).toBe(false);
  });

  it('merges a patch, sets updatedAt and writes it atomically', async () => {
    const dir = await project();
    const a = await writeControl(dir, 1, { paused: true });
    expect(a.paused).toBe(true);
    expect(Date.parse(a.updatedAt)).toBeGreaterThan(0);
    const b = await writeControl(dir, 1, { correction: 'Make the intro shorter.' });
    expect(b).toMatchObject({ paused: true, correction: 'Make the intro shorter.' });
    expect(await readControl(dir, 1)).toEqual(b);
    expect((await readdir(join(dir, 'episodes', '1'))).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('keeps each video its own control', async () => {
    const dir = await project();
    await writeControl(dir, 1, { paused: true });
    expect((await readControl(dir, 2)).paused).toBe(false);
  });

  it('takeCorrection returns the text once and clears it, keeping the rest', async () => {
    const dir = await project();
    await writeControl(dir, 1, { paused: true, correction: 'Cut the ums.' });
    expect(await takeCorrection(dir, 1)).toBe('Cut the ums.');
    expect(await takeCorrection(dir, 1)).toBeNull();
    expect(await readControl(dir, 1)).toMatchObject({ paused: true, correction: null });
    expect((await readdir(join(dir, 'episodes', '1'))).filter((f) => f.includes('.take-') || f.includes('.tmp-'))).toEqual([]);
  });

  it('takeCorrection gives null when there is no control file, and does not create one', async () => {
    const dir = await project();
    expect(await takeCorrection(dir, 1)).toBeNull();
    expect(existsSync(join(dir, 'episodes', '1', 'control.json'))).toBe(false);
  });

  it('two takeCorrection calls at once: exactly one gets the text', async () => {
    for (let round = 0; round < 20; round++) {
      const dir = await project();
      await writeControl(dir, 1, { stop: { at: '2026-11-02T10:00:00.000Z' }, correction: 'Use the second take.' });
      const got = await Promise.all([takeCorrection(dir, 1), takeCorrection(dir, 1), takeCorrection(dir, 1)]);
      expect(got.filter((g) => g !== null)).toEqual(['Use the second take.']);
      expect(await readControl(dir, 1)).toMatchObject({ stop: { at: '2026-11-02T10:00:00.000Z' }, correction: null });
      expect((await readdir(join(dir, 'episodes', '1'))).filter((f) => f.includes('.take-'))).toEqual([]);
    }
  });

  it('while a correction is being taken, the control still reads as it will be afterwards', async () => {
    const dir = await project();
    await writeControl(dir, 1, { paused: true, correction: 'x' });
    // A process that died mid-take leaves the claimed file behind.
    const { rename } = await import('node:fs/promises');
    await rename(join(dir, 'episodes', '1', 'control.json'), join(dir, 'episodes', '1', 'control.json.take-dead'));
    expect(await readControl(dir, 1)).toMatchObject({ paused: true, correction: null });
  });
});

describe('session state', () => {
  it('is empty when there is no file, and merges patches', async () => {
    const dir = await project();
    expect(await readSessionState(dir, 's1')).toEqual({ video: null, overnight: null, awakePid: null });
    expect(await writeSessionState(dir, 's1', { video: 2 })).toEqual({ video: 2, overnight: null, awakePid: null });
    const s = await writeSessionState(dir, 's1', { overnight: { videos: [2, 3], startedAt: '2026-11-02T22:00:00.000Z' }, awakePid: 4242 });
    expect(s).toEqual({ video: 2, overnight: { videos: [2, 3], startedAt: '2026-11-02T22:00:00.000Z' }, awakePid: 4242 });
    expect(await readSessionState(dir, 's1')).toEqual(s);
    expect(existsSync(join(dir, '.mirage', 'sessions', 's1.json'))).toBe(true);
    expect(await readSessionState(dir, 's2')).toEqual({ video: null, overnight: null, awakePid: null });
  });
});
