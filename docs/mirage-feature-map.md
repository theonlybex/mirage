# Mirage feature map

Date: 2026-11-03.

Every feature the Mirage plugin is meant to have, grouped by where it appears. It's a brief for building the UI.

**Where things appear**
- **The viewer page** is Mirage's only UI. It's a local page at `http://127.0.0.1:<port>`.
- **Claude Code's own chat** handles a few things, listed in the last-but-one section.

**Tags**
- **P1–P7** is the phase a feature belongs to.
- **Win** marks the Windows phase.

Sources: `docs/superpowers/specs/2026-11-02-mirage-plugin-design.md` (binding) and `docs/superpowers/specs/2026-11-02-mirage-product-design.md` §6–§9.

## The project idea

**The problem.** Many people have plenty of video ideas, and editing is what stops them. They:
- don't want to learn editing
- won't pay an editor $250–1000 per video

Some YouTubers have built Claude Code setups that edit for them, but those take hours to wire up:
- skills
- ffmpeg
- HyperFrames
- transcription
- connectors and settings

Even then, a setup only becomes good after weeks of notes.

**Mirage is the finished version of that setup.** It's a plugin for the person's own Claude Code plus a local viewer page. The person:
1. installs it and runs setup once
2. drops in footage and answers 3–4 questions
3. watches the edit happen, or leaves it to run overnight
4. clicks on the video to leave notes
5. gets back a finished video

Later phases add Shorts, a YouTube draft, and a style learned from their notes and from how viewers watch.

**What it is and isn't**
- **It runs in Claude Code.** The person installs Claude Code from Anthropic and signs in with their own plan or key. Mirage has no Claude sign-in of its own and no cost meter.
- **It connects tools; it doesn't rebuild them.** ffmpeg, Parakeet, HyperFrames, Chrome, Tella and Epidemic Sound are connected by the setup step.
- **Footage stays on the machine.** Only frames, transcripts and audio go to Claude.
- **Licence:** open source under AGPL-3.0, funded by donations.
- **Platforms:** Mac first, Windows later.
- **Format:** build-story videos first, a software build series in the style of Mat Armstrong's car rebuilds. Talking-head and tutorial videos come in P2.

**Who it's for.** First the author and their colleagues, who want to promote their own projects on social media. Then anyone who stalls at editing.

**What success looks like**
- Someone who has never edited goes from install to their first uploaded draft in one sitting.
- By their fifth video, they give few notes, because Mirage has learned their style and what their viewers respond to.

**Never, even if everything else works**
- damage footage or lose work
- leave a broken state after a pause, stop or crash
- force a look ("no animations" means none)
- hide what was changed
- require editing vocabulary
- upload publicly without the person's go-ahead

## Platforms and speech recognition

Mirage needs speech recognition to "hear" the clips and to fit the voice-over. Which engine it uses depends on the platform:

| | Mac | Windows |
|---|---|---|
| Speech recognition | Apple on-device speech (default, P1). Parakeet is an option from P2. | **Parakeet**, run through HyperFrames (Win) |
| Keeping the computer awake overnight | `caffeinate` (P1) | A PowerShell helper (Win) |
| Checking for battery power before overnight | `pmset` (P1) | A Windows power check (Win) |
| Running the hooks | Shell (P1) | PowerShell or Git Bash (Win) |
| Video encoder | VideoToolbox (P1) | NVIDIA's encoder, or libx264 when there's no NVIDIA card (Win) |

**What the UI shows for this:**
- **Setup table** (in Claude Code's chat): it lists the speech engine with ✓ / – / ✗.
  - On a Mac, Parakeet shows "optional".
  - On Windows, Parakeet shows "required".
- **Status** (in Claude Code's chat): which speech engine is in use.
- **Before the Windows phase ships:** a Windows session should say "Mirage supports macOS only for now" at start and in setup. This is proposed, not planned yet.

## Viewer: across every screen
- **Video picker** (P1): the videos in the series, each with its stage: new, rough cut, guide cut or final.
- **Tabs** (P1): Edit, Review, Versions, Report.
  - P3 adds Style.
  - P5 adds Shorts.
  - P6 adds Publish.
  - P7 adds Insights.
- **"Edit overnight" button** (P1): starts an overnight run on one or more videos.

## Edit tab: watching the edit live
- **Live timeline** (P1): four lanes (picture, on-screen text, music, narration), redrawn every time Claude saves the episode file.
- **Step list** (P1): each step marked as running, done or failed.
- **Progress bar** (P1): with the time left on long steps such as renders.
- **Pause** (P1):
  - "Pause after this step" shows the time left.
  - "Pause now" cancels the running step.
- **Correction box** while paused (P1): "Tell Mirage what to change…".
  - Resume with text: Claude gets the correction before it carries on.
  - Resume without text: the edit carries on.
- **Stop** (P1): asks for confirmation, then goes back to the last finished step and keeps the rest as a backup.
- **Interrupted banner** (P1): after an Esc or a crash, offers "Go back to the last finished step" or leaving things as they are.
- **Stall banner** (P1): shown when nothing has happened for a while.
- **Diagram proposals** (P4): in a live edit, Claude proposes a diagram, and the person approves it before it's built.

## Review tab: watching and leaving notes
- **Player** (P1): plays the current version.
- **Notes on the video** (P1):
  - **Click the video:** pauses it and adds a note at that time, with a still attached.
  - **Drag on the video:** draws a box around a spot.
  - **Hold the mic button:** records a spoken note. It's transcribed on the machine: Apple speech on a Mac, Parakeet on Windows (Win).
- **Notes list** (P1): with a button to delete each note.
- **"Send notes (k)"** (P1): sends all the notes to Claude as one round.
- **Note status** (P1): done, done differently (with how), or could not (with why).
- **Fallback text** (P1): "Tell Claude: `/mirage:notes`", if sending the notes doesn't wake an idle session.
- **Voice-over drop zone** (P1): drop the recording on the page and Claude fits it. After that it shows missing or partial lines.
- **Proposed rules after each round of notes** (P3): 0–5 rule cards, each with Keep, Edit and "Not a rule".

## Versions tab
- **Deliveries** (P1): V1, V2… each with Play and "Go back to this version".
- **"Show steps"** (P1): reveals the checkpoints between deliveries.
- **QC report on each version** (P2):
  - pass or fail
  - what was fixed
  - what couldn't be fixed

  A failure blocks delivery.

## Report tab (the morning report)
- **Overnight results** (P1):
  - what was done
  - the guesses made
  - the questions held
  - things to check
  - "Next: record the voice-over"
- **Graphics built overnight** (P4): flagged here so the person can check them.

## Recording and import (P2)
- **Recording coach card:** 4–6 tips for the kind of video. For example:
  - shoot 4K
  - after a fluff, pause 2 s and restart the sentence
  - say money in full
  - name tools out loud
  - clap once with two cameras
- **SD-card copy:** with progress, and "safe to eject" only after the copy is verified.
- **Import warnings:**
  - 1080p (limits zooms)
  - missing mic audio
  - baked-in zooms or captions
  - variable frame rate
  - clipping or a very low recording level
- **Sync result:** camera, screen and mic lined up by the clap or the audio, and the measured lip-sync offset.
- **Route choice:** build story, or talking head / tutorial.
- **Speech engine:**
  - Mac: Apple speech by default, Parakeet as an option.
  - Windows: Parakeet (Win).

## Style tab (P3)
- **Style interview:**
  - about 24 questions, each shown with small previews
  - pre-filled by measuring the person's channel and the videos they admire
  - every question has a default and can be skipped
- **Style file view:**
  - colours, font, card style, captions
  - energy, zooms, face time
  - sound, music, pauses, fillers, demos
  - B-roll rules, never-show list, packaging
- **Animation level:** none, minimal, standard or rich. "None" is honoured completely.
- **Allowed formats:** on or off for each family (lines, logos, diagrams, counters, browser cutaways, chat windows).
- **Overrides:** for each kind of video, and for each video.
- **Rules list:** each rule with its source, date and reason. Rules can be edited and deleted. A new rule replaces one it contradicts.

## Graphics, sound and B-roll (P4)
- **Format library**, built on HyperFrames:
  - lower line, logo card, chapter tag
  - flow diagram, staircase, pipeline, stat tiles, counter
  - browser cutaway, doc highlight, chat window
- **B-roll list:** each clip with its source (a real page captured through Chrome, or Pexels stock) and its licence.
- **Sound effects and music:** the picks and their licences. Epidemic Sound is optional.

## Shorts tab (P5)
- **Shorts:** 3–5 per video, with 9:16 previews that follow the face or the active part of the screen.
- **Platform exports:** TikTok, Instagram Reels, X and LinkedIn.
- **Text posts:** written from the transcript.

## Publish tab (P6)
- **Titles:** 5 options to choose from.
- **Thumbnails:** 3 options, built from the person's own frames and face.
- **Description editor:** chapters, tags, the pinned comment and credit lines.
- **Copyright check:** results, with files that have no known licence flagged.
- **AI-content label:** shown only when the video has realistic AI-generated shots.
- **Upload:** as a private draft, or scheduled. It needs an explicit go-ahead; nothing goes public without one.
- **Export:** FCPXML / EDL, for Resolve, Final Cut and Premiere.
- **Archive:** after publishing, moves or compresses the raw footage and clears render leftovers.

## Insights tab (P7)
- **Retention curve:** with each drop-off lined up against what was on screen at that moment. Read at 48 hours and 7 days.
- **Proposed rules from viewers:** Keep or reject each one.
- **Title and thumbnail comparisons:** with an A/B test where YouTube allows it.
- **Teardown:** compares the person's edits with the channels they admire.
- **"Not enough data yet" state:** for very small videos, where YouTube withholds retention data.

## In Claude Code's chat, not the viewer
- **Setup:** connects the tools and ends with a ✓ / – / ✗ table. The speech-engine row follows the platform section above.
- **The 3–4 questions per video**, and choosing the footage folders.
- **Status:** which video is where, the viewer address, and the speech engine in use.
- **Overnight pre-checks:**
  - on power
  - free disk space
  - the tools working
  - prompts to leave the lid open and switch to auto mode

## Later
- **Windows (Win):** Parakeet for speech, the PowerShell keep-awake helper, PowerShell-safe hooks, and the engine's tests on Windows CI. The viewer and the skills stay the same.
- **Recording the voice-over in the viewer:** a teleprompter over the playing cut, with retakes.
- **Long recording to highlights.**
- **Story-first planning.**
- **AI B-roll.**
- **Scheduled overnight start:** for example "start at 1 am", with a notification when it finishes.
