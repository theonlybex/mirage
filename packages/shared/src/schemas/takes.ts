import { z } from 'zod';

export const TakeSchema = z.object({
  id: z.string().min(1),
  start: z.number().min(0),
  end: z.number().min(0),
  score: z.number().min(0).max(1),
  text: z.string(),
});
export type Take = z.infer<typeof TakeSchema>;

export const TakesSchema = z.object({
  blocks: z.array(
    z.object({
      blockId: z.string().min(1),
      takes: z.array(TakeSchema),
      chosen: z.string().nullable(),
    }),
  ),
});
export type Takes = z.infer<typeof TakesSchema>;
