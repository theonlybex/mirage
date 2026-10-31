import { z } from 'zod';

export const ZoomSchema = z.object({
  scale: z.number().min(1).max(2),
  anchor: z
    .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
    .default({ x: 0.5, y: 0.4 }),
});
export type Zoom = z.infer<typeof ZoomSchema>;

export const SceneSchema = z
  .object({
    id: z.string().min(1),
    blockId: z.string().optional(),
    src: z.object({ in: z.number().min(0), out: z.number().positive() }),
    cuts: z.array(z.tuple([z.number(), z.number()])).default([]),
    zoom: ZoomSchema.default({ scale: 1, anchor: { x: 0.5, y: 0.4 } }),
    title: z.object({ text: z.string(), style: z.enum(['section', 'lower-third']) }).optional(),
    captions: z.boolean().default(true),
    markers: z.array(z.string()).default([]),
  })
  .superRefine((s, ctx) => {
    if (s.src.out <= s.src.in) {
      ctx.addIssue({ code: 'custom', message: `scene ${s.id}: src.out must be greater than src.in` });
    }
    for (const [a, b] of s.cuts) {
      if (a >= b || a < s.src.in || b > s.src.out) {
        ctx.addIssue({ code: 'custom', message: `scene ${s.id}: cut [${a}, ${b}] is outside the scene range` });
      }
    }
  });
export type Scene = z.infer<typeof SceneSchema>;

export const EdlSchema = z.object({
  version: z.literal(1),
  output: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
  }),
  scenes: z.array(SceneSchema).min(1),
  audio: z
    .object({
      music: z.object({ track: z.string(), gainDb: z.number(), duck: z.boolean() }).nullable(),
      loudnessLufs: z.number(),
    })
    .default({ music: null, loudnessLufs: -14 }),
  captions: z
    .object({ style: z.string(), maxChars: z.number().int().positive(), lines: z.number().int().positive() })
    .default({ style: 'clean-bottom', maxChars: 38, lines: 2 }),
  endScreen: z.object({ seconds: z.number().min(0).max(20) }).default({ seconds: 12 }),
});
export type Edl = z.infer<typeof EdlSchema>;
