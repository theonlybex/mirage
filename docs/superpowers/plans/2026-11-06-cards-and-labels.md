# Cards and Labels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Episodes can have full-screen cards that take their own time on the timeline (the vlog's monospace title card, bold plug and "2 days later..." cards, a picture card), plus three new on-screen labels: a name label with a joke line, a small yellow subtitle on a chosen line, and a small yellow time tag.

**Architecture:** A timeline item is now either a clip item (as today) or a card item (`card` instead of `clip` + `src`), as a zod union; every place that reads `clip`/`src` narrows on it (the TypeScript compiler finds them). A card renders as a black (or picture) segment in its chunk with silence, and its text is drawn by the final pass's ASS like overlays, in two card styles. The three labels are new overlay kinds with new ASS styles. A second bundled OFL font (a monospace) joins Montserrat in `plugin/fonts/files/`.

**Tech Stack:** TypeScript, zod 4, vitest, FFmpeg (lavfi `color`, image input with `-loop 1`), libass.

**Spec:** `docs/superpowers/specs/2026-11-06-editing-tools-and-vlog-design.md`, part 7.

## Global Constraints
- Episodes without card items and without the new overlay kinds: byte-identical FFmpeg arguments and ASS text (existing tests unchanged), and episode.json files round-trip unchanged.
- Card item (exact): `strictObject({ id, beat, card: strictObject({ text: string().default(''), style: enum(['mono', 'bold', 'image']), sec: number().min(0.5).max(30), image: string().min(1).optional() }), hold: number().min(0).max(10).default(0), quiet: boolean().default(false) })`. `style: 'image'` requires `image`, a plain path inside the project (no `..`, no absolute path) to a PNG or JPEG; `mono`/`bold` refuse `image` and require non-empty `text`. A card item has no `clip`, `src`, `speed`, `audio`, `zoom`, `move`, `frame`, `focus` or `onBeat` (the strict schema refuses them).
- A card's length is `sec` (plus `hold`); it plays silence; `itemsFingerprint` includes cards as `['card', id, sec, hold]` so a changed card length counts as a re-cut.
- Voice-over fitting never splits a card: when fitting needs to open time inside a card, it adds the time to the card's `hold` (recorded in `voiceover.holds` like other holds so a full re-fit undoes it).
- Beat snapping leaves cards alone.
- Card looks (all scale with the frame like existing styles, `k = min(W, H)/1080`):
  - `mono`: white text, the bundled monospace (JetBrains Mono Regular, OFL), size `px(72)`, centred, on black; lines from `\n` in `text`.
  - `bold`: white text, Montserrat ExtraBold, size `px(110)`, centred, on black, wrapping inside 80% of the width.
  - `image`: the picture scaled to cover the frame (cropped centred); optional `text` drawn like `bold` with a black outline `px(8)`.
  - Card text fades in and out over 150 ms.
- New overlay kinds (exact):
  - `name`: lower third, left-aligned at 6% of the width from the left and 18% of the height from the bottom; `text` in yellow `#FFD400` Montserrat ExtraBold `px(64)`, and on the line below `sub` in white Montserrat ExtraBold `px(40)`; black outline `px(5)`. New optional overlay field `sub` (only on `name`; other kinds refuse it).
  - `subtitle`: yellow `#FFD400` Montserrat ExtraBold `px(44)`, black outline `px(4)`, bottom-centre, MarginV `px(80)` (or `round(H · 0.38)` above the bottom when the episode's `captions.position` is `middle`, so it sits where captions would).
  - `timecard`: black Montserrat ExtraBold `px(40)` text in a yellow `#FFD400` box (BorderStyle 3), top-left at 5% margins.
  - Each fades in and out over 150 ms.
- Fonts: the monospace TTF goes in `plugin/fonts/files/` with its OFL licence in `plugin/fonts/` (README lists URL, version, sha256), and the notices generator includes it, as for Montserrat. `fontsdir` is passed when a card or a new overlay kind is used (as for pop/karaoke captions).
- Warnings (exact):
  - `check` ✖ `item <id>: card image <path> is missing` (hint `Put the picture in the project folder, or change the card's image.`), ✖ `item <id>: card image <path> isn't a PNG or JPEG` (same hint).
  - `render` (final only, where the narration's words are known) ⚠ `subtitle overlay <k> ("<text>") doesn't match what's said at <start>–<end> s — copy the words from the transcript` when fewer than 80% of the subtitle's words (compared with `normalizeWord`) are spoken between `start − 0.5` and `end + 0.5`.
- The viewer's timeline shows a card item as a card (its text, or the picture's name), with no clip thumbnail.
- Cross-platform; commits with `git commit -s` ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; nothing pushed.

## Review Focus
- **An existing episode is loaded, checked, cut and saved:** nothing about it changes (no new keys, same args, same fingerprints). Pinned in Task 1.
- **A card at the very start or end, two cards in a row, an episode that is only cards:** layout, chunks and the final pass work; durations exact. Pinned in Task 2.
- **A narration line running over a card:** fitting holds the card longer instead of splitting it, and a full re-fit undoes it. Pinned in Task 1.
- **A card image that's portrait, tiny (100×100) or huge (6000×4000):** covers the frame without black bars or errors. Pinned in Task 2.
- **A `name` label whose `sub` is very long, and overlay text with emoji or CJK:** wraps or stays inside the frame; emoji left out and CJK drawn as in other overlays. Pinned in Task 3.

---

### Task 1: Card items in the schema and everywhere items are read

**Files:**
- Modify: `packages/shared/src/schemas/episode.ts` (clip item / card item union; `TimelineItem` type), and every file the compiler then flags: `packages/core/src/mirage/{timeline,check,music,overlays,render-episode,reports,slots,voiceover,move,captions}.ts`, `packages/viewer/src/server/timeline-view.ts` (and its UI types if needed)
- Test: `packages/shared/src/schemas/episode.test.ts`, `packages/core/src/mirage/timeline.test.ts`, `voiceover.test.ts`, `check.test.ts`, `slots.test.ts`, viewer timeline-view test

**Interfaces:**
- Produces: `ClipItemSchema`, `CardItemSchema`, `TimelineItemSchema = union([ClipItemSchema, CardItemSchema])`; types `ClipItem`, `CardItem`, `TimelineItem`; `isCard(item): item is CardItem`; `itemFrames` handles cards (`srcFrames` = `round(sec · fps)`).
- In this task `itemChunkArgs` already renders a card as a black, silent segment of its length (a `color=black` lavfi input); card text and picture cards come in Task 2.

- [ ] **Step 1: Write the failing tests:** schema (a card item parses; it refuses `clip`, `speed`, `move`; `image` style needs `image`; `mono` refuses `image`; an existing clip-only episode round-trips byte-identically); `layoutTimeline` with cards; `itemsFingerprint` changes when a card's `sec` changes; fitting a line over a card adds to the card's `hold` and a full re-fit undoes it; beat snapping skips cards; `slots` runs over an episode with a card; `check`'s two ✖ errors; the viewer shows a card.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement** the union and fix every compiler error by narrowing (`isCard`), choosing the card behaviour each site needs (no transcript, no catalog lookup, no source range, silence). Render a card as a black, silent segment of its length in `itemChunkArgs` (text in Task 2).
- [ ] **Step 4: Run** `pnpm build:plugin && pnpm test && pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(cards): card items on the timeline`.

### Task 2: Draw cards

**Files:**
- Create: `plugin/fonts/files/JetBrainsMono-Regular.ttf`, `plugin/fonts/OFL-JetBrainsMono.txt`; Modify: `plugin/fonts/README.md`, `scripts/build-plugin.ts` (notices), `packages/core/src/mirage/fonts.ts` (a `MONO_FONT` name)
- Modify: `packages/core/src/mirage/render-episode.ts` (image cards; `fontsdir` when cards are used), `packages/core/src/mirage/overlays.ts` (`CardMono`, `CardBold` styles; card text events from the laid-out items)
- Test: `packages/core/src/mirage/render-episode.test.ts`, `overlays.test.ts`, `scripts/build-plugin.test.ts`, `packages/core/src/mirage/fonts.test.ts`

**Interfaces:**
- Consumes: `CardItem`, `isCard` (Task 1).
- Produces: `buildAss` gains optional `cards?: { start: number; end: number; card: CardItem['card'] }[]`.

- [ ] **Step 1: Write the failing tests:** ASS for a mono card (`Dialogue` on the card's times, style `CardMono`, lines joined with `\N`, fades), a bold card, an image card with text; real FFmpeg: a 1920×1080 episode with a clip, a 2 s mono title card `"Sam\nVlog #3\n11-6-26"`, a bold card and an image card renders with the exact duration; libass's verbose log shows the monospace TTF loaded; the card frames are black (mono/bold, outside the text) or the picture; each Review Focus case (cards at the start/end, two in a row, only cards; portrait, tiny and huge pictures cover the frame with no black edges); the notices list the new font with its licence.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.** Download JetBrains Mono's release (github.com/JetBrains/JetBrainsMono, a tagged release) into a fresh temp folder, check it, copy `JetBrainsMono-Regular.ttf` and its `OFL.txt`; record URL, version and sha256 in the README. Image cards: `-loop 1 -framerate <fps> -t <len> -i <image>`, scaled to cover and cropped centred to the output size.
- [ ] **Step 4: Run** `pnpm build:plugin && pnpm test && pnpm typecheck`.
- [ ] **Step 5: Real look:** render a scratch vertical and a 16:9 episode with each card style; look at frames of each; report paths and what they show.
- [ ] **Step 6: Commit** — `feat(cards): draw mono, bold and picture cards`.

### Task 3: Name labels, subtitles and time tags

**Files:**
- Modify: `packages/shared/src/schemas/episode.ts` (overlay kinds `name`, `subtitle`, `timecard`; optional `sub`), `packages/core/src/mirage/overlays.ts` (styles and events), `packages/core/src/mirage/render-episode.ts` (the subtitle warning; `fontsdir` when used)
- Test: `overlays.test.ts`, `render-episode.test.ts`, `episode.test.ts`

**Interfaces:**
- Consumes: `speechWords`, `normalizeWord`, the fonts helpers.

- [ ] **Step 1: Write the failing tests:** schema (`sub` only on `name`); ASS events and styles for each kind with the exact sizes, colours and positions; the subtitle position follows `captions.position: 'middle'`; the subtitle warning's exact text (a matching subtitle gives none; a made-up one warns; a voice-over-only subtitle is judged in the final render); the Review Focus case (a long `sub`, emoji and CJK); real FFmpeg: an episode with all three renders and the labels are visible in frames at their times (pixel colour check for the yellow).
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm build:plugin && pnpm test && pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(labels): name labels, chosen subtitles and time tags`.

### Task 4: The edit skill

**Files:**
- Modify: `plugin/skills/edit/SKILL.md`
- Test: `scripts/skills.test.ts`

- [ ] **Step 1: Write the failing test:** the edit skill names `card` with `mono`, `bold`, `image`, `sec`; the overlay kinds `name` (with `sub`), `subtitle`, `timecard`; and contains `A subtitle's text is words actually said at that moment: copy them from the transcript, never write new ones.`
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Update the skill** (keep every existing line word for word): card items in the field list (no clip or src; `sec`; the three styles; the picture must be in the project); the three overlay kinds; rules — a title card is 2 s; plug cards only if the person has something to plug; time cards for jumps ("2 days later...", "EARLIER"); a name label the first time someone appears, its joke line true to the person and never mean (the playbook's guardrail); chosen subtitles only on lines worth reading twice; pass on the ✖ and ⚠ in plain words with what to do.
- [ ] **Step 4: Run** `pnpm build:plugin && pnpm test`.
- [ ] **Step 5: Commit** — `docs(edit): cards and labels in the edit skill`.
