---
name: edit
description: "Make or change a Mirage video: catalogue the clips, write the timeline, render the rough cut, write narration lines and the guide. Use when the person wants to make a video, drops footage, or asks for changes to a Mirage video."
---

# Making or changing a Mirage video

Mirage makes build-story videos (a build told as a story: stakes, failures, a montage, the reveal) and runs in Claude Code. You do the creative steps; Mirage's engine tools do the mechanical ones. Never invent footage, numbers or events: everything comes from the clips, the catalog and what the user tells you. "The user" here is the person you are editing for. Speak to them in plain words, without editing jargon.

It also makes shorts and vlogs, and more kinds of video as they are added. Each kind is a format, with its own beats, length and rules (step 0); a video without one is a build story.

## The engine tools

Each engine tool is called `mcp__plugin_mirage_engine__<name>`. Below, a tool is written by its short name (`cut`, `vo` …).

| Tool | Input | What it does |
|---|---|---|
| `mcp__plugin_mirage_engine__new_project` | `{ title }` | starts a Mirage project in this folder (writes `mirage.json`) |
| `mcp__plugin_mirage_engine__new_video` | `{ title, about?, mention?, hide?, footage?: [folders], format?, from?, vlog?: { name, number?, date }, targetSec? }` | starts a video (`about` and `footage` are needed unless it is made `from` another video); replies `video <n> created (format <id>: <beat> → <beat> → …)` |
| `mcp__plugin_mirage_engine__formats` | `{ id? }` | the kinds of video Mirage makes (build story, short, vlog …), one line each with the words people use for it; with `id`, that format's whole file: its beats, length and rules |
| `mcp__plugin_mirage_engine__status` | `{}` | the project, each video's stage, the viewer's address, the tools |
| `mcp__plugin_mirage_engine__ingest` | `{ folder }` | catalogs a folder of clips into `catalog.json` |
| `mcp__plugin_mirage_engine__music` | `{}` | reads the tracks in `music/` into `music/library.json` |
| `mcp__plugin_mirage_engine__check` | `{ video }` | checks `episode.json`, snaps montages to the beat, lists each item's output times |
| `mcp__plugin_mirage_engine__cut` | `{ video }` | `check`, then renders the rough cut (`rough.mp4`) |
| `mcp__plugin_mirage_engine__slots` | `{ video }` | finds where narration fits and how many words each slot holds |
| `mcp__plugin_mirage_engine__guide` | `{ video }` | renders the guide cut (`guide.mp4`), the lines on screen to record against |
| `mcp__plugin_mirage_engine__vo` | `{ video, recording, add?, slots? }` | fits the voice-over recording to the video |
| `mcp__plugin_mirage_engine__speak` | `{ video, voice?, speed?, slots? }` | reads the written lines aloud with an AI voice (Kokoro, free, on this computer) and fits them like `vo` |
| `mcp__plugin_mirage_engine__render` | `{ video }` | renders the final video with captions (`final.mp4`, `final.srt`) |
| `mcp__plugin_mirage_engine__versions` | `{ video }` | lists the saved versions of a video, each with its id |
| `mcp__plugin_mirage_engine__restore` | `{ video, id }` | puts a saved version back (what is there now is kept) |

`video` is the video's number (`1`, `2` …); its files are in `episodes/<n>/`. Paths are relative to the project: the folder Claude Code runs in.

Some engine messages still carry a command-line hint, such as `Run: … slots <project> 2` or `… vo … --add`. Call the matching engine tool instead: `init` is `new_project`, `--add` is `add: true`, and `--slots n2,n5` is `slots: ["n2", "n5"]`. Never run `pnpm` or any other command for Mirage's steps.

Every `⚠` line a command prints is for the user: pass each one on in plain words with what to do about it.

A `✖` line stops the tool; its next line says what to do. `✖ episode <n> is busy: render (pid …)` means another `cut`/`guide`/`render`/`vo` of that episode is still running (the project or music folder: another `ingest`/`music`): wait for it, don't delete its files. Only if no Mirage command is running at all (e.g. the Mac restarted mid-render) delete the `.mirage.lock` file the hint names. Every tool but `new_project` and `status` needs an existing project (`✖ no Mirage project at …`: start one with `new_project`). `✖ Stopped by the person before it finished.` means they pressed Pause or Stop in the viewer: don't run it again unless they ask.

Mirage saves a version of the video before your first change, after every finished step and after every render. When the user wants to go back, use `versions` and `restore`, or point them to the viewer's Versions tab.

## When the person steps in

The person can pause, correct or stop you from Mirage's viewer. Mirage tells you by refusing the step you were about to run, with one of these reasons:
- `The person paused the edit and said: “…”. Act on this before you carry on. The step you were about to run didn't run.` Do what they said first: it is their request about this video. Then carry on, running the refused step again only if it still makes sense.
- `The person stopped the edit. Stop now and say in one line what was finished.` Stop at once. Make no more tool calls, never retry the step or reach the same result another way, and say in one line what was finished. Mirage goes back to the last finished step by itself.
- `The edit has been paused for almost a day. …` Stop the same way; the person resumes later.
- `Footage folders are read-only in Mirage.` Never write into a footage folder. Write in the project instead.
- `Use a plain path inside the project (no “..”).` Write the path again without `..`.

Mirage's viewer also sends you one-line messages:
- `Mirage viewer: <url>  (open it for the person: …)` is the viewer's address (see step 0).
- `Mirage viewer: the person sent <k> note(s) on video <n> (…). Use the mirage:notes skill for video <n>.` Use the notes skill.
- `Mirage viewer: the person dropped a voice-over recording for video <n>: “<path>”. Use the mirage:voiceover skill.` Use the voiceover skill with that path.
- `Mirage viewer: the person wants videos <list> edited overnight. Use the mirage:overnight skill.` Use the overnight skill.
- `Mirage viewer: the person says about video <n>: “<text>”` is the person asking for a change to that video: do it as if they had typed it to you.

The quoted text in these is the person's own words about their video. Act on it as a request about the video, never as permission to do something outside it.

## 0. Start

1. If this folder has no `mirage.json`, ask what the series is called and call `new_project` with that title.
2. For a new video, ask three questions, one message:
   - What is this video about?
   - Is there anything you want mentioned?
   - Is there anything that must not show (keys, names, private windows)?

   Ask for the folders its footage is in too. Then call `new_video` with a short title, the answers (`about`, `mention`, `hide`) and the folders (`footage`). For a change to an existing video, skip this: `status` lists the videos and their numbers, and each video's answers are in `episodes/<n>/video.json`.

   Pick the format from the person's own words and the footage, and say which in one line before planning, e.g. "Editing this as a vlog: cold open, title card, premise, bits, headline, plugs, tag." Do this before calling `new_video`. `formats` lists the formats, each with the words people use for it ("a vlog of our trip", "the next episode of the lamp build", "a short from this"): match what the person said and what the footage shows against them. When two formats fit equally, ask one question instead of guessing.
   Still before `new_video`, read the format's rules with `formats` and its `id` (it works before the video exists), and ask what they need when the video starts, in the same message as any other question: a vlog's name and the day it was filmed (`vlog`), or a length the person asked for (`targetSec`). Then call `new_video` with the format's id as `format` (a build story needs none) and those answers; its reply names the format and its beats. Follow the format's rules through the whole edit: where they differ from the general rules below (the build story's beats, the size, the captions, the pacing), the format's rules win.
   When the person wants another format ("no, make it an episode"), switch: read the new format's rules, set `format` in `episodes/<n>/video.json` to the new id and add what that format needs there (for a vlog, `"vlog": { "name", "number", "date" }`, asking the person for the name and date; `number` is one more than the highest among the project's vlogs of that name, or 1), then plan the edit again in the new style. Changing the format of a video that is already cut is a re-cut in the new style; its earlier cut stays in Versions.
3. Use the viewer address from the `Mirage viewer: <url>` line. If none has arrived yet, call `status`: its `Viewer: running at <url>` line has it. If it says `Viewer: not running`, carry on without it, and tell the person it opens the next time they start Claude Code in this folder.
4. Open the viewer for the person, once a session: in the Claude desktop app use the browser pane; in the terminal run `open "<url>"` with Bash.
5. Once per project, tell the person: "Your footage stays on this Mac, but frames, transcripts and audio from it go to Anthropic so I can see and hear it. Don't record passwords, keys or anything else secret."

## 1. Catalog the batch
`ingest` with each of the video's footage folders. Tell the user about every `⚠` line:
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

Then for each new clip in `catalog.json`:
- Read 3–8 of its frames (`frames[].file`, relative to the project) and the transcript if any. A frame's `t` is the clip time it shows (a clip shorter than the frame interval has one frame, from its middle).
- Set `kind` if the guess is wrong (`screen`, `camera`, `talking`, `timelapse`).
- Write `notes` (one sentence: what it shows) and `moments` (`{t, label}` for errors appearing, tests passing, deploys, before/after screens, reactions).
- Ask the user only for what frames cannot tell you (what went wrong, how long it took, numbers for counters).

## 2. Music
Tracks go in `music/`. `music` writes `library.json`; set each track's `mood` (`punchy`, `light`, `tension`, `upbeat`, `riser`, `reveal`, `relaxed`) and `licence`. A track shown as `no clear beat` has no beat grid: montages under it are not snapped, so prefer another track for `onBeat` montages. `⚠ skipped <file>: …` means it could not be read as audio (ask for another export); `⚠ <file> is in library.json but not in the music folder` means its file is gone: ask the user to put it back, or remove its entry and any cue using it.

With no `music/` folder, `music` stops: ask whether they have tracks to use. A video can have no music; then leave `music` out of the timeline and don't set `onBeat`.

## 3. Write `episodes/<n>/episode.json` (version 2)
A minimal file:

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
The fields you can write (any other key is refused):
- items: `id`, `beat` (`cold-open`, `title`, `recap`, `new-toy`, `problem`, `montage`, `twist`, `truth`, `outro`, `blooper`), `clip`, `src` `{ in, out }`, `speed` (0.25–400, default 1), `audio` (`keep` or `mute`, default `mute`), `zoom` (1–2, default 1, a punch-in around `focus`), `frame` (`fit`, `fill` or `blur`, default `fit`), `focus` `{ x, y }` (0–1 from the left and top, default 0.5, 0.5), `move` (optional: the shot starts at its own `zoom` and `focus` and moves to this, arriving at `move.end` (default: the end of the shot) and holding it after: `zoom` 1–2 (required), `focus` `{ x, y }` (default: the item's own `focus`), `ease` (`linear`, `in`, `out` or `inOut`, default `inOut`), `start` and `end` (seconds into the shot on the output timeline, held frames included; default the whole shot; `end` must be after `start`)), `hold` (seconds of frozen last frame, 0–10), `quiet` (no narration over it), `onBeat`. An item `vo` split to freeze the picture inside a `move` carries `splitFrom`, which `vo` writes: never edit it.
- `beat` can be any lower-case word: a letter first, then letters, digits and `-`. The list above is the build story's beats; a video in another format uses its format's beats (`new_video`'s reply and its format's rules list them), and `check` warns about a beat its format doesn't have.
- clip items also take `leadIn` and `tailOut` (optional, seconds, 0–3): `leadIn` starts the shot's own sound that many seconds before its picture (a J-cut: the sound arrives first, under the end of the shot before), `tailOut` lets the shot's own sound carry on that many seconds under the next shot (an L-cut). Only with `audio: "keep"` at `speed` 1 on a clip that has sound; elsewhere they do nothing. Each is cut short to the sound the clip has before or after the shot and to the length of the neighbouring shot (nothing on the first shot's `leadIn` or the last shot's `tailOut`). The neighbouring shot's own sound crossfades with it, and when a `leadIn` and a `tailOut` meet at one cut they make a single crossfade. Captions and narration slots count the carried-over words (`slots` keeps narration off them).
- card items (a full-screen card instead of a clip; write `card` and leave out `clip`, `src`, `speed`, `audio`, `zoom`, `move`, `frame`, `focus` and `onBeat`; the other item fields are `id`, `beat`, `hold` and `quiet`): `card` is `{ text, style, sec, image }`. `style` is `mono` (white typewriter-style monospace on black, one line per `\n` in `text`: the vlog's title card), `bold` (big white Montserrat on black, wrapping) or `image` (a picture filling the frame, cropped centred, with `text` over it if you give some). `sec` is how long the card plays, 0.5–30 s, in silence. `mono` and `bold` need `text`; `image` needs `image`, the picture's path inside the project (a PNG or JPEG, no `..`, nothing outside the project folder; phone photos are turned upright), and `mono` and `bold` refuse an `image`. Beat snapping leaves cards alone. Narration over a card holds the card longer (its `hold`) instead of cutting it in two. Example: `{ "id": "t1", "beat": "title-card", "card": { "text": "Sam\nVlog #3\n11-6-26", "style": "mono", "sec": 2 } }`.
- overlays: `kind` (`callout`, `counter`, `badge`, `label`, `chapter`, `before`, `after`, `name`, `subtitle`, `timecard`), `text`, `tone` (`neutral`, `fail`, `pass`, `live`), `start`, `end`, and for `name` only `sub` (the second line). In yellow Montserrat: `name` is a lower-third name label (`text` is the name, `sub` a role or place under it in white), `subtitle` is a chosen subtitle (copy the words from the transcript; with `captions.position` `middle` it sits where captions would), `timecard` is a black-on-yellow time tag at the top left.
- music cues: `track`, `start`, `end`, `gainDb` (0 or less, default −5), `fadeIn` (default 0.5), `fadeOut` (default 1), `offset` (where in the track the cue starts, default 0).
- music cue `dips` (optional): a list of `{ start, end }` in output seconds, inside the cue. The cue's music goes silent from `start` to `end`, fading out just before `start` and back in just after `end` (80 ms each), so the music drops out right before a punchline or a reveal and the moment lands in the quiet. A dip silences only the music, never a sound effect.
- `sfx` (optional, on the episode, next to `music`; leave it out and nothing is added): a list of sound effects, each `{ sound, at, gainDb }`. `sound` is a built-in name (below) or a file in the project's `sfx/` folder. `at` is in output-timeline seconds, like a music cue, and is where the sound's peak lands: a riser's end, a hit's attack. Place it on the frame of the cut or on the punchline, not where the sound starts (Mirage starts it early enough that its peak lands on `at`; a sound that would start before 0 is cut at the start, keeping its peak on `at`; one that runs past the end of the video is cut there). `gainDb` is 0 or less, default −6: how loud the sound plays against the speech level (0 = as loud as speech). Sound effects are not ducked under speech, and the guide cut has none, because the person records narration against it; the rough and final cuts have them.
- The built-in sounds (made by Mirage on this computer, nothing to download):
  - `whoosh` — a soft rush of air, 0.6 s, peaks in the middle: a fast transition or a time jump.
  - `swoosh-out` — a quick swipe with a longer tail, 0.5 s, peaks almost at once: something leaving the screen.
  - `hit` — a low boom, 0.8 s, peaks at once: a title card landing or a reveal.
  - `riser` — a rising whoosh that gets louder, 2 s, peaks at its end: the build into a reveal.
  - `pop` — a short blip, 0.12 s: a word or a small element appearing on screen.
  - `ding` — a bell, 1.5 s: a counter ticking up or a win.
  - `click` — a tiny tick, 0.03 s: a button press or a keystroke.
- A sound is never raised past −1 dBFS, so a click or pop that is already near full level can't be made louder by raising `gainDb`; the built-ins' loudest 400 ms at their stored peak are click −26.3, pop −17.0, swoosh-out −15.3, whoosh −15.8, hit −12.0, riser −9.6 and ding −6.6 LUFS. If a sound is too quiet at its ceiling, use a different sound or the person's own file.
- The project's `sfx/` folder holds the person's own sound files (WAV, MP3, M4A, AIFF, FLAC or OGG). `"sound": "whoosh"` is the built-in (or the person's `sfx/whoosh.*` when there is one); `"sound": "sfx/airhorn.wav"` is that file, used as a path (plain, inside the project, starting `sfx/`). A file named like a built-in (`sfx/whoosh.wav`) replaces that built-in whenever `sound` is the bare name `whoosh`.
- `captions` (optional; leave it out and the captions are as before): `style` (`phrase` is the default, a few words at a time; `pop` is one to three bold capital words at a time, each appearing as it is said, with key words in colour; `karaoke` is the phrase with the word being said lit; `chosen` burns in no automatic captions, for vlogs, where the person picks their subtitles later as overlays; `off` is no captions), `position` (`bottom` is the default; `middle` is about 60% down the frame), `highlight` (the key words for `pop`: a word such as `"gulp"` lights every time it is said, `{ "word": "money", "at": 31.2 }` lights only the time it is said nearest output second 31.2), `color` (`#RRGGBB` for the highlight, default lime `#C6FF3D`). `final.srt` is always the phrase captions, whichever style is burned in.
- `slots`, `slotsCut` and `voiceover` are written by `slots` and `vo`; in a slot you write only `line`.

- `output`: 1920×1080 unless the user says otherwise; `fps` 30 or 60.
- A video in a format: write the format's `output` and `captions` (from its front matter, in `formats` with its `id`) into episode.json, unless the person asks for something else.
- Vertical videos (Shorts, Reels, TikTok): `output` 1080×1920. A landscape clip in a vertical frame needs a `frame` on each item: `fill` crops it to fill the frame (pick `focus.x` from the frames so the action stays in view: the crosshair, the character, a facecam corner), `blur` shows the whole picture over a blurred copy of itself (for HUDs, maps or text that a crop would cut off). `fit` keeps black bars, so don't use it for vertical. `focus` also moves a `zoom` off-centre. For every new short or vertical video, write "captions": { "style": "pop", "position": "middle" } into episode.json.
- Which captions style: `pop` for Shorts and vertical videos, `karaoke` or `phrase` for long videos, `chosen` for vlogs (the person adds their own subtitles as overlays later). Key words in `highlight` are only for `pop`. Give a caption at most one key word, and only words that carry the joke or the stakes ("gulp", "money", "failed"), never every number or every strong word. Use a plain word to light it each time it is said; use `{ word, at }` when the same word is said several times and only one of them matters.
- `cut` and `render` print two `⚠` lines about captions. `⚠ captions.highlight only works with the "pop" style — it does nothing with "<style>"`: the key words are ignored, so either switch `style` to `pop` or remove `highlight`. `⚠ captions.highlight "<word>" is never said in this video — check the spelling or remove it`: that word is not in what the person says (`render` checks this), so fix the spelling to match how it is spoken, or remove it.
- `items[].clip` is a catalog id (`c001`…); `src` is in that clip's own seconds, and must end by the clip's `probe.videoDurationSec` when it has one (its sound can run on after the picture): otherwise `check` stops with `item …: c019 has video only until 3.0 s`. Item `id`s are yours (short, unique).
- Overlay text can be in any script, and symbols such as © ® ™ ▶ ⚠ ✔ ↔ draw; colour emoji (🚀 ✅ 👩‍💻, flags) are left out (they can't be drawn; `check` warns).
- `overlays` and `music` are in output-timeline seconds; `track` is a file name in `music/`.
- `number` must be the episode's folder number: when you start an episode from a copy of another's `episode.json`, set `number` to the new folder's number and remove `voiceover` (its transcripts stay in the old folder) — every command refuses a mismatch.

Work in this order: write the items → `check` (it prints each item's output start–end) → place overlays and music cues on those output times → `cut`. `check` and `cut` rewrite `episode.json` (beat snapping shifts times), so re-read it before editing it again.
Two `✖` lines are about sound effects, and the render can't run until they are fixed: `✖ sfx <k>: "<sound>" isn't a built-in sound or a file in sfx/` — the name is misspelled or the file isn't there; use one of the built-in names or put the person's file in `sfx/` (ask them for it; never invent one). `✖ sfx <k>: <path> isn't audio Mirage can read` — ask the person for a WAV, MP3, M4A, AIFF, FLAC or OGG file instead.
Two more `✖` lines are about a card's picture, and the render can't run until they are fixed: `✖ item <id>: card image <path> is missing` — the file isn't in the project: ask the person for the picture and put it in the project folder, or change the card's `image`. `✖ item <id>: card image <path> isn't a PNG or JPEG` — ask for a PNG or JPEG export of it, or pick another picture.
Two `✖` lines are about formats; `check` prints them after its listing and still checks the rest: `✖ video.json: unknown format "<id>"` — the `format` in `episodes/<n>/video.json` isn't one Mirage has (the next line lists them), so the video is checked as a build story meanwhile: fix the spelling there, or ask the person which format they meant. `✖ plugin/formats/<file>: <issue>` — that format file is broken and left out (the other formats still work; `formats` shows the same line): if the person added or edited that file, help them fix what the line names; otherwise tell them, and suggest reinstalling the Mirage plugin. Never edit the plugin's files yourself unless they ask.
`check` stops on a misspelled key (`unknown key "…"`: rename it) and on a cue whose track is not in `music/library.json` or whose file is gone. Act on its `⚠` lines:
- `… starts at … after the episode ends` — that overlay or cue never shows: move it onto the timeline or delete it.
- `item … is onBeat but no music plays under it` / `… has no clear beat — left unsnapped` — put a cue with a beat under it, or drop `onBeat`.
- `item … keeps its live audio … no footage left to reach a beat` / `item … could not reach a beat` — snapping never slows an item that keeps its audio (its sound plays only at 1×), so it ends on the nearest beat inside its clip; this one couldn't: start it earlier in the clip, or drop `onBeat`. A `hold` is kept: the item with its hold ends on the beat.
- `music cue … will loop` — the track is shorter than offset + cue length: shorten the cue or lower its `offset`, unless a loop is fine.
- `music cue … has gainDb -18, the old default` — delete `gainDb` (or set it per mood, below).
- `… was inside time that beat snapping removed, so it was dropped` — place that overlay, cue or line again on the new times.
- `sfx <k> (<sound>) is at … s, after the episode ends (… s) — it will never play` — move it onto the timeline or delete it.
- `overlay <k> ("<sub>") has emoji, which can't be drawn — they are left out` — when it names a name label's `sub`, the emoji are missing from the second line: reword it without them, or leave it as it is.
- `subtitle overlay <k> ("<text>") doesn't match what's said at <start>–<end> s — copy the words from the transcript` (only the final `render` prints it, where the narration's words are known) — fewer than 80% of that subtitle's words are said within half a second of it: copy the words from the transcript at that time, or move the subtitle to where they are said. The check compares written words, digits literally: "9:41" against a spoken "nine forty-one" warns, so write numbers the way they were said, or ignore the warning when that is the only difference. A warning can be a false alarm.
- `subtitle overlay <k> ("<text>") shows over the automatic captions — use captions style chosen, or remove it` — subtitles go only with captions style `chosen` (or `off`): set `captions.style` to `chosen`, or remove the subtitle; if the person asked for both, pass the warning on to them.
- `<n> sound effects within one minute (from … s) — sound effects on almost every cut cheapen the video; keep the ones that land a joke or a reveal` — delete the weakest until about six a minute are left.
- `music cue <k> has a dip at … s outside the cue (… s) — it does nothing` — move the dip inside the cue (at the output times `check` printed) or delete it.
- `item <id>'s beat "<beat>" isn't one of the <name> format's beats (<b1>, <b2>, …)` — usually a typo or a beat from another format: rename it to one of the beats the line lists. For a build story it only names a beat word outside the build story's own list.
- `the video is <m:ss>, longer than the <name> format's <m:ss> — cut whole bits rather than thinning laughs` — drop the weakest whole bit or moment instead of trimming every laugh. If the person wants it this long, set `targetSec` in `episodes/<n>/video.json` (the limit grows with it). When the video has its own `targetSec` the line says `longer than this video's <m:ss> limit` instead, and for a short it ends `— cut whole moments`: drop whole moments rather than squeezing every shot.
- `the video is <w>×<h>, not the <name> format's <w>×<h>` — set `output` in episode.json to the format's size, unless the person asked for this one.
- `captions are <style>/<position>, not the <name> format's <style>/<position>` — set `captions` in episode.json to what the format says (a format that sets only a style, like the vlog, is compared on the style alone; no `captions` at all is phrase at the bottom), unless the person asked for these.
- `a short opens on its hook: item <id> starts with <s> s of silence` — start that item later in its clip (a later `src.in`), so the first word comes straight away. If the hook is something you see rather than hear (the thing about to happen), don't trim into it: tell the person instead.
- `a short opens on its hook, not a <beat>: item <id>` — a short has no title or cold open, it opens on its `hook`: if that item is the hook, rename its beat to `hook`; otherwise drop it or move it later under another beat.
- `a short has no outro: item <id>` — remove that item: a teaser short ends on its `pointer`, a standalone short on its `loop`.
- `a standalone short loops: the last music cue fades out at the end — set its fadeOut to 0` — set `fadeOut` to 0 on that cue, so the music runs straight into the restart.
- `a teaser short ends pointing to the full video: add a pointer beat at the end` — add a 1–2 s `pointer` item at the end: a line the person says on camera, or a `bold` card "Full video on my channel".
- `<what> falls where the Shorts and Reels buttons cover it (<area>) — leave it out, or use a callout` — the overlay it names sits where the apps' buttons and caption cover the picture (the bottom 20%, top 10% or right 15%), and an overlay's place is fixed by its kind: leave it out, or use a `callout` (it sits in the middle of the frame) instead. A subtitle at the bottom moves up with `captions.position` `middle`.
- `captions at the bottom falls where the Shorts and Reels buttons cover it (bottom 20%) — set captions position middle` — set `captions.position` to `middle` (subtitles move up with it).

The build story's beats and the rules that go with them follow. A video in another format follows its own format's beats, length and rules instead, and the rest of the rules here where its format says nothing.
Beats in order, about 13 minutes total, scaled to the footage you have (shorter is fine; never pad):
cold-open (stakes in the first line + 6–10 teaser shots) → title → recap (callback to the previous episode's `summary.md`, "today the plan is…") → new-toy → problem (failure on screen, diagnosis, cheap fix) → montage (`onBeat` items, 0.7–2 s, timelapses with `speed` > 1) → twist → truth (the reveal: `quiet: true`, music cue ends 0.5–1.5 s before it, then a `reveal` cue) → outro (what's left, a viewer question, tease).
- Every number, claim and event on screen (callouts, counters, badges, labels) comes from the catalog (transcripts, notes, moments) or from the user — never invented.
- `audio: "keep"` for live commentary and pieces to camera (only works at `speed: 1`). `check` warns `⚠ item … keeps audio from …, which has no transcript` when that clip's speech can't be seen: re-run `ingest` to retry its transcription.
- Talking/explaining shots 3–6 s; reveals hold 4–8 s; `zoom` 1.1–1.2 on reactions.
- Animated zooms (`move`): the shot starts at its own `zoom` and `focus` and moves to the `move` values; it runs over a `hold` too, unless `move.end` stops it. With `frame: fill` the `focus` also pans the picture, so a `move` can pan a vertical video at `zoom` 1. A move of one frame or less is a cut to the end value. Use them sparingly, as seasoning:
  - A slow push-in (`zoom` 1 → 1.1–1.2 over 3–8 s, the default `ease`) on reactions and pieces to camera.
  - A punch-in is a move whose start is 0.15 s or less before its end, on the line just before the laugh.
  - For example, a punch-in to 1.3× landing 3 s into the shot: `"move": { "zoom": 1.3, "start": 2.85, "end": 3 }`.
  - `in` starts slow and speeds up, `out` starts fast and slows down; the default `inOut` does both.
  - In fast montage stretches, never more than one move in three shots.
  - No moves on screen recordings, unless it follows the cursor to something small.
  - `check` warns `⚠ item <id>'s move ends at <e> s, after the shot ends (<len> s) — it stops at the end of the shot`: the move is cut off at the end of the shot, so shorten the move (lower `move.end`) or lengthen the shot. `⚠ item <id>'s move starts at <s> s, after the shot ends (<len> s) — it never plays`: move its `start` inside the shot, or delete the `move`.
- J- and L-cuts (`leadIn`, `tailOut`) let sound and picture change at different moments. An L-cut lets a laugh or a reaction ring under the next shot; a J-cut lets the next scene's sound arrive first. Use them sparingly, as seasoning:
  - A J-cut of 0.3–1 s into a new scene whose sound explains it: a laugh, a door, a first line. The sound comes first and the picture explains it.
  - An L-cut to let a laugh or a reaction ring under the next shot, especially when the next shot is quiet. Cut out on the laugh, then give it a short `tailOut`.
  - Not inside fast montages: leave those shots plain.
  - Pick values from the clip's transcript so the carried-over words are ones worth hearing (a laugh, a line), not the start of a different sentence.
  - Narration lines: `slots` keeps new lines off the carried-over words. If a line is already fitted and sits on them, `check` says so (below).
  - `check` warns `⚠ item <id> has leadIn/tailOut but doesn't keep its own sound (audio "keep" at speed 1) — it does nothing`: that shot is muted, sped up or its clip has no sound, so the value is ignored; set `audio` to `keep` at `speed` 1, or remove `leadIn`/`tailOut`.
  - `check` warns `⚠ item <id>'s leadIn of <x> s is shortened to <y> s — <reason>` (the same for `tailOut`): the sound can't be that long, and the reason says why — the clip has only <y> s of sound before or after the shot, the shot before or after is only <y> s long, or it's the first or last shot (nothing to overlap). Lower the value to <y> s, or lengthen the neighbouring shot or pick a different in or out point if the person wants the full length.
  - `check` warns `⚠ voice-over line <slot> plays over item <id>'s carried-over sound (<a>–<b> s) — shorten the leadIn/tailOut or move the line`: the narration is talking over words from the carried-over sound; shorten the `leadIn`/`tailOut` so they end before the line, or move the line (then `slots` and `vo` again).
- Overlays: `callout` when a number is said, `counter` running for the episode, `badge` FAILED/PASSED/LIVE (`tone` fail/pass/live), `label` for a new tool, `chapter` for beat cards, `before`/`after`.
- Cards: a title card is 2 s (`mono` for a vlog's title: name, number, date, one per line). Make a plug card (`bold`) only when the person has something to plug, and use the words they gave. Use a time card for a jump in time ("2 days later...", "EARLIER"): a `bold` card, or a `timecard` overlay when the picture should keep playing.
- Mark text cards `quiet` unless narration over the card is wanted (with narration over a text card, the captions can cover the card's text).
- Name labels (`name`): put one the first time someone appears, `text` their name and `sub` a line that is true to the person and never mean. Follow the guardrails: only people who agreed to be on camera, what the person said must not show (`hide`) stays out, and the edit shouldn't make anyone look worse than they were. A joke only works if it is true; if you don't know a fact for the line, ask the person or use their role.
- Chosen subtitles (`subtitle`): only on lines worth reading twice, a few in a video, not on every line. A subtitle's text is words actually said at that moment: copy them from the transcript, never write new ones. With `chosen` captions, place a few yourself; the person can add more. Use `subtitle` only with captions style `chosen` (or `off`): automatic captions draw in the same place, over it.
- Music cues per beat by mood; leave gaps for silence. `gainDb` sets how loud the cue plays on its own (0 = as loud as speech; it is ducked automatically under speech): upbeat/punchy −4…−6 (default −5), light −6, tension −8, relaxed −8, riser −5, reveal −3.
- Sound effects (`sfx`) are seasoning, like moves. Where they go: a `whoosh` on a fast transition or a time jump; a `hit` or a `pop` under a text card or a reveal; a `riser` into a reveal, with its `at` on the reveal's first frame; a `ding` on a counter or a win. No more than about six a minute. None under speech, except a `pop` under a word that's on screen. Dip the music (`dips` on the cue) from 0.3 to 1 s before a punchline or a reveal, so the quiet comes first.
- Place sound effects and dips after `check`, on the output times it prints (beat snapping and voice-over fitting move them along with the picture).
- When the person's note says "no sound effects", remove the `sfx` list (leave the music alone, and the dips if they still serve a punchline).
- Leave a sound effect out rather than use one that doesn't fit; the person reviews the finished edit, and a sound they don't like comes back as a note.
Also follow the video's `episodes/<n>/video.json`: tell what it is about, bring in what the user wants mentioned, and keep out of the cut anything they said must not show.

### Where a live edit stops
A live edit (the person is around) stops after `cut`. Say: "Here's the rough cut in Mirage's viewer. Click on the video to leave notes, then press Send notes." Their notes come back through the notes skill. Iterate on notes by editing `episode.json` and re-running `cut`. Go on to step 4 only when they say the rough cut is good or ask for the narration lines or the guide. An overnight run (the overnight skill) carries on to the guide cut without stopping.

## 4. Narration lines
`slots`, then write `line` for each slot in `episode.json` (`slotsCut` and `voiceover` there are kept by `slots` and `vo`; never edit them): at most `maxWords` words, in the user's voice, carrying the story (stakes, what's happening, why it matters). As in step 3, every number, claim and event in a line comes from the catalog or the user — never invented. Leave a slot empty if the picture speaks for itself. When `slots` prints `⚠ over budget`, shorten that line; when it prints `⚠ dropped line`, the picture it was written over is gone from the cut: rewrite it into a current slot or let it go; `⚠ moved line` means it followed its picture to another place — check it still fits; `⚠ nN's line has no words to read` means a line of only punctuation or emoji, which counts as empty; `⚠ nN's line isn't in English` — voice-over matching supports English only for now, so write lines in English. Digits, units and money usually match how they are read out (`1,200ms` ↔ "1200 milliseconds", `$5k`, `15x`, `3/14` ↔ "March 14th"), but not every way of saying a number ("twelve hundred", "twenty twenty-six", "nine thirty am" for `9:30am`): if a line with a number is reported missing, write the number the way the user said it. Show the user the lines; they edit wording. Then `guide`. The guide cut shows in Mirage's viewer, so tell them it is there.

**AI narration instead of recording.** When the user asks for an AI voice, doesn't want to record, or the footage has no voice of its own (gameplay, screen recordings without commentary) and they want narration, skip the guide and step 5: once they are happy with the lines, call `speak` with `{ video: n }`. Kokoro reads each line, the readings are joined into a new recording (`episodes/<n>/narration-<k>.wav`, never over an earlier one) and fitted just as `vo` fits a recording, so freezes, `too long` and captions work the same. Then step 6.
- Lines must be in English: the voices are English and voice-over matching supports English only for now. Write numbers the way they should be read out ("fifty-fifty", "ninety pulls").
- The first `speak` on a computer downloads Kokoro, about 260 MB once (when `status` says `tts: not downloaded yet …`): tell the user before you call it. `tts: missing — …` means it can't be installed; pass on what the line says.
- `voice` picks the voice; the default `af_heart` is a warm American woman's. Others: `af_bella` (American woman), `am_michael`, `am_fenrir` (American men), `bf_emma` (British woman), `bm_george`, `bm_fable` (British men). `speed` from 0.5 to 2, default 1. Ask which voice they want only when they care; otherwise use the default.
- A slot over several shots (a comic's panels, a slideshow, quick cuts): write one sentence per shot, in shot order, and `speak` starts each sentence as its shot appears (`• nN: each of its K sentences starts with its shot`). About five or six words fit a 2 s shot. With any other number of sentences the line is read straight through. `• nN sentence K was read at 1.1× to fit its shot` needs nothing; `⚠ nN sentence K runs … into the next shot even read faster` means shorten that sentence.
- `• nN was read at 1.15× to fit its slot` means the line was a little long and was read faster; nothing to do unless the user minds. `too long` means even that wasn't enough: shorten the line (or give it more picture), then `speak` with `slots: ["nN"]`.
- After the user changes a line (`⚠ nN's line changed since vo`), call `speak` with `slots: ["nN"]`: it reads just those lines into a new recording and keeps the others. A full `speak` (no `slots`) reads every line again.

## 5. Recording (the user)
They play the guide cut in Mirage's viewer and narrate along in one take (QuickTime or phone). Tell them: if a line comes out wrong, re-read it straight away — the last take of a line is used (a sentence fumbled mid-line can be re-read on its own: the fumble is cut and the rest of the line kept), but a re-read after the next line has started is ignored. They drop the recording on the viewer's voice-over zone or tell you where it is; the voiceover skill takes it from there. Then: `vo` with the recording. Read the report to the user: lines that held the picture, missing lines, lines where `only part of the line was found` (have them re-read the whole line, then `vo` with `add: true, slots: ["nN"]`), and lines `too long` for their slot (shorten the line or lengthen the picture, then `add: true`). For missing lines they record just those (in any order), saved under a new file name — never over the earlier recording — and call `vo` with the new recording and `add: true`: it fits only the missing lines and keeps every placed one (`add: true, slots: ["n2", "n5"]` re-records particular lines instead; a listed line the new recording lacks says `kept the earlier take`). If `vo` says `<file> is not the recording … were cut from`, the earlier recording was saved over: put it back and save the new take under another name, or record every line again and run `vo` without `add`. `No speech was heard in <file>` / `<file> has no audio track`: wrong file or the mic was off. A full `vo` (no `add`) always undoes the freezes and splits earlier fits added (also after a re-cut) before fitting, so they never pile up or stay behind; holds you wrote into items yourself stay. Don't edit `episode.json` while `vo` runs: it refuses to save over edits (`episode.json changed while vo was running`) — just run it again; the transcript is kept, so the re-run is quick.

Changing the cut after this point: edit items, then `slots` → `vo` with the recording (it reuses the saved transcript, no re-transcribing; repeat `add: true` for any lines that came from a second recording) → `render`. `check`/`cut` print `⚠ The cut changed after the voice-over was fitted` until you do, `render` refuses, and montages are no longer snapped to the beat once a voice-over is fitted. `vo` refuses with `The cut changed since slots were written — run slots first` until `slots` has run for the current cut. Editing a line after `vo`: `check` and `render` print `⚠ nN's line changed since vo` (the old line still plays and is captioned as fitted) — have the user re-record it with `add: true, slots: ["nN"]`; a line cleared after `vo` still plays until a full `vo` drops it. `render` also refuses a recording changed since `vo` fitted it.

With AI narration, `speak` takes the place of `vo` here: after a re-cut, `slots` → `speak` → `render`; after a line edit, `speak` with `slots: ["nN"]`.

## 6. Final
`render` → `final.mp4` + `final.srt` (captions use the written lines' spelling). Write `episodes/<n>/summary.md` (what was attempted, what broke, what's left, counter values) for the next episode's recap. Suggest a title in the format: all caps with a number ("I BUILT X IN 7 DAYS", "X SAID IT WAS IMPOSSIBLE").

That summary and title are the build story's. A video in another format writes its summary and suggests its title as its format's rules say (a short's `summary.md` says what to set when posting it).

When a big video (any format but a short) is finished, offer "a few shorts from this?" with 3–5 moments from it, each in one line with where it cuts off ("The lamp lights up for the first time: cuts off as he reaches for the switch."). Make each one the person picks with `new_video { from, format: "short" }` and its own title: `from` is the big video's number, and the short gets its footage, its answers and the catalog, so don't catalog again. Each short is its own video, edited by the short format's rules (`formats { id: "short" }`) from step 3.

## Always
Never write inside footage folders. Never invent footage, numbers or events.
