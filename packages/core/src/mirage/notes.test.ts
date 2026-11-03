// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NoteSchema } from '@wordedits/shared';
import type { MediaTools } from '../media-tools.js';
import { addNote, deleteNote, noteStatuses, readNotes, sendNotes, updateNote } from './notes.js';
import { appendLog, sessionDir } from './session-files.js';

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mirage-notes-'));
  await mkdir(join(dir, 'episodes', '1'), { recursive: true });
  return dir;
}
function stubTools(calls: string[][] = [], fail = false): MediaTools {
  return {
    runFfmpeg: async (args: string[]) => {
      calls.push(args);
      if (fail) throw new Error('ffmpeg failed');
      await writeFile(args[args.length - 1], 'jpg');
    },
  } as unknown as MediaTools;
}
const add = (dir: string, tools: MediaTools, o: { t?: number; text?: string; box?: { x: number; y: number; w: number; h: number } | null } = {}) =>
  addNote(dir, 1, { versionId: 'v1', videoPath: '/v/final.mp4', t: o.t ?? 1.5, text: o.text ?? 'Too fast here.', box: o.box ?? null, tools });

describe('notes', () => {
  it('numbers notes n1, n2 and grabs a still for each', async () => {
    const dir = await project();
    const calls: string[][] = [];
    const tools = stubTools(calls);
    const a = await add(dir, tools, { t: 1.23456 });
    const b = await add(dir, tools, { box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } });
    expect([a.id, b.id]).toEqual(['n1', 'n2']);
    expect(a).toMatchObject({ versionId: 'v1', t: 1.23456, text: 'Too fast here.', box: null, still: 'notes/n1.jpg', round: null });
    expect(b.box).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    expect(calls[0]).toEqual(['-ss', '1.235', '-i', '/v/final.mp4', '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', join(dir, 'episodes', '1', 'notes', 'n1.jpg')]);
    expect(existsSync(join(dir, 'episodes', '1', 'notes', 'n2.jpg'))).toBe(true);
    expect((await readNotes(dir, 1)).map((n) => n.id)).toEqual(['n1', 'n2']);
  });

  it('reads no notes from a video without notes.json', async () => {
    expect(await readNotes(await project(), 1)).toEqual([]);
  });

  it('numbers after the highest id, so a deleted last note is reused but the others never clash', async () => {
    const dir = await project();
    const tools = stubTools();
    await add(dir, tools);
    await add(dir, tools);
    await add(dir, tools);
    await deleteNote(dir, 1, 'n2');
    expect((await add(dir, tools)).id).toBe('n4');
  });

  it('a still is notes/n<k>.jpg and nothing else: deleteNote refuses a notes.json pointing anywhere else, and removes nothing', async () => {
    const dir = await project();
    const note = { id: 'n1', versionId: 'v1', t: 1, text: 'x', box: null, still: 'notes/n1.jpg', createdAt: new Date().toISOString(), round: null };
    expect(NoteSchema.safeParse(note).success).toBe(true);
    for (const still of ['../../mirage.json', 'notes/../video.json', '/etc/hosts', 'notes/n1.png', 'notes/n0.jpg', 'notes/n1.jpg/x', 'video.json']) {
      expect(NoteSchema.safeParse({ ...note, still }).success, still).toBe(false);
    }
    await writeFile(join(dir, 'mirage.json'), '{"keep":true}');
    await writeFile(join(dir, 'episodes', '1', 'notes.json'), JSON.stringify({ version: 1, notes: [{ ...note, still: '../../mirage.json' }] }));
    await expect(deleteNote(dir, 1, 'n1')).rejects.toThrow();
    expect(await readFile(join(dir, 'mirage.json'), 'utf8')).toBe('{"keep":true}');
  });

  it('saves nothing when the still cannot be grabbed or the note is invalid', async () => {
    const dir = await project();
    await expect(add(dir, stubTools([], true))).rejects.toThrow('ffmpeg failed');
    await expect(add(dir, stubTools(), { text: '' })).rejects.toThrow();
    await expect(add(dir, stubTools(), { box: { x: 2, y: 0, w: 0.1, h: 0.1 } })).rejects.toThrow();
    expect(await readNotes(dir, 1)).toEqual([]);
    expect((await add(dir, stubTools())).id).toBe('n1');
  });

  it('sendNotes marks the unsent notes as round 1, then round 2 for later ones', async () => {
    const dir = await project();
    const tools = stubTools();
    await add(dir, tools);
    await add(dir, tools);
    const sent = await sendNotes(dir, 1);
    expect(sent.map((n) => [n.id, n.round])).toEqual([['n1', 1], ['n2', 1]]);
    await add(dir, tools);
    expect((await sendNotes(dir, 1)).map((n) => [n.id, n.round])).toEqual([['n3', 2]]);
    expect((await readNotes(dir, 1)).map((n) => n.round)).toEqual([1, 1, 2]);
    expect(await sendNotes(dir, 1)).toEqual([]);
    expect((await readNotes(dir, 1)).map((n) => n.round)).toEqual([1, 1, 2]);
  });

  it('updates an unsent note', async () => {
    const dir = await project();
    await add(dir, stubTools());
    const n = await updateNote(dir, 1, 'n1', { text: 'Slower.', box: { x: 0, y: 0, w: 1, h: 1 } });
    expect(n).toMatchObject({ id: 'n1', text: 'Slower.', box: { x: 0, y: 0, w: 1, h: 1 } });
    expect((await readNotes(dir, 1))[0].text).toBe('Slower.');
    expect((await updateNote(dir, 1, 'n1', { box: null })).box).toBeNull();
  });

  it('refuses to edit or delete a sent note', async () => {
    const dir = await project();
    await add(dir, stubTools());
    await sendNotes(dir, 1);
    const sentError = { code: 'BAD_INPUT', message: 'This note was already sent.', hint: 'Add a new note instead.' };
    await expect(updateNote(dir, 1, 'n1', { text: 'x' })).rejects.toMatchObject(sentError);
    await expect(deleteNote(dir, 1, 'n1')).rejects.toMatchObject(sentError);
    expect(await readNotes(dir, 1)).toHaveLength(1);
  });

  it('says plainly when the note is not there', async () => {
    const dir = await project();
    await expect(updateNote(dir, 1, 'n7', { text: 'x' })).rejects.toMatchObject({ code: 'BAD_INPUT', message: 'There is no note n7.' });
    await expect(deleteNote(dir, 1, 'n7')).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('deleting a note removes its still', async () => {
    const dir = await project();
    await add(dir, stubTools());
    await deleteNote(dir, 1, 'n1');
    expect(await readNotes(dir, 1)).toEqual([]);
    expect(existsSync(join(dir, 'episodes', '1', 'notes', 'n1.jpg'))).toBe(false);
  });
});

describe('noteStatuses', () => {
  it('the newest note-status across every session wins', async () => {
    const dir = await project();
    const s1 = sessionDir(dir, 1, 's1');
    const s2 = sessionDir(dir, 1, 's2');
    await appendLog(s1, { at: '2026-11-02T10:00:00.000Z', kind: 'note-status', noteId: 'n1', status: 'could-not', text: 'No footage for that.' });
    await appendLog(s1, { at: '2026-11-02T10:00:01.000Z', kind: 'note-status', noteId: 'n2', status: 'done', text: '' });
    await appendLog(s1, { at: '2026-11-02T10:00:02.000Z', kind: 'guess', text: 'unrelated' });
    await appendLog(s2, { at: '2026-11-02T11:00:00.000Z', kind: 'note-status', noteId: 'n1', status: 'done-differently', text: 'Cut it instead of slowing it.' });
    await appendLog(s2, { at: '2026-11-02T09:00:00.000Z', kind: 'note-status', noteId: 'n2', status: 'could-not', text: 'older' });
    expect(await noteStatuses(dir, 1)).toEqual({
      n1: { status: 'done-differently', reason: 'Cut it instead of slowing it.' },
      n2: { status: 'done' },
    });
  });

  it('ignores stray files in the sessions folder', async () => {
    const dir = await project();
    await appendLog(sessionDir(dir, 1, 's1'), { at: '2026-11-02T10:00:00.000Z', kind: 'note-status', noteId: 'n1', status: 'done', text: '' });
    await appendLog(sessionDir(dir, 1, 's2'), { at: '2026-11-02T11:00:00.000Z', kind: 'note-status', noteId: 'n2', status: 'could-not', text: 'No footage.' });
    await writeFile(join(dir, 'episodes', '1', 'sessions', '.DS_Store'), 'junk');
    expect(await noteStatuses(dir, 1)).toEqual({ n1: { status: 'done' }, n2: { status: 'could-not', reason: 'No footage.' } });
  });

  it('is empty without sessions', async () => {
    expect(await noteStatuses(await project(), 1)).toEqual({});
  });
});
