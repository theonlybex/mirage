import { z } from 'zod';

export const ProbeInfoSchema = z.object({
  durationSec: z.number().min(0),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  fps: z.number().min(0),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
});
export type ProbeInfo = z.infer<typeof ProbeInfoSchema>;
