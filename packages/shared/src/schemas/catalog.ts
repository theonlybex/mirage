import { z } from 'zod';
import { ProbeInfoSchema } from './probe.js';
import { TranscriptSchema } from './transcript.js';

export const ClipKindSchema = z.enum(['screen', 'camera', 'talking', 'timelapse']);
export type ClipKind = z.infer<typeof ClipKindSchema>;

export const ClipSchema = z.object({
  id: z.string().regex(/^c\d{3,}$/),
  path: z.string().min(1),
  sha256: z.string().length(64),
  probe: ProbeInfoSchema,
  kind: ClipKindSchema,
  transcript: TranscriptSchema.nullable(),
  frames: z.array(z.object({ t: z.number().min(0), file: z.string().min(1) })),
  notes: z.string().default(''),
  moments: z.array(z.object({ t: z.number().min(0), label: z.string().min(1) })).default([]),
});
export type Clip = z.infer<typeof ClipSchema>;

export const CatalogSchema = z.object({ version: z.literal(1), clips: z.array(ClipSchema) });
export type Catalog = z.infer<typeof CatalogSchema>;
