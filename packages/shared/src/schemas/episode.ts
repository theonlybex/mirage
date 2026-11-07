import { z } from 'zod';
import { strictObject } from './strict.js';

type Span = { start: number; end: number };

// The cast is needed because the generic shape T hides start/end from the refine callback's type.
const range = <T extends z.ZodRawShape>(shape: T, what: string) =>
  strictObject({ start: z.number().min(0), end: z.number().positive(), ...shape }).refine((r) => (r as Span).end > (r as Span).start, { message: `${what}: end must be after start` });

/** The beats of the build story, the only ones before formats; a format names its own, and any such word is a beat. */
export const BUILD_STORY_BEATS = ['cold-open', 'title', 'recap', 'new-toy', 'problem', 'montage', 'twist', 'truth', 'outro', 'blooper'] as const;
/** A beat is a lower-case word (digits and hyphens after the first letter); the format a video has says which words it expects. */
export const BeatSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
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

/** A piece of a catalogued clip: `clip` from `src.in` to `src.out`. */
export const ClipItemSchema = strictObject({
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
  /**
   * Written by voice-over fitting, never by hand: fitting split item `item`, which had a move, to freeze its picture
   * partway, and this item is one of its parts; `move` is that item's move as it was. The parts (the items next to each
   * other with the same `splitFrom.item`) play the move on one clock, as the item would have with the frozen frames in
   * it, so the picture doesn't jump at the seam: each part whose own `move` is still that one plays its share. A part
   * whose `move` was changed plays it on its own. A full re-fit merges the parts back into the item.
   */
  splitFrom: strictObject({ item: z.string().min(1), move: MoveSchema }).optional(),
}).superRefine((it, ctx) => {
  if (it.src.out <= it.src.in) ctx.addIssue({ code: 'custom', path: ['src'], message: `item ${it.id}: src.out must be greater than src.in` });
});
export type ClipItem = z.infer<typeof ClipItemSchema>;

/**
 * A plain path inside the project: relative, with no `..` part. A backslash counts as a separator too (a Windows path
 * written by hand), so `a\..\b`, `\x` and `C:\x` are refused.
 */
export const isProjectPath = (p: string): boolean =>
  !/^[\\/]/.test(p) && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..');

/**
 * A full-screen card that takes its own time and has no footage: `sec` seconds (plus `hold`) of silence. mono = white
 * monospace text on black, a line per `\n`; bold = big white text on black, wrapped; image = `image` (a PNG or JPEG
 * inside the project) covering the frame, with `text` over it if any.
 */
export const CardItemSchema = strictObject({
  id: z.string().min(1),
  beat: BeatSchema,
  card: strictObject({
    text: z.string().default(''),
    style: z.enum(['mono', 'bold', 'image']),
    sec: z.number().min(0.5).max(30),
    /** The picture of an `image` card: a path inside the project to a PNG or JPEG. */
    image: z.string().min(1).optional(),
  }),
  /** Seconds the card stays on longer (set by voice-over fitting, which never splits a card). */
  hold: z.number().min(0).max(10).default(0),
  /** No narration over this card. */
  quiet: z.boolean().default(false),
}).superRefine((it, ctx) => {
  const c = it.card;
  if (c.style === 'image') {
    if (c.image === undefined) ctx.addIssue({ code: 'custom', path: ['card', 'image'], message: `item ${it.id}: an image card needs an image (a PNG or JPEG in the project)` });
    else if (!isProjectPath(c.image)) ctx.addIssue({ code: 'custom', path: ['card', 'image'], message: `item ${it.id}: card image ${c.image} must be a path inside the project (no .., not absolute)` });
  } else {
    if (c.image !== undefined) ctx.addIssue({ code: 'custom', path: ['card', 'image'], message: `item ${it.id}: only an image card takes an image (style is ${c.style})` });
    if (!c.text.trim()) ctx.addIssue({ code: 'custom', path: ['card', 'text'], message: `item ${it.id}: a ${c.style} card needs text` });
  }
});
export type CardItem = z.infer<typeof CardItemSchema>;

/** A timeline item: a piece of a clip, or a card. Old episodes hold only clip items and parse (and save) exactly as before. */
export const TimelineItemSchema = z.union([ClipItemSchema, CardItemSchema]);
export type TimelineItem = z.infer<typeof TimelineItemSchema>;

export const isCard = (item: TimelineItem): item is CardItem => 'card' in item;

export const OverlaySchema = range(
  {
    // name: a lower-third name label (text, and `sub` under it); subtitle: a chosen subtitle; timecard: a time tag.
    kind: z.enum(['callout', 'counter', 'badge', 'label', 'chapter', 'before', 'after', 'name', 'subtitle', 'timecard']),
    text: z.string().min(1),
    tone: z.enum(['neutral', 'fail', 'pass', 'live']).default('neutral'),
    /** The second line of a name label (a role, a place). Only on `name`; left out of the file when there is none. */
    sub: z.string().min(1).optional(),
  },
  'overlay',
).superRefine((o, ctx) => {
  if (o.sub !== undefined && o.kind !== 'name') {
    ctx.addIssue({ code: 'custom', path: ['sub'], message: `overlay "${o.text}": sub (the second line) is only for a name label — a ${o.kind} overlay has none` });
  }
});
export type Overlay = z.infer<typeof OverlaySchema>;

export const MusicCueSchema = range(
  {
    track: z.string().min(1),
    gainDb: z.number().max(0).default(-5),
    fadeIn: z.number().min(0).default(0.5),
    fadeOut: z.number().min(0).default(1),
    /** Where in the track this cue starts playing. */
    offset: z.number().min(0).default(0),
    /**
     * Moments the cue's music goes silent (before a punchline or a reveal), in output seconds inside the cue: it fades out
     * over the 80 ms before `start` and back in over the 80 ms after `end`. Only this cue's music; absent = none.
     */
    dips: z.array(range({}, 'dip')).optional(),
  },
  'music cue',
);
export type MusicCue = z.infer<typeof MusicCueSchema>;

/**
 * A sound effect: `sound` is a built-in name (whoosh, swoosh-out, hit, riser, pop, ding, click; a file of that name in the
 * project's sfx/ folder replaces it) or a path inside the project starting `sfx/`. `at` is the output time its peak lands
 * on (a hit's attack, a riser's end). `gainDb` sets it relative to the speech level.
 */
export const SfxCueSchema = strictObject({
  sound: z.string().min(1),
  at: z.number().min(0),
  gainDb: z.number().max(0).default(-6),
});
export type SfxCue = z.infer<typeof SfxCueSchema>;

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
  /** Sound effects, in output seconds like music cues; absent = none. */
  sfx: z.array(SfxCueSchema).optional(),
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
