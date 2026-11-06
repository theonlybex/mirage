// SPDX-License-Identifier: MIT
// Versions and notes for the Review and Versions tests.
import type { NoteView, VersionView } from '../../view-types.js';

export const at = (min: number) => new Date(Date.parse('2026-11-02T08:00:00Z') + min * 60_000).toISOString();

export const version = (over: Partial<VersionView> & { id: string }): VersionView => ({
  version: 1,
  kind: 'delivery',
  label: 'Rough cut',
  createdAt: at(0),
  sessionId: 's1',
  delivery: 1,
  render: { mode: 'rough', file: 'video.mp4', captions: null },
  hasEpisode: true,
  hasSummary: true,
  videoUrl: `/media/p/episodes/1/versions/${over.id}/video.mp4`,
  ...over,
});

export const rough = version({ id: 'd1' });
export const guide = version({ id: 'd2', delivery: 2, label: 'Guide cut (record your voice-over over this)', createdAt: at(30), render: { mode: 'guide', file: 'video.mp4', captions: null } });
export const before = version({ id: 'b1', kind: 'before', label: 'Before this edit', delivery: null, render: null, videoUrl: undefined, createdAt: at(10) });
export const checkpoint = version({ id: 'c1', kind: 'checkpoint', label: 'Timeline checked', delivery: null, render: null, videoUrl: undefined, createdAt: at(20) });
export const backup = version({ id: 'k1', kind: 'backup', label: 'Before going back to “Timeline checked”', sessionId: null, delivery: null, render: null, videoUrl: undefined, createdAt: at(25) });

export const note = (over: Partial<NoteView> & { id: string }): NoteView => ({
  versionId: 'd1',
  t: 4.2,
  text: 'Too slow here',
  box: null,
  still: `notes/${over.id}.jpg`,
  createdAt: at(5),
  round: null,
  stillUrl: `/media/p/episodes/1/notes/${over.id}.jpg`,
  ...over,
});
