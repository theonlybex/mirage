import { z } from 'zod';

export const ScriptBlockSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['hook', 'section', 'cta']),
  title: z.string().optional(),
  text: z.string(),
  order: z.number().int().min(0),
});
export type ScriptBlock = z.infer<typeof ScriptBlockSchema>;

export const ScriptSchema = z.object({ blocks: z.array(ScriptBlockSchema) });
export type Script = z.infer<typeof ScriptSchema>;
