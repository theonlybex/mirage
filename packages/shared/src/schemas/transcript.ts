import { z } from 'zod';

export const WordSchema = z.object({
  w: z.string(),
  start: z.number().min(0),
  end: z.number().min(0),
  conf: z.number().min(0).max(1),
});
export type Word = z.infer<typeof WordSchema>;

export const TranscriptSchema = z.object({
  words: z.array(WordSchema),
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
  speech: z.array(z.tuple([z.number(), z.number()])),
});
export type Transcript = z.infer<typeof TranscriptSchema>;
