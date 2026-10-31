# Mirage Phase A (Build-Story Episodes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm mirage` commands that take a batch of build clips and a music folder, render a picture-and-music rough cut from an `episode.json` timeline, compute narration slots, render a guide video, fit a voice-over recorded last, and render the final captioned episode.

**Architecture:** The catalog (`catalog.json`) describes every clip: probe, transcript, sampled frames. The episode timeline (`episode.json`, "EDL v2") lists items from many clips, overlays, music cues, narration slots and the fitted voice-over. Rendering is chunked (≤30 items per ffmpeg process) into intermediates, then a final pass applies ASS overlays and captions, builds speech and music buses, ducks, normalises and encodes. Creative steps (frame descriptions, writing `episode.json`, writing slot lines) are done by Claude in the chat, guided by a project skill; every command is deterministic.

**Tech Stack:** Node 24, TypeScript 7, zod 4, vitest 5, execa 9, ffmpeg-static 6.0 (libass, sidechaincompress, amix, alimiter, afade, adelay present), Swift 6 / Speech framework on macOS 26.5.

**Spec:** `docs/superpowers/specs/2026-09-28-wordedits-design.md` — **§14** (format, workflow, Phase A decisions, data model). §13's fast-track plan is superseded; Tasks 1–2 here reuse two of its tasks verbatim.

## Global Constraints

- Node `>=22`; ESM only; `strict: true`; every JSON file validated with zod on read and write.
- `packages/core` never statically imports `@wordedits/sidecars` or `electron`; sidecars only through `MediaTools`.
- Sidecars spawned with argument arrays; every call has a timeout and captured stderr; failures are structured errors with `code` and `hint`.
- Timeline times are seconds on the output timeline; every item is a whole number of output frames (`round(srcLen / speed * fps)` plus `round(hold * fps)`).
- At most 30 items per ffmpeg process. Intermediates: `libx264 -preset veryfast -crf 12`, PCM 48 kHz stereo, `.mov`.
- Final mix: speech bus (live item audio + voice-over) → `highpass=f=90` → `loudnorm` to `loudnessLufs` (default −14), TP −1. Music cues are each normalised to `loudnessLufs + gainDb` (default gain −18), then ducked by `sidechaincompress` keyed on speech, mixed, limited at −1 dBFS.
- Rough and guide renders are 960×540 preview encodes; the final render uses the episode's output size and the YouTube encode args (`encodeArgs`). Duration tolerance `max(0.1, 1/fps)` s.
- Narration: 170 words per minute; slots are speech-free stretches ≥ 2.5 s that are not inside a `quiet` item, padded 0.3 s away from live speech; voice-over lines start 0.15 s into their slot and may run 0.2 s past it before the picture is held.
- Fillers are exactly `um umm uh uhh uhm er erm ah ahh hmm mm mhm`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A real build batch: one hour-long timelapse source, 40+ items, portrait phone clips next to 16:9 screen recordings.** Must render: chunking keeps processes small, portrait clips are letterboxed instead of stretched, sped-up items read only the source they need. Pinned in Task 6 (31-item render with a portrait clip and a 20× item → 2 chunks, duration within tolerance, frame aspect unchanged).
2. **A voice-over take with fumbles: a line read twice, an "um", a long pause, a line skipped.** The last take wins, fillers and long pauses are cut, the skipped line is reported as missing (never silently shifted), and a line longer than its slot holds the picture instead of overlapping the next line. Pinned in Task 8.
3. **Clip and project paths with spaces, quotes and non-ASCII.** The ASS file, chunk list, music and voice files are referenced by plain names from the work directory; clip paths only appear as `-i` arguments. Pinned in Task 6 (project dir `we proj 'q' ✨`).
4. **An episode that points at a missing clip or reads past a clip's end.** `check`/`cut` stop with `BAD_ITEM` naming the item, before ffmpeg runs. Pinned in Task 6.
5. **Music shorter than its cue, and a cue with zero fades.** The track loops; zero fades add no `afade` filter (ffmpeg rejects `d=0`). Pinned in Task 6 (`musicTrackArgs` unit test) and the render test using an 8 s track under a longer cue.

---

### Task 1: On-device transcription sidecar

**Files:** exactly those listed in **Task 1 of `docs/superpowers/plans/2026-10-30-fast-track-autoedit.md`** (the superseded plan; this task is reused unchanged).

**Interfaces:** exactly as listed there. Produces `runPath`, `RunOptions.cwd`, `RunOptions.notFoundHint`, `FfmpegOptions.cwd`, `extractWav`, `transcribeAudio`, `transcriberPath`, `sentenceSegments`, `speechRanges` in sidecars; `MediaTools.extractWav`, `MediaTools.transcribe`, `FfmpegRunOptions.cwd` in core; `pnpm build:native`, `pnpm fixtures:speech`; `fixtures/speech-retake.mp4`.

- [ ] **Step 1: Execute Steps 1–10 of that task exactly as written**, with one change: in Step 1, add only the `build:native` and `fixtures:speech` scripts to the root `package.json` (not `edit`; this plan adds `mirage` in Task 9). Commit message as written there.

---

### Task 2: Sentences, fillers and retake detection

**Files:** exactly those listed in **Task 2 of `docs/superpowers/plans/2026-10-30-fast-track-autoedit.md`** (reused unchanged).

**Interfaces:** exactly as listed there: `FILLERS`, `normalizeWord`, `isFiller`, `Sentence`, `splitSentences`, `sentenceTokens`, `textTokens`, `similarity`, `splitScript`, `RetakeDecision`, `detectRetakes`, exported from `@wordedits/core` via `packages/core/src/autoedit/index.ts`.

- [ ] **Step 1: Execute Steps 1–5 of that task exactly as written.** Commit message as written there.

---

### Task 3: Catalog, library and episode schemas; timeline layout

**Files:**
- Create: `packages/shared/src/schemas/catalog.ts`, `packages/shared/src/schemas/episode.ts`, `packages/shared/src/schemas/library.ts`, `packages/shared/src/schemas/episode.test.ts`
- Create: `packages/core/src/mirage/errors.ts`, `packages/core/src/mirage/timeline.ts`, `packages/core/src/mirage/timeline.test.ts`, `packages/core/src/mirage/index.ts`
- Modify: `packages/shared/src/index.ts`, `packages/core/src/index.ts`, `packages/core/src/edl-compiler.ts` (export `ffNum`, extract `encodeArgs`)

**Interfaces:**
- Produces (shared): `ClipKindSchema`/`ClipKind` (`screen|camera|talking|timelapse`); `ClipSchema`/`Clip`; `CatalogSchema`/`Catalog`; `BeatSchema`/`Beat`; `TimelineItemSchema`/`TimelineItem`; `OverlaySchema`/`Overlay`; `MusicCueSchema`/`MusicCue`; `SlotSchema`/`Slot`; `VoiceLineSchema`/`VoiceLine`; `EpisodeSchema`/`Episode`; `MoodSchema`/`Mood`; `MusicTrackSchema`/`MusicTrack`; `MusicLibrarySchema`/`MusicLibrary`.
- Produces (core): `ffNum(n: number): string`; `encodeArgs(o: { mode: 'preview' | 'final'; encoder: Encoder; width: number; height: number; fps: number }): string[]`; `class MirageError extends Error { code: 'BAD_ITEM' | 'NO_CATALOG' | 'NO_EPISODE' | 'NO_MUSIC_TRACK' | 'NOTHING_MATCHED' | 'DURATION_MISMATCH'; hint: string }`; `interface LaidItem { item: TimelineItem; index: number; start: number; end: number; srcFrames: number; holdFrames: number; frames: number }`; `itemFrames(item: TimelineItem, fps: number): { srcFrames: number; holdFrames: number; frames: number }`; `layoutTimeline(ep: Episode): LaidItem[]`; `timelineDuration(ep: Episode): number`; `shiftAfter(ep: Episode, at: number, delta: number): Episode`.

- [ ] **Step 1: Write the failing schema test**

`packages/shared/src/schemas/episode.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CatalogSchema } from './catalog.js';
import { EpisodeSchema } from './episode.js';
import { MusicLibrarySchema } from './library.js';

const item = { id: 'i1', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 2 } };
const base = { version: 2, number: 1, title: 'Weather app, part 1', output: { width: 1920, height: 1080, fps: 30 }, items: [item] };

describe('EpisodeSchema', () => {
  it('fills defaults', () => {
    const ep = EpisodeSchema.parse(base);
    expect(ep.items[0]).toMatchObject({ speed: 1, audio: 'mute', zoom: 1, hold: 0, quiet: false, onBeat: false });
    expect(ep).toMatchObject({ overlays: [], music: [], slots: [], voiceover: null, loudnessLufs: -14 });
  });
  it('rejects src.out <= src.in, naming the item', () => {
    const r = EpisodeSchema.safeParse({ ...base, items: [{ ...item, src: { in: 2, out: 2 } }] });
    expect(JSON.stringify(r.error?.issues)).toContain('item i1');
  });
  it('rejects duplicate item and slot ids', () => {
    expect(EpisodeSchema.safeParse({ ...base, items: [item, item] }).success).toBe(false);
    const slot = { id: 'n1', start: 0, end: 3, maxWords: 7 };
    expect(EpisodeSchema.safeParse({ ...base, slots: [slot, slot] }).success).toBe(false);
  });
  it('rejects overlays and cues that end before they start, and odd output sizes', () => {
    expect(EpisodeSchema.safeParse({ ...base, overlays: [{ kind: 'callout', text: '3 DAYS', start: 2, end: 1 }] }).success).toBe(false);
    expect(EpisodeSchema.safeParse({ ...base, music: [{ track: 'a.mp3', start: 5, end: 5 }] }).success).toBe(false);
    expect(EpisodeSchema.safeParse({ ...base, output: { width: 1921, height: 1080, fps: 30 } }).success).toBe(false);
  });
});

describe('CatalogSchema and MusicLibrarySchema', () => {
  it('parse minimal documents', () => {
    expect(CatalogSchema.parse({ version: 1, clips: [] }).clips).toEqual([]);
    const lib = MusicLibrarySchema.parse({ version: 1, tracks: [{ file: 'a.mp3', mood: 'upbeat' }] });
    expect(lib.tracks[0]).toMatchObject({ licence: '', bpm: null, beatOffset: null, durationSec: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/shared/src/schemas/episode.test.ts`
Expected: FAIL — cannot find module `./catalog.js`.

- [ ] **Step 3: Write the schemas**

`packages/shared/src/schemas/catalog.ts`:
```ts
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
```

`packages/shared/src/schemas/episode.ts`:
```ts
import { z } from 'zod';

const range = <T extends z.ZodRawShape>(shape: T, what: string) =>
  z.object({ start: z.number().min(0), end: z.number().positive(), ...shape }).refine((r) => r.end > r.start, { message: `${what}: end must be after start` });

export const BeatSchema = z.enum(['cold-open', 'title', 'recap', 'new-toy', 'problem', 'montage', 'twist', 'truth', 'outro', 'blooper']);
export type Beat = z.infer<typeof BeatSchema>;

export const TimelineItemSchema = z
  .object({
    id: z.string().min(1),
    beat: BeatSchema,
    clip: z.string().min(1),
    src: z.object({ in: z.number().min(0), out: z.number().positive() }),
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
  })
  .superRefine((it, ctx) => {
    if (it.src.out <= it.src.in) ctx.addIssue({ code: 'custom', message: `item ${it.id}: src.out must be greater than src.in` });
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
    gainDb: z.number().max(0).default(-18),
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

export const VoiceLineSchema = z.object({
  slot: z.string().min(1),
  /** Output time the line starts. */
  at: z.number().min(0),
  src: z.object({ in: z.number().min(0), out: z.number().positive() }),
  /** Ranges of the recording removed inside the line (fillers, long pauses). */
  cuts: z.array(z.tuple([z.number(), z.number()])).default([]),
});
export type VoiceLine = z.infer<typeof VoiceLineSchema>;

const even = z.number().int().positive().refine((n) => n % 2 === 0, { message: 'must be even' });

export const EpisodeSchema = z
  .object({
    version: z.literal(2),
    number: z.number().int().min(1),
    title: z.string().min(1),
    output: z.object({ width: even, height: even, fps: z.number().positive() }),
    items: z.array(TimelineItemSchema).min(1),
    overlays: z.array(OverlaySchema).default([]),
    music: z.array(MusicCueSchema).default([]),
    slots: z.array(SlotSchema).default([]),
    voiceover: z.object({ recording: z.string().min(1), lines: z.array(VoiceLineSchema) }).nullable().default(null),
    loudnessLufs: z.number().default(-14),
  })
  .superRefine((ep, ctx) => {
    for (const [list, what] of [[ep.items, 'item'], [ep.slots, 'slot']] as const) {
      const seen = new Set<string>();
      for (const x of list) {
        if (seen.has(x.id)) ctx.addIssue({ code: 'custom', message: `duplicate ${what} id ${x.id}` });
        seen.add(x.id);
      }
    }
  });
export type Episode = z.infer<typeof EpisodeSchema>;
```

`packages/shared/src/schemas/library.ts`:
```ts
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
```

Append to `packages/shared/src/index.ts`:
```ts
export * from './schemas/catalog.js';
export * from './schemas/episode.js';
export * from './schemas/library.js';
```

Run: `pnpm vitest run packages/shared/src/schemas/episode.test.ts` — expect pass.

- [ ] **Step 4: Export ffNum and encodeArgs from the compiler without changing its output**

In `packages/core/src/edl-compiler.ts`: rename the private `num` to an exported `ffNum` (same body) and update every use; add
```ts
export function encodeArgs(o: { mode: 'preview' | 'final'; encoder: Encoder; width: number; height: number; fps: number }): string[] {
  const video =
    o.mode === 'preview'
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28']
      : ['-c:v', o.encoder.name, ...o.encoder.extraArgs, '-b:v', bitrateFor(o.width, o.height, o.fps), '-g', String(Math.round(o.fps * 2))];
  const audio = o.mode === 'preview' ? ['-c:a', 'aac', '-b:a', '128k'] : ['-c:a', 'aac', '-b:a', '384k'];
  return [
    ...video,
    '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    ...audio, '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
  ];
}
```
and make `compileEdl` build its encode section with `encodeArgs({ mode: opts.mode, encoder: opts.encoder, width: edl.output.width, height: edl.output.height, fps })`.

Run: `pnpm vitest run packages/core/src/edl-compiler.test.ts` — expect pass with the snapshot **unchanged** (no `-u`).

- [ ] **Step 5: Write the failing timeline test**

`packages/core/src/mirage/timeline.test.ts`:
```ts
import { EpisodeSchema } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { itemFrames, layoutTimeline, shiftAfter, timelineDuration } from './timeline.js';

const ep = EpisodeSchema.parse({
  version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
  items: [
    { id: 'a', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 2 } },
    { id: 'b', beat: 'montage', clip: 'c002', src: { in: 0, out: 60 }, speed: 20 },
    { id: 'c', beat: 'truth', clip: 'c003', src: { in: 1, out: 2 }, hold: 0.5 },
  ],
  overlays: [
    { kind: 'callout', text: 'x', start: 1, end: 3 },
    { kind: 'badge', text: 'y', start: 3, end: 4 },
    { kind: 'label', text: 'z', start: 0, end: 1 },
  ],
  slots: [{ id: 'n1', start: 2.5, end: 5, maxWords: 5 }],
});

describe('timeline layout', () => {
  it('counts whole frames including speed and hold', () => {
    expect(itemFrames(ep.items[1], 30)).toEqual({ srcFrames: 90, holdFrames: 0, frames: 90 });
    expect(itemFrames(ep.items[2], 30)).toEqual({ srcFrames: 30, holdFrames: 15, frames: 45 });
  });
  it('lays items back to back', () => {
    expect(layoutTimeline(ep).map((l) => [l.item.id, l.start, l.end])).toEqual([['a', 0, 2], ['b', 2, 5], ['c', 5, 6.5]]);
    expect(timelineDuration(ep)).toBe(6.5);
  });
  it('never gives an item zero frames', () => {
    const tiny = EpisodeSchema.parse({ ...ep, items: [{ id: 't', beat: 'montage', clip: 'c', src: { in: 0, out: 0.001 } }] });
    expect(layoutTimeline(tiny)[0].frames).toBe(1);
  });
});

describe('shiftAfter', () => {
  it('moves ranges starting at or after the point and stretches ranges spanning it', () => {
    const s = shiftAfter(ep, 2, 1);
    expect(s.overlays.map((o) => [o.start, o.end])).toEqual([[1, 4], [4, 5], [0, 1]]);
    expect(s.slots[0]).toMatchObject({ start: 3.5, end: 6 });
    expect(s.items).toBe(ep.items);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/mirage/timeline.test.ts`
Expected: FAIL — cannot find module `./timeline.js`.

- [ ] **Step 7: Implement errors.ts, timeline.ts, index.ts**

`packages/core/src/mirage/errors.ts`:
```ts
export class MirageError extends Error {
  override name = 'MirageError';
  constructor(
    public code: 'BAD_ITEM' | 'NO_CATALOG' | 'NO_EPISODE' | 'NO_MUSIC_TRACK' | 'NOTHING_MATCHED' | 'DURATION_MISMATCH',
    message: string,
    public hint: string,
  ) {
    super(message);
  }
}
```

`packages/core/src/mirage/timeline.ts`:
```ts
import type { Episode, TimelineItem } from '@wordedits/shared';

export interface LaidItem {
  item: TimelineItem;
  index: number;
  start: number;
  end: number;
  srcFrames: number;
  holdFrames: number;
  frames: number;
}

export function itemFrames(item: TimelineItem, fps: number): { srcFrames: number; holdFrames: number; frames: number } {
  const srcFrames = Math.max(1, Math.round(((item.src.out - item.src.in) / item.speed) * fps));
  const holdFrames = Math.round(item.hold * fps);
  return { srcFrames, holdFrames, frames: srcFrames + holdFrames };
}

export function layoutTimeline(ep: Episode): LaidItem[] {
  const fps = ep.output.fps;
  let frame = 0;
  return ep.items.map((item, index) => {
    const f = itemFrames(item, fps);
    const start = frame / fps;
    frame += f.frames;
    return { item, index, start, end: frame / fps, ...f };
  });
}

export function timelineDuration(ep: Episode): number {
  const laid = layoutTimeline(ep);
  return laid.length ? laid[laid.length - 1].end : 0;
}

const EPS = 1e-9;
const shiftRange = <T extends { start: number; end: number }>(r: T, at: number, delta: number): T => ({
  ...r,
  start: r.start >= at - EPS ? r.start + delta : r.start,
  end: r.end > at + EPS ? r.end + delta : r.end,
});

/** Opens `delta` seconds at output time `at`: everything after moves, anything spanning it stretches. Items are untouched. */
export function shiftAfter(ep: Episode, at: number, delta: number): Episode {
  return {
    ...ep,
    overlays: ep.overlays.map((o) => shiftRange(o, at, delta)),
    music: ep.music.map((m) => shiftRange(m, at, delta)),
    slots: ep.slots.map((s) => shiftRange(s, at, delta)),
    voiceover: ep.voiceover
      ? { ...ep.voiceover, lines: ep.voiceover.lines.map((l) => (l.at >= at - EPS ? { ...l, at: l.at + delta } : l)) }
      : null,
  };
}
```

`packages/core/src/mirage/index.ts`:
```ts
export * from './errors.js';
export * from './timeline.js';
```
Append to `packages/core/src/index.ts`: `export * from './mirage/index.js';`

- [ ] **Step 8: Run, full suite, typecheck, commit**

Run: `pnpm vitest run packages/core/src/mirage/timeline.test.ts && pnpm test && pnpm typecheck` — all green.

```bash
git add -A && git commit -m "feat: catalog, music library and episode timeline schemas with layout helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Clip ingest into the catalog

**Files:**
- Create: `packages/core/src/mirage/ingest.ts`, `packages/core/src/mirage/ingest.test.ts`
- Modify: `packages/core/src/mirage/index.ts`

**Interfaces:**
- Consumes: `MediaTools` (`probe`, `runFfmpeg`, `extractWav`, `transcribe`), `readJsonFile`/`writeJsonFile`, catalog schemas.
- Produces: `VIDEO_EXTENSIONS: Set<string>`; `guessKind(probe: ProbeInfo, transcript: Transcript | null): ClipKind`; `frameInterval(durationSec: number): number`; `sha256File(path: string): Promise<string>`; `loadCatalog(project: string): Promise<Catalog>` (empty catalog when the file is missing); `saveCatalog(project: string, catalog: Catalog): Promise<void>`; `nextClipId(catalog: Catalog): string`; `interface IngestResult { added: Clip[]; skipped: { file: string; reason: string }[] }`; `ingestClips(o: { project: string; clipsDir: string; tools: MediaTools; locale?: string; onStep?: (m: string) => void }): Promise<IngestResult>`.

Catalog file: `<project>/catalog.json`; frames: `<project>/frames/<clip id>/f0001.jpg…` (640 px wide), `frames[].file` relative to the project. Clips are referenced in place (absolute `path`), never copied. Clips longer than 30 min are not transcribed.

- [ ] **Step 1: Write the failing test**

`packages/core/src/mirage/ingest.test.ts`:
```ts
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProbeInfo, Transcript } from '@wordedits/shared';
import { run } from '@wordedits/sidecars';
import { beforeAll, describe, expect, it } from 'vitest';
import { realMediaTools, type MediaTools } from '../media-tools.js';
import { frameInterval, guessKind, ingestClips, loadCatalog } from './ingest.js';

const probe = (o: Partial<ProbeInfo>): ProbeInfo => ({ durationSec: 10, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', ...o });
const words = (n: number, dur: number): Transcript => ({
  words: Array.from({ length: n }, (_, i) => ({ w: `w${i}`, start: (i * dur) / n, end: (i * dur) / n + 0.1, conf: 1 })),
  segments: [],
  speech: [],
});

describe('guessKind', () => {
  it('calls steady speech talking, long silent footage a timelapse, portrait a camera clip, the rest screen', () => {
    expect(guessKind(probe({ durationSec: 10 }), words(30, 10))).toBe('talking');
    expect(guessKind(probe({ durationSec: 3600 }), null)).toBe('timelapse');
    expect(guessKind(probe({ width: 1080, height: 1920 }), null)).toBe('camera');
    expect(guessKind(probe({}), words(3, 10))).toBe('screen');
  });
});

describe('frameInterval', () => {
  it('aims for about 40 frames, between 2 and 20 s apart', () => {
    expect(frameInterval(4)).toBe(2);
    expect(frameInterval(400)).toBe(10);
    expect(frameInterval(7200)).toBe(20);
  });
});

describe('ingestClips', () => {
  let tools: MediaTools;
  let clips: string;
  beforeAll(async () => {
    const real = await realMediaTools();
    tools = { ...real, transcribe: async () => words(10, 3) };
    clips = await mkdtemp(join(tmpdir(), "we clips 'q' "));
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(clips, 'screen.mp4')]);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(clips, 'phone.mov')]);
    await writeFile(join(clips, 'notes.txt'), 'not a clip');
    await writeFile(join(clips, '.hidden.mp4'), 'not a clip');
  });

  it('catalogs new clips with frames and transcripts, and skips known ones on re-run', async () => {
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    const r = await ingestClips({ project, clipsDir: clips, tools });
    expect(r.added.map((c) => [c.id, c.kind])).toEqual([['c001', 'talking'], ['c002', 'screen']]);
    const cat = await loadCatalog(project);
    expect(cat.clips[0].path).toBe(join(clips, 'phone.mov'));
    expect(cat.clips[0].transcript?.words).toHaveLength(10);
    expect(cat.clips[1].transcript).toBeNull();
    expect(cat.clips[1].frames.length).toBeGreaterThanOrEqual(2);
    expect(cat.clips[1].frames[1].t).toBe(2);
    expect(cat.clips[1].frames.every((f) => existsSync(join(project, f.file)))).toBe(true);

    const again = await ingestClips({ project, clipsDir: clips, tools });
    expect(again.added).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual(['already in the catalog', 'already in the catalog']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/mirage/ingest.test.ts`
Expected: FAIL — cannot find module `./ingest.js`.

- [ ] **Step 3: Implement ingest.ts**

`packages/core/src/mirage/ingest.ts`:
```ts
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { CatalogSchema, type Catalog, type Clip, type ClipKind, type ProbeInfo, type Transcript } from '@wordedits/shared';
import type { MediaTools } from '../media-tools.js';
import { readJsonFile, writeJsonFile } from '../project-store.js';

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm']);
const MAX_TRANSCRIBE_SEC = 30 * 60;

export function guessKind(probe: ProbeInfo, transcript: Transcript | null): ClipKind {
  const words = transcript?.words.length ?? 0;
  const wordsPerMinute = words / Math.max(probe.durationSec / 60, 1 / 60);
  if (wordsPerMinute >= 60) return 'talking';
  if (probe.durationSec >= 15 * 60) return 'timelapse';
  if (probe.height > probe.width) return 'camera';
  return 'screen';
}

export function frameInterval(durationSec: number): number {
  return Math.min(20, Math.max(2, Math.round(durationSec / 40)));
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function loadCatalog(project: string): Promise<Catalog> {
  try {
    return await readJsonFile(join(resolve(project), 'catalog.json'), CatalogSchema);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, clips: [] };
    throw e;
  }
}

export async function saveCatalog(project: string, catalog: Catalog): Promise<void> {
  await writeJsonFile(join(resolve(project), 'catalog.json'), CatalogSchema, catalog);
}

export function nextClipId(catalog: Catalog): string {
  const max = catalog.clips.reduce((m, c) => Math.max(m, Number(c.id.slice(1))), 0);
  return `c${String(max + 1).padStart(3, '0')}`;
}

export interface IngestResult {
  added: Clip[];
  skipped: { file: string; reason: string }[];
}

export async function ingestClips(o: { project: string; clipsDir: string; tools: MediaTools; locale?: string; onStep?: (m: string) => void }): Promise<IngestResult> {
  const project = resolve(o.project);
  const dir = resolve(o.clipsDir);
  await mkdir(project, { recursive: true });
  const catalog = await loadCatalog(project);
  const known = new Set(catalog.clips.map((c) => c.sha256));
  const files = (await readdir(dir)).filter((f) => !f.startsWith('.') && VIDEO_EXTENSIONS.has(extname(f).toLowerCase())).sort();
  const result: IngestResult = { added: [], skipped: [] };

  for (const name of files) {
    const path = join(dir, name);
    const sha256 = await sha256File(path);
    if (known.has(sha256)) {
      result.skipped.push({ file: name, reason: 'already in the catalog' });
      continue;
    }
    const probe = await o.tools.probe(path);
    if (!probe.hasVideo) {
      result.skipped.push({ file: name, reason: 'no video stream' });
      continue;
    }
    const id = nextClipId(catalog);
    o.onStep?.(`${name} → ${id}`);

    const framesDir = join(project, 'frames', id);
    await mkdir(framesDir, { recursive: true });
    const interval = frameInterval(probe.durationSec);
    await o.tools.runFfmpeg(['-i', path, '-vf', `fps=1/${interval},scale=640:-2`, '-q:v', '5', join(framesDir, 'f%04d.jpg')], {
      expectedDurationSec: probe.durationSec,
      timeoutMs: Math.max(120_000, probe.durationSec * 5000),
    });
    const frames = (await readdir(framesDir))
      .filter((f) => f.endsWith('.jpg'))
      .sort()
      .map((f, i) => ({ t: i * interval, file: relative(project, join(framesDir, f)) }));

    let transcript: Transcript | null = null;
    if (probe.hasAudio && probe.durationSec <= MAX_TRANSCRIBE_SEC) {
      const wav = join(project, `.tmp-${id}.wav`);
      try {
        await o.tools.extractWav(path, wav);
        transcript = await o.tools.transcribe(wav, { locale: o.locale });
      } finally {
        await rm(wav, { force: true });
      }
      if (transcript.words.length === 0) transcript = null;
    }

    const clip: Clip = { id, path, sha256, probe, kind: guessKind(probe, transcript), transcript, frames, notes: '', moments: [] };
    catalog.clips.push(clip);
    known.add(sha256);
    result.added.push(clip);
    await saveCatalog(project, catalog);
  }
  return result;
}
```
Add `export * from './ingest.js';` to `packages/core/src/mirage/index.ts`.

- [ ] **Step 4: Run, full suite, typecheck, commit**

Run: `pnpm vitest run packages/core/src/mirage/ingest.test.ts && pnpm test && pnpm typecheck` — all green.

```bash
git add -A && git commit -m "feat(core): ingest build clips into a catalog with frames and transcripts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Music library, tempo detection and beat snapping

**Files:**
- Create: `packages/core/src/mirage/tempo.ts`, `packages/core/src/mirage/tempo.test.ts`, `packages/core/src/mirage/music.ts`, `packages/core/src/mirage/music.test.ts`
- Modify: `packages/core/src/mirage/index.ts`

**Interfaces:**
- Consumes: `MediaTools.runFfmpeg`/`probe`; `itemFrames`, `shiftAfter`, `MirageError`; library/catalog/episode schemas.
- Produces: `interface Tempo { bpm: number; beatOffset: number; confidence: number }`; `onsetEnvelope(samples: Float32Array): Float32Array`; `detectTempo(samples: Float32Array, sampleRate: number): Tempo`; `decodeMono(file: string, tmpOut: string, tools: MediaTools, o: { sampleRate: number; maxSec?: number }): Promise<Float32Array>`; `AUDIO_EXTENSIONS: Set<string>`; `loadLibrary(dir: string): Promise<MusicLibrary>`; `analyzeLibrary(dir: string, tools: MediaTools): Promise<MusicLibrary>`; `snapToBeats(ep: Episode, catalog: Catalog, lib: MusicLibrary): Episode`.

Library file: `<project>/music/library.json`. `analyzeLibrary` adds any audio file in the folder that is not listed (mood `upbeat`, empty licence), and fills `bpm`, `beatOffset`, `durationSec` where null, from the first 90 s.

- [ ] **Step 1: Write the failing tempo test**

`packages/core/src/mirage/tempo.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { detectTempo } from './tempo.js';

const SR = 11025;
function clicks(bpm: number, offset: number, seconds: number): Float32Array {
  const x = new Float32Array(seconds * SR);
  for (let t = offset; t < seconds; t += 60 / bpm) {
    const s0 = Math.round(t * SR);
    for (let j = 0; j < 220 && s0 + j < x.length; j++) x[s0 + j] = Math.sin(j * 0.6) * Math.exp(-j / 40);
  }
  return x;
}

describe('detectTempo', () => {
  it('finds 120 BPM and the first beat', () => {
    const t = detectTempo(clicks(120, 0.25, 30), SR);
    expect(Math.abs(t.bpm - 120)).toBeLessThanOrEqual(1);
    expect(Math.abs(t.beatOffset - 0.25)).toBeLessThanOrEqual(0.03);
    expect(t.confidence).toBeGreaterThan(0);
  });
  it('finds 95 BPM without halving or doubling', () => {
    expect(Math.abs(detectTempo(clicks(95, 0.1, 30), SR).bpm - 95)).toBeLessThanOrEqual(1.5);
  });
  it('folds a slow pulse into the 80–160 range', () => {
    expect(Math.abs(detectTempo(clicks(140, 0, 30), SR).bpm - 140)).toBeLessThanOrEqual(1.5);
  });
  it('returns zero confidence for silence', () => {
    expect(detectTempo(new Float32Array(SR * 5), SR).confidence).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/mirage/tempo.test.ts`
Expected: FAIL — cannot find module `./tempo.js`.

- [ ] **Step 3: Implement tempo.ts**

`packages/core/src/mirage/tempo.ts`:
```ts
import { readFile, rm } from 'node:fs/promises';
import type { MediaTools } from '../media-tools.js';

export interface Tempo {
  bpm: number;
  beatOffset: number;
  confidence: number;
}

const HOP = 256;
const WIN = 1024;

/** Half-wave-rectified rise in RMS energy per hop. */
export function onsetEnvelope(samples: Float32Array): Float32Array {
  const n = Math.max(0, Math.floor((samples.length - WIN) / HOP) + 1);
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * HOP;
    for (let j = 0; j < WIN; j++) s += samples[o + j] * samples[o + j];
    energy[i] = Math.sqrt(s / WIN);
  }
  const onset = new Float32Array(n);
  for (let i = 1; i < n; i++) onset[i] = Math.max(0, energy[i] - energy[i - 1]);
  return onset;
}

function autocorr(onset: Float32Array, lag: number): number {
  const L = Math.round(lag);
  let s = 0;
  for (let i = 0; i + L < onset.length; i++) s += onset[i] * onset[i + L];
  return s / Math.max(1, onset.length - L);
}

export function detectTempo(samples: Float32Array, sampleRate: number): Tempo {
  const onset = onsetEnvelope(samples);
  let energy = 0;
  for (const v of onset) energy += v * v;
  if (energy === 0) return { bpm: 120, beatOffset: 0, confidence: 0 };

  const hopRate = sampleRate / HOP;
  const score = (bpm: number) => autocorr(onset, (hopRate * 60) / bpm) + 0.5 * autocorr(onset, (2 * hopRate * 60) / bpm);
  let bpm = 120;
  let best = -Infinity;
  for (let b = 60; b <= 200; b += 0.5) {
    const v = score(b);
    if (v > best) {
      best = v;
      bpm = b;
    }
  }
  if (bpm < 80 && score(bpm * 2) >= 0.5 * best) bpm *= 2;
  if (bpm > 160 && score(bpm / 2) >= 0.5 * best) bpm /= 2;

  const period = (hopRate * 60) / bpm;
  let bestOffset = 0;
  let bestPhase = -Infinity;
  for (let off = 0; off < period; off += 1) {
    let v = 0;
    for (let p = off; p < onset.length; p += period) v += onset[Math.round(p)] ?? 0;
    if (v > bestPhase) {
      bestPhase = v;
      bestOffset = off;
    }
  }
  // An onset at hop i means the click entered the window's end: time (i*HOP + WIN) / sampleRate.
  const beatOffset = ((bestOffset * HOP + WIN) / sampleRate) % (60 / bpm);
  return {
    bpm: Math.round(bpm * 10) / 10,
    beatOffset: Math.round(beatOffset * 1000) / 1000,
    confidence: Math.min(1, best / (energy / onset.length)),
  };
}

/** Decodes the first `maxSec` (or all) of a file to mono float PCM. */
export async function decodeMono(file: string, tmpOut: string, tools: MediaTools, o: { sampleRate: number; maxSec?: number }): Promise<Float32Array> {
  await tools.runFfmpeg([...(o.maxSec ? ['-t', String(o.maxSec)] : []), '-i', file, '-vn', '-ac', '1', '-ar', String(o.sampleRate), '-f', 'f32le', tmpOut]);
  try {
    const buf = await readFile(tmpOut);
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  } finally {
    await rm(tmpOut, { force: true });
  }
}
```

Run: `pnpm vitest run packages/core/src/mirage/tempo.test.ts` — expect pass. If the 140 BPM case lands on 70 or 280, fix the folding rule (not the test).

- [ ] **Step 4: Write the failing music test**

`packages/core/src/mirage/music.test.ts`:
```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type Catalog, type MusicLibrary } from '@wordedits/shared';
import { run } from '@wordedits/sidecars';
import { describe, expect, it } from 'vitest';
import { realMediaTools } from '../media-tools.js';
import { analyzeLibrary, snapToBeats } from './music.js';
import { layoutTimeline } from './timeline.js';

const lib = (bpm: number, beatOffset: number): MusicLibrary => ({ version: 1, tracks: [{ file: 'beat.wav', mood: 'upbeat', licence: '', bpm, beatOffset, durationSec: 60 }] });
const catalog = (dur: number): Catalog => ({
  version: 1,
  clips: [{ id: 'c001', path: '/x.mp4', sha256: 'a'.repeat(64), probe: { durationSec: dur, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: false, videoCodec: 'h264', audioCodec: null }, kind: 'screen', transcript: null, frames: [], notes: '', moments: [] }],
});
const episode = (items: object[], extra: object = {}) =>
  EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items, music: [{ track: 'beat.wav', start: 0, end: 20 }], ...extra });

describe('snapToBeats', () => {
  it('starts each cue on a beat and gives onBeat items whole-beat lengths, shifting what follows', () => {
    const ep = episode(
      [
        { id: 'a', beat: 'montage', clip: 'c001', src: { in: 0, out: 1.3 }, onBeat: true },
        { id: 'b', beat: 'montage', clip: 'c001', src: { in: 2, out: 2.2 }, onBeat: true },
        { id: 'c', beat: 'truth', clip: 'c001', src: { in: 3, out: 6 } },
      ],
      { overlays: [{ kind: 'callout', text: 'x', start: 5, end: 6 }] },
    );
    const s = snapToBeats(ep, catalog(60), lib(120, 0.1));
    expect(s.music[0].offset).toBeCloseTo(0.1);
    expect(layoutTimeline(s).map((l) => l.end - l.start)).toEqual([1.5, 0.5, 3]);
    expect(s.overlays[0].start).toBeCloseTo(5.5);
  });

  it('slows an item down when the clip has no more footage', () => {
    const ep = episode([{ id: 'a', beat: 'montage', clip: 'c001', src: { in: 0.2, out: 1.2 }, onBeat: true }]);
    const s = snapToBeats(ep, catalog(1.2), lib(100, 0));
    expect(s.items[0].speed).toBeCloseTo(1 / 1.2, 3);
    expect(layoutTimeline(s)[0].frames).toBe(36);
  });

  it('leaves items alone when no cue with a known tempo plays under them', () => {
    const ep = episode([{ id: 'a', beat: 'montage', clip: 'c001', src: { in: 0, out: 1.3 }, onBeat: true }], { music: [] });
    expect(snapToBeats(ep, catalog(60), lib(120, 0))).toEqual(ep);
  });
});

describe('analyzeLibrary', () => {
  it('adds unlisted tracks and detects their tempo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we music '));
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*880*t)*exp(-40*mod(t-0.1,0.5))*gte(mod(t-0.1,0.5),0)':s=44100:d=20", join(dir, 'beat.wav')]);
    const out = await analyzeLibrary(dir, await realMediaTools());
    expect(out.tracks).toHaveLength(1);
    expect(out.tracks[0].file).toBe('beat.wav');
    expect(Math.abs(out.tracks[0].bpm! - 120)).toBeLessThanOrEqual(1.5);
    expect(out.tracks[0].durationSec).toBeCloseTo(20, 0);
    expect(JSON.parse(await readFile(join(dir, 'library.json'), 'utf8')).tracks[0].mood).toBe('upbeat');
  });
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/mirage/music.test.ts`
Expected: FAIL — cannot find module `./music.js`.

- [ ] **Step 6: Implement music.ts**

`packages/core/src/mirage/music.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { MusicLibrarySchema, type Catalog, type Episode, type MusicLibrary } from '@wordedits/shared';
import type { MediaTools } from '../media-tools.js';
import { readJsonFile, writeJsonFile } from '../project-store.js';
import { MirageError } from './errors.js';
import { decodeMono, detectTempo } from './tempo.js';
import { itemFrames, shiftAfter } from './timeline.js';

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.aif', '.aiff', '.flac', '.ogg']);
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export async function loadLibrary(dir: string): Promise<MusicLibrary> {
  try {
    return await readJsonFile(join(resolve(dir), 'library.json'), MusicLibrarySchema);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, tracks: [] };
    throw e;
  }
}

export async function analyzeLibrary(dir: string, tools: MediaTools): Promise<MusicLibrary> {
  const root = resolve(dir);
  const lib = await loadLibrary(root);
  const files = (await readdir(root)).filter((f) => !f.startsWith('.') && AUDIO_EXTENSIONS.has(extname(f).toLowerCase())).sort();
  for (const file of files) {
    if (!lib.tracks.some((t) => t.file === file)) lib.tracks.push({ file, mood: 'upbeat', licence: '', bpm: null, beatOffset: null, durationSec: null });
  }
  for (const track of lib.tracks) {
    if (track.bpm !== null && track.beatOffset !== null && track.durationSec !== null) continue;
    const path = join(root, track.file);
    const p = await tools.probe(path).catch(() => null);
    if (!p?.hasAudio) throw new MirageError('NO_MUSIC_TRACK', `${track.file} is missing or has no audio`, 'Remove it from music/library.json or add the file.');
    const tempo = detectTempo(await decodeMono(path, join(root, `.tmp-${randomUUID()}.f32`), tools, { sampleRate: 11025, maxSec: 90 }), 11025);
    track.bpm = tempo.bpm;
    track.beatOffset = tempo.beatOffset;
    track.durationSec = p.durationSec;
  }
  await writeJsonFile(join(root, 'library.json'), MusicLibrarySchema, lib);
  return lib;
}

/**
 * Starts each cue on a beat of its track, then gives every onBeat item a whole number of beats
 * of the cue playing under it (extending the source, or slowing it when the clip runs out).
 * Everything after a changed item shifts with it.
 */
export function snapToBeats(ep: Episode, catalog: Catalog, lib: MusicLibrary): Episode {
  const track = (file: string) => lib.tracks.find((t) => t.file === file);
  let cur: Episode = {
    ...ep,
    music: ep.music.map((c) => {
      const t = track(c.track);
      if (!t?.bpm || t.beatOffset === null) return c;
      const beat = 60 / t.bpm;
      const k = Math.max(0, Math.ceil((c.offset - t.beatOffset) / beat - 1e-9));
      return { ...c, offset: r6(t.beatOffset + k * beat) };
    }),
  };
  if (cur.music.every((c, i) => c.offset === ep.music[i].offset) && !ep.items.some((it) => it.onBeat)) return ep;

  const fps = ep.output.fps;
  let t = 0;
  for (let i = 0; i < cur.items.length; i++) {
    const item = cur.items[i];
    const oldDur = itemFrames(item, fps).frames / fps;
    if (item.onBeat) {
      const cue = cur.music.find((c) => t >= c.start - 1e-6 && t < c.end);
      const tr = cue ? track(cue.track) : undefined;
      if (tr?.bpm) {
        const beat = 60 / tr.bpm;
        const target = Math.max(1, Math.round(oldDur / beat)) * beat;
        const clipDur = catalog.clips.find((c) => c.id === item.clip)?.probe.durationSec ?? item.src.out;
        let srcLen = target * item.speed;
        let speed = item.speed;
        if (item.src.in + srcLen > clipDur) {
          srcLen = clipDur - item.src.in;
          speed = srcLen / target;
        }
        const next = { ...item, speed: r6(speed), hold: 0, src: { in: item.src.in, out: r6(item.src.in + srcLen) } };
        const newDur = itemFrames(next, fps).frames / fps;
        const items = [...cur.items];
        items[i] = next;
        cur = { ...shiftAfter(cur, t + oldDur, newDur - oldDur), items };
        t += newDur;
        continue;
      }
    }
    t += oldDur;
  }
  return cur;
}
```
Add `export * from './tempo.js';` and `export * from './music.js';` to `packages/core/src/mirage/index.ts`.

- [ ] **Step 7: Run, full suite, typecheck, commit**

Run: `pnpm vitest run packages/core/src/mirage && pnpm test && pnpm typecheck` — all green.

```bash
git add -A && git commit -m "feat(core): music library with tempo detection and beat snapping

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Episode rendering: chunks, music bus, overlays, rough cut

**Files:**
- Create: `packages/core/src/mirage/overlays.ts`, `packages/core/src/mirage/overlays.test.ts`, `packages/core/src/mirage/render-episode.ts`, `packages/core/src/mirage/render-episode.test.ts`
- Modify: `packages/core/src/mirage/index.ts`

**Interfaces:**
- Consumes: `ffNum`, `encodeArgs` (Task 3); `layoutTimeline`, `LaidItem`, `MirageError`; `loadCatalog`; `loadLibrary`, `decodeMono`; `isFiller` (Task 2); `MediaTools.runFfmpeg` with `cwd`.
- Produces (overlays.ts): `interface Cue { start: number; end: number; text: string }`; `speechWords(ep: Episode, catalog: Catalog, vo: Transcript | null): Word[]` (output time, fillers removed); `keptSegments(line: VoiceLine): { in: number; out: number; offset: number }[]`; `groupCaptions(words: Word[], o: { durationSec: number; maxChars?: number; maxGap?: number; lead?: number; minDur?: number }): Cue[]`; `toSrt(cues: Cue[]): string`; `buildAss(o: { width: number; height: number; font?: string; captions: Cue[]; overlays: Overlay[]; prompts: Slot[] }): string`.
- Produces (render-episode.ts): `CHUNK_ITEMS = 30`; `interface ClipSource { path: string; hasAudio: boolean; durationSec: number }`; `sourcesFor(ep: Episode, catalog: Catalog): Map<string, ClipSource>` (throws `BAD_ITEM`); `chunkItems(laid: LaidItem[]): LaidItem[][]`; `itemChunkArgs(laid: LaidItem[], o: { width: number; height: number; fps: number }, sources: Map<string, ClipSource>, output: string): string[]`; `musicTrackArgs(cues: MusicCue[], lib: MusicLibrary, musicDir: string, durationSec: number, loudnessLufs: number, output: string): string[]`; `buildVoiceTrack(o: { recording: Float32Array; sampleRate: number; lines: VoiceLine[]; durationSec: number }): Float32Array`; `interface FinalEpisodeOptions { chunkList: string; output: string; encoder: Encoder; mode: 'preview' | 'final'; width: number; height: number; fps: number; durationSec: number; loudnessLufs: number; assFile: string; fontsDir?: string; musicWav?: string; voiceRaw?: string }`; `episodeFinalArgs(o: FinalEpisodeOptions): string[]`; `episodeDir(project: string, n: number): string`; `loadEpisode(project: string, n: number): Promise<Episode>`; `saveEpisode(project: string, ep: Episode): Promise<void>`; `type EpisodeMode = 'rough' | 'guide' | 'final'`; `renderEpisode(o: { project: string; episode: number; mode: EpisodeMode; tools: MediaTools; musicDir?: string; onProgress?: (f: number) => void }): Promise<{ outputPath: string; srtPath: string | null; durationSec: number }>`.

Files: episode at `<project>/episodes/<n>/episode.json`; outputs `rough.mp4`, `guide.mp4`, `final.mp4`, `final.srt` beside it; voice-over transcript at `voiceover.transcript.json` (written by Task 8). Rough: overlays + captions of live speech. Guide: overlays + prompts, no captions. Final: overlays + captions of all speech + voice-over.

- [ ] **Step 1: Write the failing overlays test**

`packages/core/src/mirage/overlays.test.ts`:
```ts
import { EpisodeSchema, type Catalog, type Transcript, type Word } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { buildAss, groupCaptions, keptSegments, speechWords, toSrt } from './overlays.js';

const w = (text: string, start: number, end: number): Word => ({ w: text, start, end, conf: 1 });
const tx = (words: Word[]): Transcript => ({ words, segments: [], speech: [] });
const catalog: Catalog = {
  version: 1,
  clips: [
    { id: 'c001', path: '/t.mov', sha256: 'a'.repeat(64), probe: { durationSec: 10, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac' }, kind: 'talking', transcript: tx([w('Hello', 1, 1.4), w('um', 1.5, 1.8), w('world.', 2, 2.5), w('later', 6, 6.5)]), frames: [], notes: '', moments: [] },
  ],
};
const ep = EpisodeSchema.parse({
  version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
  items: [
    { id: 'a', beat: 'cold-open', clip: 'c001', src: { in: 1, out: 3 }, audio: 'keep' },
    { id: 'b', beat: 'montage', clip: 'c001', src: { in: 5, out: 7 } },
  ],
  voiceover: { recording: 'vo.m4a', lines: [{ slot: 'n1', at: 2.5, src: { in: 10, out: 12 }, cuts: [[10.5, 11]] }] },
});

describe('speechWords', () => {
  it('maps kept live words and voice-over words to output time, dropping fillers and muted items', () => {
    const vo = tx([w('Narration', 10.1, 10.4), w('uh', 10.6, 10.9), w('here.', 11.2, 11.8)]);
    expect(speechWords(ep, catalog, vo).map((x) => [x.w, x.start, x.end])).toEqual([
      ['Hello', 0, 0.4],
      ['world.', 1, 1.5],
      ['Narration', 2.6, 2.9],
      ['here.', 3.2, 3.8],
    ]);
  });
});

describe('keptSegments', () => {
  it('splits a line around its cuts with running output offsets', () => {
    expect(keptSegments({ slot: 'n1', at: 0, src: { in: 10, out: 12 }, cuts: [[10.5, 11]] })).toEqual([
      { in: 10, out: 10.5, offset: 0 },
      { in: 11, out: 12, offset: 0.5 },
    ]);
  });
});

describe('groupCaptions and toSrt', () => {
  it('breaks at sentence ends and maxChars, never overlapping', () => {
    const cues = groupCaptions([w('Hello', 0.5, 0.8), w('there.', 0.8, 1.2), w('Next', 2.2, 2.5), w('bit.', 2.5, 2.9)], { durationSec: 10 });
    expect(cues.map((c) => c.text)).toEqual(['Hello there.', 'Next bit.']);
    expect(cues[0].start).toBeCloseTo(0.35);
    expect(cues[1].start).toBeGreaterThanOrEqual(cues[0].end);
    expect(toSrt(cues.slice(0, 1))).toBe('1\n00:00:00,350 --> 00:00:01,200\nHello there.\n');
  });
});

describe('buildAss', () => {
  const ass = buildAss({
    width: 1920, height: 1080, font: 'Helvetica Neue',
    captions: [{ start: 0.05, end: 1.3, text: 'Hi {there}' }],
    overlays: [
      { kind: 'callout', text: '3 DAYS', start: 1, end: 2.5, tone: 'neutral' },
      { kind: 'badge', text: 'FAILED', start: 3, end: 5, tone: 'fail' },
      { kind: 'counter', text: '12 h · 48 commits', start: 0, end: 10, tone: 'neutral' },
    ],
    prompts: [{ id: 'n1', start: 4, end: 9, maxWords: 12, line: 'Every request took ten seconds.' }],
  });
  it('declares one style per overlay kind sized to the frame', () => {
    expect(ass).toContain('PlayResX: 1920');
    for (const s of ['Caption', 'Callout', 'BadgeFail', 'BadgePass', 'BadgeLive', 'BadgeNeutral', 'Counter', 'Label', 'Chapter', 'Before', 'Prompt', 'PromptNext']) {
      expect(ass).toMatch(new RegExp(`^Style: ${s},`, 'm'));
    }
    expect(ass).toContain('Style: Caption,Helvetica Neue,64,');
  });
  it('writes events for captions, overlays and prompts, escaping braces', () => {
    expect(ass).toContain('Dialogue: 2,0:00:00.05,0:00:01.30,Caption,,0,0,0,,Hi (there)');
    expect(ass).toMatch(/Dialogue: 5,0:00:01\.00,0:00:02\.50,Callout,,0,0,0,,\{\\fad\(120,200\)[^}]*\}3 DAYS/);
    expect(ass).toContain(',BadgeFail,,0,0,0,,{\\fad(100,150)}FAILED');
    expect(ass).toContain('Dialogue: 6,0:00:02.50,0:00:04.00,PromptNext,,0,0,0,,Next: Every request took ten seconds.');
    expect(ass).toContain('Dialogue: 6,0:00:04.00,0:00:09.00,Prompt,,0,0,0,,Every request took ten seconds.');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/mirage/overlays.test.ts`
Expected: FAIL — cannot find module `./overlays.js`.

- [ ] **Step 3: Implement overlays.ts**

`packages/core/src/mirage/overlays.ts`:
```ts
import type { Catalog, Episode, Overlay, Slot, Transcript, VoiceLine, Word } from '@wordedits/shared';
import { isFiller } from '../autoedit/takes.js';
import { layoutTimeline } from './timeline.js';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const EPS = 1e-6;

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export function keptSegments(line: VoiceLine): { in: number; out: number; offset: number }[] {
  const cuts = [...line.cuts].sort((a, b) => a[0] - b[0]);
  const out: { in: number; out: number; offset: number }[] = [];
  let cursor = line.src.in;
  let offset = 0;
  for (const [a, b] of cuts) {
    if (a > cursor) {
      out.push({ in: cursor, out: a, offset });
      offset += a - cursor;
    }
    cursor = Math.max(cursor, b);
  }
  if (line.src.out > cursor) out.push({ in: cursor, out: line.src.out, offset });
  return out.map((s) => ({ in: r3(s.in), out: r3(s.out), offset: r3(s.offset) }));
}

/** Every spoken (non-filler) word on the output timeline: live audio of kept real-time items, plus the fitted voice-over. */
export function speechWords(ep: Episode, catalog: Catalog, vo: Transcript | null): Word[] {
  const fps = ep.output.fps;
  const out: Word[] = [];
  for (const l of layoutTimeline(ep)) {
    const { item } = l;
    if (item.audio !== 'keep' || item.speed !== 1) continue;
    const words = catalog.clips.find((c) => c.id === item.clip)?.transcript?.words ?? [];
    const srcEnd = item.src.in + l.srcFrames / fps;
    for (const w of words) {
      if (w.start < item.src.in - EPS || w.start >= srcEnd || isFiller(w)) continue;
      out.push({ ...w, start: r3(l.start + w.start - item.src.in), end: r3(l.start + Math.min(w.end, srcEnd) - item.src.in) });
    }
  }
  if (vo && ep.voiceover) {
    for (const line of ep.voiceover.lines) {
      const segs = keptSegments(line);
      for (const w of vo.words) {
        if (isFiller(w)) continue;
        const seg = segs.find((g) => w.start >= g.in - EPS && w.start < g.out);
        if (!seg) continue;
        out.push({ ...w, start: r3(line.at + seg.offset + w.start - seg.in), end: r3(line.at + seg.offset + Math.min(w.end, seg.out) - seg.in) });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const SENTENCE_END = /[.?!]["'”’)\]]*$/;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const tidy = (t: string) => t.replace(EMOJI, '').replace(/\s+([.,!?;:])/g, '$1').trim();

export function groupCaptions(words: Word[], o: { durationSec: number; maxChars?: number; maxGap?: number; lead?: number; minDur?: number }): Cue[] {
  const maxChars = o.maxChars ?? 38;
  const maxGap = o.maxGap ?? 0.6;
  const lead = o.lead ?? 0.15;
  const minDur = o.minDur ?? 0.8;
  const groups: { text: string; start: number; end: number }[][] = [];
  let cur: { text: string; start: number; end: number }[] = [];
  for (const word of words) {
    const text = tidy(word.w);
    if (!text) continue;
    const last = cur[cur.length - 1];
    const joined = [...cur.map((x) => x.text), text].join(' ');
    if (last && (joined.length > maxChars || word.start - last.end > maxGap || SENTENCE_END.test(last.text))) {
      groups.push(cur);
      cur = [];
    }
    cur.push({ text, start: word.start, end: word.end });
  }
  if (cur.length) groups.push(cur);

  const cues = groups.map((g) => ({ start: r3(Math.max(0, g[0].start - lead)), end: g[g.length - 1].end, text: tidy(g.map((x) => x.text).join(' ')) }));
  for (let i = 0; i < cues.length; i++) {
    if (i > 0) cues[i].start = Math.max(cues[i].start, cues[i - 1].end);
    const limit = i + 1 < cues.length ? cues[i + 1].start : o.durationSec;
    cues[i].end = r3(Math.max(cues[i].end, Math.min(cues[i].start + minDur, limit)));
  }
  return cues;
}

function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor((ms % 3_600_000) / 60_000))}:${p(Math.floor((ms % 60_000) / 1000))},${p(ms % 1000, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

function assTime(sec: number): string {
  const cs = Math.round(sec * 100);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(cs / 360_000)}:${p(Math.floor((cs % 360_000) / 6000))}:${p(Math.floor((cs % 6000) / 100))}.${p(cs % 100)}`;
}

const assText = (t: string) => t.replace(/\\/g, '/').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, '\\N');

function defaultFont(): string {
  if (process.platform === 'darwin') return 'Helvetica Neue';
  if (process.platform === 'win32') return 'Segoe UI';
  return 'DejaVu Sans';
}

// ASS colours are &HAABBGGRR (alpha 00 = opaque).
const WHITE = '&H00FFFFFF';
const BLACK = '&H00000000';
const BOX = '&H4D000000';

export function buildAss(o: { width: number; height: number; font?: string; captions: Cue[]; overlays: Overlay[]; prompts: Slot[] }): string {
  const k = Math.min(o.width, o.height) / 1080;
  const px = (n: number) => Math.max(1, Math.round(n * k));
  const font = o.font ?? defaultFont();
  const side = Math.round(o.width * 0.05);
  // Name, Fontsize, Primary, Outline, Back, Bold, BorderStyle, Outline, Alignment, MarginV
  const styles: [string, number, string, string, string, number, number, number, number, number][] = [
    ['Caption', px(64), WHITE, BOX, BOX, -1, 3, px(18), 2, px(90)],
    ['Callout', px(150), WHITE, BLACK, BLACK, -1, 1, px(6), 5, 0],
    ['BadgeFail', px(48), WHITE, '&H002A2AE0', '&H002A2AE0', -1, 3, px(14), 9, px(60)],
    ['BadgePass', px(48), WHITE, '&H004EAA2E', '&H004EAA2E', -1, 3, px(14), 9, px(60)],
    ['BadgeLive', px(48), WHITE, '&H00E37100', '&H00E37100', -1, 3, px(14), 9, px(60)],
    ['BadgeNeutral', px(48), WHITE, '&H00333333', '&H00333333', -1, 3, px(14), 9, px(60)],
    ['Counter', px(40), WHITE, BOX, BOX, -1, 3, px(12), 7, px(60)],
    ['Label', px(48), WHITE, BOX, BOX, -1, 3, px(14), 1, px(220)],
    ['Chapter', px(96), WHITE, BLACK, BLACK, -1, 1, px(4), 5, 0],
    ['Before', px(56), WHITE, BOX, BOX, -1, 3, px(14), 8, px(60)],
    ['Prompt', px(54), '&H0000D7FF', BOX, BOX, -1, 3, px(16), 8, px(150)],
    ['PromptNext', px(44), '&H00B4B4B4', BOX, BOX, 0, 3, px(14), 8, px(150)],
  ];
  const styleLines = styles.map(
    ([name, size, primary, outline, back, bold, border, outw, align, mv]) =>
      `Style: ${name},${font},${size},${primary},${primary},${outline},${back},${bold},0,0,0,100,100,0,0,${border},${outw},0,${align},${side},${side},${mv},1`,
  );

  const events: string[] = [];
  const ev = (layer: number, start: number, end: number, style: string, text: string) =>
    events.push(`Dialogue: ${layer},${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`);

  for (const c of o.captions) ev(2, c.start, c.end, 'Caption', assText(c.text));
  for (const ov of o.overlays) {
    const text = assText(ov.text);
    switch (ov.kind) {
      case 'callout':
        ev(5, ov.start, ov.end, 'Callout', `{\\fad(120,200)\\t(0,150,\\fscx115\\fscy115)\\t(150,300,\\fscx100\\fscy100)}${text}`);
        break;
      case 'badge':
        ev(4, ov.start, ov.end, `Badge${ov.tone[0].toUpperCase()}${ov.tone.slice(1)}`, `{\\fad(100,150)}${text}`);
        break;
      case 'counter':
        ev(3, ov.start, ov.end, 'Counter', text);
        break;
      case 'label':
        ev(3, ov.start, ov.end, 'Label', `{\\fad(150,150)}${text}`);
        break;
      case 'chapter':
        ev(5, ov.start, ov.end, 'Chapter', `{\\fad(300,300)}${text}`);
        break;
      case 'before':
      case 'after':
        ev(4, ov.start, ov.end, 'Before', text);
        break;
    }
  }
  for (const p of o.prompts) {
    if (!p.line.trim()) continue;
    ev(6, Math.max(0, p.start - 1.5), p.start, 'PromptNext', `Next: ${assText(p.line)}`);
    ev(6, p.start, p.end, 'Prompt', assText(p.line));
  }

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${o.width}`,
    `PlayResY: ${o.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styleLines,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
```

Run: `pnpm vitest run packages/core/src/mirage/overlays.test.ts` — expect pass. (`PromptNext` for the slot at 4 s starts at 2.5 s, as the test expects.)

- [ ] **Step 4: Write the failing render test**

`packages/core/src/mirage/render-episode.test.ts`:
```ts
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type Catalog, type MusicLibrary } from '@wordedits/shared';
import { run } from '@wordedits/sidecars';
import { beforeAll, describe, expect, it } from 'vitest';
import { realMediaTools, type MediaTools } from '../media-tools.js';
import { ingestClips } from './ingest.js';
import { analyzeLibrary } from './music.js';
import { buildVoiceTrack, episodeFinalArgs, itemChunkArgs, musicTrackArgs, renderEpisode, saveEpisode, sourcesFor } from './render-episode.js';
import { layoutTimeline, timelineDuration } from './timeline.js';

const enc = { name: 'libx264' as const, extraArgs: [] };
const clipOf = (id: string, dur: number, hasAudio: boolean) => ({
  id, path: `/clips/${id}.mp4`, sha256: 'a'.repeat(64),
  probe: { durationSec: dur, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio, videoCodec: 'h264', audioCodec: hasAudio ? 'aac' : null },
  kind: 'screen' as const, transcript: null, frames: [], notes: '', moments: [],
});
const cat: Catalog = { version: 1, clips: [clipOf('c001', 10, true), clipOf('c002', 600, false)] };
const ep = (items: object[], extra: object = {}) =>
  EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items, ...extra });

describe('sourcesFor', () => {
  it('stops with BAD_ITEM for a missing clip or a range past the clip end', () => {
    expect(() => sourcesFor(ep([{ id: 'x', beat: 'problem', clip: 'c999', src: { in: 0, out: 1 } }]), cat)).toThrow(expect.objectContaining({ code: 'BAD_ITEM', message: expect.stringContaining('x') }));
    expect(() => sourcesFor(ep([{ id: 'y', beat: 'problem', clip: 'c001', src: { in: 5, out: 12 } }]), cat)).toThrow(expect.objectContaining({ code: 'BAD_ITEM' }));
  });
});

describe('itemChunkArgs', () => {
  const e = ep([
    { id: 'a', beat: 'cold-open', clip: 'c001', src: { in: 1, out: 3 }, audio: 'keep', zoom: 1.2 },
    { id: 'b', beat: 'montage', clip: 'c002', src: { in: 0, out: 60 }, speed: 20, audio: 'keep' },
  ]);
  const args = itemChunkArgs(layoutTimeline(e), { width: 960, height: 540, fps: 30 }, sourcesFor(e, cat), '/w/chunk-000.mov');
  const graph = args[args.indexOf('-filter_complex') + 1];
  it('seeks each item and reads only the source it needs at its speed', () => {
    expect(args.slice(0, 8)).toEqual(['-threads', '1', '-ss', '1', '-t', '2.033333', '-i', '/clips/c001.mp4']);
    expect(args.slice(8, 16)).toEqual(['-threads', '1', '-ss', '0', '-t', '60.666667', '-i', '/clips/c002.mp4']);
  });
  it('speeds up, punches in, letterboxes and cuts to exact frames', () => {
    expect(graph).toContain('[0:v]setpts=(PTS-STARTPTS)/1,crop=trunc(iw/1.2/2)*2:trunc(ih/1.2/2)*2,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,tpad=stop=-1:stop_mode=clone,trim=end_frame=60,setpts=PTS-STARTPTS[v0]');
    expect(graph).toContain('[1:v]setpts=(PTS-STARTPTS)/20,');
  });
  it('keeps live audio only at real-time speed; sped-up items get silence', () => {
    expect(graph).toContain('[0:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end=2,asetpts=PTS-STARTPTS[a0]');
    expect(graph).toContain('anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end=3,aformat=sample_fmts=fltp:channel_layouts=stereo[a1]');
    expect(graph).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[vcat][acat]');
    expect(args.at(-1)).toBe('/w/chunk-000.mov');
  });
});

describe('musicTrackArgs', () => {
  const lib: MusicLibrary = { version: 1, tracks: [{ file: 'a.mp3', mood: 'upbeat', licence: '', bpm: 120, beatOffset: 0, durationSec: 8 }] };
  it('loops, offsets, normalises, fades and places each cue; zero fades add no filter', () => {
    const args = musicTrackArgs([{ track: 'a.mp3', start: 2, end: 12, gainDb: -18, fadeIn: 0, fadeOut: 1, offset: 0.5 }], lib, '/m', 15, -14, '/w/music.wav');
    expect(args.slice(0, 6)).toEqual(['-stream_loop', '-1', '-ss', '0.5', '-i', '/m/a.mp3']);
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('atrim=duration=10');
    expect(graph).toContain('loudnorm=I=-32:TP=-2:LRA=11');
    expect(graph).not.toContain('afade=t=in');
    expect(graph).toContain('afade=t=out:st=9:d=1');
    expect(graph).toContain('adelay=delays=2000:all=1');
    expect(graph).toContain('amix=inputs=1:duration=longest:normalize=0,apad,atrim=end=15[out]');
  });
  it('throws NO_MUSIC_TRACK for a cue whose track is not in the library', () => {
    expect(() => musicTrackArgs([{ track: 'zz.mp3', start: 0, end: 1, gainDb: -18, fadeIn: 0, fadeOut: 0, offset: 0 }], lib, '/m', 2, -14, '/w/m.wav')).toThrow(expect.objectContaining({ code: 'NO_MUSIC_TRACK' }));
  });
});

describe('buildVoiceTrack', () => {
  it('places kept segments at their output time', () => {
    const rec = new Float32Array(100).fill(0.5);
    const out = buildVoiceTrack({ recording: rec, sampleRate: 10, lines: [{ slot: 'n1', at: 1, src: { in: 2, out: 6 }, cuts: [[3, 4]] }], durationSec: 8 });
    expect(out.length).toBe(80);
    expect(out[5]).toBe(0);
    expect(out[15]).toBeCloseTo(0.5);
    expect(out[50]).toBe(0);
  });
});

describe('episodeFinalArgs', () => {
  it('builds speech and ducked music buses from relative file names', () => {
    const args = episodeFinalArgs({ chunkList: 'chunks.txt', output: '/o/final.mp4.partial', encoder: enc, mode: 'final', width: 1920, height: 1080, fps: 30, durationSec: 20, loudnessLufs: -14, assFile: 'overlays.ass', fontsDir: '/System/Library/Fonts', musicWav: 'music.wav', voiceRaw: 'vo.f32' });
    expect(args).toEqual(expect.arrayContaining(['-f', 'concat', '-safe', '0', '-i', 'chunks.txt', '-i', 'music.wav', '-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', 'vo.f32']));
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('[0:v]ass=overlays.ass:fontsdir=/System/Library/Fonts[vout]');
    expect(graph).toContain('[live][vo]amix=inputs=2:duration=first:normalize=0[speechraw]');
    expect(graph).toContain('[speechraw]highpass=f=90,loudnorm=I=-14:TP=-1:LRA=11');
    expect(graph).toContain('[mus][skey]sidechaincompress=threshold=0.03:ratio=8:attack=150:release=900[duck]');
    expect(args).toEqual(expect.arrayContaining(['-b:v', '8M', '-t', '20']));
    expect(args.at(-1)).toBe('/o/final.mp4.partial');
  });
  it('has no music or voice inputs when there are none', () => {
    const args = episodeFinalArgs({ chunkList: 'chunks.txt', output: '/o.mp4', encoder: enc, mode: 'preview', width: 960, height: 540, fps: 30, durationSec: 5, loudnessLufs: -14, assFile: 'overlays.ass' });
    expect(args.filter((a) => a === '-i')).toHaveLength(1);
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('[0:a]anull[speechraw]');
  });
});

describe('renderEpisode (real ffmpeg)', () => {
  let tools: MediaTools;
  let project: string;
  beforeAll(async () => {
    tools = { ...(await realMediaTools()), transcribe: async () => ({ words: [], segments: [], speech: [] }) };
    project = await mkdtemp(join(tmpdir(), "we proj 'q' ✨ "));
    const clips = join(project, 'raw clips');
    await mkdir(clips, { recursive: true });
    const gen = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(clips, 'a-talk.mp4')]);
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(clips, 'b-phone.mp4')]);
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=60', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(clips, 'c-long.mp4')]);
    await ingestClips({ project, clipsDir: clips, tools });
    await mkdir(join(project, 'music'), { recursive: true });
    await gen(['-f', 'lavfi', '-i', "aevalsrc='0.6*sin(2*PI*440*t)*exp(-20*mod(t,0.5))':s=44100:d=8", join(project, 'music', 'loop.wav')]);
    await analyzeLibrary(join(project, 'music'), tools);
  }, 300_000);

  it('renders a rough cut of 31 items (2 chunks) with a portrait clip, a 20x item, overlays and looping music', async () => {
    const items = [
      { id: 'talk', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 3 }, audio: 'keep' },
      { id: 'phone', beat: 'recap', clip: 'c002', src: { in: 0, out: 2 } },
      { id: 'fast', beat: 'montage', clip: 'c003', src: { in: 0, out: 40 }, speed: 20 },
      ...Array.from({ length: 28 }, (_, i) => ({ id: `m${i}`, beat: 'montage', clip: 'c003', src: { in: i, out: i + 0.3 } })),
    ];
    const e = ep(items, {
      overlays: [{ kind: 'callout', text: '3 DAYS', start: 0.5, end: 1.5 }, { kind: 'badge', text: 'FAILED', start: 3, end: 5, tone: 'fail' }],
      music: [{ track: 'loop.wav', start: 3, end: 15 }],
    });
    await saveEpisode(project, e);
    const r = await renderEpisode({ project, episode: 1, mode: 'rough', tools });
    const p = await tools.probe(r.outputPath);
    expect(Math.abs(p.durationSec - timelineDuration(e))).toBeLessThanOrEqual(0.1);
    expect([p.width, p.height]).toEqual([960, 540]);
    expect(p.hasAudio).toBe(true);
    expect(r.outputPath.endsWith(join('episodes', '1', 'rough.mp4'))).toBe(true);
    expect((await readdir(join(project, 'episodes', '1'))).filter((f) => f.startsWith('.work-') || f.includes('.partial-'))).toEqual([]);
  }, 300_000);
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/mirage/render-episode.test.ts`
Expected: FAIL — cannot find module `./render-episode.js`.

- [ ] **Step 6: Implement render-episode.ts**

`packages/core/src/mirage/render-episode.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EpisodeSchema, TranscriptSchema, type Catalog, type Episode, type MusicCue, type MusicLibrary, type Transcript, type VoiceLine } from '@wordedits/shared';
import { encodeArgs, ffNum } from '../edl-compiler.js';
import type { Encoder, MediaTools } from '../media-tools.js';
import { readJsonFile, writeJsonFile } from '../project-store.js';
import { MirageError } from './errors.js';
import { loadCatalog } from './ingest.js';
import { loadLibrary } from './music.js';
import { buildAss, groupCaptions, keptSegments, speechWords, toSrt } from './overlays.js';
import { decodeMono } from './tempo.js';
import { layoutTimeline, type LaidItem } from './timeline.js';

export const CHUNK_ITEMS = 30;
const pad3 = (i: number) => String(i).padStart(3, '0');

export interface ClipSource {
  path: string;
  hasAudio: boolean;
  durationSec: number;
}

export function sourcesFor(ep: Episode, catalog: Catalog): Map<string, ClipSource> {
  const map = new Map<string, ClipSource>();
  for (const item of ep.items) {
    const clip = catalog.clips.find((c) => c.id === item.clip);
    if (!clip) throw new MirageError('BAD_ITEM', `item ${item.id}: clip ${item.clip} is not in the catalog`, 'Run ingest, or fix the clip id in episode.json.');
    if (item.src.out > clip.probe.durationSec + 0.05) {
      throw new MirageError('BAD_ITEM', `item ${item.id}: src.out ${item.src.out}s is past the end of ${item.clip} (${clip.probe.durationSec}s)`, 'Shorten the item.');
    }
    map.set(clip.id, { path: clip.path, hasAudio: clip.probe.hasAudio, durationSec: clip.probe.durationSec });
  }
  return map;
}

export function chunkItems(laid: LaidItem[]): LaidItem[][] {
  const out: LaidItem[][] = [];
  for (let i = 0; i < laid.length; i += CHUNK_ITEMS) out.push(laid.slice(i, i + CHUNK_ITEMS));
  return out;
}

const FLTP_STEREO = 'aformat=sample_fmts=fltp:channel_layouts=stereo';

export function itemChunkArgs(laid: LaidItem[], o: { width: number; height: number; fps: number }, sources: Map<string, ClipSource>, output: string): string[] {
  const inputs: string[] = [];
  const chains: string[] = [];
  const labels: string[] = [];
  laid.forEach((l, k) => {
    const { item } = l;
    const src = sources.get(item.clip)!;
    // One extra output frame of source so fps never comes up short.
    inputs.push('-threads', '1', '-ss', ffNum(item.src.in), '-t', ffNum(((l.srcFrames + 1) / o.fps) * item.speed), '-i', src.path);
    const zoom = item.zoom > 1 + 1e-6 ? `crop=trunc(iw/${ffNum(item.zoom)}/2)*2:trunc(ih/${ffNum(item.zoom)}/2)*2,` : '';
    chains.push(
      `[${k}:v]setpts=(PTS-STARTPTS)/${ffNum(item.speed)},${zoom}` +
        `scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease,pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,` +
        `fps=${ffNum(o.fps)},tpad=stop=-1:stop_mode=clone,trim=end_frame=${l.frames},setpts=PTS-STARTPTS[v${k}]`,
    );
    const dur = ffNum(l.frames / o.fps);
    if (item.audio === 'keep' && item.speed === 1 && src.hasAudio) {
      chains.push(`[${k}:a]asetpts=PTS-STARTPTS,aresample=48000,${FLTP_STEREO},apad,atrim=end=${dur},asetpts=PTS-STARTPTS[a${k}]`);
    } else {
      chains.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end=${dur},${FLTP_STEREO}[a${k}]`);
    }
    labels.push(`[v${k}][a${k}]`);
  });
  chains.push(`${labels.join('')}concat=n=${laid.length}:v=1:a=1[vcat][acat]`);
  return [
    ...inputs,
    '-filter_complex', chains.join(';'),
    '-map', '[vcat]', '-map', '[acat]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-g', String(Math.round(o.fps)),
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    output,
  ];
}

export function musicTrackArgs(cues: MusicCue[], lib: MusicLibrary, musicDir: string, durationSec: number, loudnessLufs: number, output: string): string[] {
  const inputs: string[] = [];
  const chains: string[] = [];
  cues.forEach((c, i) => {
    if (!lib.tracks.some((t) => t.file === c.track)) {
      throw new MirageError('NO_MUSIC_TRACK', `music cue ${i + 1}: ${c.track} is not in music/library.json`, 'Run: pnpm mirage music <project>, or fix the track name.');
    }
    inputs.push('-stream_loop', '-1', '-ss', ffNum(c.offset), '-i', join(musicDir, c.track));
    const dur = c.end - c.start;
    const fades = [
      c.fadeIn > 0 ? `afade=t=in:d=${ffNum(Math.min(c.fadeIn, dur / 2))}` : '',
      c.fadeOut > 0 ? `afade=t=out:st=${ffNum(Math.max(0, dur - c.fadeOut))}:d=${ffNum(Math.min(c.fadeOut, dur))}` : '',
    ].filter(Boolean);
    chains.push(
      [
        `[${i}:a]atrim=duration=${ffNum(dur)}`,
        'asetpts=PTS-STARTPTS',
        `aresample=48000,${FLTP_STEREO}`,
        `loudnorm=I=${ffNum(loudnessLufs + c.gainDb)}:TP=-2:LRA=11`,
        `aresample=48000,${FLTP_STEREO}`,
        ...fades,
        `adelay=delays=${Math.round(c.start * 1000)}:all=1[m${i}]`,
      ].join(','),
    );
  });
  chains.push(`${cues.map((_, i) => `[m${i}]`).join('')}amix=inputs=${cues.length}:duration=longest:normalize=0,apad,atrim=end=${ffNum(durationSec)}[out]`);
  return [...inputs, '-filter_complex', chains.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', output];
}

export function buildVoiceTrack(o: { recording: Float32Array; sampleRate: number; lines: VoiceLine[]; durationSec: number }): Float32Array {
  const sr = o.sampleRate;
  const out = new Float32Array(Math.round(o.durationSec * sr));
  const fade = Math.max(1, Math.round(0.008 * sr));
  for (const line of o.lines) {
    for (const seg of keptSegments(line)) {
      const from = Math.round(seg.in * sr);
      const to = Math.min(o.recording.length, Math.round(seg.out * sr));
      const at = Math.round((line.at + seg.offset) * sr);
      const n = to - from;
      for (let i = 0; i < n && at + i < out.length; i++) {
        const gain = Math.max(0, Math.min(1, i / fade, (n - 1 - i) / fade));
        out[at + i] += o.recording[from + i] * (fade <= 1 ? 1 : gain);
      }
    }
  }
  return out;
}

export interface FinalEpisodeOptions {
  chunkList: string;
  output: string;
  encoder: Encoder;
  mode: 'preview' | 'final';
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  loudnessLufs: number;
  assFile: string;
  fontsDir?: string;
  musicWav?: string;
  voiceRaw?: string;
}

export function episodeFinalArgs(o: FinalEpisodeOptions): string[] {
  const inputs = ['-f', 'concat', '-safe', '0', '-i', o.chunkList];
  let next = 1;
  const musicIdx = o.musicWav ? next++ : -1;
  if (o.musicWav) inputs.push('-i', o.musicWav);
  const voiceIdx = o.voiceRaw ? next++ : -1;
  if (o.voiceRaw) inputs.push('-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', o.voiceRaw);
  const D = ffNum(o.durationSec);

  const chains = [`[0:v]ass=${o.assFile}${o.fontsDir ? `:fontsdir=${o.fontsDir}` : ''}[vout]`];
  if (o.voiceRaw) {
    chains.push(`[0:a]${FLTP_STEREO}[live]`, `[${voiceIdx}:a]${FLTP_STEREO},apad,atrim=end=${D}[vo]`, '[live][vo]amix=inputs=2:duration=first:normalize=0[speechraw]');
  } else {
    chains.push('[0:a]anull[speechraw]');
  }
  chains.push(
    `[speechraw]highpass=f=90,loudnorm=I=${ffNum(o.loudnessLufs)}:TP=-1:LRA=11,aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,asetpts=N/SR/TB${o.musicWav ? '[speech]' : '[aout]'}`,
  );
  if (o.musicWav) {
    chains.push(
      '[speech]asplit=2[smix][skey]',
      `[${musicIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=end=${D}[mus]`,
      '[mus][skey]sidechaincompress=threshold=0.03:ratio=8:attack=150:release=900[duck]',
      '[smix][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.891:level=false[aout]',
    );
  }
  return [...inputs, '-filter_complex', chains.join(';'), '-map', '[vout]', '-map', '[aout]', ...encodeArgs(o), '-t', D, o.output];
}

export const episodeDir = (project: string, n: number) => join(resolve(project), 'episodes', String(n));

export async function loadEpisode(project: string, n: number): Promise<Episode> {
  try {
    return await readJsonFile(join(episodeDir(project, n), 'episode.json'), EpisodeSchema);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MirageError('NO_EPISODE', `episodes/${n}/episode.json does not exist`, 'Ask Claude to write the episode timeline first.');
    }
    throw e;
  }
}

export async function saveEpisode(project: string, ep: Episode): Promise<void> {
  const dir = episodeDir(project, ep.number);
  await mkdir(dir, { recursive: true });
  await writeJsonFile(join(dir, 'episode.json'), EpisodeSchema, ep);
}

export type EpisodeMode = 'rough' | 'guide' | 'final';

export async function renderEpisode(o: { project: string; episode: number; mode: EpisodeMode; tools: MediaTools; musicDir?: string; onProgress?: (f: number) => void }): Promise<{ outputPath: string; srtPath: string | null; durationSec: number }> {
  const project = resolve(o.project);
  const ep = await loadEpisode(project, o.episode);
  const catalog = await loadCatalog(project);
  if (catalog.clips.length === 0) throw new MirageError('NO_CATALOG', 'The project has no catalogued clips', 'Run: pnpm mirage ingest <project> <clips folder>');
  const sources = sourcesFor(ep, catalog);
  const laid = layoutTimeline(ep);
  const D = laid[laid.length - 1].end;
  const fps = ep.output.fps;
  const final = o.mode === 'final';
  const [W, H] = final ? [ep.output.width, ep.output.height] : [960, 540];
  const dir = episodeDir(project, o.episode);
  const musicDir = resolve(o.musicDir ?? join(project, 'music'));
  const outputPath = join(dir, `${o.mode}.mp4`);
  const id = randomUUID();
  const work = join(dir, `.work-${id}`);
  const partial = `${outputPath}.partial-${id}.mp4`;
  await mkdir(work, { recursive: true });
  const report = (f: number) => o.onProgress?.(Math.min(1, Math.max(0, f)));

  try {
    const chunks = chunkItems(laid);
    let done = 0;
    for (const [i, chunk] of chunks.entries()) {
      const dur = chunk.reduce((s, l) => s + l.frames / fps, 0);
      await o.tools.runFfmpeg(itemChunkArgs(chunk, { width: W, height: H, fps }, sources, join(work, `chunk-${pad3(i)}.mov`)), {
        expectedDurationSec: dur,
        timeoutMs: Math.max(120_000, dur * 30 * 1000),
        onProgress: (f) => report((0.6 * (done + f * dur)) / D),
      });
      done += dur;
    }
    await writeFile(join(work, 'chunks.txt'), chunks.map((_, i) => `file 'chunk-${pad3(i)}.mov'`).join('\n') + '\n');

    let musicWav: string | undefined;
    if (ep.music.length) {
      await o.tools.runFfmpeg(musicTrackArgs(ep.music, await loadLibrary(musicDir), musicDir, D, ep.loudnessLufs, join(work, 'music.wav')), {
        expectedDurationSec: D,
        timeoutMs: Math.max(120_000, D * 10 * 1000),
      });
      musicWav = 'music.wav';
    }
    report(0.7);

    let voiceRaw: string | undefined;
    let voTranscript: Transcript | null = null;
    if (final && ep.voiceover) {
      const pcm = await decodeMono(resolve(project, ep.voiceover.recording), join(work, 'rec.f32'), o.tools, { sampleRate: 48000 });
      const track = buildVoiceTrack({ recording: pcm, sampleRate: 48000, lines: ep.voiceover.lines, durationSec: D });
      await writeFile(join(work, 'vo.f32'), Buffer.from(track.buffer, track.byteOffset, track.byteLength));
      voiceRaw = 'vo.f32';
      voTranscript = await readJsonFile(join(dir, 'voiceover.transcript.json'), TranscriptSchema);
    }

    const cues = o.mode === 'guide' ? [] : groupCaptions(speechWords(ep, catalog, voTranscript), { durationSec: D });
    await writeFile(join(work, 'overlays.ass'), buildAss({ width: W, height: H, captions: cues, overlays: ep.overlays, prompts: o.mode === 'guide' ? ep.slots : [] }));

    const encoder = final ? await o.tools.pickEncoder() : { name: 'libx264' as const, extraArgs: [] };
    await o.tools.runFfmpeg(
      episodeFinalArgs({
        chunkList: 'chunks.txt', output: partial, encoder, mode: final ? 'final' : 'preview', width: W, height: H, fps, durationSec: D,
        loudnessLufs: ep.loudnessLufs, assFile: 'overlays.ass', fontsDir: process.platform === 'darwin' ? '/System/Library/Fonts' : undefined, musicWav, voiceRaw,
      }),
      { cwd: work, expectedDurationSec: D, timeoutMs: Math.max(120_000, D * 20 * 1000), onProgress: (f) => report(0.7 + 0.3 * f) },
    );
    const probe = await o.tools.probe(partial);
    if (Math.abs(probe.durationSec - D) > Math.max(0.1, 1 / fps)) {
      throw new MirageError('DURATION_MISMATCH', `Rendered ${probe.durationSec}s but the timeline is ${D}s`, 'A clip may be shorter than the catalog says; re-run ingest.');
    }
    await rename(partial, outputPath);
    let srtPath: string | null = null;
    if (final) {
      srtPath = join(dir, 'final.srt');
      await writeFile(srtPath, toSrt(cues));
    }
    report(1);
    return { outputPath, srtPath, durationSec: D };
  } catch (e) {
    await rm(partial, { force: true }).catch(() => {});
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
```
Add `export * from './overlays.js';` and `export * from './render-episode.js';` to `packages/core/src/mirage/index.ts`.

- [ ] **Step 7: Run, full suite, typecheck, commit**

Run: `pnpm vitest run packages/core/src/mirage/render-episode.test.ts && pnpm test && pnpm typecheck` — all green. If ffmpeg rejects a chain, run the failing command by hand from the work directory (keep it by commenting out the `finally` cleanup while debugging), fix the smallest thing, and record the evidence in the report.

```bash
git add -A && git commit -m "feat(core): render episode rough cuts from multi-clip timelines with overlays and music

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Narration slots

**Files:**
- Create: `packages/core/src/mirage/slots.ts`, `packages/core/src/mirage/slots.test.ts`
- Modify: `packages/core/src/mirage/index.ts`

**Interfaces:**
- Consumes: `speechWords` (Task 6), `layoutTimeline`, `timelineDuration`.
- Produces: `computeSlots(ep: Episode, catalog: Catalog, o?: { minLen?: number; pad?: number; wpm?: number }): Slot[]`; `mergeSlots(prev: Slot[], next: Slot[]): Slot[]` (carries each written line to the new slot it overlaps most).

- [ ] **Step 1: Write the failing test**

`packages/core/src/mirage/slots.test.ts`:
```ts
import { EpisodeSchema, type Catalog } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { computeSlots, mergeSlots } from './slots.js';

const catalog: Catalog = {
  version: 1,
  clips: [
    { id: 'c001', path: '/t.mov', sha256: 'a'.repeat(64), probe: { durationSec: 30, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac' }, kind: 'talking', transcript: { words: [{ w: 'Hi', start: 0.5, end: 1 }, { w: 'there.', start: 1.1, end: 2.5 }].map((w) => ({ ...w, conf: 1 })), segments: [], speech: [] }, frames: [], notes: '', moments: [] },
  ],
};
const ep = EpisodeSchema.parse({
  version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
  items: [
    { id: 'talk', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 3 }, audio: 'keep' },
    { id: 'screen', beat: 'problem', clip: 'c001', src: { in: 10, out: 16 } },
    { id: 'reveal', beat: 'truth', clip: 'c001', src: { in: 20, out: 23 }, quiet: true },
    { id: 'tail', beat: 'outro', clip: 'c001', src: { in: 24, out: 26 } },
  ],
});

describe('computeSlots', () => {
  it('finds speech-free stretches outside quiet items, sized at 170 wpm', () => {
    expect(computeSlots(ep, catalog)).toEqual([{ id: 'n1', start: 2.8, end: 9, maxWords: 16, line: '' }]);
  });
  it('honours minLen', () => {
    expect(computeSlots(ep, catalog, { minLen: 1.5 }).map((s) => [s.start, s.end])).toEqual([[2.8, 9], [12, 14]]);
  });
});

describe('mergeSlots', () => {
  it('carries written lines to the most-overlapping new slot', () => {
    const prev = [{ id: 'n1', start: 2, end: 8, maxWords: 16, line: 'Old line.' }];
    const next = [{ id: 'n1', start: 0, end: 1, maxWords: 0, line: '' }, { id: 'n2', start: 3, end: 9, maxWords: 16, line: '' }];
    expect(mergeSlots(prev, next).map((s) => s.line)).toEqual(['', 'Old line.']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/mirage/slots.test.ts`
Expected: FAIL — cannot find module `./slots.js`.

- [ ] **Step 3: Implement slots.ts**

`packages/core/src/mirage/slots.ts`:
```ts
import type { Catalog, Episode, Slot } from '@wordedits/shared';
import { speechWords } from './overlays.js';
import { layoutTimeline, timelineDuration } from './timeline.js';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function computeSlots(ep: Episode, catalog: Catalog, o: { minLen?: number; pad?: number; wpm?: number } = {}): Slot[] {
  const minLen = o.minLen ?? 2.5;
  const pad = o.pad ?? 0.3;
  const wpm = o.wpm ?? 170;
  const D = timelineDuration(ep);
  const busy: [number, number][] = [];
  for (const w of speechWords(ep, catalog, null)) busy.push([Math.max(0, w.start - pad), Math.min(D, w.end + pad)]);
  for (const l of layoutTimeline(ep)) if (l.item.quiet) busy.push([l.start, l.end]);
  busy.sort((a, b) => a[0] - b[0]);

  const free: [number, number][] = [];
  let cursor = 0;
  for (const [a, b] of busy) {
    if (a > cursor) free.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (D > cursor) free.push([cursor, D]);

  return free
    .filter(([a, b]) => b - a >= minLen - 1e-9)
    .map(([a, b], i) => ({ id: `n${i + 1}`, start: r3(a), end: r3(b), maxWords: Math.max(0, Math.floor(((b - a - 0.4) * wpm) / 60)), line: '' }));
}

export function mergeSlots(prev: Slot[], next: Slot[]): Slot[] {
  const used = new Set<number>();
  return next.map((slot) => {
    let best = -1;
    let bestOverlap = 0;
    prev.forEach((p, i) => {
      if (used.has(i) || !p.line.trim()) return;
      const overlap = Math.min(p.end, slot.end) - Math.max(p.start, slot.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = i;
      }
    });
    if (best < 0) return slot;
    used.add(best);
    return { ...slot, line: prev[best].line };
  });
}
```
Add `export * from './slots.js';` to `packages/core/src/mirage/index.ts`.

Check the expected numbers while implementing: speech ends at 2.5 + 0.3 = 2.8; the screen item runs 3–9; the quiet reveal 9–12; tail 12–14 (2 s, under `minLen`). maxWords = floor((6.2 − 0.4) × 170 / 60) = 16.

- [ ] **Step 4: Run, full suite, typecheck, commit**

Run: `pnpm vitest run packages/core/src/mirage/slots.test.ts && pnpm test && pnpm typecheck` — all green.

```bash
git add -A && git commit -m "feat(core): narration slots from speech-free stretches of the cut

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Fitting the voice-over

**Files:**
- Create: `packages/core/src/mirage/voiceover.ts`, `packages/core/src/mirage/voiceover.test.ts`
- Modify: `packages/core/src/mirage/index.ts`

**Interfaces:**
- Consumes: `splitSentences`, `sentenceTokens`, `textTokens`, `similarity`, `isFiller` (Task 2); `keptSegments` (Task 6); `layoutTimeline`, `shiftAfter`, `itemFrames`, `MirageError`.
- Produces: `interface FitLine { slot: string; status: 'placed' | 'missing'; takes: number; overrunSec: number }`; `interface FitReport { lines: FitLine[]; extendedSec: number }`; `holdAt(ep: Episode, catalog: Catalog, t: number, delta: number): Episode` (may split an item; the second part gets id `<id>-b`); `fitVoiceover(o: { episode: Episode; catalog: Catalog; recording: string; transcript: Transcript }): { episode: Episode; report: FitReport }`.

Rules (spec §14.2 step 7): match each written slot line, in slot order, to 1–4 consecutive recording sentences with word similarity ≥ 0.6, after the previous line's match; among good matches (within 0.15 of the best) take the **latest** start that ends before the next line's first match (last take wins). Inside the chosen span cut fillers (±0.02 s) and pauses > 0.6 s (keeping 0.15 s each side). Place at slot start + 0.15 s. If the line ends more than 0.2 s past its slot, round the overrun up to whole frames and open that much time **at the slot end**: if the slot ends at an item boundary, extend that item (unused source first, then frozen frames); if it ends inside an item, split the item there and freeze its frame for the overrun. Everything after the slot end shifts.

- [ ] **Step 1: Write the failing test**

`packages/core/src/mirage/voiceover.test.ts`:
```ts
import { EpisodeSchema, type Catalog, type Transcript, type Word } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { fitVoiceover, holdAt } from './voiceover.js';
import { layoutTimeline, timelineDuration } from './timeline.js';

function said(text: string, t0: number, per = 0.3): Word[] {
  return text.split(' ').map((w, i) => ({ w, start: +(t0 + i * per).toFixed(3), end: +(t0 + i * per + 0.25).toFixed(3), conf: 1 }));
}
const tx = (words: Word[]): Transcript => ({ words, segments: [], speech: [] });
const catalog = (dur: number): Catalog => ({
  version: 1,
  clips: [{ id: 'c001', path: '/s.mp4', sha256: 'a'.repeat(64), probe: { durationSec: dur, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: false, videoCodec: 'h264', audioCodec: null }, kind: 'screen', transcript: null, frames: [], notes: '', moments: [] }],
});
const episode = (slots: object[]) =>
  EpisodeSchema.parse({
    version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
    items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 20 } }],
    overlays: [{ kind: 'badge', text: 'LIVE', start: 15, end: 18, tone: 'live' }],
    slots,
  });

const SLOTS = [
  { id: 'n1', start: 2, end: 5, maxWords: 7, line: 'This is the first line.' },
  { id: 'n2', start: 10, end: 12, maxWords: 4, line: 'And here is the second one.' },
];
const RECORDING = tx([
  ...said('This is the first line.', 0),
  ...said('This is the first line.', 2),
  { w: 'Um,', start: 3.6, end: 3.9, conf: 1 },
  ...said('And here is the second one.', 4, 0.45),
]);

describe('fitVoiceover', () => {
  it('keeps the last take, places it at the slot start and reports the takes', () => {
    const { episode: ep, report } = fitVoiceover({ episode: episode(SLOTS), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    const n1 = ep.voiceover!.lines.find((l) => l.slot === 'n1')!;
    expect(n1.src.in).toBeCloseTo(1.95);
    expect(n1.src.out).toBeCloseTo(3.55);
    expect(n1.at).toBeCloseTo(2.15);
    expect(report.lines[0]).toMatchObject({ slot: 'n1', status: 'placed', takes: 2, overrunSec: 0 });
  });

  it('holds the picture when a line runs past its slot, shifting what follows', () => {
    const { episode: ep, report } = fitVoiceover({ episode: episode(SLOTS), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    expect(report.lines[1].status).toBe('placed');
    expect(report.lines[1].overrunSec).toBeGreaterThan(0.5);
    expect(timelineDuration(ep)).toBeCloseTo(20 + report.extendedSec, 3);
    expect(ep.items[0].hold).toBeCloseTo(report.extendedSec, 3);
    expect(ep.overlays[0].start).toBeCloseTo(15 + report.extendedSec, 3);
    expect(ep.voiceover!.recording).toBe('vo.m4a');
  });

  it('reports a line it cannot find as missing, without moving anything', () => {
    const slots = [SLOTS[0], { id: 'n3', start: 14, end: 18, maxWords: 11, line: 'Completely different words appear here.' }];
    const { episode: ep, report } = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: RECORDING });
    expect(report.lines.map((l) => [l.slot, l.status])).toEqual([['n1', 'placed'], ['n3', 'missing']]);
    expect(ep.voiceover!.lines.map((l) => l.slot)).toEqual(['n1']);
  });

  it('cuts fillers and long pauses inside a line', () => {
    const rec = tx([...said('So the build', 0), { w: 'uh', start: 1.0, end: 1.3, conf: 1 }, ...said('kept failing.', 2.5)]);
    const slots = [{ id: 'n1', start: 0, end: 6, maxWords: 15, line: 'So the build kept failing.' }];
    const line = fitVoiceover({ episode: episode(slots), catalog: catalog(20), recording: 'vo.m4a', transcript: rec }).episode.voiceover!.lines[0];
    expect(line.cuts).toEqual([[0.98, 2.35]]);
  });

  it('throws NOTHING_MATCHED when no line is found', () => {
    expect(() => fitVoiceover({ episode: episode(SLOTS), catalog: catalog(20), recording: 'vo.m4a', transcript: tx(said('Totally unrelated speech.', 0)) })).toThrow(expect.objectContaining({ code: 'NOTHING_MATCHED' }));
  });
});

describe('holdAt', () => {
  it('uses unused source before freezing frames', () => {
    const ep = EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 5 } }] });
    const held = holdAt(ep, catalog(6), 5, 2);
    expect(held.items[0].src.out).toBeCloseTo(6);
    expect(held.items[0].hold).toBeCloseTo(1);
    expect(layoutTimeline(held)[0].end).toBeCloseTo(7);
  });
  it('splits an item and freezes its frame when the point is inside it', () => {
    const ep = EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 10 } }], overlays: [{ kind: 'label', text: 'x', start: 6, end: 7 }] });
    const held = holdAt(ep, catalog(20), 4, 1);
    expect(held.items.map((i) => [i.id, i.src.in, i.src.out, i.hold])).toEqual([['a', 0, 4, 1], ['a-b', 4, 10, 0]]);
    expect(timelineDuration(held)).toBeCloseTo(11);
    expect(held.overlays[0].start).toBeCloseTo(7);
  });
});
```

Derivation of the cut expectation: "So" 0–0.25, "the" 0.3–0.55, "build" 0.6–0.85, "uh" 1.0–1.3, "kept" 2.5–2.75. Filler cut `[0.98, 1.32]`; pause "build"→"kept" is 1.65 s → cut `[1.0, 2.35]`; merged `[0.98, 2.35]`. In the first test the second take's last word ends at 3.45, so `src.out` = 3.55.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/mirage/voiceover.test.ts`
Expected: FAIL — cannot find module `./voiceover.js`.

- [ ] **Step 3: Implement voiceover.ts**

`packages/core/src/mirage/voiceover.ts`:
```ts
import { EpisodeSchema, type Catalog, type Episode, type Transcript, type VoiceLine } from '@wordedits/shared';
import { isFiller, sentenceTokens, similarity, splitSentences, textTokens } from '../autoedit/takes.js';
import { MirageError } from './errors.js';
import { keptSegments } from './overlays.js';
import { itemFrames, layoutTimeline, shiftAfter } from './timeline.js';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export interface FitLine {
  slot: string;
  status: 'placed' | 'missing';
  takes: number;
  overrunSec: number;
}

export interface FitReport {
  lines: FitLine[];
  extendedSec: number;
}

/**
 * Opens `delta` seconds at output time `t`. At an item boundary the item ending there grows (unused source first,
 * then frozen frames); inside an item, the item splits at `t` and its frame there is held. Everything after `t` shifts.
 */
export function holdAt(ep: Episode, catalog: Catalog, t: number, delta: number): Episode {
  const fps = ep.output.fps;
  const laid = layoutTimeline(ep);
  const l = laid.find((x) => t > x.start + 1e-9 && t <= x.end + 1e-9) ?? laid[laid.length - 1];
  const item = l.item;
  const items = [...ep.items];
  const atEnd = Math.abs(l.end - t) < 0.5 / fps || t >= l.start + l.srcFrames / fps;

  if (atEnd) {
    const clipDur = catalog.clips.find((c) => c.id === item.clip)?.probe.durationSec ?? item.src.out;
    const available = Math.max(0, (clipDur - item.src.out) / item.speed);
    const useSource = Math.min(delta, available);
    const next = { ...item, src: { in: item.src.in, out: r6(item.src.out + useSource * item.speed) }, hold: r6(item.hold + (delta - useSource)) };
    items[l.index] = next;
    const grown = itemFrames(next, fps).frames / fps - l.frames / fps;
    return { ...shiftAfter(ep, l.end, grown), items };
  }

  const splitFrames = Math.max(1, Math.round((t - l.start) * fps));
  const splitSrc = r6(item.src.in + (splitFrames / fps) * item.speed);
  const ids = new Set(ep.items.map((x) => x.id));
  let suffix = 'b';
  while (ids.has(`${item.id}-${suffix}`)) suffix = String.fromCharCode(suffix.charCodeAt(0) + 1);
  const first = { ...item, src: { in: item.src.in, out: splitSrc }, hold: r6(delta) };
  const second = { ...item, id: `${item.id}-${suffix}`, src: { in: splitSrc, out: item.src.out } };
  items.splice(l.index, 1, first, second);
  return { ...shiftAfter(ep, l.start + splitFrames / fps, delta), items };
}

function mergeCuts(cuts: [number, number][]): [number, number][] {
  const sorted = [...cuts].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]);
    else out.push([c[0], c[1]]);
  }
  return out;
}

export function fitVoiceover(o: { episode: Episode; catalog: Catalog; recording: string; transcript: Transcript }): { episode: Episode; report: FitReport } {
  const words = o.transcript.words;
  const sentences = splitSentences(words);
  const sTokens = sentences.map((s) => sentenceTokens(s, words));
  const written = o.episode.slots.filter((s) => s.line.trim()).sort((a, b) => a.start - b.start);
  const fps = o.episode.output.fps;

  type Cand = { from: number; to: number; score: number };
  const cands: Cand[][] = written.map((slot) => {
    const lineTokens = textTokens(slot.line);
    const out: Cand[] = [];
    for (let i = 0; i < sentences.length; i++) {
      let tokens: string[] = [];
      for (let j = i; j < Math.min(sentences.length, i + 4); j++) {
        tokens = tokens.concat(sTokens[j]);
        const score = similarity(tokens, lineTokens);
        if (score >= 0.6) out.push({ from: i, to: j, score });
      }
    }
    return out;
  });

  let ep = o.episode;
  const lines: VoiceLine[] = [];
  const report: FitReport = { lines: [], extendedSec: 0 };
  let prevEnd = -1;

  for (let k = 0; k < written.length; k++) {
    const after = cands[k].filter((c) => c.from > prevEnd);
    const nextFirst = k + 1 < written.length ? Math.min(Infinity, ...cands[k + 1].filter((c) => c.from > prevEnd).map((c) => c.from)) : Infinity;
    let pool = after.filter((c) => c.to < nextFirst);
    if (pool.length === 0) pool = after;
    if (pool.length === 0) {
      report.lines.push({ slot: written[k].id, status: 'missing', takes: 0, overrunSec: 0 });
      continue;
    }
    const best = Math.max(...pool.map((c) => c.score));
    const good = pool.filter((c) => c.score >= best - 0.15);
    const chosen = good.reduce((a, b) => (b.from > a.from ? b : a));
    const takes = new Set(good.map((c) => c.from)).size;
    prevEnd = chosen.to;

    const span = words.slice(sentences[chosen.from].from, sentences[chosen.to].to + 1);
    const spoken = span.filter((w) => !isFiller(w));
    const srcIn = Math.max(0, spoken[0].start - 0.05);
    const srcOut = spoken[spoken.length - 1].end + 0.1;
    const cuts: [number, number][] = [];
    for (const w of span) if (isFiller(w) && w.start > srcIn && w.end < srcOut) cuts.push([r3(w.start - 0.02), r3(w.end + 0.02)]);
    for (let i = 1; i < spoken.length; i++) {
      const a = spoken[i - 1].end;
      const b = spoken[i].start;
      if (b - a > 0.6) cuts.push([r3(a + 0.15), r3(b - 0.15)]);
    }
    const draft: VoiceLine = { slot: written[k].id, at: 0, src: { in: r3(srcIn), out: r3(srcOut) }, cuts: mergeCuts(cuts) };
    const duration = keptSegments(draft).reduce((s, g) => s + g.out - g.in, 0);

    const slot = ep.slots.find((s) => s.id === written[k].id)!;
    const at = r3(slot.start + 0.15);
    let overrun = at + duration - (slot.end + 0.2);
    if (overrun > 1e-3) {
      overrun = Math.ceil(overrun * fps - 1e-9) / fps;
      ep = holdAt(ep, o.catalog, slot.end, overrun);
      report.extendedSec = r6(report.extendedSec + overrun);
    } else {
      overrun = 0;
    }
    lines.push({ ...draft, at });
    report.lines.push({ slot: slot.id, status: 'placed', takes, overrunSec: r3(overrun) });
  }

  if (!report.lines.some((l) => l.status === 'placed')) {
    throw new MirageError('NOTHING_MATCHED', 'None of the script lines were found in the recording', 'Check that you read the current lines; re-run slots and guide if the cut changed.');
  }
  return { episode: EpisodeSchema.parse({ ...ep, voiceover: { recording: o.recording, lines } }), report };
}
```
Add `export * from './voiceover.js';` to `packages/core/src/mirage/index.ts`.

- [ ] **Step 4: Run, full suite, typecheck, commit**

Run: `pnpm vitest run packages/core/src/mirage/voiceover.test.ts && pnpm test && pnpm typecheck` — all green (with the corrected `[[0.98, 2.35]]` expectation).

```bash
git add -A && git commit -m "feat(core): fit a voice-over recorded last into the cut's narration slots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `pnpm mirage` CLI, the episode skill, and an end-to-end run

**Files:**
- Create: `scripts/mirage.ts`, `.claude/skills/mirage-episode/SKILL.md`, `packages/core/src/mirage/e2e.test.ts`
- Modify: `package.json` (add `"mirage": "tsx scripts/mirage.ts"`), `README.md`, `packages/core/src/mirage/timeline.ts` (add `formatTime`)

**Interfaces:**
- Consumes: everything above.
- Produces: CLI commands `init <project> --title <t>`, `ingest <project> <clips-dir>`, `music <project>`, `check <project> <n>`, `cut <project> <n>`, `slots <project> <n>`, `guide <project> <n>`, `vo <project> <n> <recording>`, `render <project> <n>`; project skill `mirage-episode` describing Claude's creative steps.

`check` loads and validates the episode against the catalog (`sourcesFor`), applies `snapToBeats` when the music library has tracks and saves the result, then prints one line per item (`#  beat  id  clip  src  speed  start–end`) and the total. `cut` = `check` + `renderEpisode(rough)`. `slots` = `computeSlots` + `mergeSlots` with existing slots, save, print each slot with its time range and word budget. `vo` extracts a 16 kHz WAV, transcribes, saves `episodes/<n>/voiceover.transcript.json`, stores the recording path relative to the project when it is inside it (absolute otherwise), runs `fitVoiceover`, saves, and prints the report.

- [ ] **Step 1: Write the CLI**

`scripts/mirage.ts`:
```ts
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { TranscriptSchema } from '@wordedits/shared';
import {
  analyzeLibrary, computeSlots, episodeDir, fitVoiceover, formatTime, ingestClips, layoutTimeline, loadCatalog, loadEpisode, loadLibrary,
  mergeSlots, realMediaTools, renderEpisode, saveEpisode, snapToBeats, sourcesFor, timelineDuration, writeJsonFile, type EpisodeMode,
} from '@wordedits/core';

const USAGE = `usage: pnpm mirage <command> ...

  init <project> --title "<title>"     create a project folder
  ingest <project> <clips-folder>      catalog a batch of clips
  music <project>                      detect tempo of tracks in <project>/music
  check <project> <episode>            validate the timeline, snap montages to the beat, list it
  cut <project> <episode>              render the rough cut (picture, music, overlays)
  slots <project> <episode>            find narration slots and their word budgets
  guide <project> <episode>            render the guide video with lines on screen
  vo <project> <episode> <recording>   fit the voice-over you recorded
  render <project> <episode>           render the final episode with captions
`;

const { positionals, values } = parseArgs({ allowPositionals: true, options: { title: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
const [cmd, projectArg, third, fourth] = positionals;
if (values.help || !cmd || !projectArg) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}
const project = resolve(projectArg);
const episodeNumber = () => {
  const n = Number(third);
  if (!Number.isInteger(n) || n < 1) {
    console.error('episode must be a number like 1');
    process.exit(2);
  }
  return n;
};
let last = -1;
const progress = (f: number) => {
  const pct = Math.floor(f * 100);
  if (pct !== last) {
    last = pct;
    process.stdout.write(`\r  ${pct}%`);
  }
};

async function check(n: number) {
  const catalog = await loadCatalog(project);
  let ep = await loadEpisode(project, n);
  sourcesFor(ep, catalog);
  const lib = await loadLibrary(join(project, 'music'));
  if (lib.tracks.length) ep = snapToBeats(ep, catalog, lib);
  await saveEpisode(project, ep);
  for (const l of layoutTimeline(ep)) {
    const it = l.item;
    console.log(`${String(l.index + 1).padStart(3)}  ${it.beat.padEnd(9)} ${it.id.padEnd(12)} ${it.clip}  ${it.src.in.toFixed(2)}–${it.src.out.toFixed(2)}  ×${it.speed}  ${l.start.toFixed(2)}–${l.end.toFixed(2)}${it.quiet ? '  quiet' : ''}`);
  }
  console.log(`total ${formatTime(timelineDuration(ep))} · ${ep.items.length} items · ${ep.overlays.length} overlays · ${ep.music.length} music cues`);
  return ep;
}

async function main() {
  const tools = await realMediaTools();
  switch (cmd) {
    case 'init': {
      await mkdir(join(project, 'episodes'), { recursive: true });
      await mkdir(join(project, 'music'), { recursive: true });
      await writeFile(join(project, 'mirage.json'), JSON.stringify({ version: 1, title: values.title ?? 'Untitled build', createdAt: new Date().toISOString() }, null, 2) + '\n');
      console.log(`created ${project}`);
      break;
    }
    case 'ingest': {
      if (!third) throw Object.assign(new Error('missing clips folder'), { hint: USAGE });
      const r = await ingestClips({ project, clipsDir: third, tools, onStep: (m) => console.log(`• ${m}`) });
      for (const s of r.skipped) console.log(`  skipped ${s.file}: ${s.reason}`);
      console.log(`✓ ${r.added.length} clips added`);
      break;
    }
    case 'music': {
      const lib = await analyzeLibrary(join(project, 'music'), tools);
      for (const t of lib.tracks) console.log(`  ${t.file}  ${t.mood}  ${t.bpm} BPM  ${t.durationSec?.toFixed(0)} s`);
      break;
    }
    case 'check':
      await check(episodeNumber());
      break;
    case 'cut':
    case 'guide':
    case 'render': {
      const n = episodeNumber();
      if (cmd === 'cut') await check(n);
      const mode: EpisodeMode = cmd === 'cut' ? 'rough' : cmd === 'guide' ? 'guide' : 'final';
      const r = await renderEpisode({ project, episode: n, mode, tools, onProgress: progress });
      console.log(`\n✓ ${r.outputPath} (${formatTime(r.durationSec)})${r.srtPath ? `\n  captions: ${r.srtPath}` : ''}`);
      break;
    }
    case 'slots': {
      const n = episodeNumber();
      const ep = await loadEpisode(project, n);
      const slots = mergeSlots(ep.slots, computeSlots(ep, await loadCatalog(project)));
      await saveEpisode(project, { ...ep, slots });
      for (const s of slots) console.log(`  ${s.id}  ${s.start.toFixed(1)}–${s.end.toFixed(1)} s  ≤${s.maxWords} words  ${s.line || '(no line yet)'}`);
      break;
    }
    case 'vo': {
      const n = episodeNumber();
      if (!fourth) throw Object.assign(new Error('missing recording'), { hint: USAGE });
      const rec = resolve(fourth);
      const dir = episodeDir(project, n);
      const wav = join(dir, '.vo.wav');
      console.log('• Transcribing your voice-over…');
      await tools.extractWav(rec, wav);
      let transcript;
      try {
        transcript = await tools.transcribe(wav);
      } finally {
        await rm(wav, { force: true });
      }
      await writeJsonFile(join(dir, 'voiceover.transcript.json'), TranscriptSchema, transcript);
      const rel = relative(project, rec);
      const recording = rel.startsWith('..') || isAbsolute(rel) ? rec : rel;
      const { episode, report } = fitVoiceover({ episode: await loadEpisode(project, n), catalog: await loadCatalog(project), recording, transcript });
      await saveEpisode(project, episode);
      for (const l of report.lines) console.log(`  ${l.slot}  ${l.status}${l.takes > 1 ? `  (${l.takes} takes, used the last)` : ''}${l.overrunSec ? `  held picture +${l.overrunSec}s` : ''}`);
      console.log(`✓ voice-over fitted${report.extendedSec ? `, episode ${report.extendedSec.toFixed(2)} s longer` : ''}`);
      break;
    }
    default:
      console.log(USAGE);
      process.exit(2);
  }
}

main().catch((e: { message?: string; hint?: string }) => {
  console.error(`\n✖ ${e.message ?? String(e)}`);
  if (e.hint) console.error(`  ${e.hint}`);
  process.exit(1);
});
```

`formatTime` comes from Task 3 of the superseded plan's `plan.ts`, which this plan does **not** build. Add it to `packages/core/src/mirage/timeline.ts` instead (and export it):
```ts
export function formatTime(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
```
`writeJsonFile` is exported from `@wordedits/core` via `project-store.ts`.

Run: `pnpm mirage` → usage, exit 2.

- [ ] **Step 2: Write the episode skill**

`.claude/skills/mirage-episode/SKILL.md`:
````markdown
---
name: mirage-episode
description: Make a Mirage build-story episode with the user — catalog their clips, write the episode timeline (picture, music, overlays), write narration lines for the cut, fit their voice-over and render. Use when the user wants to make, edit or finish a Mirage episode, or drops new build clips.
---

# Making a Mirage episode

Mirage episodes follow spec §14 (`docs/superpowers/specs/2026-09-28-wordedits-design.md`). You do the creative steps; `pnpm mirage` does the mechanical ones. Never invent footage, numbers or events: everything comes from the clips, the catalog and what the user tells you.

## 1. Catalog the batch
`pnpm mirage ingest <project> <clips folder>`. Then for each new clip in `<project>/catalog.json`:
- Read 3–8 of its frames (`frames[].file`, relative to the project) and the transcript if any.
- Set `kind` if the guess is wrong (`screen`, `camera`, `talking`, `timelapse`).
- Write `notes` (one sentence: what it shows) and `moments` (`{t, label}` for errors appearing, tests passing, deploys, before/after screens, reactions).
- Ask the user only for what frames cannot tell you (what went wrong, how long it took, numbers for counters).
Remind the user once per project that frames are sent to Anthropic, so screens with secrets should not be recorded.

## 2. Music
Tracks go in `<project>/music/`. `pnpm mirage music <project>` writes `library.json`; set each track's `mood` (`punchy`, `light`, `tension`, `upbeat`, `riser`, `reveal`, `relaxed`) and `licence`.

## 3. Write `episodes/<n>/episode.json` (version 2)
Beats in order, about 13 minutes total, scaled to the footage you have (shorter is fine; never pad):
cold-open (stakes in the first line + 6–10 teaser shots) → title → recap (callback to the previous episode's `summary.md`, "today the plan is…") → new-toy → problem (failure on screen, diagnosis, cheap fix) → montage (`onBeat` items, 0.7–2 s, timelapses with `speed` > 1) → twist → truth (the reveal: `quiet: true`, music cue ends 0.5–1.5 s before it, then a `reveal` cue) → outro (what's left, a viewer question, tease).
- `audio: "keep"` for live commentary and pieces to camera (only works at `speed: 1`).
- Talking/explaining shots 3–6 s; reveals hold 4–8 s; `zoom` 1.1–1.2 on reactions.
- Overlays: `callout` when a number is said, `counter` running for the episode, `badge` FAILED/PASSED/LIVE (`tone` fail/pass/live), `label` for a new tool, `chapter` for beat cards, `before`/`after`.
- Music cues per beat by mood; leave gaps for silence.
Then `pnpm mirage cut <project> <n>` (it also snaps montages to the beat) and send the user `episodes/<n>/rough.mp4`. Iterate on their notes by editing `episode.json` and re-running `cut`.

## 4. Narration lines
`pnpm mirage slots <project> <n>`, then write `line` for each slot in `episode.json`: at most `maxWords` words, in the user's voice, carrying the story (stakes, what's happening, why it matters). Leave a slot empty if the picture speaks for itself. Show the user the lines; they edit wording. Then `pnpm mirage guide <project> <n>` and send `guide.mp4`.

## 5. Recording (the user)
They play `guide.mp4` and narrate along in one take (QuickTime or phone), re-reading any fumbled line. Then: `pnpm mirage vo <project> <n> <recording>`. Read the report to the user: missing lines (offer to re-record just those), lines that held the picture.

## 6. Final
`pnpm mirage render <project> <n>` → `final.mp4` + `final.srt`. Write `episodes/<n>/summary.md` (what was attempted, what broke, what's left, counter values) for the next episode's recap. Suggest a title in the format: all caps with a number ("I BUILT X IN 7 DAYS", "X SAID IT WAS IMPOSSIBLE").
````

- [ ] **Step 3: Write the end-to-end test (macOS)**

`packages/core/src/mirage/e2e.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, TranscriptSchema } from '@wordedits/shared';
import { run } from '@wordedits/sidecars';
import { beforeAll, describe, expect, it } from 'vitest';
import { realMediaTools, type MediaTools } from '../media-tools.js';
import { writeJsonFile } from '../project-store.js';
import { ingestClips, loadCatalog } from './ingest.js';
import { analyzeLibrary, loadLibrary, snapToBeats } from './music.js';
import { loadEpisode, renderEpisode, saveEpisode } from './render-episode.js';
import { computeSlots } from './slots.js';
import { timelineDuration } from './timeline.js';
import { fitVoiceover } from './voiceover.js';

const LINE = 'Every request took ten seconds, so I rewrote the backend.';

describe.skipIf(process.platform !== 'darwin')('a Mirage episode end to end (macOS)', () => {
  let tools: MediaTools;
  let project: string;
  beforeAll(async () => {
    tools = await realMediaTools();
    const s = await import('@wordedits/sidecars');
    if (!existsSync(s.transcriberPath())) execFileSync('pnpm', ['build:native'], { stdio: 'inherit' });
    project = await mkdtemp(join(tmpdir(), 'mirage e2e '));
    const clips = join(project, 'batch 1');
    await mkdir(clips, { recursive: true });
    await mkdir(join(project, 'music'), { recursive: true });
    const gen = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    execFileSync('say', ['-v', 'Samantha', '-o', join(project, 'talk.aiff'), "I'm building a weather app. The problem is every weather app is slow."]);
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-i', join(project, 'talk.aiff'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(clips, 'a-talk.mov')]);
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(clips, 'b-screen.mp4')]);
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=60', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(clips, 'c-long.mp4')]);
    await gen(['-f', 'lavfi', '-i', "aevalsrc='0.6*sin(2*PI*880*t)*exp(-40*mod(t-0.1,0.5))*gte(mod(t-0.1,0.5),0)':s=44100:d=40", join(project, 'music', 'beat.wav')]);
    await ingestClips({ project, clipsDir: clips, tools });
    await analyzeLibrary(join(project, 'music'), tools);
  }, 600_000);

  it('goes from clips to a captioned final episode with a fitted voice-over', async () => {
    const catalog = await loadCatalog(project);
    expect(catalog.clips.map((c) => c.kind)).toEqual(['talking', 'screen', 'screen']);
    const talk = catalog.clips[0];

    let ep = EpisodeSchema.parse({
      version: 2, number: 1, title: 'Weather app, part 1', output: { width: 1280, height: 720, fps: 30 },
      items: [
        { id: 'open', beat: 'cold-open', clip: 'c001', src: { in: 0, out: Math.min(talk.probe.durationSec, 5.5) }, audio: 'keep' },
        { id: 'fail', beat: 'problem', clip: 'c002', src: { in: 0, out: 4 } },
        { id: 'tl', beat: 'montage', clip: 'c003', src: { in: 0, out: 60 }, speed: 20, onBeat: true },
        { id: 'win', beat: 'truth', clip: 'c002', src: { in: 4, out: 8 }, quiet: true },
      ],
      overlays: [{ kind: 'badge', text: 'FAILED', start: 6, end: 9, tone: 'fail' }],
      music: [{ track: 'beat.wav', start: 5.5, end: 12.5 }],
    });
    ep = snapToBeats(ep, catalog, await loadLibrary(join(project, 'music')));
    await saveEpisode(project, ep);

    const rough = await renderEpisode({ project, episode: 1, mode: 'rough', tools });
    expect(Math.abs((await tools.probe(rough.outputPath)).durationSec - timelineDuration(ep))).toBeLessThanOrEqual(0.1);

    const slots = computeSlots(ep, catalog);
    expect(slots.length).toBeGreaterThanOrEqual(1);
    ep = { ...ep, slots: slots.map((s, i) => (i === 0 ? { ...s, line: LINE } : s)) };
    await saveEpisode(project, ep);
    await renderEpisode({ project, episode: 1, mode: 'guide', tools });

    const vo = join(project, 'vo.aiff');
    execFileSync('say', ['-v', 'Samantha', '-o', vo, `${LINE} [[slnc 600]] ${LINE}`]);
    const wav = join(project, 'vo.wav');
    await tools.extractWav(vo, wav);
    const transcript = await tools.transcribe(wav);
    await writeJsonFile(join(project, 'episodes', '1', 'voiceover.transcript.json'), TranscriptSchema, transcript);
    const fitted = fitVoiceover({ episode: await loadEpisode(project, 1), catalog, recording: 'vo.aiff', transcript });
    expect(fitted.report.lines[0]).toMatchObject({ status: 'placed', takes: 2 });
    await saveEpisode(project, fitted.episode);

    const final = await renderEpisode({ project, episode: 1, mode: 'final', tools });
    const p = await tools.probe(final.outputPath);
    expect(Math.abs(p.durationSec - timelineDuration(fitted.episode))).toBeLessThanOrEqual(0.1);
    expect([p.width, p.height]).toEqual([1280, 720]);
    const loud = await tools.measureLoudness(final.outputPath);
    expect(loud.integratedLufs).toBeGreaterThan(-16);
    expect(loud.integratedLufs).toBeLessThan(-12);
    const srt = (await readFile(final.srtPath!, 'utf8')).toLowerCase();
    expect(srt).toContain('weather');
    expect(srt).toContain('backend');
  }, 600_000);
});
```

- [ ] **Step 4: Run it**

Run: `pnpm vitest run packages/core/src/mirage/e2e.test.ts`
Expected: pass on macOS (skipped elsewhere). If the transcriber writes "10" for "ten", the line still matches (similarity ≥ 0.9). If it fails, find the stage from the assertion that broke and fix that module; record what you found in the report.

- [ ] **Step 5: README**

Add a section after the title paragraph of `README.md`:
````markdown
## Make a Mirage episode (macOS 26+)

```bash
pnpm install && pnpm build:native
pnpm mirage init ~/Mirage/weather-app --title "Weather app"
pnpm mirage ingest ~/Mirage/weather-app ~/Movies/weather-app/batch-1
# put music in ~/Mirage/weather-app/music, then:
pnpm mirage music ~/Mirage/weather-app
```

Then ask Claude (in this repo) to make episode 1: it describes your clips, writes `episodes/1/episode.json`, and runs `pnpm mirage cut` so you can watch the rough cut. When the cut is right it writes the narration lines (`slots`) and renders `guide.mp4`. Play the guide, narrate along in one take, then:

```bash
pnpm mirage vo ~/Mirage/weather-app 1 ~/Desktop/voiceover.m4a
pnpm mirage render ~/Mirage/weather-app 1
```

`episodes/1/final.mp4` and `final.srt` are ready to upload. The workflow Claude follows is in `.claude/skills/mirage-episode/SKILL.md`.
````

- [ ] **Step 6: Full suite, typecheck, commit**

Run: `pnpm test && pnpm typecheck` — all green.

```bash
git add -A && git commit -m "feat: pnpm mirage CLI and episode skill for build-story episodes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
