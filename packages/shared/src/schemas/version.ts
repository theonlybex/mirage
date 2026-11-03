// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { strictObject } from './strict.js';

export const VersionKindSchema = z.enum(['before', 'checkpoint', 'delivery']);
export type VersionKind = z.infer<typeof VersionKindSchema>;

/** `meta.json` of a saved version of an episode (episodes/<n>/versions/<id>/). */
export const VersionMetaSchema = strictObject({
  version: z.literal(1),
  id: z.string().min(1),
  kind: VersionKindSchema,
  label: z.string(),
  createdAt: z.string().refine((s) => Number.isFinite(Date.parse(s)), 'not an ISO date'),
  sessionId: z.string().nullable(),
  /** The delivery's number (1, 2, …) for a delivery, else null. */
  delivery: z.number().int().positive().nullable(),
  render: strictObject({
    mode: z.enum(['rough', 'guide', 'final']),
    file: z.literal('video.mp4'),
    captions: z.literal('captions.srt').nullable(),
  }).nullable(),
  hasEpisode: z.boolean(),
  hasSummary: z.boolean(),
});
export type VersionMeta = z.infer<typeof VersionMetaSchema>;
