# Mirage as a Claude Code plugin: design and feature map

Date: 2026-11-02.

**What this replaces.** It supersedes the architecture of `2026-11-02-mirage-product-design.md`, which had Mirage as its own Electron app with a bundled Agent SDK brain and API-key sign-in. Specifically it replaces that document's §3 platform line, §4, §4.2, §5, §7, §8, the Phase 1 parts of §10, and §12's "my calls".

**What still stands from that document:**
- the intent (§1) and goals (§2)
- the functionality content of §6: style, base filtering, recording coach, routes, graphics, Shorts, publishing, learning from viewers, housekeeping
- §9: notes, proposed rules, teardown, Resolve

The engine (old spec §14) and the design language (old spec §15) also still stand.

**The setup file:** `setup/connect-tools.md`.

## 1. What changed and why

The user decided (2026-11-02):
- **Mirage uses the person's own Claude Code.** Mirage becomes a Claude Code plugin plus a viewer page, not an app with its own Claude setup.
- **Licence:** MIT (changed from AGPL-3.0 on 2026-11-05).
- **Platform:** Mac first; Windows later.
- **Format:** build-story videos only for now.
- **Overnight:** the guide cut is delivered overnight, and the voice-over is recorded in the morning.

**Why it's allowed.** Anthropic's Claude Code terms allow a product to run the unmodified Claude Code binary, with "an end user signing in to the unmodified Claude Code binary with their own Claude subscription". They don't allow a product to offer Claude login itself, to collect credentials, or to intermediate usage. Mirage does none of those. The person installs Claude Code from Anthropic and signs in through Anthropic's own flow. Source: https://code.claude.com/docs/en/legal-and-compliance.

**What the person gains:**
- the fixed price of their plan (no per-use API bill)
- their connectors (Tella, Epidemic Sound, Chrome)
- Claude Code's own chat, interrupt and permissions
- nothing to install that needs signing: Claude Code is Anthropic's signed app, and Mirage installs into it

**Branding.** Mirage may say it "runs in Claude Code". It may not use Claude, Claude Code or Anthropic in its name or logo, or suggest Anthropic made or endorses it. The plugin name `mirage` passes `claude plugin validate`'s reserved-name check.

## 2. Goals, non-goals, anti-goals (changes only)

**Goals added**
- One plugin install gives the editing skill, the engine, the safety hooks and the viewer. One setup step connects the seven tools from the transcript.
- The viewer shows the edit live, and can pause, stop and correct it. Notes clicked on the video reach Claude without the person retyping them.

**Non-goals added**
- A separate app window, an installer, Mirage's own Claude sign-in, a cost meter. Claude Code shows usage itself.
- Rebuilding anything a connected tool or Claude Code already does: chat, permissions, connectors, the browser.

**Anti-goals unchanged.** Specifically:
- never damage footage
- never leave a broken state after a pause, stop or crash
- never upload publicly without the person's go-ahead
- never force a look

## 3. Constraints

- **Platforms:** macOS 26+ on Apple Silicon first. Windows follows (§9).
- **Claude Code:** the person's own, desktop app (Code tab) or terminal, signed in with a plan or their own API key. Some features need the plan sign-in: the Chrome browser, and the HyperFrames plugin's browser capture.
- **Runtime:** the plugin's code runs on Node 22+, installed by setup. The parts are shipped as single bundled `.mjs` files inside the plugin, so installing it needs no `npm install`.
- **Licence:**
  - Mirage is **MIT**-licensed (it was AGPL-3.0-or-later until 2026-11-05). Contributions use a **DCO** sign-off (`Signed-off-by:`).
  - Nothing is copied from the WeAreNoCode kit.
  - FFmpeg, HyperFrames and Parakeet are installed separately by setup. Mirage doesn't redistribute them.
- **Privacy:** footage stays on the machine. Frames, transcripts and audio go to Anthropic through Claude Code, and the edit skill says so once per project.
- **Design:** the viewer follows Material 3 (old spec §15). The UI/UX Pro Max skill is invoked before any viewer code.

## 4. Architecture

```
Person's Claude Code (desktop app or terminal) — signed in by the person
 ├─ Mirage plugin  (installed from the Mirage marketplace = this repository)
 │   ├─ skills/      edit · notes · voiceover · overnight · setup · status
 │   ├─ .mcp.json    "engine": node ${CLAUDE_PLUGIN_ROOT}/dist/engine.mjs   (stdio MCP server)
 │   ├─ hooks/       SessionStart · PreToolUse · PostToolUse · Stop         (node dist/hook.mjs)
 │   └─ monitors/    "viewer": node dist/viewer.mjs  — runs in every session; idle outside Mirage projects
 ├─ HyperFrames plugin, Claude in Chrome, Tella, Epidemic Sound  (connected by the setup skill)
 └─ ffmpeg, Parakeet                                              (installed by the setup skill)

Viewer page: http://127.0.0.1:<port>/?k=<session key>
  in the Claude desktop app's browser pane, or in the person's browser
```

**The edit happens in the person's Claude Code.** Claude follows the `edit` skill. It calls the engine's tools for the mechanical work and writes `episode.json` itself with Write/Edit, as today.

**The engine** is today's `packages/core` behind an MCP server.
- Claude sees its tools as `mcp__plugin_mirage_engine__<tool>`.
- The project is the folder Claude Code is open in (`CLAUDE_PROJECT_DIR`). One Claude Code folder is one Mirage series; a one-off video is a series of one.
- Each tool takes the video number.

**The viewer** is a small HTTP server, started as a plugin **monitor** in every session. In a folder that isn't a Mirage project it stays idle and silent, and it starts as soon as `mirage.json` appears. It serves:
- the page (React, built to static files)
- a live event stream
- the media files

Because it's a monitor, each line it prints reaches Claude as a notification. That's how the viewer speaks to Claude: when the person sends notes, the viewer prints one line and Claude acts on it.

**The hooks** run a bundled Node script on these Claude Code events:

| Event | What the hook does |
|---|---|
| SessionStart | Checks dependencies and compiles the speech helper on first run (§7). Tells Claude in one line whether this folder is a Mirage project, and the viewer address if it's running. |
| PreToolUse | The **pause gate** and **stop** (§5.3). The **file guard**: denies writes into footage folders. **Auto-approves** Mirage's own steps, so they never wait on a permission prompt, even overnight: engine tools, plus Write/Edit to `episode.json`, `catalog.json` and `summary.md` inside the project. Writes a "running" step line. |
| PostToolUse | Writes a "done" or "failed" step line. Takes a **checkpoint version** after every finished engine stage (§5.4), and a **delivery** after every finished render. |
| Stop | When the person pressed Stop: restores the last checkpoint and clears the stop. Overnight: writes the morning report (§5.6). |

**Connected tools.** These are connected, never rebuilt: HyperFrames (its own plugin), Claude in Chrome, Tella, Epidemic Sound, Parakeet and ffmpeg. `setup/connect-tools.md` becomes the plugin's `setup` skill.

### 4.1 Files Mirage keeps in a project

| Path | Written by | What |
|---|---|---|
| `mirage.json`, `catalog.json`, `music/` | engine / Claude | as today |
| `episodes/<n>/episode.json`, `summary.md` | Claude (Write/Edit), engine | as today |
| `episodes/<n>/video.json` | `edit` skill, via the engine's `new_video` tool | the 3–4 answers about this video and its footage folders |
| `episodes/<n>/versions/<id>/` | hooks and engine | versions (§5.4) |
| `episodes/<n>/notes.json`, `notes/` | viewer | notes and their stills (§5.5) |
| `episodes/<n>/sessions/<session-id>/` | hooks, engine, viewer | `steps.jsonl`, `progress.json`, `log.jsonl` (guesses, questions, concerns, warnings, note statuses), `report.md` |
| `episodes/<n>/control.json` | viewer | pause, stop and the correction text for that video. Hooks and the engine read it. |

## 5. How each feature works

### 5.1 First use
1. Install Claude Code (Anthropic) and sign in.
2. In Claude Code:
   - `/plugin marketplace add <mirage repository>`
   - `/plugin install mirage@mirage`
   - start a new session
3. `/mirage:setup` connects the seven tools (`setup/connect-tools.md`). It ends with a ✓ / – / ✗ table.
4. Open Claude Code in a new folder for the series and say "make a video", or run `/mirage:edit`.

### 5.2 An edit, watched live
1. The `edit` skill:
   - asks the 3–4 questions about the video
   - takes the footage folders
   - calls `new_video`
   - opens the viewer: the browser pane in the desktop app, otherwise `open <url>`
   - then follows today's build-story steps
2. **The viewer's Edit tab shows:**
   - the live timeline (picture, on-screen text, music and narration lanes), redrawn from `episode.json` on every save
   - the step list from `steps.jsonl`
   - a progress bar from `progress.json`
   - Pause and Stop buttons
3. **Live mode ends at the rough cut**, with "Here's the rough cut. Click on the video to leave notes." **Overnight runs to the guide cut** (§5.6).

### 5.3 Pause, correct, stop

**Pause** (viewer button):
- Sets `paused` in the video's `control.json`. The PreToolUse hook holds the next step, waiting with a timeout of 24 h.
- While a render runs, the sheet offers two choices:
  - "Pause after this step", with the time left from `progress.json`
  - "Pause now", which also asks the engine to cancel the running command. Cancelled work leaves nothing half-written (Phase 1 Task 1).

**Correct while paused:** the viewer's box "Tell Mirage what to change…". Resume with text → the held step is denied with the reason `The person paused the edit and said: “…”. Act on this before you carry on.` Resume without text → the step runs.

**Talking to Claude directly:** the person can always type in Claude Code's own chat, or press Esc there. That's Claude Code's own behaviour, unchanged.

**Stop** (viewer button):
1. Sets `stop` and cancels any running engine command.
2. Every further tool call in this session is denied with `The person stopped the edit. Stop now and say in one line what was finished.`
3. When Claude's turn ends, the Stop hook goes back to the video's last finished stage (its newest checkpoint) and clears `stop`. What was there is kept as a backup version, so work done since that stage isn't lost.

After an Esc or a crash, the viewer offers "Go back to the last finished step: <label>".

### 5.4 Versions
- **Snapshots** copy the raw bytes of `episode.json` and `summary.md`. Renders are linked, never re-encoded. Snapshots happen:
  - at the start of each session's first step on a video (`before`)
  - after every finished engine stage, `checkpoint` (ingest, check, cut, slots, guide, vo, render). Claude's own saves of `episode.json` between stages aren't checkpoints: they're work in progress, which Stop undoes.
  - after every finished render (`delivery`): V1, V2…
- **Restoring** keeps a backup of what was there.
- **Locking:** versions are taken under the episode lock.
- **Pruning:** the newest 50 checkpoints are kept; deliveries and `before` versions are kept forever.
- **Viewer:** the Versions tab lists deliveries, with "Show steps" for checkpoints. Actions: Play, and "Go back to this version".

### 5.5 Notes
- **In the viewer's Review tab:**
  - Click the video to pause and add a note at that time, with a still attached.
  - Drag on the video to draw a box first.
  - Hold the mic button for a spoken note, transcribed on the Mac.
- **Sending.** "Send notes (k)" marks the notes as sent. The viewer prints one line to Claude, and Claude starts the `notes` skill:

  ```
  Mirage viewer: the person sent 3 notes on video 2 (V1 · Rough cut). Use the mirage:notes skill.
  ```

- **Acting on them.** The skill reads them with the engine's `get_notes` tool, acts on each, and calls `note_status` with:
  - `done`
  - `done-differently` (with how)
  - `could-not` (with why)
- **The viewer shows each status.**
- **Fallback, if notifications don't wake an idle session** (the Phase 1 spike checks this): the viewer shows "Tell Claude: `/mirage:notes`".

### 5.6 Overnight
- **Starting.** `/mirage:overnight` with one or more videos, or the viewer's "Edit overnight", which prints the request to Claude.
- **Checks first:**
  - on power (`pmset -g batt`)
  - free disk space
  - Phase 1's required tools working: ffmpeg, ffprobe, the speech helper
- **Then the skill asks the person to:**
  - leave the lid open
  - switch Claude Code to auto mode (Shift+Tab), so a non-Mirage tool never waits on a prompt
- **Keeping awake.** The engine's `keep_awake` tool runs `caffeinate -i -w <engine pid>`, so the Mac stays awake until the session ends.
- **Never asking.** Claude follows the "never ask" rules from the skill. Guesses, questions and concerns go to `log.jsonl` through the engine's `log` tool. A failed step is retried once, then the run carries on with the next video.
- **The morning report** (`report.md`, also shown in the viewer):
  - what was done
  - the guesses made, and the questions held
  - things to check
  - "Next: record the voice-over"

### 5.7 Voice-over
- **Recording.** The person plays the guide in the viewer and reads the lines out loud, recording in QuickTime or on a phone.
- **Dropping it in.** They drop the file on the viewer's voice-over zone, or tell Claude the path. The viewer prints the path to Claude.
- **Finishing.** The `voiceover` skill runs `vo`, then `render`, and reports missing or partial lines in plain words.

### 5.8 The viewer's own safety
- **Network:** it binds only to `127.0.0.1`.
- **Session key:** every page and API call needs a random per-session key, which the viewer prints to Claude together with the address. Requests without it, or with a `Host` header other than `127.0.0.1:<port>` or `localhost:<port>`, get 403. No CORS headers are sent. This stops other web pages from injecting text into Claude through the viewer.
- **Media:** it serves files only from inside the project and the videos' footage folders, with Range support.
- **What it can send to Claude:** only the fixed notification lines, plus the person's own correction and note text, quoted.

## 6. Feature map by phase

Each phase gets its own plan, build and review.

| # | Phase | What people get | Built, bundled or connected |
|---|---|---|---|
| 1 | **The plugin and the viewer** | Marketplace and plugin. `setup` skill. `edit`, `notes`, `voiceover`, `overnight` and `status` skills on today's build-story engine. Engine as MCP tools, with cancellation and versions. Hooks: pause, stop, file guard, auto-approve, steps, checkpoints. Viewer: live timeline, steps, progress, pause/stop/correct, player with notes (typed, spoken, boxed), versions, voice-over drop, morning report. Overnight with keep-awake. Licence (MIT since 2026-11-05; first AGPL), DCO, README. WordEdits leftovers removed. | Build: plugin, engine tools, hooks, viewer. Connect: the 7 tools. |
| 2 | **Base filtering, recording coach, talking-head route** | Always-on quality checks with a report (old §6.2). Recording-coach card (§6.3). Import checks, SD-card copy with verification, camera/screen/mic sync. The talking-head and tutorial route. | Build into the engine. Transcription: Apple on Mac, Parakeet via HyperFrames as an option. |
| 3 | **Your style** | Style interview (research doc §2), with channel and reference measuring. The one-page style file. Animation level and allowed formats. Proposed rules after each round of notes, kept with one tap in the viewer. | Build (skill, style file, viewer screens) |
| 4 | **Graphics, sound, B-roll** | Format library on HyperFrames (lower lines, logo cards, diagrams, counters, browser cutaways…) drawn from the style. Sound effects. Research B-roll through Chrome. Stock B-roll. Epidemic Sound music. | Connect: HyperFrames plugin, Chrome, Epidemic, a Pexels MCP. Build: format library, engine compositing. |
| 5 | **Shorts and other platforms** | 3–5 Shorts per video, reframed for 9:16. Clips per platform. Text posts. | Build |
| 6 | **Publishing and housekeeping** | Titles, thumbnails, description, chapters, credits, copyright check, AI label, private-draft upload. FCPXML export. Archiving. | Connect: a YouTube MCP. Build: packaging skill, export. |
| 7 | **Learning from viewers** | Retention to proposed rules. Title and thumbnail comparisons. Teardown. | Connect: YouTube Analytics. Build: the analysis. |
| Later | **Windows** | The same plugin on Windows: Parakeet instead of Apple speech, `powercfg`/`SetThreadExecutionState` instead of `caffeinate`, PowerShell-safe hooks | Build the ports |
| Later | | AI B-roll, long-recording highlights, story-first planning | |

Phase 1 must already beat the CLI. The person never types a command, sees the edit happen, and can stop it safely.

## 7. Phase 1 decisions (my calls)

- **Plugin layout.** The repository is its own marketplace:
  - `.claude-plugin/marketplace.json` lists one plugin, `mirage`, with source `./plugin`.
  - The plugin's bundled `dist/*.mjs` and the viewer's built static files are committed, so a git install works without a build step.
  - `pnpm build:plugin` regenerates them, and CI-style test `plugin-dist-fresh` fails when they're stale.
- **Speech helper.** The Swift speech helper isn't committed as a binary. The SessionStart hook compiles it with `swiftc` into `${CLAUDE_PLUGIN_DATA}/bin/` on first run, because Homebrew's Command Line Tools include `swiftc`. When `swiftc` is missing, the `status` skill says "Speech recognition needs Xcode Command Line Tools: run `xcode-select --install`".
- **Skills over commands.** The skills are `edit`, `notes`, `voiceover`, `overnight`, `setup` and `status`, used as `/mirage:<name>`, and Claude also starts them from their descriptions. The current `mirage-episode` skill becomes `edit`, rewritten for tools. The repository's `.claude/skills/mirage-episode` is removed, so there's one source.
- **Tools and arguments.** Every engine tool takes `video: number`, except `new_project`, `music` and `ingest`. The project is `CLAUDE_PROJECT_DIR`.
  - **Engine tools:**
    - `new_project`, `new_video`
    - `ingest`, `music`, `check`, `cut`, `slots`, `guide`, `vo`, `render`
    - `deliver`, `versions`, `restore`
    - `get_notes`, `note_status`
    - `log`, `keep_awake`, `status`
  - **The CLI stays**, as `pnpm mirage`, for development only.
- **The viewer's port.** It listens on the first free port from 4410 to 4430. It prints `Mirage viewer: http://127.0.0.1:<port>/?k=<key>` as its first line, so Claude knows where it is.
- **When it starts.** The monitor starts in every session (`when: always`) but stays silent and idle outside Mirage projects. That way the morning after an overnight run (a new session), `/mirage:notes` or `/mirage:voiceover` on its own, and a project made mid-session all have a viewer. (Builder check.)
- **State belongs to the video, not the session.** Control, reports, versions and notes are kept per video; logs and steps are kept per video and session, and the viewer shows every session's. A new session sees everything earlier ones did. Two sessions on the same video share its pause and stop. (Builder check.)
- **What a step is.** For pause and the step list, a step is one tool call. For checkpoints and Stop, it's an engine stage, as in §5.4. (Builder check.)
- **What Phase 1 requires.** Node 22+, ffmpeg/ffprobe, and the Xcode Command Line Tools (for `swiftc`). Parakeet, HyperFrames, Chrome, Tella and Epidemic Sound are optional until the phase that uses them. Setup marks them "later" and doesn't install them unless asked. (Builder check.)
- **Spike first.** Task 0 of the plan checks, in the real Claude Code:
  1. whether a monitor's line wakes an idle session in the terminal and in the desktop app
  2. whether a PreToolUse hook can hold a step for over 10 minutes
  3. whether the desktop app's browser pane opens `127.0.0.1` pages

  Each result decides between the design above and its fallback: the "Tell Claude: …" text, a hold re-armed every 9 minutes, or the system browser.
- **Removed:**
  - the Electron app, the Agent SDK runner, API-key onboarding, the connections panel and the cost meter, all from the previous plan
  - the WordEdits talking-head pipeline Mirage doesn't call: `packages/core/src/render.ts`, `scripts/render.ts`, the `render` script, the EDL v1, brief, script and project schemas, and `project-store`'s project and EDL functions. `encodeArgs`/`ffNum` move into `mirage/encode.ts`; `readJsonFile`/`writeJsonFile`/`describeZodError` move into `mirage/json-file.ts`
  - `autoedit/takes.ts` stays: voice-over fitting uses it

## 8. Risks

1. **Monitors and the PreToolUse hold are new Claude Code features.** The spike (§7) comes first, and every use has a fallback.
2. **Overnight permission prompts.** Mirage's own steps are auto-approved by the hook, but another tool could still wait on a prompt. The overnight skill asks for auto mode, and the report says where it waited if it did.
3. **Plugin updates while a session runs.** `${CLAUDE_PLUGIN_ROOT}` changes on update. Running processes keep their old files, and the next session uses the new ones.
4. **MIT and copies.** Since 2026-11-05 Mirage is MIT: anyone may copy it, close it or sell it. The user chose reach over the protection AGPL gave.
5. **The Chrome browser needs plan sign-in.** On an API key, research B-roll (Phase 4) falls back to plain page captures.

## 9. Windows (later, not Phase 1)

What changes:
- **transcription:** Parakeet via HyperFrames
- **keep-awake:** a PowerShell `SetThreadExecutionState` helper
- **hooks:** run through PowerShell or Git Bash, in exec form with `args`
- **paths:** forward slashes from the plugin variables
- **tests:** the engine's tests run on Windows CI

The viewer, the plugin layout and the skills don't change.

## 10. Decisions

**By the user**
- Plugin + viewer page.
- Use the person's own Claude Code.
- MIT licence (was AGPL until 2026-11-05).
- Mac first.
- Build-story only for now.
- Guide cut overnight, voice-over in the morning.
- A setup file that connects the transcript's seven tools.
- Remove what isn't needed.

**My calls (to check):**
- monitors as the viewer-to-Claude path, and the hook as the pause gate (both behind the spike)
- auto-approving Mirage's own steps in the hook
- committed bundled `dist/`
- compiling the speech helper on first run
- DCO for contributions
- the engine tool list and `video` argument
- port range 4410–4430 and the session key
- removing the WordEdits leftovers

**Left to the builder:**
- the viewer's component details within §15
- the exact step-line wording beyond the labels in the plan
- the debounce timings
