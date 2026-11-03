# Mirage: product design and functionality map

Date: 2026-11-02. Supersedes the product framing in `2026-09-28-wordedits-design.md` §1–2, §4 (the AI row and the agent module), §8 and §11.

The following still stand:
- the engine
- the data model (EDL v2, §14.4)
- the build-story format (§14)
- the design language (§15)

Research behind this document: `docs/research/2026-11-02-style-interview-and-automation.md`.

## 1. Intent

Many people have plenty of video ideas, and editing is what stops them. They don't want to learn editing, and they won't pay an editor $250–1000 per video. Some YouTubers have built Claude Code setups that edit for them, but those take hours to wire up: skills, ffmpeg, HyperFrames, transcription, connectors and settings. Even then, the setup only becomes good after weeks of notes.

**Mirage is the finished version of that setup.** You download it, answer a short style interview, drop in footage, and get back a finished video, Shorts and a YouTube draft. It's open source and funded by donations. The first users are the user and their colleagues, who want to promote their own projects on social media.

**Success looks like this:**
- Someone who has never edited goes from install to their first uploaded draft in one sitting.
- By their fifth video, they give few notes, because Mirage has learned their style and what their viewers respond to.

## 2. Goals, non-goals, anti-goals

**Goals**
- Everything that people wire up by hand comes installed and connected, and the app shows what's connected.
- **Base filtering** runs on every video, with no questions asked (§6.2).
- Every edit fits the person's own style, learned from an interview, from their notes and from their viewers.
- **Overnight mode:** start an edit, go to sleep, and wake up to a finished first version (§7).
- The editing is shown live, and the person can pause or stop it at any moment to correct something (§8).
- Every video produces Shorts.

**Non-goals**
- A professional timeline editor. People never need to touch a timeline. Escape hatch: export to DaVinci Resolve, Final Cut or Premiere (§9.4).
- Rebuilding any tool that can simply be connected to Claude Code (§4).
- AI video generation in the first phases.

**Anti-goals** (each counts as failure even if everything technically works)
- Forcing a look. If someone wants no animations, they get none.
- Hiding what was changed. Every change is visible and reported.
- Damaging footage, losing work, or leaving a broken state after a pause or a crash.
- Requiring editing vocabulary to use it.
- A heavy app. Mirage stays light; heavy work runs in child processes.
- Uploading publicly without the person's explicit go-ahead.

## 3. Constraints

- Mac (Apple Silicon) first; Windows (NVIDIA) second.
- Open source. Everything bundled must have a licence that allows redistribution: MIT, Apache, BSD, OFL, or LGPL/GPL with source available. Nothing is copied from the WeAreNoCode kit, which sets no licence for its own text or scripts.
- Google Material 3 design language (old spec §15). Frontend work goes through the UI/UX Pro Max skill.
- Footage stays on the machine. Only frames, transcripts and audio clips go to Claude when needed. The app tells people this, and reminds them not to record secrets on screen.
- The person's own accounts (Claude, YouTube, optional paid tools) are never bundled or shared.

## 4. Architecture: build only what can't be connected

Three layers:

```
┌──────────────────────────────────────────────────────────────┐
│ MIRAGE APP (Electron + React, Material 3)                     │
│ projects · live timeline view · player + notes · chat ·        │
│ connections panel · overnight queue · style · publish          │
└──────────────┬───────────────────────────────────────────────┘
               │ starts and talks to (streamed JSON)
┌──────────────▼───────────────────────────────────────────────┐
│ BRAIN: Claude Code, run underneath by the app                  │
│ + the Mirage plugin (skills, Mirage MCP server, hooks)         │
│ + connected MCP servers and connectors                         │
└──────────────┬───────────────────────────────────────────────┘
               │ tool calls
┌──────────────▼───────────────────────────────────────────────┐
│ HANDS                                                          │
│ Mirage engine (existing packages/core: cut, music, vo, render, │
│ checks), exposed as a local MCP server and the CLI             │
│ + bundled: ffmpeg, HyperFrames CLI, speech models              │
│ + connected: Epidemic Sound, YouTube, Tella, browser, Resolve… │
└──────────────────────────────────────────────────────────────┘
```

**The brain is Claude Code itself (my call).** It's the harness those YouTubers use, and it already does:
- tool calls, MCP servers, skills and plugins
- interruption and long runs
- connectors, with their sign-ins handled

Rebuilding any of that would break the "connect, don't rebuild" rule. The app starts Claude Code headless (the Claude Agent SDK, or the `claude` CLI in streaming-JSON mode) and loads the Mirage plugin.

**Sign-in: an Anthropic API key only (checked 2026-11-02).** The Agent SDK docs say: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
- **What this means for Mirage:**
  - Each person pays as they go on their own key.
  - The key is stored in the OS keychain.
  - First launch walks them through getting a key and adding credit.
- **Plan login (Pro/Max) only with approval.** It's added only if Anthropic approves it. The sign-in code sits behind one interface, so it can be added later.
- **Branding** follows the SDK rules: "Mirage, powered by Claude". It never says "Claude Code" and never imitates its look.
- **claude.ai connectors don't come with an API key.** Every outside tool is therefore connected to the brain directly, as an MCP server configured by Mirage. Remote servers that need a sign-in (Epidemic Sound, Tella) need an OAuth flow run by Mirage; the Phase 4 design covers it.

**Mirage keeps its own Claude configuration (my call).**
- It uses the Agent SDK, which runs the Claude Code binary it ships with.
- It loads only Mirage's plugin and Mirage's MCP config, from Mirage's app data folder.
- It never reads or changes the person's own `~/.claude`.

So nobody needs Claude Code installed, and a developer's own setup is never touched.

### 4.1 Build, bundle or connect, per job

| Job | Decision | What it is |
|---|---|---|
| Editor (brain) | **Connect** | Claude Code, plus the Mirage plugin |
| Timeline, cut, voice-over fitting, music sync, render | **Have** | The Mirage engine, which exists. Exposed as an MCP server for the brain and as file watching for the app. |
| Base filtering and quality checks | **Build** into the engine | No tool does this; it's Mirage's core value (§6.2) |
| Transcription | **Have / bundle** | Mac: Apple speech recognition (exists). Windows: Parakeet through HyperFrames' bundled `transcribe --engine parakeet`, not our own port. |
| Motion graphics | **Bundle** | The HyperFrames CLI (Apache 2.0), plus its own Claude skills. Mirage adds only its format library and the style tokens. |
| Music and sound effects | **Connect** | The Epidemic Sound connector (official, paid, optional). Free fallback: HyperFrames' sound library (Pixabay licence) plus a local folder. |
| Research B-roll (pages, posts, screenshots) | **Connect / bundle** | A browser MCP (Playwright MCP, or Claude in Chrome when present) plus `hyperframes capture` |
| Stock footage | **Connect** | A Pexels MCP if a trustworthy one exists; otherwise a small Mirage tool on the free Pexels API |
| Screen recordings | **Connect** (optional) | The Tella connector. Without it, plain files. |
| YouTube upload, metadata, analytics | **Connect** | A YouTube MCP server, or Mirage's own small one if no community server passes review (§11, risk 3) |
| DaVinci Resolve | **Connect** (optional, Studio only) | The community Resolve MCP. Free Resolve gets the FCPXML export instead (§9.4). |
| AI B-roll (later) | **Connect** | Higgsfield or Hugging Face MCP |
| App UI, live view, notes, style learning, overnight runner, connections panel | **Build** | No tool provides these. They're the product. |

### 4.2 The connections panel

One screen lists everything Mirage uses. For each item it shows:
- **State:** connected / not connected / optional / built-in.
- **What it adds:** for example "Epidemic Sound: music and sound effects from its whole library".
- **Action:** one button to connect or fix it.

Mirage installs and configures the plugin, the bundled tools and the MCP servers itself.

How it gets the state: built-in tools are checked by the app. Connector and MCP state comes from the brain's own MCP status, which Claude Code reports at session start.

## 5. The people-facing flow

1. **First launch (about 10 minutes).**
   - Install check.
   - Add a Claude API key, with a guided walk-through.
   - Optionally connect YouTube.
   - The **style interview** (§6.1).
2. **Before recording:** a short **recording coach** card for the kind of video they're making (§6.3).
3. **New video.** Drop footage (or point at the SD card) and answer 3–4 questions about this video. Then choose **Edit now** (watch it live) or **Edit overnight**.
4. **The edit runs.** The live view shows it. Pause or stop at any time.
5. **Review.** Watch V1 in the player. Click any moment to leave a note, typed or spoken. Send the notes, and V2 follows.
6. **Mirage proposes rules** from those notes. One tap keeps each one.
7. **Publish.**
   - Titles, thumbnails, description, chapters, credits, AI label, copyright check.
   - Upload as a private draft.
   - Shorts and clips for other platforms.
8. **After it's published:** Mirage reads the viewer retention and proposes rules from it (§9.5).

## 6. Functionality map

Each item's phase number refers to §10.

### 6.1 Style (Phase 3)
- **The interview** follows the research doc §2. It has three layers:
  - first launch, about 24 questions, most of them pre-filled by measuring the person's channel and reference videos
  - each video, 3–4 questions
  - learned, never asked

  Questions are asked by showing small previews. Every question has a default and can be skipped.
- **The style file:** one page per person, kept in the app's data folder and versioned. It covers:
  - colours, font, card style, captions
  - energy, zooms, face time
  - sound, music, pauses, fillers, demos
  - B-roll rules, never-show rules
  - checkpoints, delivery, packaging
- **Animation choice belongs to the person.** The interview sets:
  - an **animation level**: none, minimal, standard or rich
  - **allowed formats**: on or off for each family, such as lines, logos, diagrams, counters, browser cutaways and chat windows

  Each kind of video can override them (educational turns diagrams up; a vlog might be captions only), and each video can override again. "None" is honoured completely.
- **Learned rules:** rules added from notes and from viewers, each with its source, date and a one-line reason. When a new rule contradicts an old one, it replaces it. The person sees, edits and deletes rules in the Style screen.

### 6.2 Base filtering, always on (Phase 2)

These run on every video by default. They're never asked about and can only be relaxed through a rule.

**Cut**
- Keep the last take of each line. Honour "cut that" or "scratch that" said out loud.
- Drop false starts and restarts. Mirage's existing restart detection is the base.
- Trim dead air, with the limit taken from the style file.
- Audit every cut edge by the sound: no slivers of dropped takes, no clipped first or last words.
- Room tone, never digital silence.

**Picture**
- Black-frame and flash scan.
- Frame-accurate joins.
- Zoom limits matched to the source resolution.
- Never carry a zoom across a cut.
- Cards never cover the face, using face-safe zones measured per shot.

**Sound**
- Voice at −14 LUFS, true peak under −1 dB.
- Sections level-matched.
- Music ducked under speech.
- Every sound effect levelled and lined up with its cause, and proved present in the render.

**File**
- Colour tags (BT.709).
- Duration and A/V sync within 1 frame.
- Bitrate floor.
- Lip-sync check.

**Content**
- Forms showing personal data, and anything on the never-show list, get cut or blurred.
- Readable third-party logos in stock footage get blurred.

**Render health**
- Free disk space is checked first.
- Temp caches are cleaned.
- A long render that hangs resumes.
- A note re-renders only the part it touches.

The result is a **QC report** attached to every version. A failure blocks delivery. Mirage fixes what it can and lists what it couldn't.

### 6.3 Recording coach and import checks (Phase 2)
- **Before recording:** 4–6 tips for the kind of video, for example:
  - shoot 4K if possible
  - after a fluffed line, pause 2 s and restart the whole sentence
  - say money in full
  - name tools out loud
  - clap once when using two cameras
- **On import:**
  - copy from the SD card, and verify the copy before saying it's safe to eject
  - flag 1080p (limits zooms), missing mic audio, baked-in zooms or captions, a variable frame rate, clipping or a very low recording level
  - sync camera, screen and mic by the clap or the audio
  - measure the lip-sync offset once per setup and remember it

### 6.4 Edit routes (Phase 2, then later phases)
- **Build story:** the existing route (clips, story, voice-over last).
- **Talking head / tutorial** (Phase 2): one or more takes, cut from the transcript under base filtering. Screen recordings become cutaways, or a screen-and-face layout. Screen zooms land on the thing being named, using the screen-activity measure.
- **Long recording to highlights:** pick the strongest moments from a long raw file.
- **Story-first:** for planned videos like an introduction, the story comes first, then a shot list, then recording.
- Several clips for one video are ordered and joined automatically.

### 6.5 Graphics, sound and B-roll (Phase 4)
- The format library is built on HyperFrames:
  - lower line, logo card, flow diagram, staircase, pipeline, stat tiles, counter
  - browser cutaway, doc highlight, chat window, chapter tag
  - Mirage's own designs, drawn from the style tokens
- **Graphics are found in what you said:** lists, steps, money, named tools and named sites. Mirage proposes a diagram before building it, unless it's running overnight, where it builds the diagram and flags it in the report.
- **Sound effects** follow the style file. The default is "silence unless something on screen makes the sound".
- **Research B-roll:** real pages, posts and documents captured through the browser. Real sources only, never invented ones.
- **Stock B-roll:** free licences only. The licence is recorded for each clip.

### 6.6 Shorts and other platforms (Phase 5)
- 3–5 Shorts from every video. They're the viral moments, and each must:
  - make sense on its own
  - hook in the first second
  - pay off its promise
- Each Short is built for 9:16, never just a centre crop. It follows the face or the active part of the screen, uses large word-by-word captions, and stays clear of the platform's button areas. It links back to the full video through YouTube's related-video link.
- The same moments are exported for TikTok, Instagram Reels, X and LinkedIn, each within that platform's length limit and screen areas. A text post can be written from the transcript.

### 6.7 Publishing (Phase 6)
- **Titles:** 5 options in the person's packaging style.
- **Thumbnails:** 3, built from their own frames and face plus their style.
- **Description, tags and pinned comment:** chapters from the edit, their standard links, and credit lines.
- **Credits:** any outside file whose licence requires naming the creator (Creative Commons BY, for example) gets its credit line in the description automatically. Mirage keeps a record of every outside file it used (source page, licence, seconds used).
- **Copyright check:** every outside music, footage and image file is checked against the record before upload. Anything without a known licence is flagged.
- **AI-content label:** it follows YouTube's rule. The label is set only when the video contains realistic AI-generated content a viewer could mistake for real, such as an AI shot of the person or a realistic scene that didn't happen. AI editing, captions, colour fixes and cartoon-style graphics never set it.
- **Upload:**
  - private draft by default, or a scheduled publish
  - captions file
  - end screen and cards where the API allows
  - nothing goes public without the person's explicit go-ahead

### 6.8 Learning from viewers (Phase 7, a key feature)
- 48 hours and 7 days after publishing, Mirage reads YouTube Analytics:
  - retention curve, drop-off moments
  - click-through rate and impressions
  - average view duration
  - the Shorts → full video path
- It lines each drop-off up with what was on screen and in the audio at that moment, then **proposes rules**. For example, "Viewers left during long intros in 3 of 4 videos. Shorten intros to under 20 s?" The person accepts or rejects each one.
- It compares thumbnails and titles across videos. Where YouTube allows it, it runs the thumbnail A/B test.
- YouTube withholds retention data on very small videos. Mirage says so plainly instead of guessing.

### 6.9 Housekeeping (Phase 6)
- **Cost meter:** an estimate before an edit starts, the running cost during it and the total after. Routine steps use cheaper models. This applies to the API key; a Claude plan shows usage instead.
- **Archiving:** after publishing, move or compress the raw footage (to an external drive, if chosen), keep the project so it can still be re-edited, and clear render leftovers.
- **Versions:** V1, V2… are all kept. Any version can be reopened.

## 7. Overnight mode (Phase 1 runner, growing every phase)

The person queues one or more videos, chooses "Edit overnight", and closes the app window. The work keeps running.

**Before it starts, Mirage checks:**
- the power adapter is connected
- there's enough free disk space
- the connections are working
- the cost estimate is within the person's nightly limit

**While it runs:**
- **It keeps the computer awake** (Electron power-save blocker). It warns that on a Mac, closing the lid sleeps the machine unless it's on power with an external display. The safe advice is: leave the lid open with the screen off.
- **Nothing stops for a question.** Wherever the live mode would ask, overnight mode makes its best guess, writes the guess down, and moves on. The question goes onto the morning list.
- **Failures:** a failed step retries once, then the run continues with whatever else it can do. A video that can't finish reports exactly where it stopped. Nothing is left half-written; the episode lock and the atomic saves already guarantee this.

**In the morning:**
- **A report:** V1 ready, what was done, its own concerns, the guesses it made, the questions it held, the QC report and the cost.
- **Notification:** a desktop notification, plus an optional phone push. The notification method is the builder's call.

**Optional schedule:** "start at 1 am", for people who want their machine free in the evening.

## 8. Live view, pause and stop (Phase 1)

**The live view is view-only.** Claude edits the episode files, and the app watches them and redraws:
- clips land and drop out
- retakes disappear
- cards land on their words
- music and voice-over lanes fill
- snapshots appear

A step list ticks alongside, for example "Cutting retakes… 14 removed". It's there because the user wants it as a design choice: it shows the automation at work. Nobody needs to touch it.

**Pause:** Mirage finishes the step that's running, never stopping mid-save, then holds. The person can then:
- type or speak a correction
- click a moment and leave a note
- look around

**Resume** carries on with the correction applied.

**Stop:** it ends the run and goes back to the last saved version, keeping everything up to that point as a numbered version.

**The chat is always there.** Typing in it pauses the run, and the reply comes from Claude. This was an original requirement.

**Pause during a long render (my call).** Pause takes effect at the next tool-call boundary, enforced by a hook on the brain. If a render or another long engine command is running, the pause sheet offers two choices:
- **"Pause after this step"** shows the time left.
- **"Pause now"** cancels the step. The engine already cleans up after a cancelled render, and it can be rerun.

### 8.1 Versions (Phase 1, moved from Phase 6)
- **A version** is a snapshot of the video's folder state: the episode file, the narration and slot files, the style rules in force, and the render, if there is one. Media is referenced, never copied.
- **Snapshots are taken automatically:**
  - before each run
  - after each completed step, as internal checkpoints
  - at each delivery: V1, V2…
- **Stop** returns to the last completed step. The pre-run state is also one tap away.
- **History:** the person sees the delivered versions. The checkpoints sit behind "show steps".
- **Where it lives:** in the engine, so the CLI and the app share it, under the existing episode lock.

## 9. Notes, learning and hand-offs

### 9.1 Notes on the video (Phase 1)
- **Click any moment** in the player, then type or say the note. The timestamp and a still of that moment are attached automatically.
- **Notes can be drawn:** a box around a spot, for example "this text is too small".
- **Notes collect in a list.** "Send notes" hands them all to Claude as one round. Each note shows its status: done, done differently (with the reason), or couldn't.

### 9.2 Proposed rules (Phase 3)
After each round, Mirage compares what the notes changed and proposes 0–5 rules. For example: "You removed 3 whooshes under text. Rule: no whoosh under text?" The choices are **Keep**, **Edit** and **Not a rule**. Kept rules go into the style file (§6.1).

### 9.3 Teardown (Phase 7)
Every few videos, Mirage measures the channels the person admires against their last edits and proposes rules from the gaps. It's for private analysis only; when a download is refused, Mirage never forces it.

### 9.4 DaVinci Resolve and other editors (Phase 6)
Resolve's MCP servers drive Resolve's scripting API. That API only works from outside Resolve in **Resolve Studio** ($295, paid); free Resolve blocks it. Resolve is also a heavy professional app, the opposite of Mirage's audience. So:
- **Every person** gets **FCPXML / EDL export** of the cut, which free Resolve, Final Cut and Premiere all open. It's the escape hatch for a real editor to finish a video.
- **People who already own Resolve Studio** can connect the community Resolve MCP, for colour grading or a Resolve-native hand-off. It's optional and never required.

## 10. Phases (each one gets its own design, plan, build and review)

| # | Phase | What people get |
|---|---|---|
| 1 | **The app** | Small installer. API-key setup. Versions. Cost estimate. Projects. Live timeline view. Player with notes. Pause and stop. Chat. Connections panel. Overnight runner (on today's build-story engine). |
| 2 | **Base filtering, recording coach, talking-head route** | The talking-head route. Always-on QC with a report. Import checks and SD-card copy. Camera, screen and mic sync. |
| 3 | **Your style** | The interview, with channel measuring. The style file. Animation level. Proposed rules. |
| 4 | **Graphics, sound, B-roll** | HyperFrames format library. Sound effects. Research and stock B-roll. Epidemic Sound connected. |
| 5 | **Shorts and other platforms** | 3–5 Shorts per video. Clips per platform. Text posts. |
| 6 | **Publishing and housekeeping** | Titles, thumbnails, description, credits, copyright check, AI label, private-draft upload. Cost meter. Archiving. FCPXML export. Resolve option. |
| 7 | **Learning from viewers** | Retention to rules. Thumbnail and title comparisons. Teardown. |
| Later | | Windows build (Parakeet via HyperFrames), AI B-roll (Higgsfield / Hugging Face), long-recording highlights, story-first planning, more formats |

Every phase ends with something people can run. Phase 1 alone must already beat the CLI.

**Phase 1 decisions (my calls, from the builder check)**
- **Projects.** The app's unit is a **video**. A **series** is a project holding ordered videos. This is the engine's existing project, with an episode per video. A one-off video is a series of one, so Phase 2's talking-head videos fit without reworking the data model. Projects made with the CLI open in the app.
- **Installer contents.** It contains only what Phase 1 uses:
  - the app
  - the Agent SDK with its binary
  - ffmpeg
  - the Apple speech helper
  - the Mirage engine, plugin and MCP server

  Later phases download their parts on first use (HyperFrames, Parakeet, browser), shown in the connections panel. This keeps the first download small.
- **Cost (moved from Phase 6).** Phase 1 shows a rough estimate before a run, a running total during it, and a nightly limit for overnight mode. These are needed because everyone pays per use on their key. The full meter with per-step model choice stays in Phase 6.

**Defaults taken when the user said "implement" without answering the last three questions (my calls, easy to change)**
- **Video types.** Phase 1 stays on the build-story route. If the colleagues mostly make talking-head videos, Phase 2 (which brings that route) comes straight after.
- **Voice-over.**
  - Overnight, V1 is the **guide cut**: the picture and music edit, plus narration lines written for each slot, rendered without voice. The morning report says "record the voice-over next".
  - Phase 1 takes a voice-over file the person **drops in**. The engine's existing `vo` step fits it, and then V2 renders.
  - In-app recording (a teleprompter over the playing cut, with retakes) is later work.
- **Distribution.**
  - Builds are **unsigned** at first. The README explains the one-time right-click → Open.
  - Signing and notarisation are added once there's an Apple Developer account.
- **Licence.**
  - Mirage's own code is **MIT**.
  - ffmpeg ships as a **separate executable**, a GPL build because the engine uses libx264. Its licence and a source link are included.
  - Mirage never links ffmpeg into its own code.

## 11. Risks and open items

1. **Claude plan sign-in: resolved.** It's not allowed without Anthropic's approval, so Mirage uses an API key (§4). Asking Anthropic for approval is optional later work.
2. **Third-party MCP servers** (YouTube, Pexels, Resolve) vary in quality and trust. Each is reviewed (code, permissions, maintenance) before Mirage installs it. If none passes review, Mirage writes its own small server.
3. **YouTube API.** Uploads from an unverified Google project are locked to private, which suits private drafts. The daily quota is shared by everyone using one project; an upload costs about 1,600 of 10,000 units. Options:
   - each person makes their own Google project (setup pain)
   - Mirage gets its project verified and raises the quota

   This is decided in the Phase 6 design.
4. **Epidemic Sound** needs each person's own subscription. Mirage must be fully usable without it.
5. **Cost per video** on the API key is unknown for Mirage's own pipeline (his setup was about $27). Measure it in Phase 1 and publish it in the README.

## 12. Decisions

**Made by the user**
- Mirage is a download-and-go product.
- Open source, donations only.
- The audience is people who stall at editing.
- Don't rebuild what can be connected to Claude Code.
- Base filtering by default.
- Animations are each person's own choice, including none.
- Click-on-video notes.
- Proposed rules.
- A recording coach ("very important").
- SD-card import and sync.
- Packaging and private-draft upload.
- A copyright check.
- The AI label only for AI-generated content.
- Learning from viewers is a key feature.
- Shorts from every video.
- A live view of the edit, by design choice.
- Pause or stop to add corrections.
- Overnight editing.
- Phase order 1–7.

**My calls** (to check)
- Claude Code (through the Agent SDK) as the brain, with Mirage's own separate configuration.
- The Mirage engine exposed as an MCP server.
- HyperFrames for graphics.
- Parakeet through HyperFrames on Windows.
- FCPXML export for everyone, and Resolve MCP only for Studio owners.
- Overnight mode makes guesses instead of stopping.
- Up to 5 proposed rules per round.
- Retention read at 48 h and 7 days.
- Phase 1 defaults (§10): build-story only, guide cut overnight with a dropped-in voice-over, unsigned builds, MIT licence with a separate GPL ffmpeg executable.

**Approval:** the user said "implement" on 2026-11-02, after reading this document.

**Left to the builder**
- How Claude Code is started.
- The file-watch mechanism.
- The style file format.
- Notification channels.
- Which browser MCP.
- Component details within §15.
