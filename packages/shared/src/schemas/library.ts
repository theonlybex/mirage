import { z } from 'zod';

export const MoodSchema = z.enum(['punchy', 'light', 'tension', 'upbeat', 'riser', 'reveal', 'relaxed']);
export type Mood = z.infer<typeof MoodSchema>;

export const MusicTrackSchema = z.object({
  file: z.string().min(1),
  mood: MoodSchema,
  licence: z.string().default(''),
  bpm: z.number().positive().nullable().default(null),
  /** Time of the first beat in the track, seconds. */
  beatOffset: z.number().min(0).nullable().default(null),
  durationSec: z.number().positive().nullable().default(null),
});
export type MusicTrack = z.infer<typeof MusicTrackSchema>;

export const MusicLibrarySchema = z.object({ version: z.literal(1), tracks: z.array(MusicTrackSchema) });
export type MusicLibrary = z.infer<typeof MusicLibrarySchema>;
