// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { strictObject } from './strict.js';

const unit = z.number().min(0).max(1);

/** Where a note's still may be, relative to the episode folder. */
export const NOTE_STILL = /^notes\/n[1-9]\d*\.jpg$/;

/** A note the user pinned to a moment (and maybe a box) of a version of a video. */
export const NoteSchema = strictObject({
  /** n1, n2, … */
  id: z.string().regex(/^n[1-9]\d*$/),
  versionId: z.string(),
  /** Seconds into that version. */
  t: z.number().min(0),
  text: z.string().min(1).max(2000),
  box: strictObject({ x: unit, y: unit, w: unit, h: unit }).nullable(),
  /** The frame grabbed at `t`, relative to the episode folder: notes/n<k>.jpg, never a path anywhere else. */
  still: z.string().regex(NOTE_STILL),
  createdAt: z.string(),
  /** The send round that took it to Claude; null until sent. */
  round: z.number().int().positive().nullable(),
});
export type Note = z.infer<typeof NoteSchema>;

/** `episodes/<n>/notes.json`. */
export const NotesFileSchema = strictObject({
  version: z.literal(1),
  notes: z.array(NoteSchema),
});
export type NotesFile = z.infer<typeof NotesFileSchema>;
