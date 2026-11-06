// SPDX-License-Identifier: MIT
// What the viewer server sends the page, in one place both sides compile against. Types only: no Node, no DOM.
import type { Control, LogEntry, Note, Progress, StepLine, VersionMeta } from '@wordedits/shared';

/** What the page draws of episode.json: the lanes with times in output seconds. `thumb` is a media path (the page adds the key). */
export type TimelineView = {
  status: 'empty' | 'ok' | 'editing';
  title: string;
  durationSec: number;
  items: { id: string; beat: string; clip: string; start: number; end: number; thumb: string | null; quiet: boolean; speed: number }[];
  overlays: { kind: string; text: string; tone: string; start: number; end: number }[];
  music: { track: string; start: number; end: number }[];
  slots: { id: string; start: number; end: number; line: string; maxWords: number }[];
  voice: { slot: string; start: number; end: number }[];
};

/** What Claude did with a note: done, done differently or could not, with its reason. */
export type NoteStatusView = { status: NonNullable<LogEntry['status']>; reason?: string };
/** A note with what Claude did with it, when it did something, and where its still is (a media path; the page adds the key). */
export type NoteView = Note & Partial<NoteStatusView> & { stillUrl: string };
/** A version, with where its video is (a media path) when it has one. */
export type VersionView = VersionMeta & { videoUrl?: string };

/** The seven kinds of event the page gets for one video, each as the JSON of its `data:` line. */
export type VideoEvents = {
  timeline: TimelineView;
  steps: StepLine[];
  progress: Progress | null;
  versions: VersionView[];
  notes: NoteView[];
  control: Control;
  report: string | null;
};
export type EventType = keyof VideoEvents;

/** One entry of `GET /api/videos`. */
export type VideoSummary = { number: number; title: string; stage: 'new' | 'rough' | 'guide' | 'final'; deliveries: number };

export type { Control, Progress, StepLine, VersionMeta };
