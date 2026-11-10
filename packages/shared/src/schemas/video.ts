// SPDX-License-Identifier: MIT
import { z } from 'zod';
import { strictObject } from './strict.js';

/**
 * The question a video is built on, in the person's own words (the four its format's rules ask for under "The question"):
 * what the thing should be against what it is, the one question with an answer a camera can see, who or what says it will
 * fail, and what the viewer can count as lost. Each is left out when the person gave none: Mirage never invents one.
 */
export const IdeaSchema = strictObject({
  gap: z.string().min(1).optional(),
  question: z.string().min(1).optional(),
  doubt: z.string().min(1).optional(),
  stake: z.string().min(1).optional(),
});
export type Idea = z.infer<typeof IdeaSchema>;

/**
 * The one deliberate change a video makes against its format's formula, so its effect can be read afterwards: which rule,
 * what was done differently, and what number should move.
 */
export const ExperimentSchema = strictObject({ rule: z.string().min(1), change: z.string().min(1), expect: z.string().min(1) });
export type Experiment = z.infer<typeof ExperimentSchema>;

/** A series' id: the name of its folder in `series/` (lower-case words joined by `-`). */
export const SeriesSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

/** Another place the same short went, beside YouTube: its numbers are never read by Mirage, only typed by the person. */
export const ALSO_PLATFORMS = ['instagram', 'tiktok'] as const;
export const AlsoPostedSchema = strictObject({ platform: z.enum(ALSO_PLATFORMS), url: z.string().min(1) });

/** `video.json` of a video (episodes/<n>/video.json): what the user told Mirage about it. */
export const VideoSchema = strictObject({
  version: z.literal(1),
  title: z.string().min(1).max(200),
  about: z.string(),
  mention: z.string(),
  hide: z.string(),
  /** Absolute paths of the folders the footage is in. */
  footage: z.array(z.string()),
  createdAt: z.string(),
  /** The id of the video's format (a file in the plugin's formats folder); absent = a build story. */
  format: z.string().min(1).optional(),
  /** The big video a short was made from. */
  from: z.number().int().positive().optional(),
  /** A vlog's series: its name, which one it is, and the date it covers. */
  vlog: strictObject({ name: z.string().min(1), number: z.number().int().positive(), date: z.string().min(1) }).optional(),
  /** The length the video aims for, in seconds; overrides the format's. */
  targetSec: z.number().positive().optional(),
  /** The question the video is built on, when the person said it (`new_video`'s `idea`). */
  idea: IdeaSchema.optional(),
  /** The video's experiment (`new_video`'s `experiment`, or written here later by the mirage:learn skill before the video is posted). */
  experiment: ExperimentSchema.optional(),
  /** Where the video is live, once the person said so (`posted`): its YouTube address, its id there, and the day that was recorded (YYYY-MM-DD). */
  posted: strictObject({
    url: z.string().min(1), id: z.string().min(1), at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Where else the same short went (`posted`'s `also`), so the record is complete. */
    also: z.array(AlsoPostedSchema).optional(),
  }).optional(),
  /** The series the video belongs to (`new_video`'s `series`): the slug of its folder, `series/<slug>/`. */
  series: SeriesSlugSchema.optional(),
  /** The title the person picked and the options they were offered, written by the mirage:edit skill's packaging step; `check` and `predict` hold the chosen one against the format's title shape. */
  titles: strictObject({ chosen: z.string().min(1).max(200).optional(), options: z.array(z.string().min(1).max(200)).max(10).optional() }).optional(),
});
export type Video = z.infer<typeof VideoSchema>;
