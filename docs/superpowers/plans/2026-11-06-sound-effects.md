# Sound Effects and Music Dips — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An episode can place sound effects (built-in ones Mirage makes itself, or the person's own files in `sfx/`) on exact moments, and dip the music to silence just before a punchline or reveal — quiet and sparing by default, so they never cheapen the video.

**Architecture:** A module `sfx.ts` in core generates the built-in sounds with FFmpeg's own audio sources (`aevalsrc`, `anoisesrc`, filters) the first time each is used, into a versioned cache in Mirage's data folder, and knows each sound's peak time. The episode gets an `sfx` list (in output seconds, like music cues) and music cues get `dips`. The render builds an sfx track (each sound levelled and placed so its peak lands on `at`) and mixes it after the music ducking, through the existing limiter; `musicTrackArgs` applies dips. `check` validates and warns.

**Tech Stack:** TypeScript, zod 4, vitest, FFmpeg (`aevalsrc`, `anoisesrc`, `afade`, `highpass`, `lowpass`, `ebur128`, `adelay`, `amix`, `volume`).

**Spec:** `docs/superpowers/specs/2026-11-06-editing-tools-and-vlog-design.md`, part 3 (with the person's decision: no one-by-one listening; they review the finished edit).

## Global Constraints
- Episodes without `sfx` and without `dips` render with byte-identical FFmpeg arguments (existing tests unchanged). Both fields are `.optional()` (`sfx` on the episode, `dips` on a music cue), never `.default`.
- `sfx` entry: `strictObject({ sound: string().min(1), at: number().min(0), gainDb: number().max(0).default(-6) })`. `sound` is a built-in name or a plain path inside the project starting `sfx/` (no `..`, no absolute path).
- Built-in sounds this plan ships (my call: `scratch` is left out — the spec ships it only with a clear recipe, and there isn't one that's simple and safe): `whoosh`, `swoosh-out`, `hit`, `riser`, `pop`, `ding`, `click`. Each has a fixed recipe, length and peak time (the moment `at` refers to):
  - `whoosh` — filtered noise rising and falling, 0.6 s, peak 0.3 s
  - `swoosh-out` — filtered noise, quick attack and longer tail, 0.5 s, peak 0.06 s
  - `hit` — a low boom (a sine dropping from about 90 to 50 Hz, fast decay) with a short noise thump, 0.8 s, peak 0.01 s
  - `riser` — noise plus a sine sweeping up, getting louder, 2.0 s, peak 2.0 s (its end)
  - `pop` — a short sine blip with a downward pitch drop, 0.12 s, peak 0.005 s
  - `ding` — a bell of three partials (about 1046, 2093 and 3136 Hz, decaying), 1.5 s, peak 0.005 s
  - `click` — a 6 ms high-passed noise burst, 0.03 s, peak 0.002 s
- Every built-in: 48 kHz stereo WAV; highpass 40 Hz and lowpass 12 kHz; peak at or below −1 dBFS; a fade of at least 3 ms at both ends (the first and last millisecond below −40 dBFS relative to its peak); length within 5% of the above. Tests measure all of these.
- The built-ins are cached at `<data>/sfx/v1/<name>.wav`, where `<data>` is `MIRAGE_SFX_DIR`, else `$MIRAGE_PLUGIN_DATA/sfx`, else `~/.cache/mirage/sfx` (the same pattern as `kokoroDir`); a recipe change bumps `v1`. A file written by a killed process never counts (write to a temp name, then rename).
- The person's file wins: `sfx/<name>.wav` (or `.mp3`, `.m4a`, `.aiff`, `.flac`, `.ogg`, `.wav`) in the project replaces the built-in of that name when `sound` is the bare name. A `sound` given as a path (`sfx/airhorn.wav`) is that file. A person's file's peak is its loudest sample (decoded mono 48 kHz).
- Level: each sound is set so its loudest 400 ms (EBU R128 momentary maximum) sits at `loudnessLufs + gainDb` LUFS (the episode's speech target, default −14, plus the cue's gain, default −6); never raised so its peak passes −1 dBFS.
- Placement: a sound starts at `at − peak` (clamped at 0: a riser asked for at 1.0 s starts at 0 and its first second is cut, keeping its peak on `at`); a sound running past the episode's end is cut there.
- Mix: the sfx track is not ducked under speech; it's added after the music ducking, before the existing `alimiter`.
- Dips: `dips: [{ start, end }]` on a music cue, output seconds, inside the cue; the cue's music is silent over each dip, with 80 ms fades out before `start` (ending at `start`) and in after `end` (starting at `end`). The schema refuses `end <= start`.
- Guide cut: no sound effects (the person records narration against it); rough and final cuts have them.
- `check` (exact warnings; ✖ for the first two because the render can't run):
  - ✖ `sfx <k>: "<sound>" isn't a built-in sound or a file in sfx/` with hint `Built-in sounds: whoosh, swoosh-out, hit, riser, pop, ding, click. Or put the file in the project's sfx folder.`
  - ✖ `sfx <k>: <path> isn't audio Mirage can read` with hint `Use a WAV, MP3, M4A, AIFF, FLAC or OGG file.`
  - ⚠ `sfx <k> (<sound>) is at <at> s, after the episode ends (<D> s) — it will never play`
  - ⚠ `<n> sound effects within one minute (from <a> s) — sound effects on almost every cut cheapen the video; keep the ones that land a joke or a reveal` when any 60 s window (the whole video if shorter) holds more than 6.
  - ⚠ `music cue <k> has a dip at <s>–<e> s outside the cue (<cs>–<ce> s) — it does nothing`
- Cross-platform; commits with `git commit -s` ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; nothing pushed.

## Review Focus
- **Two processes making the same built-in at once** (cut and render in two sessions): both end with a complete file; neither reads a half-written one. Pinned in Task 1.
- **A sound at `at` = 0 whose peak is late (a riser at 0 s):** it's cut, not shifted, and its peak still lands on 0 — the episode doesn't get longer. Pinned in Task 2.
- **Very short episodes (under 3 s) with a sound effect:** no loudnorm NaN (the levelling uses a measured volume, not loudnorm on the short track). Pinned in Task 2.
- **A person's `sfx/` file with no sound at all, or one that's a minute long:** silent file → refused by `check` with the "isn't audio Mirage can read" error only if FFmpeg can't decode it; a silent decodable one plays (silently) with no division by zero in the levelling; a long one is cut at the episode end. Pinned in Task 2.
- **Overlapping sound effects and a dip under a sound effect:** sounds add (the limiter catches peaks); a dip silences only music. Pinned in Task 2.

---

### Task 1: The built-in sounds

**Files:**
- Create: `packages/core/src/mirage/sfx.ts`
- Test: `packages/core/src/mirage/sfx.test.ts`

**Interfaces:**
- Produces: `BUILTIN_SFX: readonly string[]` (the seven names, in the order above); `sfxDir(env?: NodeJS.ProcessEnv): string`; `builtinSfx(name: string, tools: MediaTools, o?: { dir?: string; signal?: AbortSignal }): Promise<{ file: string; peakSec: number; durationSec: number }>` (generates if missing, else returns the cached file); `SFX_RECIPE_VERSION = 1`.

- [ ] **Step 1: Write the failing tests** (real FFmpeg): for each built-in, generate into a temp `dir`, decode it (stereo 48 kHz), and assert the Global Constraints' measurements — length within 5%, peak ≤ −1 dBFS and located within 10 ms of `peakSec`, fades at both ends, energy below 40 Hz and above 12 kHz at least 24 dB under the band in between (an FFT or a pair of `highpass`/`lowpass` passes measured with `astats`, your call); a second call returns the same file without regenerating (mtime unchanged); two concurrent calls for the same name both succeed and the file is complete; `sfxDir` order; an unknown name throws.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement** the recipes with `aevalsrc`/`anoisesrc` and FFmpeg filters (no files from the internet). Keep each recipe short and classic (the spec: "simple, classic designs that are hard to get wrong"); document each in a one-line comment.
- [ ] **Step 4: Run** focused tests, then `pnpm build:plugin && pnpm test && pnpm typecheck`.
- [ ] **Step 5: Listen-free check:** write the seven WAVs to `/private/tmp/claude-501/-Users-becks-Desktop-Mirage-Edits/7b13ead7-490f-40f0-84ff-bcd5decb91ea/scratchpad/sfx-look/` and save a waveform image of each (`showwavespic`) for the report.
- [ ] **Step 6: Commit** — `feat(sfx): built-in sound effects made with FFmpeg`.

### Task 2: Sound effects and dips in the episode

**Files:**
- Modify: `packages/shared/src/schemas/episode.ts` (`SfxCueSchema`, `EpisodeSchema.sfx`, `MusicCueSchema.dips`)
- Modify: `packages/core/src/mirage/render-episode.ts` (sfx track, dips in `musicTrackArgs`, mix in `episodeFinalArgs`)
- Modify: `packages/core/src/mirage/check.ts` (validation and warnings)
- Test: `packages/core/src/mirage/render-episode.test.ts`, `packages/core/src/mirage/check.test.ts`, `packages/shared/src/schemas/episode.test.ts`

**Interfaces:**
- Consumes: `builtinSfx`, `BUILTIN_SFX`, `sfxDir` (Task 1).
- Produces: `resolveSfx(project: string, sound: string, tools: MediaTools, o?): Promise<{ file: string; peakSec: number; durationSec: number }>`; `sfxTrackArgs(...)` (your signature, mirroring `musicTrackArgs`); `episodeFinalArgs` gains optional `sfxWav`.

- [ ] **Step 1: Write the failing tests:** schema (optional fields round-trip absent; `dips` end ≤ start refused; `gainDb > 0` refused); arguments (no `sfx`, no `dips` → today's exact args; with sfx the final pass mixes the sfx input after ducking and before `alimiter`); real FFmpeg — an episode with a `hit` at 2.0 s and a `whoosh` at 4.0 s over a music cue and live speech: the hit's peak is within 15 ms of 2.0 s in `final.mp4`'s audio, the sfx level isn't reduced under speech (compare the hit's peak with and without speech under it, within 1 dB), a dip from 3.0 to 3.5 s makes the music at least 40 dB quieter in 3.1–3.4 s and back by 3.7 s; each Review Focus case; `check` gives each exact message.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.** Levelling: measure each sound file once per render with `ebur128` (momentary max) and apply `volume`; cap the gain so the peak stays ≤ −1 dBFS. The guide mode skips sfx.
- [ ] **Step 4: Run** `pnpm build:plugin && pnpm test && pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(sfx): place sound effects and dip the music`.

### Task 3: The edit skill

**Files:**
- Modify: `plugin/skills/edit/SKILL.md`
- Test: `scripts/skills.test.ts`

- [ ] **Step 1: Write the failing test:** the edit skill names `sfx` (with `sound`, `at`, `gainDb`), the seven built-in names, `dips`, and contains the sentence `Leave a sound effect out rather than use one that doesn't fit; the person reviews the finished edit, and a sound they don't like comes back as a note.`
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Update the skill** (keep every existing line word for word): the `sfx` field (in output seconds like music cues; `at` is where the sound's peak lands — a riser's end, a hit's attack — so place it on the frame of the cut or the punchline; `gainDb` 0 or less, default −6), the built-in names with one plain line each on what they are, the `sfx/` folder (the person's own files, which replace a built-in of the same name), `dips` on music cues; rules from the spec: whoosh on a fast transition or a time jump, hit or pop under a text card or a reveal, riser into a reveal, ding on a counter or a win; at most about 6 a minute; none under speech except a pop under a word that's on screen; dip the music 0.3–1 s before a punchline or reveal; when the person's note says "no sound effects", remove the `sfx` list; the sentence above; pass on each new ⚠/✖ in plain words with what to do.
- [ ] **Step 4: Run** `pnpm build:plugin && pnpm test`.
- [ ] **Step 5: Commit** — `docs(edit): sound effects and music dips in the edit skill`.
