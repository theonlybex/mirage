// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NOTE_STILL, NoteSchema, NotesFileSchema, type LogEntry, type Note } from '@wordedits/shared';
import type { MediaTools } from '../media-tools.js';
import { MirageError } from './errors.js';
import { readJsonFile, writeJsonFile } from './json-file.js';
import { episodeDir } from './render-episode.js';
import { readLog } from './session-files.js';

const notesPath = (project: string, n: number) => join(episodeDir(project, n), 'notes.json');

/** The video's notes in the order they were added. */
export async function readNotes(project: string, n: number): Promise<Note[]> {
  try {
    return (await readJsonFile(notesPath(project, n), NotesFileSchema, `episodes/${n}/notes.json`)).notes;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

const saveNotes = (project: string, n: number, notes: Note[]) => writeJsonFile(notesPath(project, n), NotesFileSchema, { version: 1, notes }, `episodes/${n}/notes.json`);

const sentError = () => new MirageError('BAD_INPUT', 'This note was already sent.', 'Add a new note instead.');

function find(notes: Note[], id: string): Note {
  const note = notes.find((x) => x.id === id);
  if (!note) throw new MirageError('BAD_INPUT', `There is no note ${id}.`, 'Check the note id.');
  if (note.round !== null) throw sentError();
  return note;
}

/**
 * Adds a note at time `t` of the version at `videoPath`: grabs the frame there as episodes/<n>/notes/<id>.jpg and saves
 * the note as unsent. Nothing is saved when the note is invalid or the frame cannot be grabbed.
 */
export async function addNote(
  project: string,
  n: number,
  o: { versionId: string; videoPath: string; t: number; text: string; box: Note['box']; tools: MediaTools },
): Promise<Note> {
  const notes = await readNotes(project, n);
  const id = `n${notes.reduce((m, x) => Math.max(m, Number(x.id.slice(1))), 0) + 1}`;
  const note = NoteSchema.parse({ id, versionId: o.versionId, t: o.t, text: o.text, box: o.box, still: `notes/${id}.jpg`, createdAt: new Date().toISOString(), round: null });
  const out = join(episodeDir(project, n), note.still);
  await mkdir(join(episodeDir(project, n), 'notes'), { recursive: true });
  try {
    await o.tools.runFfmpeg(['-ss', o.t.toFixed(3), '-i', o.videoPath, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', out]);
  } catch (e) {
    await rm(out, { force: true });
    throw e;
  }
  await saveNotes(project, n, [...notes, note]);
  return note;
}

/** Changes the text and/or box of an unsent note. */
export async function updateNote(project: string, n: number, id: string, patch: { text?: string; box?: Note['box'] }): Promise<Note> {
  const notes = await readNotes(project, n);
  const old = find(notes, id);
  const next = NoteSchema.parse({ ...old, ...(patch.text !== undefined && { text: patch.text }), ...(patch.box !== undefined && { box: patch.box }) });
  await saveNotes(project, n, notes.map((x) => (x.id === id ? next : x)));
  return next;
}

/** Deletes an unsent note and its still. */
export async function deleteNote(project: string, n: number, id: string): Promise<void> {
  const notes = await readNotes(project, n);
  const note = find(notes, id);
  // The schema already holds stills to notes/n<k>.jpg; checked again here because this removes a file.
  if (!NOTE_STILL.test(note.still)) throw new MirageError('BAD_INPUT', `Note ${id} has a still outside notes/.`, 'Check notes.json.');
  await saveNotes(project, n, notes.filter((x) => x.id !== id));
  await rm(join(episodeDir(project, n), note.still), { force: true });
}

/** Hands the unsent notes to Claude as the next round (max round + 1). Returns them; nothing changes when there are none. */
export async function sendNotes(project: string, n: number): Promise<Note[]> {
  const notes = await readNotes(project, n);
  const unsent = notes.filter((x) => x.round === null);
  if (!unsent.length) return [];
  const round = notes.reduce((m, x) => Math.max(m, x.round ?? 0), 0) + 1;
  const next = notes.map((x) => (x.round === null ? { ...x, round } : x));
  await saveNotes(project, n, next);
  return next.filter((x) => unsent.some((u) => u.id === x.id));
}

/** What Claude did with a note: done, done differently or could not, with its reason. */
export type NoteStatus = { status: NonNullable<LogEntry['status']>; reason?: string };

/** What Claude did with each note, from the session logs of the video: the newest `note-status` entry of a note wins. */
export async function noteStatuses(project: string, n: number): Promise<Record<string, NoteStatus>> {
  const sessions = join(episodeDir(project, n), 'sessions');
  // Session folders only: a stray file (.DS_Store) in sessions/ is not a session.
  const entries = await readdir(sessions, { withFileTypes: true }).catch(() => []);
  const names = entries.filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const newest = new Map<string, NoteStatus & { at: number }>();
  for (const name of names) {
    for (const e of await readLog(join(sessions, name))) {
      if (e.kind !== 'note-status' || !e.noteId || !e.status) continue;
      const at = Date.parse(e.at);
      const prev = newest.get(e.noteId);
      if (prev && prev.at > at) continue;
      newest.set(e.noteId, { at, status: e.status, ...(e.text ? { reason: e.text } : {}) });
    }
  }
  return Object.fromEntries([...newest].map(([id, { at: _at, ...status }]) => [id, status]));
}
