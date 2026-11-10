// SPDX-License-Identifier: MIT
import { z } from 'zod';
import { strictObject } from './strict.js';

/** `mirage.json` at the root of a project, as `init` writes it. */
export const MirageProjectSchema = strictObject({
  version: z.literal(1),
  title: z.string(),
  createdAt: z.string(),
  /**
   * The channels that lead the person's niche, per format id: their YouTube addresses, as the person named them. The
   * mirage:learn skill writes it and learns from them (with mirage:analyse) while the person's own videos are too few.
   */
  niche: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
});
export type MirageProject = z.infer<typeof MirageProjectSchema>;

/** `<project>/.mirage/viewer.json`: where the running viewer listens, written by the viewer when it starts. */
export const ViewerInfoSchema = strictObject({
  url: z.string(),
  pid: z.number().int(),
});
export type ViewerInfo = z.infer<typeof ViewerInfoSchema>;
