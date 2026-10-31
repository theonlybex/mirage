---
name: mirage-episode
description: Make a Mirage build-story episode with the user — catalog their clips, write the episode timeline (picture, music, overlays), write narration lines for the cut, fit their voice-over and render. Use when the user wants to make, edit or finish a Mirage episode, or drops new build clips.
---

# Making a Mirage episode

Mirage episodes follow spec §14 (`docs/superpowers/specs/2026-09-28-wordedits-design.md`). You do the creative steps; `pnpm mirage` does the mechanical ones. Never invent footage, numbers or events: everything comes from the clips, the catalog and what the user tells you.

Every `⚠` line a command prints is for the user: pass each one on in plain words with what to do about it.

A `✖` line stops the command; its next line says what to do. `✖ episode <n> is busy: render (pid …)` means another `cut`/`guide`/`render`/`vo` of that episode is still running (the project or music folder: another `ingest`/`music`): wait for it, don't delete its files. Only if no Mirage command is running at all (e.g. the Mac restarted mid-render) delete the `.mirage.lock` file the hint names. Every command but `init` needs an existing project (`✖ no Mirage project at …`: check the path).

## 1. Catalog the batch
`pnpm mirage ingest <project> <clips folder>`. Tell the user about every `⚠` line:
- `⚠ skipped <file>: failed …` / `no video stream` / `its duration can't be read` — unreadable: ask them to re-export it (the reason after `—` is the tool's).
- `⚠ skipped <file>: not a video Mirage reads` — photos and other formats are not used; if it belongs in the episode, ask for an .mp4 or .mov export.
- `⚠ <file> is HDR …` — colours will look washed out: ask for an SDR export (Photos → Export → "Most Compatible").
- `⚠ <file>: transcription failed …` — its speech is invisible to slots and captions; running `ingest` again on the same folder retries just those clips.
- `⚠ <file> looks cut short …` — the copy or recording is incomplete (only the seconds it names are there): ask whether a full copy exists.
- `⚠ <file>: its picture stops at … but its sound runs to …` — items can only use the seconds with picture (`probe.videoDurationSec`).
- `⚠ <file>: its first audio track is silent, so its sound is taken from track …` — nothing to do; worth a mention if the user expected the other track.
- `⚠ <file>: Mirage couldn't read through the whole file, so its length is what its header says …` — the file is huge or on a slow drive; it is catalogued, but if a render of it fails or stops early, ask for a fresh copy or export.
- `• <file>: moved, path updated` needs nothing: a clip found in a new folder keeps its id.
- `✖ catalog.json: …` while it runs — an edit made to catalog.json meanwhile broke it (the line names the key): fix that, then run `ingest` again; clips already catalogued are kept.

Then for each new clip in `<project>/catalog.json`:
- Read 3–8 of its frames (`frames[].file`, relative to the project) and the transcript if any. A frame's `t` is the clip time it shows (a clip shorter than the frame interval has one frame, from its middle).
- Set `kind` if the guess is wrong (`screen`, `camera`, `talking`, `timelapse`).
- Write `notes` (one sentence: what it shows) and `moments` (`{t, label}` for errors appearing, tests passing, deploys, before/after screens, reactions).
- Ask the user only for what frames cannot tell you (what went wrong, how long it took, numbers for counters).
Remind the user once per project that frames are sent to Anthropic, so screens with secrets should not be recorded.

## 2. Music
Tracks go in `<project>/music/`. `pnpm mirage music <project>` writes `library.json`; set each track's `mood` (`punchy`, `light`, `tension`, `upbeat`, `riser`, `reveal`, `relaxed`) and `licence`. A track shown as `no clear beat` has no beat grid: montages under it are not snapped, so prefer another track for `onBeat` montages. `⚠ skipped <file>: …` means it could not be read as audio (ask for another export); `⚠ <file> is in library.json but not in the music folder` means its file is gone: ask the user to put it back, or remove its entry and any cue using it.

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
- `items[].clip` is a catalog id (`c001`…); `src` is in that clip's own seconds, and must end by the clip's `probe.videoDurationSec` when it has one (its sound can run on after the picture): otherwise `check` stops with `item …: c019 has video only until 3.0 s`. Item `id`s are yours (short, unique).
- Overlay text can be in any script, and symbols such as © ® ™ ▶ ⚠ ✔ ↔ draw; colour emoji (🚀 ✅ 👩‍💻, flags) are left out (they can't be drawn; `check` warns).
- `overlays` and `music` are in output-timeline seconds; `track` is a file name in `music/`.
- `number` must be the episode's folder number: when you start an episode from a copy of another's `episode.json`, set `number` to the new folder's number and remove `voiceover` (its transcripts stay in the old folder) — every command refuses a mismatch.

Work in this order: write the items → `pnpm mirage check <project> <n>` (it prints each item's output start–end) → place overlays and music cues on those output times → `pnpm mirage cut <project> <n>`. `check` and `cut` rewrite `episode.json` (beat snapping shifts times), so re-read it before editing it again.
`check` stops on a misspelled key (`unknown key "…"`: rename it) and on a cue whose track is not in `music/library.json` or whose file is gone. Act on its `⚠` lines:
- `… starts at … after the episode ends` — that overlay or cue never shows: move it onto the timeline or delete it.
- `item … is onBeat but no music plays under it` / `… has no clear beat — left unsnapped` — put a cue with a beat under it, or drop `onBeat`.
- `item … keeps its live audio … no footage left to reach a beat` / `item … could not reach a beat` — snapping never slows an item that keeps its audio (its sound plays only at 1×), so it ends on the nearest beat inside its clip; this one couldn't: start it earlier in the clip, or drop `onBeat`. A `hold` is kept: the item with its hold ends on the beat.
- `music cue … will loop` — the track is shorter than offset + cue length: shorten the cue or lower its `offset`, unless a loop is fine.
- `music cue … has gainDb -18, the old default` — delete `gainDb` (or set it per mood, below).
- `… was inside time that beat snapping removed, so it was dropped` — place that overlay, cue or line again on the new times.

Beats in order, about 13 minutes total, scaled to the footage you have (shorter is fine; never pad):
cold-open (stakes in the first line + 6–10 teaser shots) → title → recap (callback to the previous episode's `summary.md`, "today the plan is…") → new-toy → problem (failure on screen, diagnosis, cheap fix) → montage (`onBeat` items, 0.7–2 s, timelapses with `speed` > 1) → twist → truth (the reveal: `quiet: true`, music cue ends 0.5–1.5 s before it, then a `reveal` cue) → outro (what's left, a viewer question, tease).
- Every number, claim and event on screen (callouts, counters, badges, labels) comes from the catalog (transcripts, notes, moments) or from the user — never invented.
- `audio: "keep"` for live commentary and pieces to camera (only works at `speed: 1`). `check` warns `⚠ item … keeps audio from …, which has no transcript` when that clip's speech can't be seen: re-run `ingest` to retry its transcription.
- Talking/explaining shots 3–6 s; reveals hold 4–8 s; `zoom` 1.1–1.2 on reactions.
- Overlays: `callout` when a number is said, `counter` running for the episode, `badge` FAILED/PASSED/LIVE (`tone` fail/pass/live), `label` for a new tool, `chapter` for beat cards, `before`/`after`.
- Music cues per beat by mood; leave gaps for silence. `gainDb` sets how loud the cue plays on its own (0 = as loud as speech; it is ducked automatically under speech): upbeat/punchy −4…−6 (default −5), light −6, tension −8, relaxed −8, riser −5, reveal −3.
Then send the user `episodes/<n>/rough.mp4`. Iterate on their notes by editing `episode.json` and re-running `cut`.

## 4. Narration lines
`pnpm mirage slots <project> <n>`, then write `line` for each slot in `episode.json` (`slotsCut` and `voiceover` there are kept by `slots` and `vo`; never edit them): at most `maxWords` words, in the user's voice, carrying the story (stakes, what's happening, why it matters). As in step 3, every number, claim and event in a line comes from the catalog or the user — never invented. Leave a slot empty if the picture speaks for itself. When `slots` prints `⚠ over budget`, shorten that line; when it prints `⚠ dropped line`, the picture it was written over is gone from the cut: rewrite it into a current slot or let it go; `⚠ moved line` means it followed its picture to another place — check it still fits; `⚠ nN's line has no words to read` means a line of only punctuation or emoji, which counts as empty; `⚠ nN's line isn't in English` — voice-over matching supports English only for now, so write lines in English. Digits, units and money usually match how they are read out (`1,200ms` ↔ "1200 milliseconds", `$5k`, `15x`, `3/14` ↔ "March 14th"), but not every way of saying a number ("twelve hundred", "twenty twenty-six", "nine thirty am" for `9:30am`): if a line with a number is reported missing, write the number the way the user said it. Show the user the lines; they edit wording. Then `pnpm mirage guide <project> <n>` and send `guide.mp4`.

## 5. Recording (the user)
They play `guide.mp4` and narrate along in one take (QuickTime or phone). Tell them: if a line comes out wrong, re-read it straight away — the last take of a line is used (a sentence fumbled mid-line can be re-read on its own: the fumble is cut and the rest of the line kept), but a re-read after the next line has started is ignored. Then: `pnpm mirage vo <project> <n> <recording>`. Read the report to the user: lines that held the picture, missing lines, lines where `only part of the line was found` (have them re-read the whole line, then `--add --slots nN`), and lines `too long` for their slot (shorten the line or lengthen the picture, then `--add`). For missing lines they record just those (in any order), saved under a new file name — never over the earlier recording — and run `pnpm mirage vo <project> <n> <new recording> --add`: it fits only the missing lines and keeps every placed one (`--add --slots n2,n5` re-records particular lines instead; a listed line the new recording lacks says `kept the earlier take`). If `vo` says `<file> is not the recording … were cut from`, the earlier recording was saved over: put it back and save the new take under another name, or record every line again and run `vo` without `--add`. `No speech was heard in <file>` / `<file> has no audio track`: wrong file or the mic was off. A full `vo` (no `--add`) always undoes the freezes and splits earlier fits added (also after a re-cut) before fitting, so they never pile up or stay behind; holds you wrote into items yourself stay. Don't edit `episode.json` while `vo` runs: it refuses to save over edits (`episode.json changed while vo was running`) — just run it again; the transcript is kept, so the re-run is quick.

Changing the cut after this point: edit items, then `pnpm mirage slots <project> <n>` → `pnpm mirage vo <project> <n> <recording>` (it reuses the saved transcript, no re-transcribing; repeat `--add` for any lines that came from a second recording) → `render`. `check`/`cut` print `⚠ The cut changed after the voice-over was fitted` until you do, `render` refuses, and montages are no longer snapped to the beat once a voice-over is fitted. `vo` refuses with `The cut changed since slots were written — run slots first` until `slots` has run for the current cut. Editing a line after `vo`: `check` and `render` print `⚠ nN's line changed since vo` (the old line still plays and is captioned as fitted) — have the user re-record it with `--add --slots nN`; a line cleared after `vo` still plays until a full `vo` drops it. `render` also refuses a recording changed since `vo` fitted it.

## 6. Final
`pnpm mirage render <project> <n>` → `final.mp4` + `final.srt` (captions use the written lines' spelling). Write `episodes/<n>/summary.md` (what was attempted, what broke, what's left, counter values) for the next episode's recap. Suggest a title in the format: all caps with a number ("I BUILT X IN 7 DAYS", "X SAID IT WAS IMPOSSIBLE").
