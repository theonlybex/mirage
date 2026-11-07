# Animated Zooms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shot can move: push in, pull out or drift across the picture, smoothly (no shimmer), over the whole shot or part of it — slow push-ins on reactions, quick punch-ins on punchlines.

**Architecture:** An optional item field `move` (the frame at the move's end; the shot starts at its `zoom` and `focus`). A pure module computes the zoom and focus for each output frame with easing; the item's filter chain in `itemChunkArgs` renders the move on the source picture (before framing, as `zoom` does today), only for items that have one, so every other item's FFmpeg arguments stay exactly as they are. `check` warns about moves that don't fit their shot.

**Tech Stack:** TypeScript, zod 4, vitest, FFmpeg filters (the builder picks: `zoompan` on an upscaled picture, or `scale`/`crop` with per-frame expressions).

**Spec:** `docs/superpowers/specs/2026-11-06-editing-tools-and-vlog-design.md`, part 2.

## Global Constraints
- Items without `move` produce byte-identical FFmpeg arguments (the existing `itemChunkArgs` tests pass unchanged).
- `move` is `.optional()` on the item (never `.default`); `strictObject`; unknown keys refused.
- Fields: `move.zoom` 1–2 (required), `move.focus` `{ x, y }` 0–1 (default: the item's own `focus`), `move.ease` `linear` | `in` | `out` | `inOut` (default `inOut`), `move.start` / `move.end` seconds into the item on the output timeline, held frames included (defaults 0 and the item's full length). Schema refuses `end <= start`.
- Easing of progress `p` (0–1): `linear` p; `in` p²; `out` 1−(1−p)²; `inOut` p < 0.5 ? 2p² : 1−2(1−p)². Before `start` the shot holds the start frame, after `end` the end frame.
- Zoom changes at a steady rate to the eye: `z = z0 · (z1/z0)^e(p)`. Focus moves linearly with `e(p)`: `f = f0 + (f1 − f0)·e(p)`. `focus` keeps today's meaning: the crop window's position, `(iw−ow)·x` from the left and `(ih−oh)·y` from the top.
- The move runs over held frames too (a `hold` from voice-over fitting keeps moving unless `move.end` says otherwise).
- Smoothness (the spec's "no shimmer"): on a slow move (1 → 1.1 over 6 s), a tracked point's position changes by a steady amount frame to frame: second differences under 0.25 output pixels, and never stepping backwards.
- Speed: rendering an item with a move takes at most 3× the time of the same item with a fixed `zoom` of the move's larger value (measured on a 1920×1080, 6 s source made with FFmpeg's `testsrc2`).
- `check` warnings (exact):
  - `item <id>'s move ends at <e> s, after the shot ends (<len> s) — it stops at the end of the shot`
  - `item <id>'s move starts at <s> s, after the shot ends (<len> s) — it never plays`
- Cross-platform; commits with `git commit -s` ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; nothing pushed.

## Review Focus
- **A move on a sped-up item (a timelapse at `speed: 20`) or an item with a `hold`:** times are output seconds of the shot, the move is smooth across the hold. Pinned in Task 2.
- **A move with `frame: blur` or `fill` on a vertical output:** the blurred background follows the same move (it comes from the same moving picture), no black edges. Pinned in Task 2.
- **A move to `zoom: 1` (a pull-out to the full picture) and from 1:** no crop larger than the picture, no off-by-one black line at the edge. Pinned in Task 2.
- **Odd source sizes (e.g. 1081 × 607, a portrait phone clip):** no FFmpeg error from odd crop sizes. Pinned in Task 2.
- **A punch-in of 0.1 s (3 frames at 30 fps):** renders, no division by zero when start and end are one frame apart. Pinned in Tasks 1 and 2.

---

### Task 1: The `move` field and its timing

**Files:**
- Modify: `packages/shared/src/schemas/episode.ts` (`MoveSchema`, `TimelineItemSchema.move`)
- Create: `packages/core/src/mirage/move.ts`
- Modify: `packages/core/src/mirage/check.ts` (the two warnings)
- Test: `packages/core/src/mirage/move.test.ts`, `packages/shared/src/schemas/episode.test.ts`, `packages/core/src/mirage/check.test.ts`

**Interfaces:**
- Produces: `type Move`; `ease(kind: Move['ease'], p: number): number`; `moveFrames(item: TimelineItem, frames: number, fps: number): { zoom: number; x: number; y: number }[]` — one entry per output frame of the item (`frames` = `LaidItem.frames`), clamped to the shot.
- `itemsFingerprint` unchanged (a move doesn't change timing).

- [ ] **Step 1: Write the failing tests:** ease values at p = 0, 0.25, 0.5, 1 for each kind; `moveFrames` for a 6 s, 30 fps item 1 → 1.2 with default times: frame 0 zoom 1, last frame 1.2, the middle frame `1.2^0.5` for `inOut`; `start: 2, end: 4` holds before and after; a 3-frame punch-in (`start` = `end` − 0.1) reaches its end value on the third frame; focus defaults to the item's; schema refuses `end <= start`, `zoom: 2.5` and an unknown key, and an item without `move` round-trips without the key; `check` gives the two exact warnings.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the focused tests, then `pnpm build:plugin && pnpm test && pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(move): the move field and its timing`.

### Task 2: Render the move, smoothly

**Files:**
- Modify: `packages/core/src/mirage/render-episode.ts` (`itemChunkArgs`, items with `move` only)
- Test: `packages/core/src/mirage/render-episode.test.ts`

**Interfaces:**
- Consumes: `moveFrames`, `ease` (Task 1).
- Produces: no new exports needed; `itemChunkArgs` keeps its signature.

- [ ] **Step 1: Write the failing tests:**
  - Arguments: an item without `move` gives exactly today's chain (keep the existing literal tests); an item with `move` gives a chain that puts the hold before the move (so held frames move) and the move before framing.
  - Smoothness (real FFmpeg): a 1920×1080, 6 s source of a black frame with one small white square off-centre (made with `color` + `drawbox` lavfi filters — not text, which needs libass), an item `move: { zoom: 1.1 }` over the whole shot rendered at 1920×1080 30 fps; extract every frame as grey raw (`-f rawvideo -pix_fmt gray`), compute the square's centroid per frame, and assert the Global Constraints' smoothness rule.
  - Speed (real FFmpeg): render the same item with the move and with a fixed `zoom: 1.1`; the move takes at most 3× (take the faster of 2 runs of each).
  - Review Focus cases: `speed: 20` with a move; a `hold: 1` with the move covering it (the square keeps moving in the held second); `frame: blur` and `fill` on a 1080×1920 output (no black pixels at the frame edges for blur/fill); `zoom: 1 → 1.3` and `1.3 → 1`; a 1081×607 source; a 3-frame punch-in. Each renders, with the expected frame count.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.** Pick the technique by measurement against the smoothness and speed rules (note both in the report with numbers). Known options: `zoompan` (its `z`, `x`, `y` expressions per output frame, `d=1`, `s=` the size the framing step expects) on the picture upscaled first so its whole-pixel steps become sub-pixel (an upscale of 4× was smooth for the 2 s comic panels of video 3, but is costly for 1080p+ sources — measure 2×); or per-frame `scale` + `crop` expressions. The per-frame values can be written as an FFmpeg expression of the frame number (`on`/`n`) built from the same easing maths, or as a `sendcmd` file; keep `moveFrames` the single source of the numbers so tests and render agree.
- [ ] **Step 4: Run** `pnpm build:plugin && pnpm test && pnpm typecheck`.
- [ ] **Step 5: Real look:** render a scratch vertical episode (temp folder, never the person's project) from `fixtures/speech-retake.mp4` with `frame: fill`, a slow push-in on one item and a 0.15 s punch-in on another; extract frames at the start, middle and end of each move; look at them; put the paths and what they show in the report.
- [ ] **Step 6: Commit** — `feat(move): render animated zooms smoothly`.

### Task 3: The edit skill

**Files:**
- Modify: `plugin/skills/edit/SKILL.md` (the items field list and the rules)
- Test: `scripts/skills.test.ts`

- [ ] **Step 1: Write the failing test:** the edit skill names `move` with `zoom`, `focus`, `ease`, `start`, `end`, and contains the sentence `A punch-in is a move whose start is 0.15 s or less before its end, on the line just before the laugh.`
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Update the skill** (keep every existing line word for word): the field in the items list; rules from the spec — slow push-ins (1 → 1.1–1.2 over 3–8 s) on reactions and pieces to camera; a punch-in on the line before a laugh (the sentence above); never more than one move in three shots in fast montage stretches; no moves on screen recordings unless following the cursor to something small; the two `⚠` warnings passed on in plain words with what to do.
- [ ] **Step 4: Run** `pnpm build:plugin && pnpm test`.
- [ ] **Step 5: Commit** — `docs(edit): animated zooms in the edit skill`.
