// SPDX-License-Identifier: AGPL-3.0-or-later
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
});
export type Video = z.infer<typeof VideoSchema>;
