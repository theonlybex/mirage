import { z } from 'zod';

export const StageSchema = z.enum(['start', 'script', 'import', 'review', 'publish']);
export type Stage = z.infer<typeof StageSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().datetime(),
  stage: StageSchema,
  format: z.literal('talking-head'),
  source: z.object({ path: z.string(), sha256: z.string().length(64) }).nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;
