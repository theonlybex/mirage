import { z } from 'zod';

export const BriefSchema = z.object({
  tone: z.string(),
  targetMinutes: z.number().positive(),
  audience: z.string(),
  pacing: z.enum(['natural', 'fast', 'extra-fast']),
  styleRefs: z.array(z.string()).default([]),
});
export type Brief = z.infer<typeof BriefSchema>;
/** Partially filled brief while the interview is in progress. */
export const BriefDraftSchema = BriefSchema.partial();
export type BriefDraft = z.infer<typeof BriefDraftSchema>;
