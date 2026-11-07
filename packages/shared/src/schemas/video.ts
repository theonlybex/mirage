// SPDX-License-Identifier: MIT
import { z } from 'zod';
import { strictObject } from './strict.js';

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
});
export type Video = z.infer<typeof VideoSchema>;
