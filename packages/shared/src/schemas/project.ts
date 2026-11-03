// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { strictObject } from './strict.js';

/** `mirage.json` at the root of a project, as `init` writes it. */
export const MirageProjectSchema = strictObject({
  version: z.literal(1),
  title: z.string(),
  createdAt: z.string(),
});
export type MirageProject = z.infer<typeof MirageProjectSchema>;

/** `<project>/.mirage/viewer.json`: where the running viewer listens, written by the viewer when it starts. */
export const ViewerInfoSchema = strictObject({
  url: z.string(),
  pid: z.number().int(),
});
export type ViewerInfo = z.infer<typeof ViewerInfoSchema>;
