> **Superseded (2026-11-02):** Mirage became a Claude Code plugin. See `2026-11-02-mirage-plugin-phase-1.md`.

# Mirage Phase 1 (The App) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A downloadable Mac app with:
- API-key setup
- projects and videos
- an edit Claude runs on today's build-story engine, shown live on a timeline that redraws as the episode file changes
- pause, stop and chat at any moment
- a player with click-on-video notes
- versions
- a cost estimate
- a connections panel
- overnight mode

**Architecture:** Electron + React, Material 3.
- The main process hosts the **brain runner**. It calls the Claude Agent SDK's `query()` with Mirage's own isolated configuration: no settings sources, a Mirage plugin carrying the episode skill, and the Mirage engine as a stdio MCP server.
- The engine (`packages/core`) gains three things: cancellation, versions, and shared command reports. A new `packages/mcp` wraps it as MCP tools.
- The app never edits episodes itself. It watches the files Claude and the engine write, and draws them.
- Pause is a gate inside a `PreToolUse` hook.
- Stop aborts the query and restores the last checkpoint.

**Tech Stack:**
- Node 24, TypeScript 7, zod 4, vitest 5
- Electron 45, electron-vite 6, electron-builder 26
- React 19, Vite 8, @radix-ui primitives, @material/material-color-utilities 0.4
- @anthropic-ai/claude-agent-sdk 0.3.x, @anthropic-ai/sdk (key check), @modelcontextprotocol/sdk 1.32
- @testing-library/react 16 + jsdom 30, @playwright/test (Electron) for the end-to-end test

**Spec:** `docs/superpowers/specs/2026-11-02-mirage-product-design.md`. Phase 1 is §10 row 1, plus §4, §7, §8, §8.1, §9.1 and §10's "Phase 1 decisions" and "Defaults". Design language: `docs/superpowers/specs/2026-09-28-wordedits-design.md` §15. Engine behaviour: the same file's §14 and `.claude/skills/mirage-episode/SKILL.md`.

## Global Constraints

- **Code basics:** Node `>=22`. ESM only. `strict: true`. Every JSON file the app or engine reads or writes is validated with zod: settings, video.json, notes.json, version meta, run files.
- **Package boundaries:**
  - `packages/core` and `packages/mcp` never import `electron` or `@anthropic-ai/claude-agent-sdk`.
  - The renderer has no Node access (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`). Everything goes through `window.mirage`, typed by `MirageApi` in `packages/app/src/shared/ipc.ts`.
- **Claude configuration isolation (spec §4):**
  - `settingSources: []`
  - `CLAUDE_CONFIG_DIR=<userData>/claude`
  - only Mirage's plugin and Mirage's MCP server
  - The app never reads or writes `~/.claude`.
- **The API key (spec §4):**
  - Sign-in is the person's Anthropic API key only.
  - It is stored encrypted with Electron `safeStorage` (Keychain-backed), never in plain text, and never logged.
  - It reaches only api.anthropic.com, through the SDKs.
  - The app never offers claude.ai login.
- **Branding:** UI copy says "Mirage" and "powered by Claude". It never says "Claude Code" and never imitates its look.
- **Models:** the default is `claude-opus-5-5`. Settings also offers `claude-sonnet-5-5`, labelled "Cheaper". Exact IDs only.
- **Design:**
  - Material 3 per old spec §15: tokens, type, shape, motion, icons, layout, components. Dark theme is the default.
  - **Before writing or editing any frontend code, invoke the `ui-ux-pro-max:ui-ux-pro-max` skill** (the user's standing instruction).
- **Copy:**
  - Plain words with no editing vocabulary (spec §2 anti-goal). Every error shown says what happened and what to do.
  - The privacy line appears once in onboarding and on every first edit of a project: frames, transcripts and audio go to Anthropic, so don't record secrets on screen.
- **Footage is never written to.** The app and Claude only write inside the project folder. Brain file tools are limited to the project folder (read and write) and the video's footage folders (read only).
- **Nothing public:** Phase 1 uploads nothing anywhere.
- **Platform:** macOS on Apple Silicon only in Phase 1.
- **Tests:** renderer tests carry `// @vitest-environment jsdom` on line 1. The root `vitest.config.ts` includes `packages/*/src/**/*.test.{ts,tsx}` and `scripts/**/*.test.ts`.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Stop or "Pause now" in the middle of a render or a voice-over fit.** The engine leaves no `.work-*` or `.partial-*` files and releases the lock. `episode.json` equals the last checkpoint, and the next run starts cleanly. Pinned in Task 1 (cancelled render test) and Task 10 (`stop() restores the last checkpoint after a cancelled render`).
2. **Claude saves a broken `episode.json`: invalid JSON, or valid JSON that fails the schema.**
   - The live view keeps the last good timeline, marked "Being edited", and never throws.
   - Checkpoints copy raw bytes, so a broken file can still be snapshotted and restored.
   - Pinned in Task 2 (`snapshots and restores an episode.json that does not parse`) and Task 11 (`keeps the last good view while the file is broken`).
3. **The app quits, crashes or loses power during a run.** The next launch finds run folders with no `outcome.json`. It marks them `interrupted`, shows "This edit was interrupted at <step>" with "Go back to <step>", and a later run takes over the stale engine lock. Pinned in Task 12 (`recoverRuns marks unfinished runs interrupted`).
4. **Text in a transcript, frame or file asks Claude to read `~/.ssh`, write outside the project, or run a shell.** Bash and web tools aren't available. The `PreToolUse` path policy denies file tools outside the allowed roots, with a reason, and the run carries on. Pinned in Task 10 (`denies file tools outside the project and footage`).
5. **Paths with spaces, quotes, `#`, `%` and non-ASCII, footage on a drive that was unplugged, and `../` in a media URL.** The media protocol decodes and serves allowed paths with Range support, answers 404 for missing files and 403 outside the roots. The engine's missing-clip error reaches the step list in plain words. Pinned in Task 13 (`handleMediaRequest` tests) and Task 4 (`check` on a missing clip returns the engine's ✖ text with `isError`).

---

## File structure

```
packages/core/src/mirage/
  errors.ts                 + 'CANCELLED' code
  cancel.ts                 asCancelled(): maps aborts to MirageError CANCELLED
  versions.ts (+test)       snapshot / list / restore / deliver versions
  reports.ts (+test)        the lines each command prints (shared by CLI and MCP)
  run-files.ts (+test)      progress.json, cancel flag, log.jsonl, outcome.json in a run folder
packages/shared/src/schemas/
  version.ts, run.ts, video.ts, notes.ts
packages/sidecars/src/      run.ts signal → execa cancelSignal; transcribe.ts WORDEDITS_TRANSCRIBER
packages/mcp/               @wordedits/mcp: server.ts (+test), main.ts (stdio entry), build.ts (esbuild bundle)
scripts/build-plugin.ts (+test)   writes packages/app/resources/plugin/ from the repo skill + preamble
packages/app/               @wordedits/app (electron-vite)
  electron.vite.config.ts, electron-builder.yml, playwright.config.ts
  src/shared/ipc.ts         MirageApi, RunEvent, TimelineView, … (types only, no runtime imports)
  src/main/
    index.ts                lifecycle, window, IPC registration
    paths.ts (+test)        dev vs packaged locations of every bundled part
    settings.ts (+test)     settings.json
    keystore.ts (+test), api-key.ts (+test)
    library.ts (+test)      projects and videos
    cost.ts (+test)
    brain/options.ts (+test), brain/prompts.ts (+test), brain/steps.ts (+test),
    brain/policy.ts (+test), brain/runner.ts (+test), brain/fake-query.ts, brain/manager.ts (+test)
    timeline-view.ts (+test), watch.ts (+test)
    media-protocol.ts (+test), notes.ts (+test)
    connections.ts (+test)
    overnight.ts (+test), report.ts (+test)
  src/preload/index.ts
  src/renderer/
    main.tsx, App.tsx, theme/tokens.css, theme/motion.ts
    components/ NavRail, Button, IconButton, Card, TextField, Chip, Sheet, Dialog, WavyProgress, FloatingToolbar, Icon
    screens/ Onboarding, Projects, Project, NewVideo, Video (Edit · Review · Versions tabs), Connections, Overnight, Report, Settings
    edit/ LiveTimeline, StepList, RunBar, ChatPane, PauseSheet, StopDialog
    review/ Player, NoteComposer, NotesList, VoiceoverDrop
    versions/ VersionsList
  e2e/edit.spec.ts, e2e/fixtures/brain-edit.json
LICENSE, THIRD_PARTY_NOTICES.md, README.md (install section)
```

---

### Task 1: Cancellation in the engine

**Files:**
- Modify: `packages/sidecars/src/errors.ts` (code `'CANCELLED'`)
- Modify: `packages/sidecars/src/run.ts` (`RunOptions.signal`)
- Modify: `packages/sidecars/src/ffmpeg.ts` (`FfmpegOptions.signal`; `extractWav` opts `signal`)
- Modify: `packages/core/src/media-tools.ts` (`FfmpegRunOptions.signal`; `extractWav`/`transcribe` opts `signal`)
- Modify: `packages/core/src/mirage/errors.ts` (code `'CANCELLED'`)
- Create: `packages/core/src/mirage/cancel.ts`
- Modify: `packages/core/src/mirage/render-episode.ts`, `voiceover-files.ts`, `ingest.ts` (accept `signal`)
- Test: `packages/sidecars/src/run.test.ts`, `packages/core/src/mirage/render-episode.test.ts`, `packages/core/src/mirage/voiceover-files.test.ts`

**Interfaces:**
- Produces:
  - `RunOptions.signal?: AbortSignal`. When it aborts, `runPath` throws `SidecarError(name, 'CANCELLED', `${name} was stopped`, 'Stopped on request.')`.
  - `FfmpegRunOptions.signal?: AbortSignal`.
  - `MediaTools.extractWav(src, out, opts?: { …; signal?: AbortSignal })` and `MediaTools.transcribe(audio, opts?: { …; signal?: AbortSignal })`.
  - `MirageError` code `'CANCELLED'`.
  - `asCancelled(e: unknown, signal?: AbortSignal): unknown`. It returns `new MirageError('CANCELLED', 'Stopped before it finished', 'Nothing was changed. Run it again to finish.')` when `signal?.aborted`, or when `e` is a `SidecarError` with code `CANCELLED`. Otherwise it returns `e`.
  - `signal?: AbortSignal` on the options of `renderEpisode`, `fitRecording` and `ingestClips`.

- [ ] **Step 1: Write the failing tests**
  - `run.test.ts` → `it('stops the child and throws CANCELLED when the signal aborts')`:
    - Run `runPath('sleep', '/bin/sleep', ['10'], { signal })` and abort after 50 ms.
    - Expect rejection with `{ code: 'CANCELLED' }` within 2 s.
  - `render-episode.test.ts` → `it('a cancelled render leaves no work files, keeps the previous output and releases the lock')`:
    - Use the file's existing fixture project and stub tools. `runFfmpeg` resolves the first chunk, then waits on `opts.signal` and rejects with `new SidecarError('ffmpeg','CANCELLED','ffmpeg was stopped','')`.
    - Write a dummy `rough.mp4` containing `old` first.
    - Start `renderEpisode({ …, mode: 'rough', signal })` and abort after the first chunk.
    - Expect it to reject with `{ code: 'CANCELLED' }`.
    - Expect `readdirSync(dir)` to contain no name starting `.work-` or including `.partial-`, and no `.mirage.lock`.
    - Expect `readFileSync(rough.mp4,'utf8') === 'old'`.
  - `voiceover-files.test.ts` → `it('a cancelled fit leaves episode.json unchanged')`. Abort during `transcribe`; the episode file bytes are unchanged and the lock is gone.

- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/sidecars/src/run.test.ts packages/core/src/mirage/render-episode.test.ts packages/core/src/mirage/voiceover-files.test.ts`

  Expected: the three new tests FAIL (signal is ignored, or the error code isn't `CANCELLED`).

- [ ] **Step 3: Implement**
  - Pass `cancelSignal: opts.signal` to `execa`. Check `res.isCanceled` before the other exit checks.
  - In the engine, call `o.signal?.throwIfAborted()` between chunks, before the music pass, before the final pass, and before saving. Pass `signal` into every `runFfmpeg`, `extractWav` and `transcribe` call.
  - Wrap each command's locked body in `try { … } catch (e) { throw asCancelled(e, o.signal); }`. The existing `finally` blocks already remove work folders and release locks.
  - An aborted `fitRecording` must never reach `saveEpisode`.

- [ ] **Step 4: Run the full suite**

  Run: `pnpm test && pnpm typecheck`

  Expected: PASS. All 361 existing tests still pass.

- [ ] **Step 5: Commit**

  `git commit -m "feat(core): engine commands stop cleanly on an abort signal"`

---

### Task 2: Versions in the engine (spec §8.1)

**Files:**
- Create: `packages/shared/src/schemas/version.ts` (export from the shared index)
- Create: `packages/core/src/mirage/versions.ts`, `packages/core/src/mirage/versions.test.ts`
- Modify: `packages/core/src/mirage/index.ts`

**Interfaces:**
- Consumes: `episodeDir`, `lockEpisode`, `EpisodeMode`, `MirageError`.
- Produces:
  - `VersionKind = 'pre-run' | 'checkpoint' | 'delivery'`.
  - `VersionMetaSchema` / `VersionMeta` = `{ version: 1, id: string, kind: VersionKind, label: string, createdAt: string (ISO), runId: string | null, delivery: number | null, render: { mode: 'rough'|'guide'|'final', file: 'video.mp4', captions: 'captions.srt' | null } | null, hasEpisode: boolean, hasSummary: boolean }`.
  - `VERSIONS_DIR = 'versions'`. Versions live at `episodes/<n>/versions/<id>/`.
  - `snapshotVersion(project: string, n: number, o: { kind: VersionKind; label: string; runId?: string; render?: EpisodeMode; waitMs?: number }): Promise<VersionMeta>`.
  - `listVersions(project: string, n: number): Promise<VersionMeta[]>`, oldest first.
  - `restoreVersion(project: string, n: number, id: string, o?: { waitMs?: number }): Promise<{ restored: VersionMeta; backup: VersionMeta }>`.
  - `MAX_CHECKPOINTS = 50`.

**Decisions:**
- **Ids.** An id is `<UTC yyyyMMdd-HHmmss-SSS>-<kind>-<4 random hex>`, so sorting by name is chronological.
- **What a snapshot holds.** It copies the **raw bytes** of `episode.json` and `summary.md`, when present, and records `hasEpisode` and `hasSummary`. The episode file isn't parsed, so a broken one is still saved.
- **Delivery.** `kind: 'delivery'` sets `delivery` to the highest existing delivery number plus 1, starting at 1.
  - When `render` is given, it hard-links `<mode>.mp4` to `video.mp4` (falling back to `copyFile` on `EXDEV`, `EPERM` or `ENOTSUP`).
  - For `final`, it also links `final.srt` to `captions.srt`.
  - A missing render file throws `MirageError('BAD_INPUT', 'episodes/<n>/<mode>.mp4 does not exist', 'Render it first.')`.
- **Restore.** It first snapshots the current state as a `checkpoint` labelled `Before going back to “<label>”` (the backup). Then it writes `episode.json` and `summary.md` atomically (temp file plus rename), or removes each one when the version didn't have it. It never touches renders, the catalog, notes, footage or other versions.
- **Locking.**
  - Snapshot and restore both hold `lockEpisode(project, n, 'versions')`.
  - On `BUSY`, they retry every 250 ms for up to `waitMs` (default 30 000), then rethrow. A lock left by a dead process is taken over by the existing lock code.
  - Version folders are written as a `.tmp-<uuid>` folder and then renamed, so a half-written version is never listed.
- **Pruning.** After each checkpoint, checkpoints beyond the newest 50 are deleted. Pre-run versions and deliveries are kept forever.
- **Listing.** `listVersions` skips folders whose `meta.json` is missing or invalid.

- [ ] **Step 1: Write the failing tests** in `versions.test.ts`, on a temp project made with `initProject` plus `episodes/1/episode.json`:
  - `it('snapshots episode.json and summary.md and lists versions oldest first')`
  - `it('numbers deliveries 1, 2, … and links the render as video.mp4')`. After a later `rough.mp4` is replaced via rename, V1's `video.mp4` keeps the old bytes.
  - `it('restores a version and keeps a backup of what was there')`. Edit the file, restore V1: the bytes equal V1's, and `backup.label` is `Before going back to “<V1 label>”`.
  - `it('restoring a version made before episode.json existed removes it')`
  - `it('snapshots and restores an episode.json that does not parse')`. The bytes are `{"version": 2, "items": [` and come back exactly.
  - `it('waits for a busy episode and then snapshots')`. Hold `lockEpisode(…,'render')` for 300 ms, and the snapshot resolves after release.
  - `it('keeps only the newest 50 checkpoints but every delivery and pre-run')`
  - `it('ignores a version folder with a broken meta.json')`

- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/core/src/mirage/versions.test.ts`

  Expected: FAIL (`snapshotVersion` is not exported).

- [ ] **Step 3: Implement `versions.ts` and `version.ts`** as decided above.

- [ ] **Step 4: Run the tests and typecheck**

  Run: `pnpm vitest run packages/core/src/mirage/versions.test.ts && pnpm typecheck`

  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "feat(core): versions of an episode: snapshots, deliveries and restore"`

---

### Task 3: Shared command reports and run files

**Files:**
- Create: `packages/core/src/mirage/reports.ts`, `reports.test.ts`
- Create: `packages/shared/src/schemas/run.ts`
- Create: `packages/core/src/mirage/run-files.ts`, `run-files.test.ts`
- Modify: `scripts/mirage.ts` (print the report lines; behaviour unchanged)
- Modify: `packages/core/src/mirage/render-episode.ts` (export `RenderOptions`, `RenderResult`)
- Modify: `packages/core/src/mirage/index.ts`

**Interfaces:**
- **Report functions.** Each returns the exact lines `scripts/mirage.ts` prints today, without the `\r  NN%` progress:
  - `checkReport(r: { episode: Episode; warnings: string[]; notes: string[] }): string[]`
  - `ingestReport(r: IngestResult): string[]`
  - `musicReport(r: { tracks: LibraryTrack[]; warnings: string[] }, dir: string): string[]`. Use the track type `analyzeLibrary` returns.
  - `renderReport(r: RenderResult): string[]`
  - `updateSlots(project: string, n: number): Promise<{ slots: Slot[]; moved: MovedSlot[]; dropped: Slot[] }>`. This is the load + `carrySlots(computeSlots)` + save that the CLI does today. Use the `moved` element type `carrySlots` returns.
  - `slotsReport(r: Awaited<ReturnType<typeof updateSlots>>): string[]`
  - `voReport(report: FitReport, n: number): string[]`
- **Run files.**
  - `ProgressSchema = { command: string, fraction: number (0..1), startedAt: string, updatedAt: string }`
  - `LogEntrySchema = { at: string, kind: 'guess'|'question'|'concern'|'warning'|'note-status', text: string, noteId?: string, status?: 'done'|'done-differently'|'could-not' }`
  - `OutcomeSchema = { outcome: 'done'|'stopped'|'failed'|'budget'|'interrupted', endedAt: string, costUsd: number, sessionId: string|null, error?: string, lastStep?: string }`
  - The run folder is `runDir(project: string, n: number, runId: string) = episodes/<n>/runs/<runId>`.
  - `writeProgress(dir, p: Progress): Promise<void>` (atomic) and `readProgress(dir): Promise<Progress | null>`.
  - `requestCancel(dir)`, `clearCancel(dir)` and `cancelRequested(dir): boolean`, using the file `cancel`.
  - `watchCancel(dir: string, controller: AbortController, intervalMs = 250): () => void`
  - `appendLog(dir, e: LogEntry)`. One JSON line per entry in `log.jsonl`.
  - `readLog(dir): Promise<LogEntry[]>`. It skips unparsable lines.
  - `writeOutcome(dir, o)` and `readOutcome(dir)`, using `outcome.json`.
  - `listRuns(project, n): Promise<string[]>`. Run ids, oldest first.

- [ ] **Step 1: Write the failing tests**
  - `reports.test.ts`, with values copied from today's CLI strings:
    - `checkReport` prints the item line `'  1  cold-open open         c001  12.50–18.00  ×1  0.00–5.50'` and a `total …` line, with `•` notes and `⚠` warnings in that order.
    - `voReport` on a report with a `partial` line contains `⚠ only part of the line was found — re-read the whole line with vo --add --slots n2`.
    - `slotsReport` contains `⚠ over budget (12 > 9 words)` for an over-budget slot.
  - `run-files.test.ts`:
    - `it('appends and reads log entries, skipping a broken line')`
    - `it('watchCancel aborts the controller once the cancel file appears')`
    - `it('readProgress is null when there is no progress file')`

- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/core/src/mirage/reports.test.ts packages/core/src/mirage/run-files.test.ts`

  Expected: FAIL.

- [ ] **Step 3: Implement.** Move the formatting out of `scripts/mirage.ts` into `reports.ts` unchanged. The CLI then does `for (const l of xReport(r)) console.log(l)`. `check()` in the CLI keeps returning the episode.

- [ ] **Step 4: Verify that CLI behaviour is unchanged**

  Run: `pnpm test && pnpm typecheck`

  Expected: PASS. The macOS e2e test still passes.

- [ ] **Step 5: Commit**

  `git commit -m "refactor(core): command reports and run files shared by the CLI and the app"`

---

### Task 4: The Mirage MCP server

**Files:**
- Create: `packages/mcp/package.json` (`@wordedits/mcp`; deps `@modelcontextprotocol/sdk@^1.32.2`, `zod`, `@wordedits/core`, `@wordedits/shared`; dev `esbuild`)
- Create: `packages/mcp/tsconfig.json`
- Create: `packages/mcp/src/server.ts`, `packages/mcp/src/main.ts`, `packages/mcp/src/server.test.ts`, `packages/mcp/build.ts`
- Modify: `packages/sidecars/src/transcribe.ts` (`transcriberPath()` returns `process.env.WORDEDITS_TRANSCRIBER` when set)
- Modify: root `package.json` typecheck list, `tsconfig` references, `.gitignore` (`packages/mcp/dist/`)

**Interfaces:**
- Consumes:
  - from Task 1: `signal` options
  - from Task 3: the report functions, `updateSlots`, `writeProgress`, `watchCancel`, `appendLog`, `clearCancel`
  - from the engine: `describeError`
- Produces:
  - `createMirageServer(ctx: { project: string; episode: number; runDir: string; tools: MediaTools }): McpServer`. `McpServer` comes from `@modelcontextprotocol/sdk/server/mcp.js`, and the server is named `mirage`.
  - `TOOL_NAMES: readonly string[]`, the ten tool names in the table below. It's exported for Task 5.
  - A bundled stdio entry, `packages/mcp/dist/mirage-mcp.mjs`, built by `pnpm --filter @wordedits/mcp build`.
  - Its environment: `MIRAGE_PROJECT` (absolute), `MIRAGE_EPISODE` (integer), `MIRAGE_RUN_DIR` (absolute), `WORDEDITS_FFMPEG_DIR` and `WORDEDITS_TRANSCRIBER`.
  - Claude sees the tools as `mcp__mirage__<name>`.

| Tool | Input (zod) | Does |
|---|---|---|
| `ingest` | `{ folder: string }` (absolute, or relative to the project) | `ingestClips` → `ingestReport` |
| `music` | `{}` | `analyzeLibrary(<project>/music)` → `musicReport`. A missing folder returns the CLI's `NO_MUSIC_TRACK` error text. |
| `check` | `{}` | `checkEpisode` → `checkReport` |
| `cut` / `guide` / `render` | `{}` | `renderEpisode` in mode `rough` / `guide` / `final`. `cut` passes `beforeRender: () => checkEpisode(…)` and prepends `checkReport` lines. Result: `renderReport`. |
| `slots` | `{}` | `updateSlots` → `slotsReport` |
| `vo` | `{ recording: string, add?: boolean, slots?: string[] }` | `fitRecording` → `voReport` |
| `log` | `{ kind: 'guess'\|'question'\|'concern', text: string (1..2000) }` | `appendLog`. Returns `noted`. |
| `note_status` | `{ noteId: string, status: 'done'\|'done-differently'\|'could-not', reason?: string }` | `appendLog({kind:'note-status', …})`. A missing `reason` with a status other than `done` returns an `isError` result: `✖ say why: reason is needed unless the note is done`. |

**Decisions:**
- **Results.** A success is `{ content: [{ type: 'text', text: lines.join('\n') || 'done' }] }`.
- **Errors** are `isError: true`, with text `✖ ${message}` and `\n  ${hint}` when there is a hint, from `describeError`.
- **Cancelled commands** are `isError: true` with the text `✖ Stopped by the person before it finished. Nothing was changed.`
- **Long commands** (`ingest`, `cut`, `guide`, `render`, `vo`):
  - They create an `AbortController` and run `watchCancel(runDir, controller)` for the duration. They also abort on the MCP request's own `extra.signal`.
  - They write `writeProgress` at most every 250 ms.
  - They delete `progress.json` when they finish.
- **Warnings.** Every `⚠` line a command returns is also appended to the log as `{kind:'warning'}`.
- **Bundling.** `main.ts` calls `requireProject(project)`, builds `realMediaTools()`, and connects `StdioServerTransport`. `build.ts` bundles with esbuild: `platform: 'node'`, `format: 'esm'`, `target: 'node22'`, `external: ['ffmpeg-static','ffprobe-static']`, and a banner that defines `require` via `createRequire(import.meta.url)`.

- [ ] **Step 1: Write the failing tests** in `server.test.ts`. Use `InMemoryTransport.createLinkedPair()` (`@modelcontextprotocol/sdk/inMemory.js`) and a `Client`, on a temp project with a catalog and `episodes/1/episode.json` written directly.
  - `it('lists exactly the Mirage tools')`: the names equal `['ingest','music','check','cut','guide','render','slots','vo','log','note_status']`, in any order.
  - `it('check returns the timeline lines')`: the text contains `total ` and the item id.
  - `it('check on a missing clip returns the engine error as an error result')`: `isError === true` and the text starts with `✖ `.
  - `it('cut stops when the cancel file appears and says nothing was changed')`. Stub tools' `runFfmpeg` waits on `opts.signal`. Call `requestCancel(runDir)` after 100 ms, then expect `isError` and the exact cancelled text.
  - `it('log appends a guess to log.jsonl')`
  - `it('note_status needs a reason unless done')`
  - `it('a ⚠ warning from check is copied into the log')`

- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/mcp/src/server.test.ts`

  Expected: FAIL (module not found).

- [ ] **Step 3: Implement `server.ts`, `main.ts` and `build.ts`** as above.

- [ ] **Step 4: Verify the tests, the build and a smoke run**

  Run: `pnpm vitest run packages/mcp && pnpm --filter @wordedits/mcp build && node packages/mcp/dist/mirage-mcp.mjs < /dev/null`

  Expected: the tests PASS and the bundle exists. The last command exits non-zero with `✖ no Mirage project at` because no env is set, which proves the bundle loads.

- [ ] **Step 5: Commit**

  `git commit -m "feat(mcp): the Mirage engine as an MCP server"`

---

### Task 5: The Mirage plugin (the skill the app's brain loads)

**Files:**
- Create: `scripts/build-plugin.ts`, `scripts/build-plugin.test.ts`
- Modify: root `package.json` (script `build:plugin`), `.gitignore` (`packages/app/resources/plugin/`)

**Interfaces:**
- Produces:
  - `buildPlugin(o: { skillFile: string; outDir: string; version: string }): Promise<void>`. It writes:
    - `<outDir>/.claude-plugin/plugin.json`: `{ "name": "mirage", "version": <version>, "description": "Mirage's video-editing skills" }`
    - `<outDir>/skills/mirage-episode/SKILL.md`
  - `APP_PREAMBLE: string`
  - `pnpm build:plugin` writes `packages/app/resources/plugin/` from `.claude/skills/mirage-episode/SKILL.md`, using the version from `packages/app/package.json`.

**Decisions:**
- The generated `SKILL.md` is the source frontmatter, unchanged, then `APP_PREAMBLE`, then the source body, unchanged. That way the CLI skill stays the single source.
- `APP_PREAMBLE` is exactly:

```markdown
## In the Mirage app

You are working inside the Mirage app, and the person watches your edit live. Before each step, say what you're about to do in one short sentence.

- Each `pnpm mirage <command> <project> <n> …` in this skill is the tool `mcp__mirage__<command>`. The project and video are already chosen, so pass only the other arguments: `ingest` takes `folder`; `vo` takes `recording`, `add` and `slots`. Every command named in the steps below has a tool.
- There is no shell. Never try to run `pnpm` or any other command.
- File paths in this skill are relative to the project folder, which is your working directory. Read clips' frames there, and write `episodes/<n>/episode.json` there with the Write or Edit tool.
- You can't read or write outside the project and the video's footage folders. Footage folders are read-only.
- When the person sends notes, each note has an id. Once you've dealt with a note, call `mcp__mirage__note_status` with `done`, `done-differently` (say how) or `could-not` (say why).
- To leave something for the person to read later, call `mcp__mirage__log`: `concern` for a doubt about the result, `question` for something only they can answer, `guess` for a choice you made for them.
```

- [ ] **Step 1: Write the failing test** `build-plugin.test.ts`. Build into a temp dir from the real skill file, then check:
  - `plugin.json` parses and has `name === 'mirage'`.
  - `SKILL.md` starts with `---\nname: mirage-episode\n`.
  - It contains `APP_PREAMBLE` and the full source body.
  - Every `pnpm mirage (\w+)` command in the source is one of the MCP tool names. Import the list as `TOOL_NAMES` from `packages/mcp/src/server.ts`.

- [ ] **Step 2: Run it to verify it fails**

  Run: `pnpm vitest run scripts/build-plugin.test.ts`

  Expected: FAIL.

- [ ] **Step 3: Implement `buildPlugin` and the CLI entry.**

- [ ] **Step 4: Verify**

  Run: `pnpm vitest run scripts/build-plugin.test.ts && pnpm build:plugin`

  Expected: PASS, and `packages/app/resources/plugin/skills/mirage-episode/SKILL.md` exists.

- [ ] **Step 5: Commit**

  `git commit -m "feat: build the Mirage plugin for the app's brain from the episode skill"`

---

### Task 6: App skeleton and the Material 3 shell

Invoke `ui-ux-pro-max:ui-ux-pro-max` before writing any renderer code.

**Files:**
- Create `packages/app/`:
  - `package.json`, with:
    - dependencies: `electron@45`, `react@19`, `react-dom@19`, `@radix-ui/react-dialog`, `@radix-ui/react-tabs`, `@radix-ui/react-tooltip`, `material-symbols` (Apache-2.0), and a variable font package (below)
    - dev dependencies: `electron-vite@6`, `vite@8`, `@vitejs/plugin-react@6`, `@testing-library/react@16`, `jsdom@30`
    - scripts: `dev`, `build`, `test:e2e`, `dist`
  - `electron.vite.config.ts`, `tsconfig.json`
  - `src/main/index.ts`, `src/preload/index.ts`, `src/shared/ipc.ts`
  - `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`
  - `src/renderer/theme/tokens.css`, `src/renderer/theme/motion.ts`
  - `src/renderer/components/*` (NavRail, Button, IconButton, Card, TextField, Chip, Sheet, Dialog, WavyProgress, FloatingToolbar, Icon)
  - `src/renderer/App.test.tsx`, `src/renderer/theme/tokens.test.ts`
- Modify: root `vitest.config.ts` include (`packages/*/src/**/*.test.{ts,tsx}`), `pnpm-workspace.yaml` `allowBuilds`/`onlyBuiltDependencies` (`electron`)

**Interfaces:**
- Produces:
  - `MirageApi` in `src/shared/ipc.ts`. Later tasks add methods to it, and each method is listed in that task's Interfaces.
  - `window.mirage: MirageApi`, exposed in preload with `contextBridge.exposeInMainWorld('mirage', api)`. Each method is `ipcRenderer.invoke('<method name>', …args)`.
  - Subscriptions: `on(channel: 'run-event' | 'timeline' | 'connections' | 'overnight', cb): () => void`.
  - `registerIpc(handlers: Partial<MirageApiHandlers>)` in main. A handler for each `MirageApi` method is registered with `ipcMain.handle`.
  - Routing: a `Screen` union in `App.tsx` (`'onboarding'|'projects'|'project'|'video'|'connections'|'overnight'|'report'|'settings'`), with simple state navigation and no router library.
  - Components follow §15's component table.
    - `WavyProgress({ value?: number })`: determinate when `value` is given.
    - `FloatingToolbar`, plus `Sheet` and `Dialog` (Radix) at radius 28.

**Decisions:**
- **Fonts.** Use `@fontsource-variable/google-sans-flex` if it's on npm (`npm view` it). Otherwise fall back to `@fontsource-variable/roboto-flex`. Record the choice in THIRD_PARTY_NOTICES (Task 16).
- **Tokens.** `tokens.css` defines every role in §15's colour table as `--md-sys-color-<role>`, using the exact hex values: dark under `:root, [data-theme=dark]`, light under `[data-theme=light]`. It also defines the type scale (`--md-sys-typescale-*`), shape scale (`--md-sys-shape-corner-*`) and motion tokens from §15. `motion.ts` exports the spring and easing constants.
- **Reduced motion.** `@media (prefers-reduced-motion: reduce)` swaps spatial motion for opacity-only motion.
- **Window.** 1280×800, minimum 960×640, `titleBarStyle: 'hiddenInset'`, background `#111418`.
  - CSP: `default-src 'self'; img-src 'self' mirage-media: data:; media-src mirage-media:; style-src 'self' 'unsafe-inline'; font-src 'self'`.
  - Opening a new window is denied. External links go through `shell.openExternal`, and only for `https://` URLs.
- **Shell layout.** A navigation rail with Projects, Overnight, Connections and Settings (icon plus label, 96 px), and the workspace on `surface`.

- [ ] **Step 1: Write the failing tests**
  - `tokens.test.ts` parses `tokens.css` and checks the colour values, for example `--md-sys-color-primary: #A3C9FE` under dark and `#39608F` under light. It checks all 33 colour roles listed in §15 (written as an array in the test) for both themes.
  - `App.test.tsx`, with a fake `window.mirage`: the rail renders four buttons with accessible names `Projects`, `Overnight`, `Connections` and `Settings`. `document.documentElement.dataset.theme === 'dark'`.

- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/app`

  Expected: FAIL.

- [ ] **Step 3: Implement the skeleton, tokens, components and shell.**

- [ ] **Step 4: Verify**

  Run: `pnpm vitest run packages/app && pnpm --filter @wordedits/app build`

  Expected: PASS, and `packages/app/out/` is built. `pnpm --filter @wordedits/app dev` opens the window with the rail (check by eye once).

- [ ] **Step 5: Commit**

  `git commit -m "feat(app): Electron app skeleton with the Material 3 shell"`

---

### Task 7: Settings, the API key and onboarding

Invoke `ui-ux-pro-max:ui-ux-pro-max` before the renderer part.

**Files:**
- Create: `packages/app/src/main/settings.ts` (+test), `keystore.ts` (+test), `api-key.ts` (+test)
- Create: `packages/app/src/renderer/screens/Onboarding.tsx` (+test), `screens/Settings.tsx`
- Modify: `src/shared/ipc.ts`, `src/main/index.ts`, `App.tsx` (show onboarding when there is no key)
- Add dependency: `@anthropic-ai/sdk` to the app

**Interfaces:**
- **Settings.**
  - `SettingsSchema = { version: 1, model: 'claude-opus-5-5' | 'claude-sonnet-5-5' (default opus), nightlyLimitUsd: number > 0 (default 20), libraryDir: string (default ~/Movies/Mirage), recentProjects: string[] (max 20, default []), overnightAdviceSeen: boolean (default false) }`
  - `loadSettings(file): Promise<Settings>` (a missing file gives the defaults) and `saveSettings(file, s)` (atomic).
- **Keystore.**
  - `createKeystore(o: { file: string; crypto: SafeStorageLike }): Keystore`, where `SafeStorageLike = { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string }`.
  - `Keystore = { get(): Promise<string | null>; set(key: string): Promise<void>; clear(): Promise<void> }`.
  - The file is `<userData>/secrets/anthropic-key.bin`, mode `0o600`. `set` throws `Error('This Mac can’t encrypt the key right now, so it wasn’t saved.')` when encryption isn't available. Plain text is never written.
- **Key check.**
  - `validateApiKey(key: string, o?: { makeClient?: (key: string) => { models: { list(p: { limit: number }): Promise<unknown> } } }): Promise<KeyCheck>`.
  - `KeyCheck = { ok: true } | { ok: false; reason: 'format' | 'rejected' | 'offline' | 'other'; message: string }`.
- **IPC methods:** `getSettings()`, `setSettings(patch)`, `hasApiKey()`, `saveApiKey(key) → KeyCheck` (validates first, stores only when ok), `removeApiKey()`, `openExternal(url)`.

**Decisions:**
- **Key check.**
  - The format check is the regex `/^sk-ant-[A-Za-z0-9_-]{20,}$/` on the trimmed key.
  - The real check is `new Anthropic({ apiKey }).models.list({ limit: 1 })`.
  - Error mapping:
    - `Anthropic.AuthenticationError` and `PermissionDeniedError` → `rejected`: "Claude didn't accept this key. Check you copied all of it, or make a new one."
    - `APIConnectionError` → `offline`: "Mirage couldn't reach Claude. Check your internet connection."
    - Anything else → `other`, with the error message.
- **Onboarding (spec §5.1).** Four steps in a 28-radius card, with one filled button each.
  1. **"Welcome to Mirage."** "Drop in your footage, and Mirage edits the video for you. It's powered by Claude, so you'll need a Claude API key. You pay Anthropic for what you use, usually a few dollars per video."
  2. **"Get your key."** Three numbered lines:
     - "Open the Claude Console" (button → `https://console.anthropic.com/settings/keys`)
     - "Add some credit" (button → `https://console.anthropic.com/settings/billing`)
     - "Create a key and copy it"
  3. **"Paste your key"**: a password-type field with a show/hide toggle and a Check button. Errors appear under the field.
  4. **"Before you start"**: "Mirage sends frames, transcripts and audio from your footage to Anthropic to edit it. Your video files stay on this Mac. Don't record passwords or other secrets on screen." Button: "Start".
- **Settings screen:**
  - API key (Replace / Remove)
  - Model (Opus 5.5 "Best", Sonnet 5.5 "Cheaper")
  - Nightly spending limit ($)
  - Library folder
  - About (version, licences link)

- [ ] **Step 1: Write the failing tests**
  - `settings.test.ts`: the defaults are returned when the file is missing; an invalid model is rejected.
  - `keystore.test.ts`, with a fake `SafeStorageLike` that XORs:
    - `set` then `get` round-trips the key.
    - The file bytes don't contain the key.
    - `set` throws when encryption isn't available, and no file is written.
    - `clear` removes the file.
  - `api-key.test.ts`, with a fake client that throws `new Anthropic.AuthenticationError(401, …)`:
    - `→ { ok:false, reason:'rejected' }`
    - `'abc' → reason 'format'`, and the client is never called
    - success `→ { ok:true }`
  - `Onboarding.test.tsx`: "Check" with a bad key shows the rejected message under the field; a good key advances to "Before you start".

- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/app/src/main packages/app/src/renderer/screens`

  Expected: FAIL.

- [ ] **Step 3: Implement.** In `index.ts`, wire `crypto` to Electron `safeStorage`.

- [ ] **Step 4: Run the tests**

  Run: `pnpm vitest run packages/app`

  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "feat(app): API-key setup, onboarding and settings"`

---

### Task 8: Projects and videos

Invoke `ui-ux-pro-max:ui-ux-pro-max` before the renderer part.

**Files:**
- Create: `packages/shared/src/schemas/video.ts`
- Create: `packages/app/src/main/library.ts` (+test)
- Create: `src/renderer/screens/Projects.tsx`, `Project.tsx`, `NewVideo.tsx` (+test)
- Modify: `src/shared/ipc.ts`, `src/main/index.ts`

**Interfaces:**
- Consumes: `initProject`, `requireProject`, `slugify`, `listVersions`, `loadSettings`/`saveSettings`.
- Produces:
  - `VideoSchema = { version: 1, title: string (1..200), about: string, mention: string, hide: string, footage: string[] (absolute folder paths, ≥1), createdAt: string }`, stored at `episodes/<n>/video.json`.
  - `ProjectSummary = { path: string; title: string; videos: VideoSummary[] }`.
  - `VideoSummary = { number: number; title: string; stage: 'new' | 'rough' | 'guide' | 'final'; latestRender: { mode: EpisodeMode; path: string; mtimeMs: number } | null; deliveries: number; running: boolean }`.
  - `listProjects(settings: Settings): Promise<ProjectSummary[]>`: every child folder of `libraryDir` containing `mirage.json`, plus each `recentProjects` entry that still exists, de-duplicated and sorted by newest change.
  - `createProject(settings, title): Promise<string>`: the path is `libraryDir/<slugify(title)>`, with `-2`, `-3`… when taken, then `initProject`, then add it to recent.
  - `openProject(settings, path): Promise<ProjectSummary>`: `requireProject`, then add it to recent.
  - `createVideo(project: string, v: Omit<Video,'version'|'createdAt'>): Promise<number>`: n = the highest numbered folder in `episodes/` plus 1. Write `video.json`.
  - `readVideo(project, n): Promise<Video | null>`
  - `videoSummary(project, n): Promise<VideoSummary>`
- **IPC methods:** `listProjects()`, `createProject(title)`, `openProject(path)`, `pickFolder() → string | null` (dialog), `createVideo(project, video)`, `getVideo(project, n)`.

**Decisions:**
- **CLI projects.** A video without `video.json` (made with the CLI) takes its title from `episode.json`, and its footage is `[]`.
- **Stage.** It's the newest of `final.mp4` > `guide.mp4` > `rough.mp4` that exists, otherwise `new`.
- **New video flow (spec §5.3).**
  - **Footage.** A drop zone plus "Choose folder". Only folders are accepted; a dropped file gives "Drop the folder your clips are in." The folders are listed with clip counts (files with `VIDEO_EXTENSIONS`).
  - **Three questions:**
    - "What's this video about, and what should viewers come away with?" (required)
    - "Anything to mention, like a sponsor, links or a product?" (optional)
    - "Anything that must not be shown?" (optional)
  - **Buttons:** "Edit now" (filled) and "Edit overnight" (tonal).

- [ ] **Step 1: Write the failing tests**
  - `library.test.ts`:
    - `createProject` twice with the same title gives `…/weather-app` and `…/weather-app-2`.
    - `createVideo` numbers videos 1, 2.
    - A CLI-made episode with no `video.json` is listed with its `episode.json` title.
    - `stage` is `guide` when `guide.mp4` and `rough.mp4` both exist.
    - A recent project that was deleted isn't listed.
  - `NewVideo.test.tsx`: "Edit now" is disabled until a folder and the "about" answer are given; dropping a file shows the folder message.

- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/app/src/main/library.test.ts packages/app/src/renderer/screens/NewVideo.test.tsx`

  Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests**

  Run: `pnpm vitest run packages/app`

  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "feat(app): projects, videos and the new-video flow"`

---

### Task 9: Cost estimate and running total

**Files:**
- Create: `packages/app/src/main/cost.ts` (+test)

**Interfaces:**
- `PRICES: Record<ModelId, { input: number; output: number; cacheWrite: number; cacheRead: number }>`, in USD per million tokens. Exact values:
  - `claude-opus-5-5`: `{ input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 }`
  - `claude-sonnet-5-5`: `{ input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }`
- `costOfUsage(model: ModelId, u: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }): number`
- `RunKind = 'edit' | 'notes' | 'voiceover' | 'chat'`, defined in `src/shared/ipc.ts` and imported here
- `RunCostRecord = { kind: RunKind; model: ModelId; clips: number; usd: number; at: string }`, stored in `<userData>/cost-history.json` (zod array, last 200).
- `estimateRun(o: { model: ModelId; kind: RunKind; clips: number; history: RunCostRecord[] }): { low: number; likely: number; high: number; basis: 'defaults' | 'your-runs' }`
- `CostTally`: `add(messageId: string, model: ModelId, usage)` (adds once per id), `setFinal(usd: number)`, `get total(): number`.

**Decisions:**
- **Defaults** for `likely` with Opus:
  - edit: `1.50 + 0.40 × clips`
  - notes: `0.80`
  - voiceover: `0.40`
  - chat: `0.20`
  - Sonnet: half of each.
- **Learning from past runs.** With 3 or more history records of the same kind and model:
  - for edit, `likely = median(usd / max(clips,1)) × clips`
  - for the other kinds, `likely = median(usd)`
  - `basis: 'your-runs'`
- **Range.** `low = likely × 0.6` and `high = likely × 1.8`, each rounded to cents.
- **Overcounting.** The SDK can repeat an assistant message's usage once per content block, so `CostTally` de-duplicates by message id. `setFinal` replaces the running sum with the SDK's `total_cost_usd`.

- [ ] **Step 1: Write the failing tests:**
  - `costOfUsage('claude-opus-5-5', {input_tokens: 1e6, output_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6})` → `29.2`
  - the default estimate for an Opus edit with 10 clips → `likely 5.5`, `low 3.3`, `high 9.9`
  - three history records at $0.30/clip → `likely 3` for 10 clips, with `basis 'your-runs'`
  - `CostTally` counts a repeated message id once, and `setFinal` wins

- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/app/src/main/cost.test.ts`

  Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests**

  Run: `pnpm vitest run packages/app/src/main/cost.test.ts`

  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "feat(app): cost estimate and running total"`

---

### Task 10: The brain runner

**Files:**
- Create in `packages/app/src/main/brain/`:
  - `paths` use (`../paths.ts` is created here too: `AppPaths`)
  - `options.ts`, `prompts.ts`, `steps.ts`, `policy.ts`, `runner.ts`, `fake-query.ts`
  - tests: `options.test.ts`, `prompts.test.ts`, `steps.test.ts`, `policy.test.ts`, `runner.test.ts`
- Add dependency: `@anthropic-ai/claude-agent-sdk@^0.3.317`

**Interfaces:**
- Consumes:
  - from Task 2: `snapshotVersion`, `restoreVersion`, `listVersions`
  - from Task 3: `runDir`, `requestCancel`, `clearCancel`, `readProgress`, `readLog`, `writeOutcome`
  - from Task 9: `CostTally`, `costOfUsage`
  - from Task 8: `readVideo`
  - from Task 7: the settings and keystore
- **Paths.** `AppPaths = { userData: string; plugin: string; mcpServer: string; nodeCommand: string; ffmpegDir: string; transcriber: string; claudeExecutable: string | undefined; claudeConfigDir: string }`. Task 16 finishes the packaged branch. In dev:
  - `plugin = packages/app/resources/plugin`
  - `mcpServer = packages/mcp/dist/mirage-mcp.mjs`
  - `nodeCommand = process.execPath`
  - `ffmpegDir` = the folder of `ffmpeg-static`'s binary
  - `transcriber = packages/sidecars/bin/darwin/wordedits-transcribe`
  - `claudeConfigDir = <userData>/claude`
- **Query function.** `QueryFn = (a: { prompt: string; options: Options }) => AsyncIterable<SDKMessage> & { close(): void }`. The SDK's `query` satisfies it.
- **Building the options.** `buildOptions(o: { spec: RunSpec; video: Video | null; paths: AppPaths; apiKey: string; settings: Settings; hooks: Options['hooks']; canUseTool: CanUseTool; abortController: AbortController; runDir: string }): Options`. Exact fields:

```ts
{
  model: settings.model,
  cwd: spec.project,
  settingSources: [],
  plugins: [{ type: 'local', path: paths.plugin }],
  mcpServers: { mirage: { type: 'stdio', command: paths.nodeCommand, args: [paths.mcpServer], env: {
    ELECTRON_RUN_AS_NODE: '1', MIRAGE_PROJECT: spec.project, MIRAGE_EPISODE: String(spec.episode), MIRAGE_RUN_DIR: runDir,
    WORDEDITS_FFMPEG_DIR: paths.ffmpegDir, WORDEDITS_TRANSCRIBER: paths.transcriber } } },
  env: { PATH: process.env.PATH, HOME: os.homedir(), ANTHROPIC_API_KEY: apiKey, CLAUDE_CONFIG_DIR: paths.claudeConfigDir },
  systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend(spec, video) },
  allowedTools: ['mcp__mirage'],
  disallowedTools: ['Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task', 'Agent'],
  permissionMode: 'default',
  canUseTool, hooks, abortController,
  maxBudgetUsd: spec.budgetUsd,
  resume: spec.resumeSessionId,
  pathToClaudeCodeExecutable: paths.claudeExecutable,
}
```

- **Prompts.**
  - `systemAppend(spec: RunSpec, video: Video | null): string`
  - `userPrompt(spec: RunSpec, extra: { video: Video | null; notes?: SentNote[]; recording?: string; text?: string }): string`
- **Steps.** `stepLabel(toolName: string, input: unknown): { label: string; doneLabel: string }`
- **File policy.**
  - `filePolicy(o: { project: string; footage: string[] }): (toolName: string, input: Record<string, unknown>) => { allow: true } | { allow: false; reason: string }`
  - `isMutating(toolName: string, input: unknown, project: string, n: number): boolean`
- **The runner.**
  - `RunSpec = { project: string; episode: number; mode: 'live' | 'overnight'; kind: RunKind; resumeSessionId?: string; budgetUsd?: number; notes?: SentNote[]; recording?: string; text?: string }`
  - `RunState = 'starting' | 'running' | 'pausing' | 'paused' | 'stopping' | 'done' | 'stopped' | 'failed'`
  - `class Run`:

```ts
constructor(spec: RunSpec, deps: RunDeps)
readonly id: string; readonly dir: string
start(): Promise<RunOutcome>          // resolves when the run ends, never rejects
pause(how: 'after-step' | 'now'): void
resume(correction?: string): void
stop(): Promise<void>
pauseInfo(): Promise<{ runningStep: string | null; remainingSec: number | null }>
on(listener: (e: RunEvent) => void): () => void
get state(): RunState
get sessionId(): string | null
```

  - `RunDeps = { query: QueryFn; paths: AppPaths; settings: Settings; apiKey: () => Promise<string | null>; now?: () => Date }`
  - `RunOutcome = { outcome: 'done' | 'stopped' | 'failed' | 'budget'; sessionId: string | null; costUsd: number; delivered: VersionMeta | null; error?: string }`
- **Events.** `RunEvent`, in `src/shared/ipc.ts`:

```ts
| { type: 'state'; state: RunState }
| { type: 'step'; id: string; label: string; status: 'running' | 'done' | 'failed'; detail?: string }
| { type: 'text'; text: string }                    // Claude's words, for the chat pane
| { type: 'cost'; usd: number }
| { type: 'version'; meta: VersionMeta }
| { type: 'ended'; outcome: RunOutcome }
```
  Every event also carries `{ runId, project, episode }`.
- **The fake brain.** `createScriptedQuery(script: ScriptStep[], o: { callTool: (name: string, input: unknown) => Promise<{ text: string; isError: boolean }> }): QueryFn`, where:

```ts
ScriptStep = { say: string } | { tool: string; input: unknown } | { fail: string }
```
  It emits:
  - a `system/init` message with `session_id: 'fake-session'` and `mcp_servers: [{ name: 'mirage', status: 'connected' }]`
  - then each step:
    - `say` → an assistant text message
    - `tool` → an assistant `tool_use` block, then the options' `PreToolUse` hooks (awaited), then either the deny reason as an error tool result or `callTool`, then `PostToolUse`, then a user `tool_result`
  - then a `result` with `subtype: 'success'` and `total_cost_usd: 0.01`
  - `fail` → a `result` with `subtype: 'error_during_execution'`, `errors: [fail]`

  The abort signal ends the iteration.

**Decisions:**
- **`systemAppend`** (each line included verbatim):
  - `You are Mirage's video editor, editing video ${n} (“${title}”) in the project at ${project}.`
  - The video brief: "What it's about", "Mention", "Don't show", "Footage folders" (one per line).
  - Live: `The person is watching the edit live. Ask them when you need something only they know, in one short question.`
  - Overnight:
    - `The person is asleep. Never stop to ask a question. Make your best guess, record it with mcp__mirage__log (kind "guess"), and carry on. Put anything only they can answer on the morning list with kind "question".`
    - `Finish with the guide cut: catalogue the clips, write the timeline, render the rough cut, write the narration lines, then render the guide video with mcp__mirage__guide. Don't wait for a voice-over.`
  - Both: `Never invent footage, numbers or events.`
- **`userPrompt`** by kind:
  - **edit:** `Edit this video from the footage in ${folders}. Follow the mirage-episode skill from cataloguing the clips to ${mode === 'overnight' ? 'the guide video' : 'the rough cut, then show me the rough cut and wait for my notes'}.`
  - **notes:** `Here are my notes on ${versionLabel}. Act on each one, then render again with the same command that made this version.` Then one block per note:
    - `Note ${id} at ${t.toFixed(1)} s: ${text}`
    - when there's a box: `(about the area ${pct(x)}–${pct(x+w)} across, ${pct(y)}–${pct(y+h)} down)`
    - `Still: ${stillPath}`
  - **voiceover:** `I recorded the voice-over: ${recording}. Fit it with mcp__mirage__vo, then render the final video with mcp__mirage__render. Tell me plainly about any missing or partial lines.`
  - **chat:** the text, as written.
- **Step labels.** `stepLabel` returns `{label, doneLabel}`:
  - `mcp__mirage__ingest` → "Cataloguing your clips" / "Clips catalogued"
  - `music` → "Reading the music" / "Music read"
  - `check` → "Checking the timeline" / "Timeline checked"
  - `cut` → "Rendering the rough cut" / "Rough cut rendered"
  - `slots` → "Finding room for narration" / "Narration slots found"
  - `guide` → "Rendering the guide video" / "Guide video rendered"
  - `vo` → "Fitting your voice-over" / "Voice-over fitted"
  - `render` → "Rendering the final video" / "Final video rendered"
  - `log` → "Making a note for you" / "Noted"
  - `note_status` → "Updating a note" / "Note updated"
  - `Read` on an image under `frames/` → "Looking at clips" / "Looked at clips"
  - other `Read` → "Reading <basename>" / "Read <basename>"
  - `Write`/`Edit`/`MultiEdit` on `episode.json` → "Writing the timeline" / "Timeline written"
  - `Write`/`Edit` on `catalog.json` → "Describing clips" / "Clips described"
  - other `Write`/`Edit` → "Saving <basename>" / "Saved <basename>"
  - `Glob`/`Grep` → "Looking through the project" / "Looked through the project"
  - anything else → "Working" / "Done"

  Consecutive "Looking at clips" steps merge into one step with a count detail (`12 frames`).
- **`filePolicy`:**
  - It applies to `Read`, `Write`, `Edit`, `MultiEdit`, `Glob` and `Grep`. The path comes from `input.file_path ?? input.path`; `Glob` without a path means cwd.
  - The path is made absolute and `realpath`ed (or its parent's realpath when the file doesn't exist yet).
  - Allowed if inside `project`, or for `Read`/`Glob`/`Grep` inside a footage folder.
  - Writes into footage folders are refused: `Footage folders are read-only in Mirage.`
  - Anything else: `Mirage only lets you use files in this project${footage.length ? ' and its footage folders' : ''}.`
  - Tools not in the list and not `mcp__mirage__*` are refused: `That tool isn't available in Mirage.`
- **`isMutating`** is true for `mcp__mirage__{ingest,check,cut,slots,guide,vo,render}`, and for `Write`/`Edit`/`MultiEdit` whose path is `<project>/catalog.json` or inside `<project>/episodes/<n>/`.
- **The `PreToolUse` hook** (one matcher, no `matcher` field, `timeout: 604800`):
  1. If the policy refuses → return `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }`.
  2. Await the gate, which is open unless paused.
  3. If a correction is pending → clear it and return a deny with the reason: `The person paused the edit and said: “${text}”. Act on this before you carry on. The step you were about to run didn't run.`
  4. Otherwise emit the step `running` event and return `{}`.
- **`canUseTool`** returns `{ behavior: 'allow', updatedInput: input }` for tools the policy allows, and otherwise `{ behavior: 'deny', message: reason }`.
- **The `PostToolUse` hook:**
  - Emit the step `done` event, or `failed` when the tool response is an error.
  - If `isMutating` → `snapshotVersion(…, { kind: 'checkpoint', label: doneLabel, runId })` and emit `version`.
- **Starting.** `start()`:
  - Snapshots `pre-run` with labels by kind:
    - edit: "Before the edit"
    - notes: "Before your notes"
    - voiceover: "Before the voice-over"
    - chat: "Before your message"
  - Iterates the query:
    - `system/init` → `sessionId`. If the `mirage` server status isn't `connected` → fail with `Mirage's editing engine didn't start. Open Connections to check it.`
    - assistant text → `text` events
    - assistant usage → the cost tally (de-duplicated by `message.id`) and a `cost` event
    - assistant `error === 'authentication_failed'` → fail with `Claude didn't accept your API key. Replace it in Settings.`
    - `result` → `setFinal(total_cost_usd)`. Outcome: `success` → `done`, `error_max_budget_usd` → `budget`, anything else → `failed` with `errors.join('; ')`.
  - With no API key: an immediate `failed` with `Add your Claude API key in Settings first.`
- **Delivery.** On `done`, the newest of `final.mp4`/`guide.mp4`/`rough.mp4` modified after the run started becomes a `delivery` version, labelled:
  - final: "Final video"
  - guide: "Guide cut (record your voice-over over this)"
  - rough: "Rough cut"
- **Pausing.**
  - `pause('after-step')` closes the gate and sets the state to `pausing`. It becomes `paused` when a `PreToolUse` is waiting at the gate, or immediately when no tool is running.
  - `pause('now')` does the same and also calls `requestCancel(dir)`.
  - `resume(correction?)` calls `clearCancel(dir)`, stores the correction, opens the gate and sets the state to `running`.
- **Time left on a running step.** `pauseInfo()` reads `readProgress(dir)`. `remainingSec = elapsed × (1 − f) / f` when `f ≥ 0.02`, otherwise `null`.
- **Stopping.** `stop()`:
  1. Set the state to `stopping`, call `requestCancel(dir)`, open the gate (so a held hook can return), then `abortController.abort()`.
  2. Wait up to 10 s for the iteration to end, then call `close()`.
  3. `restoreVersion` to this run's newest `checkpoint`, or its `pre-run` when there's none.
  4. If a render was made during the run → a `delivery` labelled `Stopped after: ${lastDoneLabel}`; otherwise none.
  5. Outcome `stopped`.
- **Every end** writes `writeOutcome(dir, …)` and appends a `RunCostRecord`, then emits `ended`.

- [ ] **Step 1: Write the failing tests**
  - `options.test.ts`:
    - `buildOptions` sets `settingSources: []`, `CLAUDE_CONFIG_DIR` under userData, the API key only in `env.ANTHROPIC_API_KEY`, and the mirage server env (all six variables).
    - `disallowedTools` includes `Bash`.
    - It never mentions `~/.claude`.
  - `prompts.test.ts`:
    - The overnight `systemAppend` contains the "Never stop to ask a question" line and `mcp__mirage__guide`; the live one doesn't.
    - The notes prompt contains `Note n1 at 12.3 s:` and `about the area 10%–40% across`.
  - `steps.test.ts`: the labels table above, row by row.
  - `policy.test.ts`, test name `denies file tools outside the project and footage`:
    - `Read ~/.ssh/id_rsa` → deny
    - `Write <footage>/x.txt` → deny "read-only"
    - `Read <footage>/a.mov` → allow
    - `Write <project>/episodes/1/episode.json` → allow
    - a symlink inside the project pointing outside → deny
    - `Bash` → deny
  - `runner.test.ts` uses `createScriptedQuery` with a `callTool` that writes files and simulates renders in a temp project:
    - `it('runs a script, emits steps and cost, snapshots after mutating steps and delivers the rough cut')`
    - `it('pause after step holds the next tool until resume')`. The second tool's `callTool` isn't called until `resume()`.
    - `it('resume with a correction denies the held step with the person’s words')`. The tool result text contains `The person paused the edit and said: “keep the intro”`.
    - `it('pause now writes the cancel file')`
    - `it('stop() restores the last checkpoint after a cancelled render')`. The script writes `episode.json` (checkpoint), then a partial edit, then a `cut` that waits for cancel. After `stop()`, the bytes equal the checkpoint's and the outcome is `stopped`.
    - `it('fails with a plain message when the engine server is not connected')`
    - `it('maps error_max_budget_usd to budget')`
    - `it('fails at once without an API key')`

- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/app/src/main/brain`

  Expected: FAIL.

- [ ] **Step 3: Implement** `paths.ts` (dev branch), then `options.ts`, `prompts.ts`, `steps.ts`, `policy.ts`, `fake-query.ts` and `runner.ts`. Import the SDK types (`Options`, `SDKMessage`, `CanUseTool`, `HookCallback`) from `@anthropic-ai/claude-agent-sdk`. Don't redefine them.

- [ ] **Step 4: Run the tests and typecheck**

  Run: `pnpm vitest run packages/app/src/main/brain && pnpm typecheck`

  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "feat(app): brain runner on the Agent SDK with pause, stop, checkpoints and a file policy"`

---

### Task 11: The live timeline

Invoke `ui-ux-pro-max:ui-ux-pro-max` before the renderer part.

**Files:**
- Create: `packages/app/src/main/timeline-view.ts` (+test), `watch.ts` (+test)
- Create: `src/renderer/edit/LiveTimeline.tsx` (+test), `StepList.tsx` (+test)
- Modify: `src/shared/ipc.ts`, `src/main/index.ts`

**Interfaces:**
- Consumes: `EpisodeSchema`, `CatalogSchema`, `layoutTimeline`, `timelineDuration`, and the `RunEvent` step events.
- Produces:
  - `TimelineView`:

```ts
{ status: 'empty' | 'ok' | 'editing'; title: string; durationSec: number;
  items: { id: string; beat: Beat; clip: string; start: number; end: number; thumb: string | null; quiet: boolean; speed: number }[];
  overlays: { kind: Overlay['kind']; text: string; tone: Overlay['tone']; start: number; end: number }[];
  music: { track: string; start: number; end: number }[];
  slots: { id: string; start: number; end: number; line: string; maxWords: number }[];
  voice: { slot: string; start: number; end: number }[] }
```

  - `buildTimelineView(project: string, raw: { episode: string | null; catalog: string | null }, previous: TimelineView | null): TimelineView`
  - `mediaUrl(absPath: string): string` = `'mirage-media://file/' + encodeURIComponent(absPath)`. Task 13 serves it.
  - `watchVideo(project: string, n: number, onView: (v: TimelineView) => void): () => void`
  - IPC: `watchTimeline(project, n)` starts pushing `'timeline'` events for that video (one watcher per window); `unwatchTimeline()`.
  - `LiveTimeline({ view: TimelineView })`
  - `StepList({ steps: StepItem[] })`, with `StepItem = { id; label; status; detail? }`

**Decisions:**
- **Status.** `status`:
  - `empty`: no `episode.json`
  - `editing`: the episode doesn't parse or fails the schema. The view keeps `previous`'s lists, or empty ones.
  - `ok`: otherwise
- **Thumbnails.** `thumb` is the catalog frame of the item's clip whose `t` is closest to `(src.in + src.out) / 2`, as a `mediaUrl`.
- **Voice lines.** A voice line's end is `at + (src.out − src.in) − Σ(cut lengths)`.
- **Watching.** `watchVideo` uses `fs.watch` on `episodes/<n>/` and on the project folder (for `catalog.json`), with a 100 ms debounce. It reads both files and rebuilds. It emits once at start, and stops cleanly on dispose.
- **Lanes.** `LiveTimeline` draws four lanes on `surface-container`:
  - **Picture:** thumbnails sized by duration, with a beat-coloured top edge; quiet items are hatched.
  - **On screen:** overlay pills.
  - **Music:** cue bars with the track name.
  - **Narration:** slot outlines with their line, filled where a voice line is placed.
  - A time ruler sits on top. It scales to fit the width; when there are more than 60 items, it scrolls horizontally inside the lane area only.
- **Motion.**
  - Items whose id is new since the last view get `data-state="entering"` (fade plus 8 px rise, the emphasized-decelerate curve, 300 ms). Removed ids stay 200 ms with `data-state="exiting"` (fade out).
  - Moved items animate `transform` only.
  - With reduced motion, opacity only.
  - `editing` shows a small "Being edited…" chip, not an error.
- **Steps.** `StepList` lists steps newest-last:
  - running: a spinner, `aria-live="polite"`
  - done: a check
  - failed: an error icon with the detail
  - It keeps the last 200 steps.

- [ ] **Step 1: Write the failing tests**
  - `timeline-view.test.ts`:
    - A two-item episode with an overlay, music and a fitted voice line gives the expected starts, ends and thumbnail URLs.
    - `keeps the last good view while the file is broken`: raw `'{"version":2,'` with a previous view → `status 'editing'` and the same items.
    - Missing `episode.json` → `empty`.
  - `watch.test.ts`: an atomic rewrite (write temp, rename) of `episode.json` produces a new view within 1 s; dispose stops the events.
  - `LiveTimeline.test.tsx`: rendering view A then view B (one item added, one removed) marks the new item `entering` and keeps the removed one as `exiting`. With `editing` status, "Being edited" shows.
  - `StepList.test.tsx`: a failed step shows its detail text.

- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/app/src/main/timeline-view.test.ts packages/app/src/main/watch.test.ts packages/app/src/renderer/edit`

  Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests**

  Run: `pnpm vitest run packages/app`

  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "feat(app): live timeline view drawn from the episode files"`

---

### Task 12: The edit screen: run, pause, stop, chat

Invoke `ui-ux-pro-max:ui-ux-pro-max` before the renderer part.

**Files:**
- Create: `packages/app/src/main/brain/manager.ts` (+test)
- Create: `src/renderer/screens/Video.tsx`
- Create: `src/renderer/edit/RunBar.tsx`, `ChatPane.tsx` (+test), `PauseSheet.tsx` (+test), `StopDialog.tsx`
- Modify: `src/shared/ipc.ts`, `src/main/index.ts`

**Interfaces:**
- Consumes: from Task 10, `Run`, `RunSpec` and `RunEvent`; from Task 9, `estimateRun`; from Task 3, `listRuns`, `readOutcome` and `writeOutcome`.
- Produces:
  - `RunManager`:

```ts
class RunManager {
  constructor(deps: RunDeps & { emit: (e: RunEvent) => void })
  start(spec: RunSpec): Promise<string>      // runId; refuses a second run of the same video ("This video is already being edited.")
  pause(project: string, n: number, how: 'after-step' | 'now'): void
  resume(project: string, n: number, correction?: string): void
  stop(project: string, n: number): Promise<void>
  chat(project: string, n: number, text: string): Promise<void>
  active(project: string, n: number): { runId: string; state: RunState } | null
  pauseInfo(project: string, n: number): Promise<{ runningStep: string | null; remainingSec: number | null }>
  recoverRuns(project: string, n: number): Promise<(Outcome & { runId: string })[]>   // see decisions
}
```

  - Sessions: `session.json` in `episodes/<n>/runs/` holds `{ sessionId: string }`, the latest session for the video.
  - IPC methods (all map 1:1 onto the manager):
    - `startEdit(project, n, mode)`
    - `pauseRun(project, n, how)`
    - `resumeRun(project, n, correction?)`
    - `stopRun(project, n)`
    - `sendChat(project, n, text)`
    - `runStatus(project, n)`
    - `pauseInfo(project, n)`
    - `estimate(project, n, kind)`
    - `recoverRuns(project, n)`
    - `restoreVersion(project, n, id)`
  - Events: `'run-event'` carries `RunEvent`.

**Decisions:**
- **Starting an edit.** `startEdit` builds `RunSpec { kind: 'edit', mode }`. When the video has a session, it sets `resumeSessionId` from `session.json`. Every run with an `ended` outcome `done` and a session id saves it.
- **Chat.**
  - `chat()` with an active run → `resume(text)` (typing has already paused it).
  - Otherwise → `start({ kind: 'chat', text, resumeSessionId })`.
  - The renderer calls `pauseRun(…, 'after-step')` on the first keystroke in the chat field while the run is `running`.
- **Recovering runs.** `recoverRuns` runs when a video is opened. Each run folder with no `outcome.json` gets an outcome `interrupted`, with `lastStep` = the label of the run's newest checkpoint. It returns those, and the screen shows "This edit was interrupted at “<lastStep>”" with "Go back to “<lastStep>”" (`restoreVersion` of that checkpoint) and "Keep things as they are".
- **The Video screen** has tabs Edit · Review · Versions; Tasks 13 and 15 fill the last two.
- **The Edit tab:**
  - LiveTimeline, with StepList to its right on wide windows and below it on narrow ones.
  - **RunBar** with:
    - a state chip
    - the cost (`$1.20 so far · estimate $3.30–$9.90`)
    - Pause (tonal) and Stop (text button in `error`)
  - **When idle:** the estimate and the two buttons "Edit now" and "Edit overnight". "Edit overnight" adds to the overnight queue (Task 15).
  - **The chat pane** is the supporting pane on `surface-container-low`, 360–420 px, always visible at ≥1200 px and a bottom sheet below 600 px. It shows the person's messages and Claude's `text` events. Its field has the placeholder "Tell Mirage what to change…".
- **The pause sheet:**
  - While a step is running, it offers two options:
    - "Pause after this step", with the line `“<step>” finishes in about <m> min` (or `finishes soon` when unknown)
    - "Pause now", with the line `Stops “<step>” now. It can run again later.`
  - Otherwise it pauses straight away.
  - While paused, the RunBar shows "Paused", with Resume (filled) and the chat field.
- **The stop dialog:** "Stop the edit?" / "Mirage goes back to the last finished step, “<label>”. Nothing before it is lost." Buttons: "Keep editing" and "Stop" (error).

- [ ] **Step 1: Write the failing tests**
  - `manager.test.ts`, with `createScriptedQuery`:
    - A second `start` for the same video rejects.
    - `chat` during a paused run resumes it with a correction.
    - `chat` with no run starts a `chat` run with `resumeSessionId` from `session.json`.
    - `recoverRuns marks unfinished runs interrupted`: a run folder with a checkpoint and no `outcome.json` → `interrupted`, with `lastStep` set.
  - `PauseSheet.test.tsx`: with `runningStep "Rendering the rough cut"` and `remainingSec 150`, it shows both options and `finishes in about 3 min`.
  - `ChatPane.test.tsx`: the first keystroke while running calls `pauseRun(…,'after-step')` once; Send calls `sendChat`.

- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/app/src/main/brain/manager.test.ts packages/app/src/renderer/edit`

  Expected: FAIL.

- [ ] **Step 3: Implement.** In `index.ts`, wire the real `query` from the SDK. When `!app.isPackaged && process.env.MIRAGE_FAKE_BRAIN` is set, use `createScriptedQuery(JSON.parse(readFileSync(MIRAGE_FAKE_BRAIN)))` instead. Its `callTool` connects an MCP `Client` over `StdioClientTransport` to the real `mirage-mcp.mjs` with the same env as `buildOptions`, and uses `fs` for `Write`/`Edit`.

- [ ] **Step 4: Run the tests**

  Run: `pnpm vitest run packages/app`

  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "feat(app): edit screen with live run, pause, stop, chat and interrupted-run recovery"`

---

### Task 13: Player, notes, versions and the voice-over drop

Invoke `ui-ux-pro-max:ui-ux-pro-max` before the renderer part.

**Files:**
- Create: `packages/shared/src/schemas/notes.ts`
- Create: `packages/app/src/main/media-protocol.ts` (+test), `notes.ts` (+test)
- Create: `src/renderer/review/Player.tsx` (+test), `NoteComposer.tsx`, `NotesList.tsx` (+test), `VoiceoverDrop.tsx`
- Create: `src/renderer/versions/VersionsList.tsx` (+test)
- Modify: `src/shared/ipc.ts`, `src/main/index.ts`, `screens/Video.tsx`

**Interfaces:**
- Consumes: from Task 2, `listVersions` and `restoreVersion`; from Task 3, `listRuns` and `readLog`; from Task 12, `RunManager.start`; from the sidecars, `runFfmpeg`, `extractWav` and `transcribeAudio`.
- Produces:
  - **The media protocol.**
    - `MEDIA_SCHEME = 'mirage-media'`. Registered privileged as `{ standard: true, secure: true, stream: true, supportFetchAPI: true }` before `app.ready`.
    - `handleMediaRequest(req: Request, roots: string[]): Promise<Response>`
    - `registerMediaProtocol(roots: () => string[]): void`. The roots are the open projects and their videos' footage folders.
  - **Notes.**
    - `NoteSchema = { id: string ('n' + 1..), versionId: string, t: number ≥0, text: string (1..2000), box: { x, y, w, h } (each 0..1) | null, still: string (path relative to the episode folder), createdAt: string, round: number | null }`
    - `NotesFileSchema = { version: 1, notes: Note[] }`, in `episodes/<n>/notes.json`, written only by the app (atomic).
    - `addNote(project, n, o: { versionId, videoPath, t, text, box }): Promise<Note>`. It grabs the still at `t` into `episodes/<n>/notes/<id>.jpg`.
    - `updateNote(project, n, id, patch: { text?, box? })` and `deleteNote(project, n, id)`. Only for unsent notes, otherwise `Error('This note was already sent.')`.
    - `sendNotes(project, n): Promise<SentNote[]>`. It gives every unsent note `round = max + 1` and returns them with absolute still paths. `SentNote = Note & { stillPath: string }`.
    - `noteStatuses(project, n): Promise<Record<string, { status, reason?: string }>>`. It reads `note-status` entries from every run log; the newest wins.
    - `transcribeVoiceNote(project, n, bytes: Uint8Array): Promise<string>`. It saves `notes/voice-<uuid>.webm`, then `extractWav`, then `transcribeAudio`, and returns the text.
  - **IPC methods:**
    - `listVersions(project, n)`
    - `listNotes(project, n)`, which merges statuses
    - `addNote(…)`, `updateNote(…)`, `deleteNote(…)`
    - `sendNotes(project, n)`, which starts a `notes` run with the sent notes and the version label
    - `transcribeVoiceNote(project, n, bytes)`
    - `startVoiceover(project, n, recordingPath)`, which starts a `voiceover` run
    - `mediaUrl(path)`

**Decisions:**
- **Serving media.** `handleMediaRequest`:
  - The URL is `mirage-media://file/<encodeURIComponent(abs)>`. Decode it, `resolve()` it, and require it to be inside a root after `realpath`; otherwise 403.
  - A missing file gives 404.
  - A `Range: bytes=a-b` request gives 206 with `Content-Range`, `Accept-Ranges: bytes` and `Content-Length`. Without one, 200.
  - Content types: `.mp4` `video/mp4`, `.mov` `video/quicktime`, `.jpg` `image/jpeg`, `.png` `image/png`, `.webm` `audio/webm`; anything else `application/octet-stream`.
  - Files are streamed with `fs.createReadStream({start,end})` through `Readable.toWeb`.
- **Stills.** The ffmpeg args are `['-ss', t.toFixed(3), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', out]`.
- **Microphone.** `session.setPermissionRequestHandler` allows only `media` permission with `mediaTypes` exactly `['audio']` for the app's own window; everything else is denied.
- **Review tab:**
  - The player plays the newest delivery's `video.mp4` by default, or the latest render when there's no delivery. A version picker sits above it.
  - The video sits in a 16-radius frame with the floating toolbar from §15: play, scrubber with note markers, timecode in tabular numerals.
  - **Clicking the picture** pauses it and opens the NoteComposer at the current time, with a still preview, a text field, a mic button (hold to record, release to transcribe into the field) and Add. **Dragging on the picture** draws the box first.
  - **NotesList** shows each note with time, text, a thumbnail and a status chip: "Not sent", "Sent", "Done", "Done differently: <reason>" or "Couldn't: <reason>". Clicking a note seeks to it. The button "Send notes (k)" appears when there are unsent notes and is disabled while a run is active.
  - **VoiceoverDrop** shows when the shown version is a guide delivery: "Play this guide and read the lines out loud as they come up. Record yourself with QuickTime or your phone, then drop the recording here." Dropping an audio or video file (or "Choose file") → `startVoiceover`.
- **Versions tab** (`VersionsList`):
  - It lists deliveries as "V<k> · <label> · <date>", plus pre-run versions as "Before …".
  - "Show steps" reveals checkpoints.
  - Actions: Play (opens Review on that version, deliveries only) and "Go back to this version" (confirm dialog: "Go back to “<label>”? What's there now is kept as a version too.") → `restoreVersion`.

- [ ] **Step 1: Write the failing tests**
  - `media-protocol.test.ts`, on a temp root containing `we proj 'q' #1 ✨/clip.mp4`:
    - 200 with the full body
    - `Range: bytes=10-19` → 206, 10 bytes, `Content-Range: bytes 10-19/<size>`
    - a missing file → 404
    - `mirage-media://file/` + `encodeURIComponent(root + '/../etc/passwd')` → 403
    - a symlink inside the root pointing outside → 403
  - `notes.test.ts`, with stub tools for ffmpeg:
    - `addNote` numbers notes `n1`, `n2` and writes the still path.
    - `sendNotes` sets `round 1` and returns absolute still paths.
    - Editing a sent note throws.
    - `noteStatuses` takes the newest status across two runs' logs.
  - `Player.test.tsx`: a click on the picture at `currentTime = 4.2` opens the composer showing `0:04`; a drag records a box with values between 0 and 1.
  - `NotesList.test.tsx`: the status chips read correctly from statuses.
  - `VersionsList.test.tsx`: checkpoints are hidden until "Show steps"; "Go back" asks for confirmation before calling `restoreVersion`.

- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/app/src/main/media-protocol.test.ts packages/app/src/main/notes.test.ts packages/app/src/renderer/review packages/app/src/renderer/versions`

  Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests**

  Run: `pnpm vitest run packages/app`

  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "feat(app): player with click-on-video notes, versions and the voice-over drop"`

---

### Task 14: The connections panel

Invoke `ui-ux-pro-max:ui-ux-pro-max` before the renderer part.

**Files:**
- Create: `packages/app/src/main/connections.ts` (+test)
- Create: `src/renderer/screens/Connections.tsx` (+test)
- Modify: `src/shared/ipc.ts`, `src/main/index.ts`

**Interfaces:**
- `ConnectionState = 'connected' | 'built-in' | 'not-connected' | 'problem' | 'later'`
- `Connection = { id: string; name: string; adds: string; state: ConnectionState; detail?: string; action?: { label: string; target: 'settings-key' | 'retry' | 'help' } }`
- `checkConnections(deps: { keystore: Keystore; validateApiKey: typeof validateApiKey; paths: AppPaths; checkEngine: () => Promise<{ ok: boolean; detail?: string }>; checkFfmpeg: () => Promise<{ ok: boolean; encoder?: string; detail?: string }>; macosMajor: () => number }): Promise<Connection[]>`
- `checkEngine(paths: AppPaths): Promise<{ ok: boolean; detail?: string }>`. It spawns `mirage-mcp.mjs` via `StdioClientTransport` with a temp empty project, calls `listTools`, expects `cut`, closes, and times out after 15 s.
- IPC: `getConnections()`. It's pushed on `'connections'` after each check.

**Decisions.** Rows, in order:

| id | Name | Adds | States |
|---|---|---|---|
| `claude` | Claude | "The editor. Writes your timeline, picks shots, writes narration lines." | `connected` when the key validates. `not-connected` when there's no key (action "Add key"). `problem` when it's rejected or offline (the KeyCheck message, action "Replace key" / "Try again"). |
| `engine` | Mirage engine | "Cuts, music sync, voice-over fitting and rendering." | `built-in`, or `problem` with the detail (action "Try again") |
| `ffmpeg` | Video tools (FFmpeg) | "Reads and writes video files." | `built-in` with detail `encoder: <name>`, or `problem` |
| `speech` | Speech recognition | "Turns speech in your clips and voice-over into words, on this Mac." | `built-in` on macOS ≥ 26 with the transcriber present; otherwise `problem`: "Needs macOS 26 or later." |
| `youtube` | YouTube | "Upload private drafts and learn from your viewers." | `later` |
| `epidemic` | Epidemic Sound | "Music and sound effects from its whole library (needs your own subscription)." | `later` |
| `hyperframes` | HyperFrames | "Animated diagrams, counters and cards." | `later` |
| `browser` | Browser | "Real web pages and posts as B-roll." | `later` |

The `later` chip reads "Coming later". The screen shows one card per row, with the state chip, the "adds" line, the detail and one action button.

- [ ] **Step 1: Write the failing tests**
  - `connections.test.ts`, with fakes:
    - No key → `claude` is `not-connected` with action "Add key".
    - A rejected key → `problem` with the message.
    - An engine failure → `problem` with the detail.
    - macOS 25 → `speech` is `problem`.
    - The four `later` rows are always present, in the order above.
  - `Connections.test.tsx`: a `problem` row shows its action button.

- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/app/src/main/connections.test.ts packages/app/src/renderer/screens/Connections.test.tsx`

  Expected: FAIL.

- [ ] **Step 3: Implement.** `checkFfmpeg` uses the sidecars' `locate('ffmpeg')` and `pickEncoder()`, with `WORDEDITS_FFMPEG_DIR` set from `paths.ffmpegDir` at app start.

- [ ] **Step 4: Run the tests**

  Run: `pnpm vitest run packages/app`

  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "feat(app): connections panel"`

---

### Task 15: Overnight mode and the morning report

Invoke `ui-ux-pro-max:ui-ux-pro-max` before the renderer part.

**Files:**
- Create: `packages/app/src/main/overnight.ts` (+test), `report.ts` (+test)
- Create: `src/renderer/screens/Overnight.tsx` (+test), `screens/Report.tsx`
- Modify: `src/shared/ipc.ts`, `src/main/index.ts` (keep running when the window closes)

**Interfaces:**
- Consumes: from Task 12, `RunManager`; from Task 9, `estimateRun`; from Task 14, `checkConnections`; from Task 3, `readLog`, `listRuns` and `readOutcome`; from Task 2, `listVersions`.
- Produces:
  - **The queue.**
    - `QueueSchema = { version: 1, items: { project: string; episode: number; addedAt: string }[]; startAt: string | null ("HH:MM", 24 h) }`, in `<userData>/overnight.json`.
    - `addToQueue(project, n)`, `removeFromQueue(project, n)`, `setStartAt(hhmm | null)`.
  - **Preflight.** `preflight(o: { queue; settings; deps: { onBattery(): boolean; freeBytes(path): Promise<number>; footageBytes(project, n): Promise<number>; connections(): Promise<Connection[]>; estimate(project, n): Promise<number> } }): Promise<{ ok: boolean; problems: string[]; estimateUsd: number }>`
  - **The runner.**

```ts
class OvernightRunner {
  constructor(deps: { manager: RunManager; preflight: …; powerSaveBlocker: { start(t: 'prevent-app-suspension'): number; stop(id: number): void }; notify: (title: string, body: string, onClick: () => void) => void; settings: () => Settings; now?: () => Date })
  start(): Promise<NightSummary>
  schedule(): void
  cancel(): void
}
```

  - **The morning report.**
    - `buildReport(o: { video: VideoSummary; outcome: Outcome; steps: StepItem[]; log: LogEntry[]; delivered: VersionMeta | null; costUsd: number }): string`, in Markdown, saved as `runs/<id>/report.md`.
    - `NightSummary = { items: { project; episode; runId; outcome; reportPath }[]; costUsd: number }`.
  - **IPC methods:** `getQueue()`, `addToQueue(project, n)`, `removeFromQueue(project, n)`, `setStartAt(hhmm)`, `preflight()`, `startOvernight()`, `cancelOvernight()`, `getReport(project, n, runId)`. Events on `'overnight'`.

**Decisions:**
- **Preflight problems**, each with exact copy:
  - On battery → `Plug in your Mac. Overnight editing needs the power adapter.`
  - Free space on each project's disk below `max(10 GB, 2 × footage bytes)` → `Free up space on <volume>: Mirage needs about <X> GB for tonight's videos.`
  - Any of the `claude`, `engine`, `ffmpeg`, `speech` rows not ok → `<Name>: <detail>. Fix it in Connections.`
  - The sum of `estimate.high` over the queue above `nightlyLimitUsd` → `Tonight's videos could cost up to $<high>, more than your $<limit> nightly limit. Remove a video or raise the limit in Settings.`
- **Before the first start**, a sheet: "Leave your Mac plugged in with the lid open. You can turn the screen off. Closing the lid puts it to sleep, and the editing stops." `overnightAdviceSeen` is set after the first start.
- **Running the queue.** `start()`:
  - Runs preflight and refuses on problems.
  - Calls `powerSaveBlocker.start('prevent-app-suspension')`.
  - Runs the queue one video at a time with `RunManager.start({ kind: 'edit', mode: 'overnight', budgetUsd: limit − spent })`, waiting for each `ended`.
  - A `failed` outcome retries once: `kind: 'chat'`, `mode: 'overnight'`, `resumeSessionId`, text `The last step failed: <error>. Carry on from where you stopped.`
  - A `budget` outcome stops the night: the rest of the queue is reported as "Not started: the nightly limit was reached".
  - After each video, `buildReport` → `report.md`. At the end, it stops the blocker, clears the done items from the queue, and calls `notify('Your videos are ready', '<k> of <m> finished · $<cost>', open the Report screen)`.
- **Scheduling.** `schedule()` sets a timer for the next `startAt`, re-armed after each night. The app keeps running with the window closed while a night is scheduled or running: on macOS the window hides, and `window-all-closed` doesn't quit.
- **Report sections, in order:**
  - title: `# <video title>: <"V1 ready" | "Stopped at: <lastStep>" | "Didn't finish: <error>">`
  - `## What I did` (the done step labels)
  - `## Things I wasn't sure about` (`concern` entries)
  - `## Choices I made for you` (`guess` entries)
  - `## Questions for you` (`question` entries)
  - `## Things to check` (`warning` entries, de-duplicated)
  - `## Next` (for a guide delivery: `Record the voice-over: open the video, go to Review, and follow the steps there.`)
  - `Cost: $<x.xx>`
  - Empty sections are left out.
- **Overnight screen:**
  - the queue list (video title, estimate, remove)
  - the "Start at" time
  - the night's total estimate against the limit
  - preflight problems in an error card
  - "Start now" (filled)
  - while running: each video's state and its current step
- **Report screen:** the Markdown rendered with a minimal renderer (headings, lists, paragraphs), plus "Open video".

- [ ] **Step 1: Write the failing tests**
  - `overnight.test.ts`, with a fake manager whose runs end with scripted outcomes and fake deps:
    - Preflight on battery → the exact battery message.
    - Estimates over the limit → the exact limit message.
    - Two videos run in order, with the blocker started and stopped.
    - A failed video retries once with the resume text, then the next video runs.
    - `budget` stops the night and marks the rest "Not started".
    - `notify` is called once with `2 of 2 finished`.
  - `report.test.ts`:
    - A guide delivery with one guess, one question and a repeated warning gives the section headings in order, the warning once, and the voice-over "Next" line.
    - Empty sections are absent.
  - `Overnight.test.tsx`: preflight problems render in an error card, and "Start now" is disabled while there are problems.

- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/app/src/main/overnight.test.ts packages/app/src/main/report.test.ts packages/app/src/renderer/screens/Overnight.test.tsx`

  Expected: FAIL.

- [ ] **Step 3: Implement.** Wire Electron's `powerMonitor.isOnBatteryPower`, `powerSaveBlocker`, `Notification` and `fs.statfs` in `index.ts`.

- [ ] **Step 4: Run the tests**

  Run: `pnpm vitest run packages/app`

  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "feat(app): overnight mode with preflight, keep-awake, retries and the morning report"`

---

### Task 16: Packaging, licences and the README

**Files:**
- Create: `packages/app/electron-builder.yml`, `packages/app/scripts/prepare-resources.ts`
- Modify: `packages/app/src/main/paths.ts` (packaged branch) (+`paths.test.ts`)
- Create: `LICENSE`, `THIRD_PARTY_NOTICES.md`
- Modify: `README.md` (install section), `src/renderer/screens/Settings.tsx` (About → notices)

**Interfaces:**
- `resolvePaths(o: { isPackaged: boolean; resourcesPath: string; appPath: string; userData: string; requireResolve: (id: string) => string }): AppPaths`.

**Decisions:**
- **Bundled resources.** `prepare-resources.ts` runs before `electron-builder`. It copies into `packages/app/build-resources/`:
  - `bin/ffmpeg` and `bin/ffprobe`, from `ffmpeg-static` / `ffprobe-static`
  - `bin/wordedits-transcribe`, built with `pnpm build:native` if missing
  - `mcp/mirage-mcp.mjs`, built with `pnpm --filter @wordedits/mcp build`
  - `plugin/`, built with `pnpm build:plugin`
- **`electron-builder.yml`:**
  - `appId: com.mirage.desktop`, `productName: Mirage`
  - `mac: { target: [{ target: dmg, arch: arm64 }], identity: null, hardenedRuntime: false, category: public.app-category.video }`
  - `extraResources: [{ from: build-resources, to: . }]`
  - `asarUnpack: ['node_modules/@anthropic-ai/**']`
  - `files: ['out/**']`
- **Packaged paths:**
  - `plugin = <resourcesPath>/plugin`
  - `mcpServer = <resourcesPath>/mcp/mirage-mcp.mjs`
  - `ffmpegDir = <resourcesPath>/bin`
  - `transcriber = <resourcesPath>/bin/wordedits-transcribe`
  - `nodeCommand = process.execPath`
  - `claudeExecutable`: resolve the SDK's native binary. Find its package name with `ls node_modules/@anthropic-ai/` after install and record it in the code comment. Use `requireResolve`, then replace `app.asar` with `app.asar.unpacked`.
  - In dev, `claudeExecutable` is `undefined`, so the SDK resolves it itself.
- **Licences.**
  - `LICENSE`: MIT, "Copyright (c) 2026 Mirage contributors".
  - `THIRD_PARTY_NOTICES.md` lists:
    - FFmpeg (GPL-3.0-or-later build shipped by `ffmpeg-static`, a separate executable; source: https://ffmpeg.org/download.html and the `ffmpeg-static` build scripts)
    - the chosen font (OFL-1.1)
    - Material Symbols (Apache-2.0)
    - the Claude Agent SDK (its LICENSE file's terms, quoted by name and link; read `node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md`)
    - Electron, React, Radix and zod (MIT)
    - @modelcontextprotocol/sdk (its licence)
- **README "Install"** covers:
  - download the dmg and drag it to Applications
  - first open: right-click → Open (the app isn't signed yet); or System Settings → Privacy & Security → "Open Anyway"
  - needs macOS 26 on Apple Silicon and a Claude API key ("you pay Anthropic per use; Mirage shows an estimate before each edit")
  - privacy: footage stays on the Mac, and frames, transcripts and audio go to Anthropic
  - overnight: lid open, plugged in

- [ ] **Step 1: Write the failing test** `paths.test.ts`. Packaged → the resource paths above; `claudeExecutable` contains `app.asar.unpacked` and never `app.asar/`. Dev → `packages/mcp/dist/mirage-mcp.mjs`, and `claudeExecutable === undefined`.

- [ ] **Step 2: Run it to verify it fails**

  Run: `pnpm vitest run packages/app/src/main/paths.test.ts`

  Expected: FAIL.

- [ ] **Step 3: Implement** `resolvePaths`, `prepare-resources.ts`, the builder config, LICENSE, the notices and the README.

- [ ] **Step 4: Build the dmg and check it by hand**

  Run: `pnpm --filter @wordedits/app dist`

  Expected: `packages/app/dist/Mirage-<version>-arm64.dmg`.
  - Mount it, copy the app to `/tmp`, and open it with `open`. Onboarding appears.
  - Connections shows `engine`, `ffmpeg` and `speech` as built-in. That proves the bundled MCP server, ffmpeg and transcriber resolve from inside the app.

- [ ] **Step 5: Commit**

  `git commit -m "build(app): unsigned arm64 dmg with bundled engine, ffmpeg and speech; MIT licence and notices"`

---

### Task 17: End-to-end with the fake brain

**Files:**
- Create: `packages/app/playwright.config.ts`, `packages/app/e2e/edit.spec.ts`, `packages/app/e2e/fixtures/brain-edit.json`
- Modify: `packages/app/src/main/index.ts` (test-only switches, active only when `!app.isPackaged`):
  - `MIRAGE_USER_DATA` → `app.setPath('userData', …)`
  - `MIRAGE_FAKE_KEYSTORE=1` → an in-memory keystore holding `sk-ant-test-0000000000000000000000`, with `validateApiKey` returning ok

**Interfaces:**
- Consumes everything above. `brain-edit.json` is a `ScriptStep[]`:
  1. `{ say: "Cataloguing your clips." }`
  2. `{ tool: "mcp__mirage__ingest", input: { folder: "<FOOTAGE>" } }`
  3. `{ tool: "Write", input: { file_path: "<PROJECT>/episodes/1/episode.json", content: <two-item episode using c001 and c002> } }`
  4. `{ tool: "mcp__mirage__check", input: {} }`
  5. `{ tool: "mcp__mirage__cut", input: {} }`
  6. `{ say: "Here's the rough cut." }`

  The `<FOOTAGE>` and `<PROJECT>` placeholders are replaced by the fake query from env `MIRAGE_FAKE_VARS` (JSON).

**Decisions:**
- **Setup.** The test copies `fixtures/tone-6s.mp4` and `fixtures/silent-6s.mp4` into a temp footage folder named `my clips ✨`, then launches the built app via `_electron.launch({ args: ['packages/app/out/main/index.js'], env: { MIRAGE_USER_DATA, MIRAGE_FAKE_KEYSTORE: '1', MIRAGE_FAKE_BRAIN, MIRAGE_FAKE_VARS } })`.
- **Steps**, all through the UI:
  1. Create the project "E2E".
  2. New video: choose the footage folder (a stubbed `pickFolder` via the `MIRAGE_FAKE_PICK` env) and answer "about".
  3. "Edit now".
  4. Expect the step list to reach "Rough cut rendered" within 120 s, and the Picture lane to show 2 items.
  5. Expect Versions to show "V1 · Rough cut".
  6. Open Review. The `<video>` reaches `readyState >= 2`.
  7. Click the picture, type "too dark", Add. Expect a note row "0:0x too dark · Not sent".
- **Second test**, with a brain script whose step 5 is a `cut` that the test cancels:
  - Press Pause → "Pause now". Expect the state "Paused". Press Stop → confirm.
  - Expect `episode.json` to equal the checkpoint after step 3 (read from disk), and `episodes/1` to contain no `.work-*`.

- [ ] **Step 1: Write the e2e tests** as above.

- [ ] **Step 2: Run them to verify they fail until the switches exist**

  Run: `pnpm --filter @wordedits/app build && pnpm --filter @wordedits/app test:e2e`

  Expected: FAIL (onboarding shows, or the fake brain isn't used).

- [ ] **Step 3: Implement the test-only switches** in `index.ts`, guarded by `!app.isPackaged`.

- [ ] **Step 4: Run the e2e and full suites**

  Run: `pnpm --filter @wordedits/app build && pnpm --filter @wordedits/app test:e2e && pnpm test && pnpm typecheck`

  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "test(app): end-to-end edit, notes, pause and stop with a scripted brain"`

---

## After the plan: the one real-Claude check (needs the user)

A real edit costs money on the user's own API key, so it isn't part of any task. Once Task 17 passes, ask the user to:
1. add their key in onboarding
2. edit a short real batch with "Edit now"

Record the run's cost from `cost-history.json` in the README's cost line (spec §11 risk 5).
