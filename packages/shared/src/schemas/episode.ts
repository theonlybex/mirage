import { z } from 'zod';
import { strictObject } from './strict.js';

type Span = { start: number; end: number };

// The cast is needed because the generic shape T hides start/end from the refine callback's type.
const range = <T extends z.ZodRawShape>(shape: T, what: string) =>
  strictObject({ start: z.number().min(0), end: z.number().positive(), ...shape }).refine((r) => (r as Span).end > (r as Span).start, { message: `${what}: end must be after start` });

export const BeatSchema = z.enum(['cold-open', 'title', 'recap', 'new-toy', 'problem', 'montage', 'twist', 'truth', 'outro', 'blooper']);
export type Beat = z.infer<typeof BeatSchema>;

/**
 * A camera move over an item: zoom and focus travel from the item's own `zoom` and `focus` to these. What is left out
 * is filled in when the move is played, not here, so the file keeps what was written: `focus` (or one axis of it)
 * stays the item's, `start` is 0 and `end` is the end of the shot. `start` and `end` are seconds into the item on the
 * output timeline, held frames included.
 */
export const MoveSchema = strictObject({
  /** The zoom at the end of the move. */
  zoom: z.number().min(1).max(2),
  /** The focus at the end of the move, 0–1 from the left and from the top; an axis left out stays the item's. */
  focus: strictObject({ x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional() }).optional(),
  ease: z.enum(['linear', 'in', 'out', 'inOut']).default('inOut'),
  start: z.number().min(0).optional(),
  end: z.number().positive().optional(),
}).refine((m) => m.start === undefined || m.end === undefined || m.end > m.start, { message: 'move: end must be after start' });
export type Move = z.infer<typeof MoveSchema>;

export const TimelineItemSchema = strictObject({
  id: z.string().min(1),
  beat: BeatSchema,
  clip: z.string().min(1),
  src: strictObject({ in: z.number().min(0), out: z.number().positive() }),
  /** 1 = real time; timelapses > 1. */
  speed: z.number().min(0.25).max(400).default(1),
  /** keep = the clip's own sound (live commentary, pieces to camera). Ignored when speed ≠ 1. */
  audio: z.enum(['keep', 'mute']).default('mute'),
  /** Punch-in around `focus`, 1 = none. */
  zoom: z.number().min(1).max(2).default(1),
  /**
   * How a picture of another shape meets the output frame: fit = whole picture with black bars, fill = cropped around
   * `focus` to fill the frame, blur = whole picture over a blurred copy of itself that fills the frame.
   */
  frame: z.enum(['fit', 'fill', 'blur']).default('fit'),
  /** The point of the picture kept in view when it is cropped (zoom, fill): 0–1 from the left and from the top. */
  focus: strictObject({ x: z.number().min(0).max(1).default(0.5), y: z.number().min(0).max(1).default(0.5) }).default({ x: 0.5, y: 0.5 }),
  /** A camera move from `zoom` and `focus` to the frame the move names; absent = the picture holds still. */
  move: MoveSchema.optional(),
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

/** How spoken words are burned in as captions. Absent = phrase captions at the bottom, as before. */
export const CaptionsSchema = strictObject({
  /** phrase = a line at a time; pop = 1–3 big words, each popping in; karaoke = the phrase with the spoken word lit; chosen/off = no automatic captions. */
  style: z.enum(['phrase', 'pop', 'karaoke', 'chosen', 'off']).default('phrase'),
  position: z.enum(['bottom', 'middle']).default('bottom'),
  /** Words to light up in the pop style: every time it is said (a string), or only the saying nearest output time `at`. */
  highlight: z.array(z.union([z.string().min(1), strictObject({ word: z.string().min(1), at: z.number().min(0) })])).default([]),
  /** The highlight colour as #RRGGBB. */
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});
export type Captions = z.infer<typeof CaptionsSchema>;

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
    items: z.array(strictObject({ id: z.string(), start: z.number(), end: z.number(), in: z.number(), speed: z.number(), clip: z.string().optional(), out: z.number().optional() })),
  }).optional(),
  voiceover: strictObject({
    recording: z.string().min(1),
    lines: z.array(VoiceLineSchema),
    /** Recording path → its transcript file in the episode folder. Absent: voiceover.transcript.json (older episodes). */
    transcripts: z.record(z.string(), z.string()).default({}),
    /** Recording path → its sha256 when it was fitted: a recording saved over is never used for lines cut from the old one. */
    recordingSha256: z.record(z.string(), z.string()).optional(),
    /** Fingerprint of the cut the voice-over was fitted to (items before the fit's holds). */
    cutFingerprint: z.string().optional(),
    /** Fingerprint of the items right after the fit; any other value means the cut changed since. */
    fittedItemsFingerprint: z.string().optional(),
    /** The items before the fit held the picture: a full re-fit starts from them again. */
    baseItems: z.array(TimelineItemSchema).optional(),
    /**
     * Time the fits opened (output time `at`, `sec` seconds), in order, so a full re-fit can close it again; and what each
     * did to its item (`hold` seconds of frozen frame added, source extended to `out` by `outAdded`, `split` = the id of the
     * second half it created), so a full re-fit after a re-cut can undo whatever of it is still there.
     */
    holds: z
      .array(strictObject({ at: z.number(), sec: z.number(), item: z.string().optional(), hold: z.number().optional(), out: z.number().optional(), outAdded: z.number().optional(), split: z.string().optional() }))
      .optional(),
  })
    .nullable()
    .default(null),
  loudnessLufs: z.number().default(-14),
  captions: CaptionsSchema.optional(),
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
