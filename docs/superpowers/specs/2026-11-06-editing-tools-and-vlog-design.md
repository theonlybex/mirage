# Editing tools for viral videos, the vlog and short formats, and asking before setup

Date: 2026-11-06. Status: design, waiting for approval. Branch: from `claude/kokoro-narration`.

## Why

The person makes YouTube videos and Shorts with Mirage and wants them edited "at a professional level, so people click
and stay until the end". Mirage today makes one kind of video, the build story, with phrase captions, fixed zooms,
music cues and overlays. Professional retention editing uses a few more tools, and the person asked for all of them:

1. word-by-word captions with the current word highlighted;
2. animated zooms (slow push-ins, moves across the picture);
3. sound effects;
4. J- and L-cuts (sound that starts before its picture, or carries on after it);
5. a hook-first, loopable short format;
6. thumbnails and titles;

plus a **vlog** format, built from the research in the person's `References/vlogs-playbook.md` (a study of a hit vlog
channel's editing: structure, pacing, text on screen, packaging). The person named it "vlog".

Separately, the person asked that a new user who has just installed the plugin is **asked** whether Mirage may install
the tools editing needs, with a plain explanation of why each is needed (part 8).

## Goals
- Each tool works in every format, not only in the one it was researched for.
- Claude (the editor) uses these tools through `episode.json` and engine tools, as it uses Mirage today; the edit skill
  says when to use each one, with numbers from the playbook.
- Everything runs on the person's computer, on macOS, Windows and Linux. No paid services, no downloads beyond fonts
  bundled in the plugin.
- Existing episodes render exactly as before: every new field is optional, with a default that means "as today".

## Non-goals
- Automatic laugh, face or emotion detection. Claude picks moments from frames, transcripts and catalog moments, as now.
- Copyrighted music. The playbook's channel uses hit songs; Mirage keeps using the person's own `music/` library.
- A timeline editor in the viewer. The person still steers with notes.
- Uploading to YouTube or Instagram.

## Anti-goals (a failure even if it works)
- A vlog or short that invents events, numbers or people. The existing rule holds: everything comes from the footage
  and what the person says.
- Effects that cheapen the video: a sound effect on every cut, zooms on every shot, captions that cover faces. The
  skill gives limits (below) and `check` warns past them.
- Sound effects that are clearly fake-sounding left in by default. If a built-in sound isn't good enough, it is
  better left out than used.
- A setup question that nags: asking in every session, or in folders that have nothing to do with video.

## Constraints
- Cross-platform only (person's standing rule): FFmpeg and libass do the rendering; nothing Mac-only.
- `episode.json` stays version 2; new fields are additions with defaults. `strictObject` still refuses unknown keys.
- Footage folders stay read-only. Generated files go in the episode folder or Mirage's data folder.
- Render time: the new tools may not make an ordinary render more than about 20% slower when they aren't used, and
  animated zooms may not make an item's render more than 3× slower than a fixed zoom.
- The SessionStart hook runs in every session the person opens, Mirage or not: it must stay fast (no process spawns
  outside a Mirage project beyond reading a file or two and scanning PATH).

---

## Part 1 · Word-by-word captions

**Today:** `groupCaptions` makes phrase cues (up to 38 characters, split at pauses and sentence ends), drawn by
`buildAss` in one bottom-centre `Caption` style. `final.srt` carries the same cues.

**New:** an episode field `captions`:

```json
"captions": { "style": "pop", "position": "middle", "highlight": ["gulp", "awful"] }
```

- `style`:
  - `phrase` (default): today's captions, unchanged.
  - `pop`: 1–3 words at a time (at most 16 characters), bold, ALL CAPS, white with a dark outline. Each word appears as
    it is spoken. The Shorts style from the playbook.
  - `karaoke`: today's phrase, with the word being spoken drawn in the highlight colour.
  - `chosen`: no automatic captions; only `subtitle` overlays (part 7) show. For vlogs.
  - `off`: none burned in.
- `position`: `bottom` (default) or `middle` (about 60% down the frame, clear of the Shorts interface at the bottom).
- **Defaults never change an existing episode** (my call): with no `captions` field an episode renders exactly as today
  (phrase captions, bottom, today's font), whatever its shape. The new looks come from Claude writing `captions` into
  `episode.json`: the edit skill writes `{ "style": "pop", "position": "middle" }` for every new short and vertical
  video. Rendering never reads `video.json` for this.
- `highlight`: key words Claude marks; in `pop` each is drawn in the highlight colour (lime-yellow, `#C6FF3D`-ish) and
  slightly larger. Each entry is either a word (`"gulp"`: lit every time it's said) or one moment
  (`{ "word": "money", "at": 31.2 }`: lit only where it's said nearest output time `at`, for a word the speaker repeats).
  At most one key word per group. In `karaoke` the colour marks the current word instead, so `highlight` is ignored.
- `color` (optional, `#RRGGBB`): overrides the highlight colour.
- Word times come from the transcripts Mirage already has (`speechWords`), so captions follow both live sound and
  voice-over, written spelling included.
- `final.srt` stays phrase cues whatever the style, so YouTube's own captions read normally.
- `pop` words animate in with a short scale pop (about 120 ms, 115% → 100%), as `callout` does today.
- The guide cut keeps showing the narration prompts, not captions, as today.

**Fonts:** pop captions need a heavy font that looks the same everywhere. Mirage bundles two OFL-licensed fonts in the
plugin (my call: Montserrat ExtraBold for `pop` and `karaoke` captions, cards and the new overlays; `phrase` captions and
the existing overlays keep today's font, and a monospace such as JetBrains Mono for the vlog title
card), passed to libass with `fontsdir` pointing at that small folder only (the comment in `render-episode.ts` about not
pointing it at system font folders still holds). CJK fallback stays as today. Licences go in `THIRD_PARTY_NOTICES.txt`.

**Rules for Claude (edit skill):** `pop` for Shorts and vertical videos, `karaoke` or `phrase` for long videos, `chosen`
for vlogs. One key word per caption at most, and only words that carry the joke or the stakes.

## Part 2 · Animated zooms

**Today:** an item has a fixed `zoom` (1–2) around `focus`, applied as a crop before framing.

**New:** an item field `move`, the frame at the item's end; the item starts at its `zoom` and `focus`:

```json
{ "id": "react", "zoom": 1, "move": { "zoom": 1.25, "focus": { "x": 0.4, "y": 0.35 }, "ease": "inOut" } }
```

- `move.zoom` 1–2, `move.focus` like `focus`, `ease` one of `linear`, `in`, `out`, `inOut` (default `inOut`).
- `move.start` / `move.end` (optional, seconds into the item, default the whole item): a move over part of the shot,
  holding before and after. A **punch-in** on a punchline is `move` with `start` = `end` − 0.15 s or less, or (as today)
  a split into two items with different `zoom`; the skill explains both.
- The move covers the item's held frames too, unless `move.end` says otherwise.
- **Smooth, not jittery:** a crop moving in whole pixels shimmers. The builder picks the technique and proves it on a
  slow move (1 → 1.1 over 6 s) by eye on a frame dump. A known way: FFmpeg's `zoompan` on a frame upscaled first (it
  worked for the comic panels of video 3, with a 4× Lanczos upscale), or a per-frame `scale` + `crop` with sub-pixel
  maths. Within the render-time constraint above.
- `frame: fill` and `blur` still apply after the move (the move works on the source picture, as `zoom` does now).

**Rules for Claude:** slow push-ins (1 → 1.1–1.2 over 3–8 s) on reactions and pieces to camera; a punch-in on the line
before a laugh; never more than one move in three shots in fast montage stretches; no moves on screen recordings
unless following the cursor to something small.

## Part 3 · Sound effects

**New:** an episode list `sfx`, in output seconds like music cues:

```json
"sfx": [{ "sound": "whoosh", "at": 12.4, "gainDb": -8 }, { "sound": "sfx/airhorn.wav", "at": 30.1 }]
```

- `sound`: a built-in name, or a file in the project's `sfx/` folder (a plain path inside the project, as music is).
- Built-in sounds, generated with FFmpeg's own audio sources the first time they're used and cached in Mirage's data
  folder (no download, no licence): `whoosh`, `swoosh-out`, `hit` (a low boom), `riser` (2 s, ends on `at`), `pop`,
  `ding`, `click`, `scratch` (record scratch).
- **The person listens before any ship** (their decision). The builder can't hear, so part 3 stops at a checkpoint: it
  hands the person each built-in sound as a WAV (two or three variants of each where the sound design is uncertain)
  and a short test render with them placed on cuts and a punchline. Only the sounds the person approves ship; the rest
  are dropped (anti-goal), and the skill lists only the approved ones. Their notes ("too thin", "louder") go into
  another round before the part is finished. The rest of part 3 (`sfx/` files, music dips, `check`) doesn't wait on it.
- `at` is where the sound's peak lands (a riser's end, a hit's attack), so Claude places it on the frame of the cut or
  the punchline. `gainDb` 0 or less, default −6 relative to speech loudness.
- SFX get their own bus: not ducked under speech, mixed after the music ducking, through the existing limiter.
- **Music dips:** the playbook drops the music right before a punchline or reveal. A music-cue field
  `dips: [{ start, end }]` mutes that cue over those spans with fast (about 80 ms) fades. `check` warns about a dip
  outside its cue.
- `check` checks each sound exists, warns about a sound past the episode's end, and warns when there are more than
  about 6 sounds a minute ("sound effects on almost every cut cheapen the video").
- `music` (the tool) is unchanged; `sfx/` files are read when used, without a library file. A file that isn't audio is
  refused at `check`.

**Rules for Claude:** whoosh on a fast transition or a time jump, hit or pop under a text card or a reveal, riser into
a reveal, ding on a counter or a win, scratch on a "wait, what?" moment. Under the limit above; none under speech
except a pop under a word that's on screen.

## Part 4 · J- and L-cuts

**Today:** each item's sound is cut exactly with its picture (`itemChunkArgs` pairs `[v]` and `[a]` and concatenates).

**New:** item fields, in seconds of the item's own sound:
- `leadIn` (0–3): the item's sound starts this much **before** its picture (a J-cut: you hear the next scene first).
- `tailOut` (0–3): the item's sound carries on this much **after** its picture ends (an L-cut).

How it plays:
- Only for items with `audio: "keep"` at speed 1 (as live sound works today), and only from source the clip has before
  `src.in` / after `src.out`; `check` warns and shortens a lead or tail the clip can't supply.
- Under the overlap the neighbouring item's own sound crossfades: it fades out over the J-cut's lead (and fades in over
  the L-cut's tail) so two voices don't talk over each other at full level. My call; equal-power fades.
- Captions, slots and voice-over fitting see the moved sound: `speechWords` includes the lead and tail words at their
  output times, and `slots` treats them as speech (no narration over them).
- The builder chooses how to render it. One way that keeps chunks as they are: the chunks keep each item's own sound,
  and the lead and tail pieces render as a separate "spill" track (decoded from the sources, placed with `adelay`),
  mixed into the speech bus before normalising, with the neighbours' fades applied on the chunk audio.
- `itemsFingerprint` includes `leadIn` and `tailOut` only if they change timing — they don't (the picture cut stays),
  so the voice-over stays fitted; but a voice-over line under a new lead or tail is reported by `vo` as overlapping
  speech.

**Rules for Claude:** a 0.3–1 s J-cut into a new scene whose sound explains it (a laugh, a door, a first line); an
L-cut to let a laugh or a reaction ring under the next shot. Not inside fast montages.

## Part 5 · Video formats: build story, short, vlog

**New:** `video.json` gets `format`: `build-story` (default, and what every existing video is), `short` or `vlog`.
`new_video` takes it; the edit skill asks for it with the three questions it asks now (or infers it from what the
person says, and says which it picked).

The beat list grows. `BeatSchema` gains `hook`, `payoff`, `loop` (short) and `title-card`, `premise`, `bit`, `headline`,
`sponsor`, `plugs`, `tag` (vlog). `check` warns when an item's beat isn't one of its video's format (an existing
build-story episode is never refused for this).

`check` prints the length against the format's target and warns when it's far off:
- build story: about 13 min, scaled to the footage (as now, no warning);
- short: 20–45 s target, warning past 60 s;
- vlog: a target in `video.json` (`targetSec`), default 260 s (4:20, the classic length), or 600–960 s for the "now"
  style when the person asks for long vlogs.

### Short
Beats: **hook** (frame 0: the claim, or the thing about to happen; no title, no logo, no "hey guys") → **payoff** →
**loop** (ends mid-beat so the restart flows into the hook).
- `check` warns when the first item starts with silence longer than 0.5 s or with a `title`/`cold-open` beat, when the
  last music cue fades out at the end, and when there's an `outro`.
- Claude writes 1080×1920 and `captions: { "style": "pop", "position": "middle" }` into a new short's `episode.json`.
- The skill describes the loop: the last line or sound leads back into the first shot (a question the hook answers,
  a sentence cut so the hook finishes it, the same motion at both ends).
- A short can be cut from any project's footage, including a vlog's: a new video with `format: "short"` and the same
  footage folders.

### Vlog
Beats in order (from the playbook, measured on the classic vlogs):
1. **cold-open**: an 8–15 s standalone gag, not a preview of the headline.
2. **title-card**: 2 s, black, three lines of white monospace: `<name> / Vlog #<n> / <M-D-YY>`.
3. **premise**: 30–50 s to camera, fast; any sponsor read goes here (or mid-video for long vlogs).
4. **bit** × any, then **headline**: the bit the title promises, held back until it pays off. Build-up fast and
   handheld (2 s shots, 15–25 cuts a minute); the reveal held long on one angle (jump cuts on that same angle).
5. **plugs**: full-screen cards (merch, socials, "vlog continues on…"), only if the person has something to plug.
6. **tag**: one more gag after the cards. Never end on a card or a sign-off.

What the vlog needs that Mirage lacks, covered by parts 1–4 and 7: card items, name labels with a joke line, time
cards, chosen yellow subtitles, one song per bit with dips before punchlines, sound effects.

`video.json` gets an optional `vlog: { name, number, date }` for the title card (the person gives the name and
number once; Mirage counts up from the last vlog in the project). The date is the day most of the footage was filmed
(from the catalog), which Claude confirms with the person.

**Rules for Claude (from the playbook):** cut out on the laugh; speech front-loaded and a music-led back half; one song
per bit; cut whole bits before thinning laughs to reach the target length; consent and blurring per the playbook's
guardrails (the `hide` answer already covers what must not show).

## Part 6 · Thumbnails and titles

**New engine tool** `thumbnail { video, at?, text?, focus? }`:
- Without `at`: writes up to 12 candidate frames from the rendered cut (`final.mp4`, else `rough.mp4`) to
  `episodes/<n>/thumbs/cand-<k>.jpg`, picked at catalog `moments`, the loudest second of each kept-sound item, reveal
  and headline beats, and evenly between them. Claude looks at them and picks one, preferring a wide-open shocked or
  laughing face with its cause in frame (the playbook's style).
- With `at` (output seconds): writes `episodes/<n>/thumbnail.jpg` at 1280×720 (16:9 videos) or 1080×1920 (vertical;
  the Shorts cover), from the full-quality source frame (not the compressed render), cropped around `focus`, slightly
  sharpened and brightened. Optional `text`: up to 4 words in the bundled bold font with a heavy outline (the playbook
  style is no text; the person can ask for it).
- The thumbnail is copied to `Finished/…` with the video by the person's existing rule.

**Titles:** no tool. The edit skill has Claude write 3 title options in `summary.md` in the format's style: ALL CAPS
ending in "!!" and hiding who/what (classic), or first-person sentence case (now); 3–8 words; never a claim the video
doesn't deliver. Plus a description in the playbook's template (people in the video, credits, music licences).

## Part 7 · Cards and new overlays (used by the vlog, available everywhere)

- **Card items:** an item with `card` instead of `clip` + `src`, taking its own time on the timeline:
  `{ "id": "tc", "beat": "title-card", "card": { "text": "Sam\nVlog #3\n11-6-26", "style": "mono", "sec": 2 } }`.
  `style`: `mono` (white monospace on black, the title card), `bold` (big bold centred text on black: plug cards, "2
  days later..."), `image` (a picture from the project, `card.image`, with optional text over it). No sound unless
  `tailOut` from the item before or `leadIn` from the one after runs under it, or a sound effect is placed on it.
- **`name` overlay:** a lower-third name label with a joke line, yellow:
  `{ "kind": "name", "text": "Alex", "sub": "Has never won a game", "start": 4, "end": 7 }`. New optional `sub` field
  (refused on other kinds).
- **`subtitle` overlay:** a small yellow subtitle on a chosen line, bottom-centre. Its text must be words actually said
  there (Claude copies them from the transcript); `check` warns when it doesn't match the speech under it.
- **`timecard` overlay:** a small yellow tag in the top-left corner ("EARLIER", "THE NEXT DAY").
- Styles in `buildAss`, all scaling with the frame like the existing ones.

## Part 8 · Asking a new user before setup

**Today:** the SessionStart hook says something only inside a Mirage project ("This folder is a Mirage project …").
A new user who installs the plugin and opens a session finds out tools are missing only when an engine tool fails, or
when they run `/mirage:setup`. If Node is missing, the launcher prints "Mirage needs Node.js 22 or later. Run
/mirage:setup." to stderr and nothing reaches Claude.

**New:**
1. **When it asks** (my call; the person may change it):
   - the first session after the plugin is installed or updated to this version, in **any** folder;
   - after that, only in sessions inside a Mirage project, and only while something required is missing;
   - never again for 7 days after the person says "not now" (they can always run `/mirage:setup`).
2. **How it knows:** the hook checks what it can without running anything slow: FFmpeg and ffprobe on PATH (and the
   places the launcher looks), `whisper-cli` on PATH, the speech model file. Node is present if the hook runs. State
   lives in Mirage's data folder (`setup.json`: `{ askedVersion, laterUntil }`).
3. **What it says:** additional context telling Claude, at the start of its first reply, to ask the person whether
   Mirage may install what's missing now, explaining each in one plain sentence with its size, then run the setup
   skill for whatever they agree to. The explanations, kept in the setup skill so they stay in one place:
   - **Node.js** — runs Mirage itself: its engine and the viewer you watch your videos in.
   - **FFmpeg** — does the actual video work: cutting, joining, captions, music and the final export.
   - **whisper.cpp and its speech model (about 574 MB)** — lets Claude hear what's said in your clips, so it can pick
     the best takes and write captions; it runs on your computer, nothing is uploaded.
   - **Kokoro AI voice (about 260 MB, optional)** — reads narration aloud if you don't record your own; downloaded
     the first time you use it, so nothing to install now.
   - Plus what the person must do themselves (e.g. pasting the Homebrew installer, which asks for their password).
4. **"Not now":** a small engine tool `setup_later {}` records `laterUntil`; Claude calls it when the person declines.
   The hook stays quiet until then.
5. **Node missing:** the hook can't run at all. The launcher (`plugin/scripts/node`), when its last argument is
   `session-start`, prints the SessionStart JSON itself with the same kind of message (Node only; it can't check the
   rest), and exits 0. Same first-session / Mirage-project rule, read from `setup.json` with plain shell.
6. **Windows:** the launcher is a POSIX shell script, so on Windows none of the hooks run today (pre-existing). This
   part doesn't fix that; it's listed as a follow-up.
7. The setup skill's "Ask before each install, and say what it is and roughly how big it is" rule stays; this part
   only makes sure the question is asked at the start, before the person tries to edit.

---

## Build order

Each part ships on its own, with tests, in this order (the earlier ones are what Shorts need most):
1. Part 8 (asking before setup) — small, and every new user meets it first.
2. Part 1 (captions) with the bundled fonts.
3. Part 2 (animated zooms).
4. Part 3 (sound effects and music dips), with the listening checkpoint: the build carries on with part 7 while the
   person listens.
5. Part 7 (cards and new overlays).
6. Part 5 (formats: short, then vlog), using 1–3 and 7.
7. Part 4 (J/L-cuts) — the most render work, least needed for Shorts.
8. Part 6 (thumbnails and titles).

After each: `pnpm test`, `pnpm typecheck`, `pnpm build:plugin`, a real render showing the new thing, the skills updated
(edit, notes where relevant, setup for part 8), commits with `-s`, nothing pushed.

## Testing
- Unit tests in the style of `overlays.test.ts` / `render-episode.test.ts` for each new field: schema defaults, ASS
  events, FFmpeg argument shapes, `check` warnings.
- One real render per part on fixtures (the existing `fixtures/` clips), checked by frame dumps and, for sound,
  by measuring levels at the expected times; whisper still hears the words.
- Existing episodes: the existing render tests pass unchanged (the "as today" defaults).
- Part 8: hook tests for each case (first session anywhere, Mirage project with tools missing, after "not now",
  everything installed), and a launcher test with no Node (the existing `MIRAGE_NODE_FIXED` mechanism).

## What's left to the builder
- The rendering technique for smooth zooms (part 2) and for J/L-cuts (part 4), within the constraints.
- The exact sound design of the built-in effects, and which ones ship.
- Exact colours, sizes and margins of the new styles, matched to the playbook's descriptions.
- Which OFL fonts exactly (Montserrat and JetBrains Mono are my suggestion).
- Names of internal functions and files.

## My calls in this document (for the person to check)
- Built-in sound effects are generated, not downloaded; your own files go in `sfx/`.
- Two bundled fonts so captions look the same on every computer.
- `final.srt` stays normal phrase captions whatever style is burned in.
- Old episodes, the Short already made among them, keep today's captions; new shorts get pop captions because Claude
  writes them in, not because the default changed.
- A highlighted word lights up every time it's said, unless Claude pins it to one moment.
- Overlapping sound in J/L-cuts crossfades rather than playing both at full level.
- The vlog's default length is 4:20 (the classic), long vlogs on request.
- The setup question: first session after install anywhere, then only in Mirage projects, quiet for 7 days after
  "not now".
- No automatic laugh or face detection: Claude picks moments by looking, as today.
