---
name: mirage-episode
description: Make a Mirage build-story episode with the user — catalog their clips, write the episode timeline (picture, music, overlays), write narration lines for the cut, fit their voice-over and render. Use when the user wants to make, edit or finish a Mirage episode, or drops new build clips.
---

# Making a Mirage episode

Mirage episodes follow spec §14 (`docs/superpowers/specs/2026-09-28-wordedits-design.md`). You do the creative steps; `pnpm mirage` does the mechanical ones. Never invent footage, numbers or events: everything comes from the clips, the catalog and what the user tells you.

Every `⚠` line a command prints is for the user: pass each one on in plain words with what to do about it.

## 1. Catalog the batch
`pnpm mirage ingest <project> <clips folder>`. Tell the user about every `⚠` line:
- `⚠ skipped <file>` — unreadable or no video: ask them to re-export it.
- `⚠ <file> is HDR …` — colours will look washed out: ask for an SDR export (Photos → Export → "Most Compatible").
- `⚠ <file>: transcription failed …` — its speech is invisible to slots and captions; running `ingest` again on the same folder retries just those clips.
- `• <file>: moved, path updated` needs nothing: a clip found in a new folder keeps its id.

Then for each new clip in `<project>/catalog.json`:
- Read 3–8 of its frames (`frames[].file`, relative to the project) and the transcript if any.
- Set `kind` if the guess is wrong (`screen`, `camera`, `talking`, `timelapse`).
- Write `notes` (one sentence: what it shows) and `moments` (`{t, label}` for errors appearing, tests passing, deploys, before/after screens, reactions).
- Ask the user only for what frames cannot tell you (what went wrong, how long it took, numbers for counters).
Remind the user once per project that frames are sent to Anthropic, so screens with secrets should not be recorded.

## 2. Music
Tracks go in `<project>/music/`. `pnpm mirage music <project>` writes `library.json`; set each track's `mood` (`punchy`, `light`, `tension`, `upbeat`, `riser`, `reveal`, `relaxed`) and `licence`. A track shown as `no clear beat` has no beat grid: montages under it are not snapped, so prefer another track for `onBeat` montages.

## 3. Write `episodes/<n>/episode.json` (version 2)
The schema is `packages/shared/src/schemas/episode.ts`. A minimal file:

```json
{
  "version": 2,
  "number": 1,
  "title": "Weather app, part 1",
  "output": { "width": 1920, "height": 1080, "fps": 30 },
  "items": [
    { "id": "open", "beat": "cold-open", "clip": "c001", "src": { "in": 12.5, "out": 18 }, "audio": "keep" },
    { "id": "tl1", "beat": "montage", "clip": "c004", "src": { "in": 0, "out": 600 }, "speed": 200, "onBeat": true }
  ],
  "overlays": [{ "kind": "badge", "text": "FAILED", "tone": "fail", "start": 6, "end": 9 }],
  "music": [{ "track": "drive.mp3", "start": 5.5, "end": 40, "gainDb": -5 }]
}
```
- `output`: 1920×1080 unless the user says otherwise; `fps` 30 or 60.
- `items[].clip` is a catalog id (`c001`…); `src` is in that clip's own seconds. Item `id`s are yours (short, unique).
- `overlays` and `music` are in output-timeline seconds; `track` is a file name in `music/`.

Work in this order: write the items → `pnpm mirage check <project> <n>` (it prints each item's output start–end) → place overlays and music cues on those output times → `pnpm mirage cut <project> <n>`. `check` and `cut` rewrite `episode.json` (beat snapping shifts times), so re-read it before editing it again.

Beats in order, about 13 minutes total, scaled to the footage you have (shorter is fine; never pad):
cold-open (stakes in the first line + 6–10 teaser shots) → title → recap (callback to the previous episode's `summary.md`, "today the plan is…") → new-toy → problem (failure on screen, diagnosis, cheap fix) → montage (`onBeat` items, 0.7–2 s, timelapses with `speed` > 1) → twist → truth (the reveal: `quiet: true`, music cue ends 0.5–1.5 s before it, then a `reveal` cue) → outro (what's left, a viewer question, tease).
- Every number, claim and event on screen (callouts, counters, badges, labels) comes from the catalog (transcripts, notes, moments) or from the user — never invented.
- `audio: "keep"` for live commentary and pieces to camera (only works at `speed: 1`). `check` warns `⚠ item … keeps audio from …, which has no transcript` when that clip's speech can't be seen: re-run `ingest` to retry its transcription.
- Talking/explaining shots 3–6 s; reveals hold 4–8 s; `zoom` 1.1–1.2 on reactions.
- Overlays: `callout` when a number is said, `counter` running for the episode, `badge` FAILED/PASSED/LIVE (`tone` fail/pass/live), `label` for a new tool, `chapter` for beat cards, `before`/`after`.
- Music cues per beat by mood; leave gaps for silence. `gainDb` sets how loud the cue plays on its own (0 = as loud as speech; it is ducked automatically under speech): upbeat/punchy −4…−6 (default −5), light −6, tension −8, relaxed −8, riser −5, reveal −3.
Then send the user `episodes/<n>/rough.mp4`. Iterate on their notes by editing `episode.json` and re-running `cut`.

## 4. Narration lines
`pnpm mirage slots <project> <n>`, then write `line` for each slot in `episode.json`: at most `maxWords` words, in the user's voice, carrying the story (stakes, what's happening, why it matters). As in step 3, every number, claim and event in a line comes from the catalog or the user — never invented. Leave a slot empty if the picture speaks for itself. When `slots` prints `⚠ over budget`, shorten that line; when it prints `⚠ dropped line`, the cut changed under it: rewrite it into a current slot or let it go. Show the user the lines; they edit wording. Then `pnpm mirage guide <project> <n>` and send `guide.mp4`.

## 5. Recording (the user)
They play `guide.mp4` and narrate along in one take (QuickTime or phone). Tell them: if a line comes out wrong, re-read it straight away — the last take of a line is used, but a re-read after the next line has started is ignored. Then: `pnpm mirage vo <project> <n> <recording>`. Read the report to the user: lines that held the picture, and missing lines. For missing lines they record just those (in any order) and run `pnpm mirage vo <project> <n> <new recording> --add`: it fits only the missing lines and keeps every placed one (`--add --slots n2,n5` re-records particular lines instead).

Changing the cut after this point: edit items, then `pnpm mirage slots <project> <n>` → `pnpm mirage vo <project> <n> <recording>` (it reuses the saved transcript, no re-transcribing; repeat `--add` for any lines that came from a second recording) → `render`. `check`/`cut` print `⚠ The cut changed after the voice-over was fitted` until you do, `render` refuses, and montages are no longer snapped to the beat once a voice-over is fitted.

## 6. Final
`pnpm mirage render <project> <n>` → `final.mp4` + `final.srt` (captions use the written lines' spelling). Write `episodes/<n>/summary.md` (what was attempted, what broke, what's left, counter values) for the next episode's recap. Suggest a title in the format: all caps with a number ("I BUILT X IN 7 DAYS", "X SAID IT WAS IMPOSSIBLE").
