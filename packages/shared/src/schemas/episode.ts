import { z } from 'zod';
import { strictObject } from './strict.js';

type Span = { start: number; end: number };

// The cast is needed because the generic shape T hides start/end from the refine callback's type.
const range = <T extends z.ZodRawShape>(shape: T, what: string) =>
  strictObject({ start: z.number().min(0), end: z.number().positive(), ...shape }).refine((r) => (r as Span).end > (r as Span).start, { message: `${what}: end must be after start` });

export const BeatSchema = z.enum(['cold-open', 'title', 'recap', 'new-toy', 'problem', 'montage', 'twist', 'truth', 'outro', 'blooper']);
export type Beat = z.infer<typeof BeatSchema>;

export const TimelineItemSchema = strictObject({
  id: z.string().min(1),
  beat: BeatSchema,
  clip: z.string().min(1),
  src: strictObject({ in: z.number().min(0), out: z.number().positive() }),
  /** 1 = real time; timelapses > 1. */
  speed: z.number().min(0.25).max(400).default(1),
  /** keep = the clip's own sound (live commentary, pieces to camera). Ignored when speed ≠ 1. */
  audio: z.enum(['keep', 'mute']).default('mute'),
  /** Centred punch-in, 1 = none. */
  zoom: z.number().min(1).max(2).default(1),
  /** Seconds of frozen last frame appended (set by voice-over fitting). */
  hold: z.number().min(0).max(10).default(0),
  /** No narration over this item (reveals, silences). */
  quiet: z.boolean().default(false),
  /** Snap this item's length to whole beats of the music under it. */
  onBeat: z.boolean().default(false),
}).superRefine((it, ctx) => {
  if (it.src.out <= it.src.in) ctx.addIssue({ code: 'custom', path: ['src'], message: `item ${it.id}: src.out must be greater than src.in` });
});
export type TimelineItem = z.infer<typeof TimelineItemSchema>;

export const OverlaySchema = range(
  {
    kind: z.enum(['callout', 'counter', 'badge', 'label', 'chapter', 'before', 'after']),
    text: z.string().min(1),
    tone: z.enum(['neutral', 'fail', 'pass', 'live']).default('neutral'),
  },
  'overlay',
);
export type Overlay = z.infer<typeof OverlaySchema>;

export const MusicCueSchema = range(
  {
    track: z.string().min(1),
    gainDb: z.number().max(0).default(-5),
    fadeIn: z.number().min(0).default(0.5),
    fadeOut: z.number().min(0).default(1),
    /** Where in the track this cue starts playing. */
    offset: z.number().min(0).default(0),
  },
  'music cue',
);
export type MusicCue = z.infer<typeof MusicCueSchema>;

export const SlotSchema = range({ id: z.string().min(1), maxWords: z.number().int().min(0), line: z.string().default('') }, 'slot');
export type Slot = z.infer<typeof SlotSchema>;

export const VoiceLineSchema = strictObject({
  slot: z.string().min(1),
  /** Output time the line starts. */
  at: z.number().min(0),
  src: strictObject({ in: z.number().min(0), out: z.number().positive() }),
  /** Ranges of the recording removed inside the line (fillers, long pauses). */
  cuts: z.array(z.tuple([z.number(), z.number()])).default([]),
  /** The recording this line was cut from; absent = the voice-over's `recording`. */
  recording: z.string().min(1).optional(),
  /** The written line, used for caption spelling. */
  text: z.string().optional(),
});
export type VoiceLine = z.infer<typeof VoiceLineSchema>;

const even = z.number().int().positive().refine((n) => n % 2 === 0, { message: 'must be even' });

export const EpisodeSchema = strictObject({
  version: z.literal(2),
  number: z.number().int().min(1),
  title: z.string().min(1),
  output: strictObject({ width: even, height: even, fps: z.number().positive() }),
  items: z.array(TimelineItemSchema).min(1),
  overlays: z.array(OverlaySchema).default([]),
  music: z.array(MusicCueSchema).default([]),
  slots: z.array(SlotSchema).default([]),
  /** The cut the slots were computed for (written by `slots`, kept in step by `vo`): its fingerprint and where each item sat. */
  slotsCut: strictObject({
    fingerprint: z.string(),
    items: z.array(strictObject({ id: z.string(), start: z.number(), end: z.number(), in: z.number(), speed: z.number() })),
  }).optional(),
  voiceover: strictObject({
    recording: z.string().min(1),
    lines: z.array(VoiceLineSchema),
    /** Recording path → its transcript file in the episode folder. Absent: voiceover.transcript.json (older episodes). */
    transcripts: z.record(z.string(), z.string()).default({}),
    /** Fingerprint of the cut the voice-over was fitted to (items before the fit's holds). */
    cutFingerprint: z.string().optional(),
    /** Fingerprint of the items right after the fit; any other value means the cut changed since. */
    fittedItemsFingerprint: z.string().optional(),
  })
    .nullable()
    .default(null),
  loudnessLufs: z.number().default(-14),
}).superRefine((ep, ctx) => {
  for (const [list, what] of [[ep.items, 'item'], [ep.slots, 'slot']] as const) {
    const seen = new Set<string>();
    for (const x of list) {
      if (seen.has(x.id)) ctx.addIssue({ code: 'custom', message: `duplicate ${what} id ${x.id}` });
      seen.add(x.id);
    }
  }
});
export type Episode = z.infer<typeof EpisodeSchema>;
