// SPDX-License-Identifier: MIT
import { z } from 'zod';
import { strictObject } from './strict.js';
import { SeriesSlugSchema } from './video.js';

/**
 * The thumbnail layout a series keeps from episode to episode (a thumbnail built from two sources: a face and a subject,
 * side by side): which side the face is on, and its share of the width.
 */
export const ThumbLayoutSchema = strictObject({ face: z.enum(['left', 'right']), share: z.number().min(0.2).max(0.5) });
export type ThumbLayout = z.infer<typeof ThumbLayoutSchema>;

/**
 * `series/<slug>/series.json`: what a series carries from episode to episode. The folder groups its episodes by their
 * video numbers; the videos themselves stay in `episodes/<n>/`. Every text is the person's own: Mirage never invents one.
 */
export const SeriesSchema = strictObject({
  version: z.literal(1),
  /** Equal to the folder's name. */
  slug: SeriesSlugSchema,
  name: z.string().min(1).max(200),
  /** The id of the format its episodes are made in. */
  format: z.string().min(1),
  /** The big question the whole series asks. */
  question: z.string().min(1).optional(),
  /** The question the latest episode's outro left open: the next episode's recap starts from it. */
  openQuestion: z.string().min(1).optional(),
  /** The video whose outro left `openQuestion`. */
  openQuestionFrom: z.number().int().positive().optional(),
  /** The running counts (cost so far, attempts used), by name: numbers the person or the catalog gave. */
  counts: z.record(z.string().min(1), strictObject({ value: z.number(), unit: z.string().min(1).optional() })),
  /** The line every episode ends on. */
  signOff: z.string().min(1).optional(),
  /** How its titles are shaped, in words ("ATTEMPTING TO … IN [N] DAYS"). */
  titleShape: z.string().min(1).optional(),
  thumbnail: ThumbLayoutSchema.optional(),
  /** Its episodes' video numbers, in order. */
  episodes: z.array(z.number().int().positive()),
  createdAt: z.string(),
});
export type Series = z.infer<typeof SeriesSchema>;
