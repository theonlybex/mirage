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
  /** ffprobe's color_transfer of the video stream, e.g. bt709, arib-std-b67 (HLG), smpte2084 (PQ). */
  colorTransfer: z.string().nullable().default(null),
  /** How long the video stream runs, from the clip's start (catalogs before it was recorded: assume durationSec). */
  videoDurationSec: z.number().min(0).optional(),
  /** The header promises more than the file holds (a copy or recording cut short); the durations are what is there. */
  truncated: z.boolean().optional(),
  /** How many audio streams the file has, when more than one. */
  audioStreams: z.number().int().min(2).optional(),
  /** Which audio stream (0 = first) has the clip's sound, when that is not the first (e.g. a silent system-audio track first). */
  audioStream: z.number().int().min(1).optional(),
});
export type ProbeInfo = z.infer<typeof ProbeInfoSchema>;
