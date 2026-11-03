// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { strictObject } from './strict.js';

/** One line of a session's steps.jsonl: a tool call and how it went, or the end of a turn. */
export const StepLineSchema = z.union([
  strictObject({
    at: z.string(),
    /** The tool_use_id. */
    id: z.string(),
    tool: z.string(),
    label: z.string(),
    status: z.enum(['running', 'done', 'failed', 'denied']),
    detail: z.string().optional(),
  }),
  strictObject({ at: z.string(), type: z.literal('turn-end') }),
]);
export type StepLine = z.infer<typeof StepLineSchema>;

/** progress.json of a session: the long command that is running now. */
export const ProgressSchema = strictObject({
  command: z.string(),
  fraction: z.number().min(0).max(1),
  startedAt: z.string(),
  updatedAt: z.string(),
});
export type Progress = z.infer<typeof ProgressSchema>;

/** One line of a session's log.jsonl: what Claude guessed, asked, worried about, or did with a note. */
export const LogEntrySchema = strictObject({
  at: z.string(),
  kind: z.enum(['guess', 'question', 'concern', 'warning', 'note-status']),
  text: z.string(),
  noteId: z.string().optional(),
  status: z.enum(['done', 'done-differently', 'could-not']).optional(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

/** `episodes/<n>/control.json`: the user's pause, stop and correction for one video. All off by default. */
export const ControlSchema = strictObject({
  version: z.literal(1),
  paused: z.boolean(),
  pauseNow: z.boolean(),
  stop: strictObject({ at: z.string() }).nullable(),
  correction: z.string().nullable(),
  updatedAt: z.string(),
});
export type Control = z.infer<typeof ControlSchema>;

/** `<project>/.mirage/sessions/<sessionId>.json`: which video a Claude session is working on. */
export const SessionStateSchema = strictObject({
  video: z.number().int().positive().nullable(),
  overnight: strictObject({ videos: z.array(z.number().int().positive()), startedAt: z.string() }).nullable(),
  awakePid: z.number().int().nullable(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;
