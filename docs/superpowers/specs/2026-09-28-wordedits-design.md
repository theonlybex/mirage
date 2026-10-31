# WordEdits — Design Spec (v1: talking-head explainer)

Date: 2026-09-28
Status: approved design, pending implementation plan

## 1. Purpose

WordEdits is "Claude Code for video editing." A person with a video idea and no editing skill describes it in chat and, in minutes, gets a professionally structured video rendered and uploaded to their YouTube channel. The user never has to learn an editor; they talk, record one long take, review, and publish.

**Primary user for v1:** the author, on a MacBook (Apple Silicon, no discrete GPU) and occasionally a Windows PC with an NVIDIA GPU. The app must run acceptably on a plain MacBook so it can later be shared with ordinary users.

**Success criteria for v1**

1. From "I have an idea" to a rendered MP4 in under 30 minutes of the user's time for a 5–10 minute video (excluding recording time).
2. The result follows the talking-head format profile (section 7) without any manual timeline work.
3. Every change the user asks for in chat becomes a visible, undoable edit within seconds (preview), not minutes.
4. The final MP4 uploads to YouTube from inside the app (private until Google's audit; the user flips visibility on YouTube).
5. A professional editor can leave at any point with an FCPXML/EDL export and finish in their own tool.

## 2. Scope

**v1 supports one format: talking-head explainer.** One person on camera reads the script in one long take, recorded outside the app and imported as a file.

**In scope (v1)**

- Chat-driven interview with multiple-choice cards, script generation, block editor for the script
- File import (MP4/MOV/MKV/WebM; 1080p or 4K; 24–60 fps)
- Local transcription with word timestamps, silence/filler/retake detection
- Automatic edit: best take per script block, silence and filler removal, alternating punch-ins, section title cards, captions, music bed with ducking, audio cleanup and loudness normalisation, end screen
- Review workspace: scene list with thumbnails, preview player, frame-accurate trim, undo/redo, keyboard shortcuts, presets, markers
- Chat edits on the result ("cut the pricing part", "faster intro", "swap scenes 3 and 4")
- Export: MP4 (YouTube spec), SRT captions, FCPXML and CMX3600 EDL
- YouTube upload with Claude-drafted title, description and chapters
- Settings: Claude API key, model choice (Sonnet 5 default, Opus 5 "high quality"), YouTube account, token-usage display

**Out of scope (v1)**

- In-app recording / teleprompter
- Other formats (gameplay + voice-over, documentary/stock, screen tutorial)
- Multi-track timeline, keyframes, masks, colour wheels, motion tracking, speed ramps, multicam, LUTs, transition library
- Cloud sync, accounts, collaboration, public distribution/signing/notarisation, auto-update

## 3. Design principles

1. **Chat is always visible.** The window is a workspace on the left and the chat on the right for the entire process, like Claude Code beside an editor. The interview, progress reporting, questions and edits all happen in chat.
2. **Interruptible.** Pipeline runs stream their steps into chat. The agent pauses at gates (section 5.4). If the user types while a stage runs, the run finishes its current step, stops, and the agent reads the message before continuing.
3. **Nothing irreversible without a yes.** Upload, overwriting a final render, deleting a project.
4. **The UI never touches video.** The renderer shows a `<video>` of a 540p proxy and sends typed commands; all media work runs in the main process and sidecar binaries.
5. **Deterministic.** The same `edl.json` always produces the same video. Every AI decision is written to a file the user can inspect.
6. **Apple-style.** System font (SF Pro on macOS, Segoe UI on Windows), native title bar with vibrancy on macOS, at most three primary controls per screen, 120–160 ms transitions only when state changes, inline cards instead of modals wherever possible, light and dark mode. Feels fast: no spinner longer than 300 ms without a progress message in chat.
7. **Light.** No Python, no bundled browser for rendering, no database. Target install ≤ 300 MB (Electron ~200 MB + sidecars ~80 MB + one whisper model downloaded on first run). Idle RAM comparable to a text editor.

## 4. Architecture

```
┌──────────────────────────────────────────────────────────┐
│  UI — Electron renderer, React + TypeScript               │
│  Workspace (left) + Chat (right); stages: Start · Script ·│
│  Import · Review · Publish · Settings                     │
└──────────────┬───────────────────────────────────────────┘
               │ typed IPC: commands down, events/streams up
┌──────────────▼───────────────────────────────────────────┐
│  Core — Node in the Electron main process                 │
│  · project store (one folder per video, JSON files)       │
│  · agent (Claude conversation, tools, gates)              │
│  · pipeline (transcribe → align → plan → compile → render)│
│  · publisher (YouTube OAuth + resumable upload)           │
└──────────────┬───────────────────────────────────────────┘
               │ child processes / in-process ONNX
┌──────────────▼───────────────────────────────────────────┐
│  Sidecars — bundled per platform                          │
│  ffmpeg + ffprobe · whisper.cpp · Silero VAD (onnxruntime)│
└──────────────────────────────────────────────────────────┘
```

**Stack decisions (from the 2026-09-28 technical survey)**

| Concern | Choice | Why |
|---|---|---|
| Shell | Electron (current stable) + React 19 + TypeScript, Vite | Chromium gives reliable `<video>` seeking and WebCodecs on macOS and Windows; Tauri's web views crash or over-allocate when seeking multi-GB files. Same choice as Cursor and LosslessCut. |
| Rendering | JSON EDL → generated FFmpeg `filter_complex` + `.ass` captions, single-pass encode | Programmatic, deterministic, no browser in the render path. `h264_videotoolbox` on Apple Silicon, `h264_nvenc` on NVIDIA, `libx264` fallback. |
| Transcription | whisper.cpp `large-v3-turbo` with `--dtw` word timestamps (Metal/CoreML on macOS, CUDA or CPU on Windows) | Single static binary, MIT, ~1–2.5 min for a 20-min take on M-series. Later: Swift helper using Apple SpeechAnalyzer on macOS 26 (~4x faster); Parakeet v3 ONNX on Windows. |
| VAD | Silero VAD v6 via `onnxruntime-node` | ~2 MB, MIT, real-time on one CPU thread. |
| AI | Anthropic TypeScript SDK; `claude-sonnet-5` default, `claude-opus-5` optional; strict tool use / `output_config.format` JSON schema for the EDL and brief | Cost/latency; structured output guarantees a parseable EDL. |
| YouTube | Data API v3, loopback + PKCE OAuth, resumable upload | Only supported native flow. Uploads private-only until compliance audit. |
| Packaging | electron-builder, sidecars via `extraResources` | Routine; LosslessCut pattern. Not signed/notarised in v1. |
| Licensing | Use an LGPL FFmpeg build; all other components MIT/Apache | Keeps the option of a proprietary app. |

**Module boundaries** (each is a package in a pnpm workspace so it can be tested alone):

- `packages/core` — pure TypeScript, no Electron imports: project store, pipeline stages, EDL compiler, format profile, alignment, agent orchestration. Depends only on sidecar wrappers through an interface (`MediaTools`) so tests can stub them.
- `packages/sidecars` — locates and spawns ffmpeg/ffprobe/whisper; parses their output; owns the Silero VAD session.
- `packages/app` — Electron main (IPC, window, menus, OAuth loopback server) and renderer (React UI).
- `packages/shared` — types and zod schemas for `brief`, `script`, `transcript`, `takes`, `edl`, `project`, plus the IPC contract.

## 5. Data model

All files live in the project folder `~/WordEdits/<project-slug>/`. JSON is validated with zod on read and write.

```
project.json      id, title, createdAt, stage, format:"talking-head", settings overrides
brief.json        answers from the interview (tone, length, audience, pacing, style refs)
script.json       { blocks: [{ id, kind:"hook"|"section"|"cta", title?, text, order }] }
source/           the imported file (copied or referenced by path + hash)
proxy.mp4         540p H.264 proxy for the preview player
probe.json        ffprobe output (duration, fps, resolution, audio)
transcript.json   { words: [{ w, start, end, conf }], segments: [...], speech: [[start,end]] }
takes.json        per block: candidate takes [{ blockId, start, end, score, words }], chosen take id
edl.json          see 5.2
history/          edl snapshots, one per undoable step (edl.0001.json ...)
renders/          preview-<hash>.mp4, final-<hash>.mp4, captions.srt, export.fcpxml, export.edl
chat.jsonl        the conversation, one message per line (also the agent's memory for the project)
```

### 5.2 EDL (edit decision list)

```jsonc
{
  "version": 1,
  "output": { "width": 1920, "height": 1080, "fps": 30 },
  "scenes": [
    {
      "id": "s1", "blockId": "b1",
      "src": { "in": 12.40, "out": 31.05 },          // seconds in source
      "cuts": [[14.10, 14.72], [22.00, 22.55]],       // internal removals (silence/filler)
      "zoom": { "scale": 1.15, "anchor": "face" },   // 1.0 = wide
      "title": { "text": "Why this matters", "style": "section" },
      "captions": true,
      "markers": ["b-roll idea: show pricing page"]
    }
  ],
  "audio": { "music": { "track": "calm-01", "gainDb": -22, "duck": true }, "loudnessLufs": -14 },
  "captions": { "style": "clean-bottom", "maxChars": 38, "lines": 2 },
  "endScreen": { "seconds": 12 }
}
```

The EDL is the only thing the render reads. Chat edits, manual trims, presets and undo all operate on this file.

## 6. Pipeline

Every stage reads files from the project folder and writes exactly one file. A stage can be rerun without redoing earlier ones. Stages emit progress events that the chat renders.

| Stage | Input → Output | Behaviour |
|---|---|---|
| **Interview** | chat → `brief.json` | The agent asks multiple-choice questions as inline cards (tone, target length, audience, pacing: natural/fast/extra fast, style references). It stops when the brief schema is complete or after 6 questions. Free text is always allowed. |
| **Script** | brief → `script.json` | Claude writes ordered blocks: one hook (≤15 s spoken), sections with titles, one closing CTA. The user edits text inline, drags to reorder, deletes, or asks chat to rewrite one block. Block order = scene order. |
| **Import** | file → `source/`, `probe.json`, `proxy.mp4` | ffprobe validates; FFmpeg makes the proxy and extracts 16 kHz mono WAV for transcription. Rejects files without an audio track with a chat message. |
| **Transcribe** | wav → `transcript.json` | whisper.cpp with word timestamps and a verbatim-encouraging prompt so fillers are kept; Silero VAD produces speech segments. |
| **Align** | transcript + script → `takes.json` | Normalise tokens; local sequence alignment (Smith–Waterman) of transcript against each block; repeated matches are candidate retakes. Blocks with no match above threshold are flagged. |
| **Plan** | takes + brief → `edl.json` | Claude (strict tool) picks the best take per block given the transcript text, timings and confidences, defaulting to the last take. Then the deterministic **format profile** (section 7) computes cuts, zooms, titles, captions, music and end screen. |
| **Render** | edl → `renders/` | EDL compiler emits a `filter_complex` graph and an `.ass` file; one FFmpeg pass. Preview renders use the proxy at 540p and only re-render scenes whose EDL changed (per-scene segments concatenated). Final render uses the source at output resolution. |
| **Publish** | final + metadata → YouTube | Claude drafts title, description, chapter list (first at 00:00, ≥3, each ≥10 s) and tags from the script; user edits and confirms; resumable upload with retry; result URL shown in chat. |

### 6.4 Gates (agent pauses and asks)

1. Brief complete → "Here's what I understood. Write the script?"
2. Script generated → user edits; "Ready to record? Import the take when done."
3. Alignment done → shows blocks with missing/weak takes; "Continue, or re-record these?"
4. Plan ready and preview rendered → review loop until "Export"
5. Before upload → shows title/description/visibility; explicit confirm.

### 6.5 Chat edits on the result

The agent has tools that mutate the EDL: `trim_scene`, `remove_scene`, `reorder_scenes`, `set_zoom`, `set_title`, `set_pacing_preset`, `set_caption_style`, `set_music`, `add_marker`, `choose_take`. Each tool call creates one history snapshot (one undo step) and triggers a partial preview render. Requests that don't map to a tool get a plain-language answer explaining what is possible.

## 7. Talking-head format profile (deterministic rules)

Numbers come from the 2026-09-28 editing-practices research. All are defaults exposed as presets; the user never sees them unless they ask.

**Cutting**
- Remove silences longer than 0.5 s (natural) / 0.35 s (fast) / 0.25 s (extra fast); keep 0.4 s / 0.25 s / 0.15 s of padding on each side of a cut.
- Remove filler words: um, uh, er, like (when isolated), you know, I mean, sort of, basically; remove restarted phrases inside a take.
- Retakes: keep the chosen take, drop the others.
- Cut on breaths: snap cut points to the nearest VAD boundary.

**Visual variety**
- Alternate wide (1.0) and punch-in (1.12–1.25, anchored on the detected face or centre-top third) at each scene boundary and at internal cuts when the scene is longer than 15 s. Punch-in scale never exceeds 1.5 for 1080p sources; up to 2.0 for 4K→1080p.
- Force a visual change (zoom step, title, caption emphasis) if 20 s pass without one.
- Section title card: 3–5 s overlay at the start of each `section` block, lower-third style; at least 10 s apart.

**Captions**
- Phrase captions, 32–42 characters per line, max 2 lines, bold sans-serif, white with 70 % black box, bottom-centre inside the 90 % title-safe area, shown 0.15 s before the word starts. Word-highlight style available as a preset.

**Audio**
- Chain: high-pass 90 Hz → denoise (afftdn, ≤10 dB) → compressor 3:1, threshold −20 dB, attack 15 ms, release 100 ms → limiter −1 dBTP → loudnorm to −14 LUFS integrated.
- Music: −22 dB below voice, sidechain duck a further 6 dB while speech is active (attack 200 ms, release 800 ms). Bundled royalty-free tracks; user can add a file.
- Intro: no sting longer than 2 s; hook starts immediately.

**Structure**
- Hook block is the first scene; no title card over it.
- End screen: last 12 s (configurable 5–20 s) shows a static branded card with the voice continuing; export writes chapter timestamps into the description.

**Export (YouTube spec)**
- MP4, `+faststart`, H.264 High profile, closed GOP, 2 B-frames, 4:2:0, BT.709; 1080p30 at 8 Mbps / 1080p60 at 12 Mbps / 2160p at 40 Mbps VBR; AAC-LC 48 kHz 384 kbps stereo; frame rate = source.

## 8. UI

One window. Left: stage workspace. Right: chat (resizable, min 320 px). Top: project title, stage indicator (Script · Import · Review · Publish), undo/redo.

| Stage | Workspace |
|---|---|
| Start | Recent projects grid; "New video" starts the interview in chat |
| Script | Block editor: each block is a card with title and text, inline editing, drag handles, per-block "rewrite" that opens a chat prompt prefilled with the block |
| Import | Drop zone → proxy player with transcription progress bar; alignment result shows blocks colour-coded (found / weak / missing) |
| Review | Scene list (thumbnail, block title, duration, zoom badge, markers) + preview player with trim handles; keyboard: space play/pause, J/K/L, ←/→ frame step, I/O set trim, Delete removes scene, ⌘Z/⌘⇧Z undo/redo |
| Publish | Title, description, chapters, visibility (private default), thumbnail from a frame; Upload button; progress and final URL |
| Settings | API key (stored in OS keychain via `keytar`/`safeStorage`), model, YouTube account connect/disconnect, sidecar status, token usage per project |

Visual style: system font, 8 px spacing grid, neutral greys with one accent, native macOS vibrancy sidebar, no drop shadows heavier than 8 px blur, transitions 120–160 ms ease-out. Frontend implementation must follow the UI/UX Pro Max skill per the user's global instructions.

## 9. Error handling

- Every sidecar call has a timeout (transcription: 10× real time; render: 20× real time), captured stderr, and a structured error `{ stage, code, message, hint }`.
- Errors surface in chat as a short message with **Retry** / **Skip** / **Tell me more** choices; never a stack trace. Full logs go to `~/WordEdits/logs/`.
- Defined responses: no audio track; no speech detected; alignment weak for >50 % of blocks (offer to re-record or continue); missing GPU (silently use CPU encode, note it in chat); Claude rate limit or invalid key (pause, explain, resume on retry); YouTube token expired (re-auth in browser, resume upload from the saved session URI); disk full.
- The plan stage retries Claude at most twice on schema failure, then falls back to "last take per block" and says so.
- Token usage per request is recorded in `chat.jsonl` and summed in Settings.

## 10. Testing

- **Unit** (`packages/core`, vitest): alignment, format profile rules, EDL compiler (snapshot of the generated FFmpeg args and `.ass` output), history/undo, schemas. Sidecars are stubbed via `MediaTools`.
- **Fixtures**: three 5–10 s clips checked into `fixtures/`: clean speech, speech with retake and fillers, silence-only. Generated once with FFmpeg + a synthetic voice so the repo stays small.
- **Integration** (needs real sidecars, runs locally and in CI on macOS): import → transcribe → align → plan (Claude mocked with recorded responses) → render; verify with ffprobe (duration within ±0.1 s of EDL, resolution, fps) and `ebur128` (−14 ±1 LUFS).
- **Agent**: recorded Claude conversations replayed for the interview and plan stages; schema validation on every tool output.
- **UI** (Playwright for Electron): new project → script edit and reorder → import fixture → chat edit "remove scene 2" → undo → export MP4 and FCPXML.
- **Manual acceptance**: one real 5-minute talking-head take end to end on the MacBook, including a real upload (private).

## 11. Sub-projects and order

1. **Foundation** — workspace, schemas, project store, sidecar wrappers, EDL compiler with a trivial EDL rendering a fixture. (Proves the render path.)
2. **Transcribe + align** — whisper/VAD integration, alignment, `takes.json`.
3. **Format profile + plan** — deterministic rules, Claude take selection, full auto-edit from a real take.
4. **Shell + chat** — Electron window, chat panel, agent with gates, interview, script generation and block editor.
5. **Review** — scene list, preview player, trims, undo, shortcuts, chat edit tools, presets.
6. **Export + publish** — final render, SRT, FCPXML/EDL, YouTube OAuth and upload.
7. **Polish** — Apple-style pass, error paths, Windows build, packaging.

Each becomes a section of the implementation plan; 1–3 have no UI and can be built and tested headless first.

## 12. Open items (decided defaults, change if you disagree)

- Face detection for zoom anchoring: v1 uses a fixed anchor (centre, 40 % from top). Face detection is a later addition.
- Music library: three bundled CC0 tracks in v1.
- Windows: supported and tested at the end of v1, not per sub-project.
- Project folder location and API key storage are configurable in Settings only.

## 13. Addendum (2026-10-30): fast-track auto-edit CLI

The user needs to edit real videos before the desktop app exists. Sub-projects 2 and 3 are re-cut into one command-line deliverable, built on the sub-project 1 core, with this chat (Claude Code) standing in for the app's chat until sub-project 4.

**Command:** `pnpm edit <take> [--script script.md] [--pace natural|fast|extra-fast] [--music track] [--no-captions] [--edl edl.json] [--out dir]`

**Does:** transcribes locally, cuts restart cues, retakes (keep the last take), hesitation fillers and long pauses, burns in phrase captions and writes an `.srt`, mixes optional music ducked under the voice, renders a YouTube-spec MP4, and writes `edl.json`, `transcript.json` and a plain-language `report.md` of every cut. `--edl` re-renders a hand- or chat-edited EDL without re-transcribing.

**Decisions:**
- macOS transcription uses Apple SpeechAnalyzer (macOS 26+) through a small Swift helper built locally with `swiftc`; it keeps fillers and gives word timings. whisper.cpp remains the Windows path (later).
- Only hesitation sounds are removed as fillers (um, uh, er, ah, hmm…); "like", "you know" and similar stay until a context-aware pass exists.
- Spec §7's per-side padding values are read as the *total* pause kept when a pause is shortened (0.4 / 0.25 / 0.15 s), split evenly before and after the cut.
- Renders run in chunks of at most 30 segments to near-lossless intermediates, then one final pass applies captions, the audio chain and music, and encodes. This replaces the single command that hit Windows' command-line limit and macOS's thread limit on long takes.
- Out of scope for this deliverable: punch-in zooms, section titles, end screen, YouTube upload, the desktop app.

## 14. Future features (post-v1 roadmap)

Added 2026-10-30 after comparing WordEdits with ChatCut, Descript and Gling. None of this is in v1. Each item keeps the v1 principles: the EDL stays the single source of truth, AI decisions are written to inspectable files, and anything that needs the cloud is optional.

**Phase A — close the obvious gaps in the talking-head format**
- Face-tracked punch-ins (replaces the fixed anchor from §12).
- Context-aware filler removal for "like", "you know", "I mean" (deferred in §13).
- B-roll and screen-recording inserts: `markers` become real overlay clips; user-supplied files first.
- In-app recording with a teleprompter driven by `script.json`.

**Phase B — multi-track editing**
- Multi-track timeline (video overlays, B-roll, music, SFX lanes) with the EDL extended to tracks; the scene list stays the default view.
- Basic transitions, speed changes and keyframed position/scale for overlays.
- Motion-graphics templates (lower thirds, callouts, animated titles) rendered as deterministic `.ass`/overlay layers.

**Phase C — generative media (optional, provider-pluggable)**
- AI voiceover and voice correction ("Overdub"-style fixes for a misspoken word), with explicit consent for voice cloning.
- AI image and video generation for B-roll and thumbnails.
- AI music generation alongside the bundled CC0 library.
- Stock media search (licensed providers) inserted as B-roll.
- Every generated asset is saved into the project folder and referenced from the EDL, so renders stay deterministic.

**Phase D — more formats and languages**
- Formats: gameplay + voice-over, screen tutorial, documentary/stock, podcast/interview multicam, short-form vertical clips cut from a long video.
- Multi-language: transcription and captions in other languages, translated captions, and dubbed audio tracks.

**Phase E — sharing and collaboration**
- Cloud sync of projects, review links with time-coded comments, multiple editors on one project.
- Accounts, signed/notarised builds, auto-update, public distribution.

## 14. Revision (2026-10-30): Mirage, first format "build story", Phase A

The app is renamed **Mirage**. Its first format is no longer the talking-head explainer (§2, §7) but a **build-story series** about the user's own software projects, modelled on Mat Armstrong's car-rebuild series. The fast-track talking-head CLI of §13 is **superseded and will not be built**; its transcriber, retake detection, captions, chunked rendering and ducking are reused here. Further formats are added only when needed.

### 14.1 The format (one episode ≈ 13 min, one episode per build stage)

| Beat | Target | Content |
|---|---|---|
| Cold open | 0:00–0:30 | Stakes in the first line (goal, number, obstacle) + teaser of 6–10 quick shots of upcoming wins and failures |
| Title sting | ~5 s | Project title card |
| Recap + plan | ~1 min | Callback to the previous episode; "today the plan is…" with one goal, optional deadline |
| New toy | ~1 min | A new library/tool/API arrives; first install |
| Problem | ~2 min | Failure on screen (red build, crash), diagnosis, cheap clever fix |
| Build montage | ~1.5 min | Timelapse + screen clips, 0.7–2 s shots cut on the music beat |
| Mid-point twist | ~2 min | New blocker or a side quest with its own timer |
| Moment of truth | ~1.5 min | Deploy/demo: music cut to silence 0.5–1.5 s, then it works, before/after |
| Outro | ~1 min | What's left, a viewer question, tease of the next episode |

Edit grammar: talking/explaining shots 3–6 s; montage 0.7–2 s on the beat; reveal holds 4–8 s; punch-in 1.10–1.20× on reactions; timelapses sped up to fit. Overlays: big number callouts when a figure is spoken, running counters (hours, commits, cost, users), FAILED / PASSED / LIVE badges, tool labels, chapter cards, before/after labels. Music by beat: punchy cold open, light plan, low drone under problems, upbeat montage, riser into the twist, silence then a big track at the reveal, relaxed outro; ducked 15–20 dB under speech. Titles: all caps with a number ("I BUILT X IN 7 DAYS", "X SAID IT WAS IMPOSSIBLE").

### 14.2 Episode workflow (voice-over last)

1. **Import** the episode's clips in one batch (screen recordings, phone clips, pieces to camera, long timelapses).
2. **Catalog:** probe each clip; transcribe clips with speech; sample frames (every few seconds plus scene changes); classify the clip type; record key moments (error appears, test passes, before/after) with timestamps.
3. **Story edit (picture + music + overlays, no narration):** an episode timeline in the beats above. Live commentary and pieces to camera keep their own sound; montages snap to the music beat; reveals get silence before them.
4. **Rough cut:** render and watch; changes requested in chat until the cut works.
5. **Voice-over script:** narration slots are the stretches without live speech that the story marks for narration; each slot gets lines sized at ~170 wpm; reveal silences and live commentary stay clear.
6. **Record:** the user narrates while a guide render of the cut plays, with each line shown on screen shortly before its slot. One take; re-reading a fumbled line is allowed.
7. **Fit:** transcribe the recording; match each spoken sentence to its script line by words (keep the last take; drop fillers); place each line at its slot start; when a line runs past its slot, hold the picture of that item longer; re-duck music under all speech.
8. **Final render** with captions from all speech; publish.

### 14.3 Phase A decisions

- **Phase A is command-line plus this chat.** Claude in the chat (Claude Code) performs the creative steps: describing frames, writing the story timeline, writing voice-over lines, episode summaries. Deterministic `pnpm mirage <command>` steps do cataloguing, beat detection, rendering and voice-over fitting. All creative output is files (`catalog.json` notes, `episode.json`), so the app can later fill the same files through the Claude API. Frames read by Claude are sent to Anthropic; screens showing secrets should not be recorded.
- **Music library** is a folder of user-supplied or free-licence tracks with a `library.json` (mood, licence); tempo is detected by Mirage. Sound effects are Phase B.
- **Recording sync** is by words, not beeps, so headphones work.
- **Phase B (later):** counters from git history, sound effects, speed ramps, title/thumbnail suggestions, automated recaps from episode summaries. **Then** the desktop app (§8 UI, adapted to this flow).

### 14.4 Data: catalog and timeline (EDL v2)

`<project>/catalog.json` — clips: `{ id, path, sha256, probe, kind: screen|camera|talking|timelapse, transcript?, frames: [{t, file}], notes?, moments: [{t, label}] }`.

`<project>/episodes/<n>/episode.json` — the timeline, times in seconds on the output timeline unless named `src`:
- `items[]` (back to back, video track): `{ id, beat, clip, src: {in, out}, speed (1 = normal; timelapses > 1), audio: keep|mute, zoom?, onBeat? }`
- `overlays[]`: `{ kind: callout|counter|badge|label|chapter|beforeAfter, text, start, end }`
- `music[]`: `{ track, start, end, gainDb, fadeIn, fadeOut }` — gaps are silence
- `slots[]`: `{ id, start, end, maxWords, line? }` — narration slots and their script lines
- `voiceover?`: `{ recording, lines: [{ slot, src: {in, out}, cuts: [[a,b]] }] }`
- `output`: `{ width, height, fps }`

Rendering reuses §13's chunked approach: items render in chunks of ≤30 to intermediates (speed via setpts/atempo, muted audio as silence); the final pass adds overlays and captions (ASS), voice-over and music tracks, the mix and the encode.
