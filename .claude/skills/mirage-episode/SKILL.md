---
name: mirage-episode
description: Make a Mirage build-story episode with the user — catalog their clips, write the episode timeline (picture, music, overlays), write narration lines for the cut, fit their voice-over and render. Use when the user wants to make, edit or finish a Mirage episode, or drops new build clips.
---

# Making a Mirage episode

Mirage episodes follow spec §14 (`docs/superpowers/specs/2026-09-28-wordedits-design.md`). You do the creative steps; `pnpm mirage` does the mechanical ones. Never invent footage, numbers or events: everything comes from the clips, the catalog and what the user tells you.

## 1. Catalog the batch
`pnpm mirage ingest <project> <clips folder>`. Tell the user about every `⚠ skipped` file (unreadable or no video) so they can re-export it. Then for each new clip in `<project>/catalog.json`:
- Read 3–8 of its frames (`frames[].file`, relative to the project) and the transcript if any.
- Set `kind` if the guess is wrong (`screen`, `camera`, `talking`, `timelapse`).
- Write `notes` (one sentence: what it shows) and `moments` (`{t, label}` for errors appearing, tests passing, deploys, before/after screens, reactions).
- Ask the user only for what frames cannot tell you (what went wrong, how long it took, numbers for counters).
Remind the user once per project that frames are sent to Anthropic, so screens with secrets should not be recorded.

## 2. Music
Tracks go in `<project>/music/`. `pnpm mirage music <project>` writes `library.json`; set each track's `mood` (`punchy`, `light`, `tension`, `upbeat`, `riser`, `reveal`, `relaxed`) and `licence`. A track shown as `no clear beat` has no beat grid: montages under it are not snapped, so prefer another track for `onBeat` montages.

## 3. Write `episodes/<n>/episode.json` (version 2)
Beats in order, about 13 minutes total, scaled to the footage you have (shorter is fine; never pad):
cold-open (stakes in the first line + 6–10 teaser shots) → title → recap (callback to the previous episode's `summary.md`, "today the plan is…") → new-toy → problem (failure on screen, diagnosis, cheap fix) → montage (`onBeat` items, 0.7–2 s, timelapses with `speed` > 1) → twist → truth (the reveal: `quiet: true`, music cue ends 0.5–1.5 s before it, then a `reveal` cue) → outro (what's left, a viewer question, tease).
- `audio: "keep"` for live commentary and pieces to camera (only works at `speed: 1`).
- Talking/explaining shots 3–6 s; reveals hold 4–8 s; `zoom` 1.1–1.2 on reactions.
- Overlays: `callout` when a number is said, `counter` running for the episode, `badge` FAILED/PASSED/LIVE (`tone` fail/pass/live), `label` for a new tool, `chapter` for beat cards, `before`/`after`.
- Music cues per beat by mood; leave gaps for silence.
Then `pnpm mirage cut <project> <n>` (it also snaps montages to the beat) and send the user `episodes/<n>/rough.mp4`. Iterate on their notes by editing `episode.json` and re-running `cut`.

## 4. Narration lines
`pnpm mirage slots <project> <n>`, then write `line` for each slot in `episode.json`: at most `maxWords` words, in the user's voice, carrying the story (stakes, what's happening, why it matters). Leave a slot empty if the picture speaks for itself. When `slots` prints `⚠ over budget`, shorten that line; when it prints `⚠ dropped line`, the cut changed under it: rewrite it into a current slot or let it go. Show the user the lines; they edit wording. Then `pnpm mirage guide <project> <n>` and send `guide.mp4`.

## 5. Recording (the user)
They play `guide.mp4` and narrate along in one take (QuickTime or phone), re-reading any fumbled line. Then: `pnpm mirage vo <project> <n> <recording>`. Read the report to the user: missing lines (offer to re-record just those), lines that held the picture.

## 6. Final
`pnpm mirage render <project> <n>` → `final.mp4` + `final.srt`. Write `episodes/<n>/summary.md` (what was attempted, what broke, what's left, counter values) for the next episode's recap. Suggest a title in the format: all caps with a number ("I BUILT X IN 7 DAYS", "X SAID IT WAS IMPOSSIBLE").
