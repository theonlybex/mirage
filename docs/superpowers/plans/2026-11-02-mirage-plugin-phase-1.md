# Mirage Plugin Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin, installable from this repository as a marketplace. It gives the person's own Claude Code:
- Mirage's skills: edit, notes, voiceover, overnight, setup and status
- the build-story engine as MCP tools
- safety hooks for pause, stop, the file guard, auto-approve, step lines and checkpoints
- a localhost viewer that shows the edit live and takes notes

**Architecture:**
- The engine (`packages/core`) gains cancellation, versions and session files.
- `packages/mcp` wraps it as a stdio MCP server (`engine`).
- `packages/hooks` is one bundled script that Claude Code runs on SessionStart, PreToolUse, PostToolUse and Stop.
- `packages/viewer` is an HTTP server, started as a plugin monitor, plus a React page. It watches the project files and prints one-line messages to Claude.
- `pnpm build:plugin` bundles the three entry points into `plugin/dist/` and builds the page into `plugin/dist/viewer-ui/`. Both are committed.

**Tech Stack:**
- Node 22+, TypeScript 7, zod 4, vitest 5, esbuild
- @modelcontextprotocol/sdk 1.32
- React 19 + Vite 8 for the page, @testing-library/react 16 + jsdom 30
- @playwright/test (Chromium) for the end-to-end test

**Spec:** `docs/superpowers/specs/2026-11-02-mirage-plugin-design.md`, which is binding. Feature content comes from `docs/superpowers/specs/2026-11-02-mirage-product-design.md` §6 and §9. The engine is old spec §14; the design language is old spec §15. Claude Code plugin format: https://code.claude.com/docs/en/plugins-reference and https://code.claude.com/docs/en/hooks.

## Global Constraints

- **Code basics:** Node `>=22`. ESM only. `strict: true`. Every JSON file read or written is validated with zod.
- **Package boundaries:** `packages/core` never imports `@modelcontextprotocol/sdk`, `react`, or anything from `packages/hooks|viewer|mcp`.
- **The project folder** is the folder Claude Code is open in:
  - MCP server: env `MIRAGE_PROJECT` (set to `${CLAUDE_PROJECT_DIR}` in `.mcp.json`), falling back to `process.cwd()`
  - hooks: `cwd` from their JSON input
  - viewer: the `--project` argument
- **Speed and quiet:** every hook invocation where `cwd` has no `mirage.json` exits 0 within 150 ms, printing nothing. The plugin is enabled in all of the person's sessions.
- **Footage is never written.** No Mirage code writes inside a video's footage folders, and the hook denies Claude's writes there.
- **Tool names Claude sees:** `mcp__plugin_mirage_engine__<tool>`. Hook matchers and labels use that full name.
- **Running Node:** every plugin entry point runs through `plugin/scripts/node` (POSIX sh), which finds Node in this order:
  1. `PATH`
  2. `/opt/homebrew/bin/node`
  3. `/usr/local/bin/node`
  4. the newest `~/.nvm/versions/node/*/bin/node`
  5. `~/.volta/bin/node`

  It execs that Node with its arguments. With none found, it prints to stderr `Mirage needs Node.js 22 or later. Run /mirage:setup.` and exits 1.
- **Viewer safety (spec §5.8):**
  - It binds `127.0.0.1` only.
  - Every request needs `k=<session key>` (query) or the header `x-mirage-key`. A wrong or missing key gets 403.
  - A `Host` header that isn't `127.0.0.1:<port>` or `localhost:<port>` gets 403.
  - No CORS headers are sent.
- **Viewer → Claude messages** are exactly the lines given in Task 7. Text the person wrote is quoted inside them and is never shaped into instructions.
- **Branding:** copy says "Mirage". It may say it "runs in Claude Code". It never uses Claude, Claude Code or Anthropic as part of Mirage's name, and never imitates their look.
- **Design:** the viewer follows Material 3 per old spec §15. Dark theme is the default. **Invoke `ui-ux-pro-max:ui-ux-pro-max` before writing or editing any viewer UI code.**
- **Copy:** plain words, no editing jargon. Every error says what happened and what to do.
- **Licence:** AGPL-3.0-or-later.
  - Every `package.json` has `"license": "AGPL-3.0-or-later"`.
  - New source files start with `// SPDX-License-Identifier: AGPL-3.0-or-later`.
  - Commits are signed off (`git commit -s`) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Tests:** renderer tests carry `// @vitest-environment jsdom` on line 1. The root vitest `include` is `packages/*/src/**/*.test.{ts,tsx}` and `scripts/**/*.test.ts`.

## Review Focus

1. **Stop or "Pause now" during a render or a voice-over fit.**
   - Expected: the engine leaves no `.work-*` or `.partial-*` files and no lock. After the Stop hook, `episode.json` equals the session's last checkpoint, and the next edit runs cleanly.
   - Tests: Task 2 (`a cancelled render…`), Task 5 (`cut stops when the control file asks`), Task 6 (`stop denies tools and the Stop hook restores the last checkpoint`).
2. **Claude saves an `episode.json` that doesn't parse or fails the schema.**
   - Expected: the viewer keeps the last good timeline, marked "Being edited". A checkpoint still copies the bytes, and restore brings them back.
   - Tests: Task 3 (`snapshots and restores an episode.json that does not parse`), Task 7 (`keeps the last good view while the file is broken`).
3. **A hook runs in a session that isn't a Mirage project, or with input it doesn't expect** (unknown tool, missing `tool_input`, a Windows-style path).
   - Expected: it exits 0 quickly, prints nothing, and never blocks the person's normal work.
   - Test: Task 6 (`does nothing outside a Mirage project`, `ignores unknown tools and odd input`).
4. **Another web page or local program calls the viewer.**
   - Expected: requests without the session key, with a foreign `Host`, or with `../` in a media path get 403, and nothing is printed to Claude.
   - Test: Task 7 (`refuses requests without the key or with a foreign Host`, `media outside the roots is 403`).
5. **Paths with spaces, quotes, `#`, `%`, non-ASCII, and footage on an unplugged drive.**
   - Expected: the media URL round-trips. A missing file is 404, and the engine's missing-clip error reaches the step list in plain words.
   - Tests: Task 7 (media tests on `we proj 'q' #1 ✨`) and Task 5 (`check on a missing clip returns the engine error`).

---

## File structure

```
.claude-plugin/marketplace.json          the repository as a marketplace (one plugin: ./plugin)
plugin/
  .claude-plugin/plugin.json
  .mcp.json                              engine server
  hooks/hooks.json                       SessionStart · PreToolUse · PostToolUse · Stop
  monitors/monitors.json                 viewer (every session; idle outside Mirage projects)
  scripts/node                           finds Node and execs it
  native/transcribe.swift                copied from native/macos at build
  skills/{edit,notes,voiceover,overnight,setup,status}/SKILL.md
  dist/engine.mjs, dist/hook.mjs, dist/viewer.mjs, dist/viewer-ui/**   (generated, committed)
packages/core/src/mirage/
  encode.ts, json-file.ts                moved helpers (Task 1)
  cancel.ts, versions.ts, session-files.ts, video.ts, notes.ts, reports.ts, labels.ts (+tests)
packages/shared/src/schemas/  version.ts, session.ts, video.ts, notes.ts
packages/mcp/      @wordedits/mcp:     src/server.ts (+test), src/main.ts, src/preflight.ts (+test)
packages/hooks/    @wordedits/hooks:   src/hook.ts (+test), src/policy.ts (+test), src/main.ts
packages/viewer/   @wordedits/viewer:  src/server/{server,events,timeline-view,media,api}.ts (+tests), src/main.ts,
                                       src/ui/** (React page), index.html, vite.config.ts
scripts/build-plugin.ts (+test)        bundles dist and copies native source
LICENSE (AGPL-3.0 text), CONTRIBUTING.md (DCO), README.md
```

---

### Task 1: Remove the WordEdits leftovers, and the AGPL licence

**Files:**
- Delete:
  - `packages/core/src/render.ts`, `render.test.ts`
  - `packages/core/src/edl-compiler.test.ts`
  - `scripts/render.ts`
  - `packages/shared/src/schemas/{edl,edl.test,script,brief,project,project.test}.ts`
  - `packages/core/src/__snapshots__` files used only by the deleted tests
- Create:
  - `packages/core/src/mirage/encode.ts`: move `encodeArgs`, `bitrateFor`, `ffNum` and whatever `encodeArgs` needs from `edl-compiler.ts`, then delete `edl-compiler.ts`
  - `packages/core/src/mirage/json-file.ts`: move `readJsonFile`, `writeJsonFile`, `JsonFileError`, `describeZodError` from `project-store.ts`, then delete `project-store.ts` and its test (keep the moved functions' tests by moving them into `json-file.test.ts`)
  - `LICENSE`: the full AGPL-3.0 text from https://www.gnu.org/licenses/agpl-3.0.txt
  - `CONTRIBUTING.md`
- Modify:
  - every import of the moved symbols
  - `packages/core/src/index.ts`, `packages/shared/src/index.ts`
  - root `package.json`: remove the `render` script, add `"license": "AGPL-3.0-or-later"`, plus the same field in every package
  - `pnpm-workspace.yaml`: drop `ffmpeg-static` from `allowBuilds`/`onlyBuiltDependencies`, as nothing bundles it now
  - `packages/sidecars/src/locate.ts`: keep the ffmpeg-static fallback. It still helps in dev

**Interfaces:**
- Produces: `encodeArgs`, `bitrateFor` and `ffNum` from `packages/core/src/mirage/encode.ts`, and `readJsonFile`, `writeJsonFile`, `JsonFileError` and `describeZodError` from `packages/core/src/mirage/json-file.ts`. Exports from `@wordedits/core` are unchanged for these names.

**`CONTRIBUTING.md` says:**
- Mirage is AGPL-3.0-or-later.
- Contributions are accepted under the same licence, with a DCO sign-off (`git commit -s`, the Developer Certificate of Origin 1.1 at https://developercertificate.org).
- Run `pnpm test && pnpm typecheck` before a pull request.
- Don't copy code or text from projects whose licence doesn't allow it.

- [ ] **Step 1: Delete and move the files** as listed.
- [ ] **Step 2: Run the suite**

  Run: `pnpm test && pnpm typecheck`

  Expected: PASS. The count drops only by the deleted tests, and `grep -rn "edl-compiler\|project-store\|renderEdl" packages scripts` returns nothing.
- [ ] **Step 3: Commit**

  `git commit -s -m "chore: remove the unused WordEdits pipeline; AGPL-3.0 licence and DCO"`

---

### Task 2: Cancellation in the engine

**Files:**
- Modify: `packages/sidecars/src/errors.ts` (code `'CANCELLED'`), `run.ts`, `ffmpeg.ts`
- Modify: `packages/core/src/media-tools.ts`, `packages/core/src/mirage/errors.ts`
- Create: `packages/core/src/mirage/cancel.ts`
- Modify: `render-episode.ts`, `voiceover-files.ts`, `ingest.ts`
- Test: `packages/sidecars/src/run.test.ts`, `packages/core/src/mirage/render-episode.test.ts`, `voiceover-files.test.ts`

**Interfaces:**
- Produces:
  - `RunOptions.signal?: AbortSignal`. When it aborts, `runPath` throws `SidecarError(name, 'CANCELLED', `${name} was stopped`, 'Stopped on request.')`.
  - `FfmpegRunOptions.signal?: AbortSignal`, plus `signal?` on the opts of `MediaTools.extractWav` and `MediaTools.transcribe`.
  - `MirageError` code `'CANCELLED'`.
  - `asCancelled(e: unknown, signal?: AbortSignal): unknown`. It returns `new MirageError('CANCELLED', 'Stopped before it finished', 'Nothing was changed. Run it again to finish.')` when `signal?.aborted`, or when `e` is a `SidecarError` with code `CANCELLED`. Otherwise it returns `e`.
  - `signal?: AbortSignal` on the options of `renderEpisode`, `fitRecording` and `ingestClips`.

- [ ] **Step 1: Write the failing tests**
  - `run.test.ts` → `it('stops the child and throws CANCELLED when the signal aborts')`: `runPath('sleep','/bin/sleep',['10'],{signal})`, abort after 50 ms, rejects `{code:'CANCELLED'}` within 2 s.
  - `render-episode.test.ts` → `it('a cancelled render leaves no work files, keeps the previous output and releases the lock')`:
    - Stub `runFfmpeg` resolves chunk 0, then waits on `opts.signal` and rejects with a CANCELLED `SidecarError`.
    - Seed `rough.mp4` containing `old`, then abort after the first chunk.
    - Expect: rejects `{code:'CANCELLED'}`; no `.work-*`, `.partial-` or `.mirage.lock` in the folder; `rough.mp4` still reads `old`.
  - `voiceover-files.test.ts` → `it('a cancelled fit leaves episode.json unchanged')`. Abort during `transcribe`; the bytes are unchanged and there's no lock.
- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/sidecars/src/run.test.ts packages/core/src/mirage/render-episode.test.ts packages/core/src/mirage/voiceover-files.test.ts`

  Expected: the 3 new tests FAIL.
- [ ] **Step 3: Implement**
  - Pass `cancelSignal: opts.signal` to execa, and check `res.isCanceled` before the other exit checks.
  - Call `signal?.throwIfAborted()` between chunks, before the music pass, before the final pass, and before every save. Pass `signal` into every `runFfmpeg`, `extractWav` and `transcribe` call.
  - Wrap each locked body: `catch (e) { throw asCancelled(e, o.signal) }`. An aborted `fitRecording` never reaches `saveEpisode`.
- [ ] **Step 4: Run the full suite**

  Run: `pnpm test && pnpm typecheck`

  Expected: PASS.
- [ ] **Step 5: Commit**

  `git commit -s -m "feat(core): engine commands stop cleanly on an abort signal"`

---

### Task 3: Versions

**Files:**
- Create: `packages/shared/src/schemas/version.ts`
- Create: `packages/core/src/mirage/versions.ts`, `versions.test.ts`, `labels.ts`

**Interfaces:**
- Consumes: `episodeDir`, `lockEpisode`, `EpisodeMode`, `MirageError`.
- Produces:
  - `VersionKind = 'before' | 'checkpoint' | 'delivery'`.
  - `VersionMetaSchema` / `VersionMeta`:

```ts
{ version: 1, id: string, kind: VersionKind, label: string, createdAt: string /* ISO */, sessionId: string | null,
  delivery: number | null, render: { mode: 'rough'|'guide'|'final', file: 'video.mp4', captions: 'captions.srt' | null } | null,
  hasEpisode: boolean, hasSummary: boolean }
```

  - Versions live at `episodes/<n>/versions/<id>/`.
  - `snapshotVersion(project: string, n: number, o: { kind: VersionKind; label: string; sessionId?: string; render?: EpisodeMode; waitMs?: number }): Promise<VersionMeta>`
  - `listVersions(project: string, n: number): Promise<VersionMeta[]>`, oldest first.
  - `restoreVersion(project: string, n: number, id: string, o?: { waitMs?: number }): Promise<{ restored: VersionMeta; backup: VersionMeta }>`
  - `MAX_CHECKPOINTS = 50`.
  - `DELIVERY_LABEL: Record<EpisodeMode, string>`, in `labels.ts`:

```ts
{ rough: 'Rough cut', guide: 'Guide cut (record your voice-over over this)', final: 'Final video' }
```

**Decisions:**
- **Ids.** An id is `<UTC yyyyMMdd-HHmmss-SSS>-<kind>-<4 hex>`, so sorting by name is chronological.
- **Snapshots** copy the raw bytes of `episode.json` and `summary.md` when present. The episode file is never parsed.
- **Deliveries.**
  - `delivery` = the highest existing delivery number plus 1, starting at 1.
  - When `render` is given, `<mode>.mp4` is hard-linked as `video.mp4`, with `copyFile` on `EXDEV`/`EPERM`/`ENOTSUP`. For `final`, `final.srt` is linked as `captions.srt`.
  - A missing render throws `MirageError('BAD_INPUT', 'episodes/<n>/<mode>.mp4 does not exist', 'Render it first.')`.
- **Restoring.**
  - It first snapshots the current state as a `checkpoint` labelled `Before going back to “<label>”`.
  - Then it writes, or removes, `episode.json` and `summary.md` atomically.
  - It never touches renders, the catalog, notes, footage or other versions.
- **Locking.** Snapshot and restore hold `lockEpisode(project, n, 'versions')`. On `BUSY` they retry every 250 ms up to `waitMs` (default 30 000). Versions are written to `.tmp-<uuid>` and then renamed.
- **Pruning.** After each checkpoint, checkpoints beyond the newest 50 are deleted. `before` versions and deliveries are kept forever.
- **Listing** skips folders whose `meta.json` is missing or invalid.

- [ ] **Step 1: Write the failing tests** in `versions.test.ts`:
  - `it('snapshots episode.json and summary.md and lists versions oldest first')`
  - `it('numbers deliveries 1, 2, … and links the render as video.mp4')`. V1's `video.mp4` keeps its bytes after `rough.mp4` is replaced via rename.
  - `it('restores a version and keeps a backup of what was there')`
  - `it('restoring a version made before episode.json existed removes it')`
  - `it('snapshots and restores an episode.json that does not parse')`, with the bytes `{"version": 2, "items": [`
  - `it('waits for a busy episode and then snapshots')`
  - `it('keeps only the newest 50 checkpoints but every delivery and before-version')`
  - `it('ignores a version folder with a broken meta.json')`
- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/core/src/mirage/versions.test.ts`

  Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and typecheck**

  Run: `pnpm vitest run packages/core/src/mirage/versions.test.ts && pnpm typecheck`

  Expected: PASS.
- [ ] **Step 5: Commit**

  `git commit -s -m "feat(core): versions: before, checkpoints, deliveries and restore"`

---

### Task 4: Session files, the video file, notes, control and shared reports

**Files:**
- Create: `packages/shared/src/schemas/{session,video,notes}.ts`
- Create: `packages/core/src/mirage/{session-files,video,notes,reports}.ts` (+tests)
- Modify: `scripts/mirage.ts` (prints the report lines; output unchanged)
- Modify: `render-episode.ts` (export `RenderResult`)

**Interfaces:**
- **Schemas** (shared):
  - `VideoSchema = { version: 1, title: string (1..200), about: string, mention: string, hide: string, footage: string[] /* absolute folders */, createdAt: string }`, stored at `episodes/<n>/video.json`
  - `StepLineSchema = { at: string, id: string /* tool_use_id */, tool: string, label: string, status: 'running'|'done'|'failed'|'denied', detail?: string }` | `{ at: string, type: 'turn-end' }`
  - `ProgressSchema = { command: string, fraction: number /* 0..1 */, startedAt: string, updatedAt: string }`
  - `LogEntrySchema = { at: string, kind: 'guess'|'question'|'concern'|'warning'|'note-status', text: string, noteId?: string, status?: 'done'|'done-differently'|'could-not' }`
  - `ControlSchema = { version: 1, paused: boolean, pauseNow: boolean, stop: { at: string } | null, correction: string | null, updatedAt: string }`. The default is all off. Each video has its own, at `episodes/<n>/control.json`.
  - `SessionStateSchema = { video: number | null, overnight: { videos: number[]; startedAt: string } | null, awakePid: number | null }`, at `<project>/.mirage/sessions/<sessionId>.json`
  - `NoteSchema = { id: string /* n1, n2… */, versionId: string, t: number, text: string (1..2000), box: { x: number; y: number; w: number; h: number } | null /* each 0..1 */, still: string /* relative to the episode folder */, createdAt: string, round: number | null }`
  - `NotesFileSchema = { version: 1, notes: Note[] }`, at `episodes/<n>/notes.json`
- **Session files** (`session-files.ts`):
  - the folder: `sessionDir(project, n, sessionId)` = `episodes/<n>/sessions/<sessionId>/`
  - steps: `appendStep(dir, line)`, `readSteps(dir)` (skips bad lines)
  - progress: `writeProgress(dir, p)` (atomic), `readProgress(dir)`, `clearProgress(dir)`
  - log: `appendLog(dir, e)`, `readLog(dir)`
  - control: `readControl(project, n): Promise<Control>` (default when missing or broken), `writeControl(project, n, patch: Partial<Control>): Promise<Control>` (atomic, sets `updatedAt`)
  - session state: `readSessionState(project, sessionId)`, `writeSessionState(project, sessionId, patch)`
  - `takeCorrection(project, n): Promise<string | null>`: an atomic read-and-clear. Implement it with `rename(control.json → control.json.take-<uuid>)`, then read and rewrite, so two hooks never both take one correction.
- **Videos** (`video.ts`):
  - `newVideo(project, v: Omit<Video,'version'|'createdAt'>): Promise<number>`: n = the highest numbered folder in `episodes/` plus 1, then write `video.json`.
  - `readVideo(project, n): Promise<Video | null>`
- **Notes** (`notes.ts`):
  - `readNotes(project, n)`, `addNote(project, n, o: { versionId; videoPath; t; text; box; tools: MediaTools }): Promise<Note>`. The still is grabbed with `tools.runFfmpeg(['-ss', t.toFixed(3), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', out])` into `episodes/<n>/notes/<id>.jpg`.
  - `updateNote` and `deleteNote` work only on unsent notes, otherwise `MirageError('BAD_INPUT', 'This note was already sent.', 'Add a new note instead.')`.
  - `sendNotes(project, n): Promise<Note[]>` sets `round = max+1` on the unsent notes.
  - `noteStatuses(project, n): Promise<Record<string, { status; reason? }>>`. The newest `note-status` entry across every session log wins.
- **Reports** (`reports.ts`), the exact lines `scripts/mirage.ts` prints today, without the `\r NN%` progress:
  - `checkReport`, `ingestReport`, `musicReport`, `renderReport`, `slotsReport` and `voReport`
  - `updateSlots(project, n)`: the CLI's load + `carrySlots(computeSlots)` + save, moved here

- [ ] **Step 1: Write the failing tests** (`session-files.test.ts`, `video.test.ts`, `notes.test.ts`, `reports.test.ts`):
  - `takeCorrection` called twice concurrently: exactly one gets the text.
  - `readControl` on a broken file gives the defaults.
  - `newVideo` numbers 1 then 2.
  - `addNote` numbers notes `n1`, `n2` and writes the still path (stub ffmpeg).
  - `sendNotes` sets round 1, and editing a sent note throws.
  - `noteStatuses`: the newest across two sessions wins.
  - `reports`: `checkReport` prints `'  1  cold-open open         c001  12.50–18.00  ×1  0.00–5.50'` and a `total …` line; `voReport` contains `re-read the whole line with vo --add --slots n2`.
- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/core/src/mirage/session-files.test.ts packages/core/src/mirage/video.test.ts packages/core/src/mirage/notes.test.ts packages/core/src/mirage/reports.test.ts`

  Expected: FAIL.
- [ ] **Step 3: Implement.** The CLI prints the report lines; its behaviour is unchanged.
- [ ] **Step 4: Run the full suite**

  Run: `pnpm test && pnpm typecheck`

  Expected: PASS.
- [ ] **Step 5: Commit**

  `git commit -s -m "feat(core): session files, control, video and notes; reports shared with the CLI"`

---

### Task 5: The engine MCP server

**Files:**
- Create: `packages/mcp/{package.json,tsconfig.json}` (`@wordedits/mcp`; deps `@modelcontextprotocol/sdk@^1.32.2`, `zod`, `@wordedits/core`, `@wordedits/shared`)
- Create: `packages/mcp/src/server.ts`, `server.test.ts`, `preflight.ts`, `preflight.test.ts`, `main.ts`
- Modify: `packages/sidecars/src/transcribe.ts` (`transcriberPath()` returns `process.env.WORDEDITS_TRANSCRIBER` when set)

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `createEngineServer(ctx: { project: string; tools: MediaTools; sessionId?: () => string | null }): McpServer`, named `engine`.
  - `TOOL_NAMES: readonly string[]`.
  - `preflight(o: { project: string; videos: number[]; deps: { onBattery(): Promise<boolean>; freeBytes(path: string): Promise<number>; footageBytes(project: string, n: number): Promise<number>; which(cmd: string): Promise<boolean> } }): Promise<{ ok: boolean; problems: string[] }>`.

| Tool | Input (zod) | Does |
|---|---|---|
| `new_project` | `{ title: string }` | `initProject(project, title)`, but only when `mirage.json` is missing. Otherwise it returns `already a Mirage project: <title>`. |
| `new_video` | `{ title, about, mention?, hide?, footage: string[] }` | Checks every footage folder exists (else `✖ <path> does not exist`), calls `newVideo`, records `video` in the session state, and returns `video <n> created`. |
| `ingest` | `{ folder: string }` | `ingestClips`, reported with `ingestReport` |
| `music` | `{}` | `analyzeLibrary(<project>/music)` → `musicReport` |
| `check` | `{ video: number }` | `checkEpisode` → `checkReport` |
| `cut` / `guide` / `render` | `{ video: number }` | `renderEpisode` in mode rough / guide / final. `cut` checks first, as the CLI does. Result: `renderReport`. |
| `slots` | `{ video: number }` | `updateSlots` → `slotsReport` |
| `vo` | `{ video: number, recording: string, add?: boolean, slots?: string[] }` | `fitRecording` → `voReport` |
| `versions` | `{ video: number }` | One line per version: `V<k> · <label> · <date>`, or `<label> · <date>` for the rest, plus its id |
| `restore` | `{ video: number, id: string }` | `restoreVersion`. Returns `went back to “<label>” (what was there is kept as “<backup label>”)`. |
| `get_notes` | `{ video: number, round?: number }` | The notes of the newest round, or of `round`. One block per note: `Note <id> at <t.toFixed(1)> s: <text>`, then `(about the area x1%–x2% across, y1%–y2% down)` when there's a box, then `Still: <absolute path>` |
| `note_status` | `{ video: number, noteId: string, status: 'done'\|'done-differently'\|'could-not', reason?: string }` | Appends to the session log. A missing reason with a status other than `done` gives `isError` with `✖ say why: reason is needed unless the note is done` |
| `log` | `{ video: number, kind: 'guess'\|'question'\|'concern', text: string (1..2000) }` | Appends to the session log. Returns `noted`. |
| `overnight` | `{ videos: number[] }` | Runs `preflight`. On problems, `isError` with the problems one per line. Otherwise:<ul><li>writes `overnight` into the session state</li><li>starts `caffeinate -i -w <process.pid>` (detached, its pid stored as `awakePid`)</li><li>returns `ready: <k> videos, Mac kept awake until this session ends`</li></ul> |
| `status` | `{}` | One line each for:<ul><li>the project title</li><li>each video's stage (`new`/`rough`/`guide`/`final`)</li><li>its delivery count</li><li>whether the viewer is running (from `.mirage/viewer.json`)</li><li>tool checks: `ffmpeg`, `ffprobe`, the transcriber file, Node ≥22</li></ul> |

**Decisions:**
- **Session id.** `ctx.sessionId()` reads the newest `<project>/.mirage/sessions/*.json` that the SessionStart hook touched in the last 24 h (the hook writes it; Task 6). Session logs go to that session's folder, or `sessions/unknown/` when there's none.
- **Long commands** (`ingest`, `cut`, `guide`, `render`, `vo`):
  - They run with an `AbortController`. It aborts when the MCP request's `extra.signal` aborts, or when `readControl(project, video)` (polled every 250 ms) shows `pauseNow` or `stop`, with `updatedAt` after the command started.
  - They write `progress.json` at most every 250 ms, and clear it at the end.
  - Every `⚠` line goes into the session log as `warning`.
- **Errors** are `isError: true` with `✖ ${message}`, plus `\n  ${hint}` from `describeError`.
- **Cancelled commands** say exactly `✖ Stopped by the person before it finished. Nothing was changed.`
- **Preflight problems**, with exact copy:
  - battery: `Plug in your Mac. Overnight editing needs the power adapter.` On battery means `pmset -g batt` contains `'Battery Power'`.
  - space: `Free up space: Mirage needs about <X> GB on this disk for tonight's videos.`, when free space is below `max(10 GB, 2 × footage bytes)`
  - tools: `<tool> isn't installed. Run /mirage:setup.`, for each of `ffmpeg` and `ffprobe` that's missing
- **The entry point.** `main.ts` reads `MIRAGE_PROJECT` (or the cwd), builds `realMediaTools()`, and connects stdio. It never exits on a missing `mirage.json`, because `new_project` must work.

- [ ] **Step 1: Write the failing tests** (`server.test.ts`, with `InMemoryTransport.createLinkedPair()` and a `Client`, on temp projects):
  - `it('lists exactly the engine tools')`, against `TOOL_NAMES`
  - `it('new_project creates mirage.json once')`
  - `it('new_video refuses a missing footage folder')`
  - `it('check returns the timeline lines')`
  - `it('check on a missing clip returns the engine error')`: `isError`, with text starting `✖ `
  - `it('cut stops when the control file asks and says nothing was changed')`: stub ffmpeg waits on the signal; `writeControl(project, 1, {pauseNow:true})` after 100 ms
  - `it('get_notes prints the newest round with boxes and stills')`
  - `it('note_status needs a reason unless done')`
  - `it('a ⚠ warning from check goes into the session log')`

  And `preflight.test.ts`: the battery copy, the space copy, and `ok` with no problems.
- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/mcp`

  Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and typecheck**

  Run: `pnpm vitest run packages/mcp && pnpm typecheck`

  Expected: PASS.
- [ ] **Step 5: Commit**

  `git commit -s -m "feat(mcp): the engine as MCP tools for the plugin"`

---

### Task 6: The hooks

**Files:**
- Create: `packages/hooks/{package.json,tsconfig.json}` (`@wordedits/hooks`)
- Create: `packages/hooks/src/policy.ts` (+test), `hook.ts` (+test), `main.ts`

**Interfaces:**
- Consumes: Tasks 3–4 (`snapshotVersion`, `restoreVersion`, `listVersions`, `DELIVERY_LABEL`, session files, `readVideo`).
- Produces:
  - `runHook(event: 'session-start' | 'pre' | 'post' | 'stop', input: HookInput, deps: HookDeps): Promise<{ stdout: string; exitCode: 0 }>`
    - `HookInput = { session_id: string; cwd: string; hook_event_name: string; tool_name?: string; tool_input?: unknown; tool_use_id?: string; tool_response?: unknown; permission_mode?: string }`
    - `HookDeps = { now(): Date; sleep(ms: number): Promise<void>; pluginData: string; pluginRoot: string; swiftc(src: string, out: string): Promise<boolean> }`
  - `stepLabel(tool: string, input: unknown): { label: string; doneLabel: string }`
  - `videoOf(tool: string, input: unknown, project: string, session: SessionState): number | null`
  - `isChanging(tool: string, input: unknown, project: string): boolean`: any engine tool except `versions`/`status`/`get_notes`/`log`, or a Write/Edit/MultiEdit inside the project's `episodes/` or of `catalog.json`
  - `isStage(tool: string): boolean`: true only for engine `ingest`, `check`, `cut`, `slots`, `guide`, `vo`, `render`
  - `fileDecision(tool: string, input: unknown, project: string, footage: string[]): 'allow' | { deny: string } | null`
  - `main.ts` reads the event from `process.argv[2]` and the JSON from stdin, and writes `stdout`. Any exception → exit 0 with nothing printed, plus one line in `${CLAUDE_PLUGIN_DATA}/hook-errors.log`.

**Decisions:**
- **Every event first checks `existsSync(join(cwd,'mirage.json'))`.** When it's missing → exit 0 with no output, except `session-start`, which still does the speech-helper check.
- **`session-start`:**
  - If `${CLAUDE_PLUGIN_DATA}/bin/wordedits-transcribe` is missing or older than `plugin/native/transcribe.swift`, compile it with `swiftc -parse-as-library -O <src> -o <out>`. The command takes about 30 s, so start it detached and never wait for it.
  - Write `<project>/.mirage/sessions/<session_id>.json` (defaults).
  - Print `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<line>"}}`, where the line is:
    - in a project: `This folder is a Mirage project (“<title>”, <k> videos). Use the mirage:edit skill to make or change a video.`
    - otherwise: nothing
- **`pre`, in this order:**
  1. **The file guard:** `fileDecision`.
     - It applies to `Write`, `Edit`, `MultiEdit` and `NotebookEdit`, using `tool_input.file_path`, made absolute against `cwd`.
     - Inside any footage folder of any video in the project → deny `Footage folders are read-only in Mirage.`
  2. **Stop:** the video is `videoOf(…)`; with no video, steps 2–3 are skipped. If that video's `control.stop` is set → deny every tool with `The person stopped the edit. Stop now and say in one line what was finished.`
  3. **The pause gate:** while that video's `control.paused`, sleep 250 ms and re-read, up to 23 h 50 m (the hook timeout is 86 400 s).
     - When the pause ends with a correction (`takeCorrection(project, video)`) → deny with `The person paused the edit and said: “<text>”. Act on this before you carry on. The step you were about to run didn't run.`, and write the step line `denied`.
  4. **A `before` version:** if `isChanging` and this session has no `before` version for that video yet → `snapshotVersion(before, label 'Before this edit')`.
  5. **The running step:** write `running` with `stepLabel`.
  6. **Auto-approve:** for `mcp__plugin_mirage_engine__*`, and for Write/Edit/MultiEdit whose path is the project's `catalog.json`, or `episode.json`/`summary.md` inside `episodes/<n>/` → print `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}`. Otherwise print nothing.
  - A deny prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<reason>"}}`.
- **`post`:**
  - Write `done`, or `failed` when `tool_response` has `isError: true` or is an error string, with the first `✖` line as detail.
  - If `isStage` and done → `snapshotVersion(checkpoint, doneLabel, sessionId)`. Claude's own Write/Edit saves are not checkpoints, so Stop undoes the work in progress since the last stage.
  - If the tool is engine `cut`/`guide`/`render` and done → `snapshotVersion(delivery, DELIVERY_LABEL[mode], render: mode)`.
  - When the tool is engine `new_video`, record `video` in the session state.
- **`stop`** (Claude's turn ended): append `{type:'turn-end'}`.
  - For each video whose `control.stop` is set and that this session changed: restore the video's newest `checkpoint` or `before` version (whichever is newer; `restoreVersion` keeps the current state as a backup), then `writeControl(project, n, {stop:null, paused:false, pauseNow:false})`.
  - If the session state has `overnight` → write `report.md` with `buildReport` into each video's session folder (Task 10 defines `buildReport`; until then, this task writes the report from the steps and log with the section rules in Task 10).
- **`stepLabel`** table, in this exact order. Engine tools are `mcp__plugin_mirage_engine__<x>`:

| Tool | Label | Done label |
|---|---|---|
| `new_project` | Starting the project | Project started |
| `new_video` | Setting up the video | Video set up |
| `ingest` | Cataloguing your clips | Clips catalogued |
| `music` | Reading the music | Music read |
| `check` | Checking the timeline | Timeline checked |
| `cut` | Rendering the rough cut | Rough cut rendered |
| `slots` | Finding room for narration | Narration slots found |
| `guide` | Rendering the guide video | Guide video rendered |
| `vo` | Fitting your voice-over | Voice-over fitted |
| `render` | Rendering the final video | Final video rendered |
| `versions` / `status` | Checking | Checked |
| `restore` | Going back to an earlier version | Went back |
| `get_notes` | Reading your notes | Read your notes |
| `note_status` | Updating a note | Note updated |
| `log` | Making a note for you | Noted |
| `overnight` | Getting ready for overnight | Ready for overnight |
| `Read` of a file under `frames/` | Looking at clips | Looked at clips |
| other `Read` | Reading `<basename>` | Read `<basename>` |
| Write/Edit/MultiEdit of `episode.json` | Writing the timeline | Timeline written |
| …of `catalog.json` | Describing clips | Clips described |
| …of another file | Saving `<basename>` | Saved `<basename>` |
| `Glob`/`Grep` | Looking through the project | Looked through the project |
| `mcp__plugin_hyperframes…` / `Bash` | Working | Done |
| anything else | Working | Done |

- **`videoOf`:**
  - the `video` field of engine tool input
  - otherwise `episodes/(\d+)/` in a file path
  - otherwise the session state's `video`

  Steps without a video are not written.
- **Paths** are normalised with `path.resolve` and `realpath` of the nearest existing parent. On Windows-style input, use the `\` separator when `process.platform === 'win32'`.

- [ ] **Step 1: Write the failing tests** (`policy.test.ts`, `hook.test.ts`; spawn `runHook` directly on temp projects, with a fake `sleep` that advances a fake clock):
  - `does nothing outside a Mirage project`: empty stdout, and under 150 ms through `main.ts` via `node` (measured with `execFileSync` on the bundled file after Task 11. Mark it `it.skipIf(!existsSync(dist))`).
  - `ignores unknown tools and odd input`: missing `tool_input`, a non-object input.
  - `denies writing into a footage folder` (including through a symlink).
  - `auto-approves engine tools and timeline writes`.
  - `holds the next step while paused and denies it with the correction`.
  - `stop denies tools and the Stop hook restores the last checkpoint`. The flow: a `check` stage (checkpoint), then a later Write of `episode.json` (no checkpoint), then stop set, then `pre` denies, then `stop` restores the checkpoint's bytes, keeps the backup and clears control.
  - `post takes a checkpoint after an engine stage, none after a timeline write, and a delivery after cut`.
  - `stepLabel`: every table row.
- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/hooks`

  Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and typecheck**

  Run: `pnpm vitest run packages/hooks && pnpm typecheck`

  Expected: PASS.
- [ ] **Step 5: Commit**

  `git commit -s -m "feat(hooks): pause gate, stop, file guard, auto-approve, steps and checkpoints"`

---

### Task 7: The viewer server

**Files:**
- Create: `packages/viewer/{package.json,tsconfig.json}` (`@wordedits/viewer`)
- Create: `packages/viewer/src/server/server.ts`, `events.ts`, `timeline-view.ts`, `media.ts`, `api.ts` (+tests), `src/main.ts`

**Interfaces:**
- Consumes: Tasks 3–4, `layoutTimeline`, `timelineDuration`, `EpisodeSchema`, `CatalogSchema`, `transcribeAudio`, `extractWav`.
- Produces:
  - `startViewer(o: { project: string; uiDir: string; pluginData: string; ports?: [number, number]; key?: string; say: (line: string) => void; tools: MediaTools }): Promise<{ url: string; port: number; key: string; close(): Promise<void> }>`
  - `buildTimelineView(project: string, raw: { episode: string | null; catalog: string | null }, previous: TimelineView | null): TimelineView`:

```ts
TimelineView = { status: 'empty'|'ok'|'editing'; title: string; durationSec: number;
  items: { id; beat; clip; start; end; thumb: string | null; quiet: boolean; speed: number }[];
  overlays: { kind; text; tone; start; end }[]; music: { track; start; end }[];
  slots: { id; start; end; line; maxWords }[]; voice: { slot; start; end }[] }
```

  - `handleMedia(req: Request, roots: string[]): Promise<Response>`
  - `mediaPath(abs: string): string` = `/media/` + `encodeURIComponent(abs)`. The page appends `?k=`.
- **HTTP API.** All of it requires the key; JSON in and out.
  - `GET /` → `index.html` from `uiDir`. `GET /assets/*` → the static files.
  - `GET /api/videos` → `VideoSummary[]`, where `VideoSummary = { number; title; stage: 'new'|'rough'|'guide'|'final'; deliveries: number }`
  - `GET /api/events?video=<n>` → an SSE stream (below)
  - `POST /api/control` with `{ video: number, pause?: 'after-step'|'now', resume?: { correction?: string }, stop?: true }`
  - `GET /api/notes?video=n`, `POST /api/notes` (`{ video, versionId, t, text, box }`), `PATCH /api/notes/:id`, `DELETE /api/notes/:id`, `POST /api/notes/send` (`{ video }`)
  - `POST /api/voice-note` (body `audio/webm`) → `{ text }`
  - `POST /api/voiceover` with `{ video, path }`
  - `POST /api/overnight` with `{ videos }`
  - `POST /api/restore` with `{ video, id }`
  - `GET /media/<encoded abs path>`

**Decisions:**
- **Listening.** Try ports 4410–4430 on `127.0.0.1`; the first free one wins. The key is 32 random bytes in base64url. Write `<project>/.mirage/viewer.json` = `{ url, pid }`.
- **First line to Claude.** `say()` prints a line to stdout, which is Claude's notification. The first one is exactly:

  ```
  Mirage viewer: <url>  (open it for the person: in the Claude desktop app use the browser pane; otherwise run: open "<url>")
  ```

  where `<url>` = `http://127.0.0.1:<port>/?k=<key>`.
- **The event stream.** `/api/events` pushes `event: <type>` messages, each once at start and then on every change:
  - `timeline` (TimelineView)
  - `steps` (the last 200 step lines across this video's sessions, newest-last)
  - `progress` (Progress | null)
  - `versions` (VersionMeta[])
  - `notes` (notes merged with statuses)
  - `control` (Control)
  - `report` (the newest `report.md` text, or null)

  Changes come from `fs.watch` on `episodes/<n>/` (recursive, which covers `control.json`) and `catalog.json`, with a 100 ms debounce. A keep-alive comment goes out every 20 s.
- **Timeline view.**
  - `status`:
    - `empty`: no `episode.json`
    - `editing`: the episode doesn't parse or fails the schema. The view keeps `previous`'s lists, or empty ones.
    - `ok`: otherwise
  - `thumb` is the clip's catalog frame closest to the middle of `src`.
  - A voice line ends at `at + (src.out − src.in) − Σ cuts`.
- **Lines to Claude**, each sent by `say` exactly as written:
  - **send notes:** `Mirage viewer: the person sent <k> note(s) on video <n> (<version label>). Use the mirage:notes skill for video <n>.`
  - **voice-over:** `Mirage viewer: the person dropped a voice-over recording for video <n>: <path>. Use the mirage:voiceover skill.`
  - **overnight:** `Mirage viewer: the person wants videos <list> edited overnight. Use the mirage:overnight skill.`
  - **a correction while not paused** (Claude is idle): `Mirage viewer: the person says about video <n>: “<text>”`
- **Control.**
  - `pause:'after-step'` → `{paused:true}`
  - `pause:'now'` → `{paused:true, pauseNow:true}`
  - `resume` → `{paused:false, pauseNow:false, correction}`
  - `stop` → `{stop:{at:now}, paused:false}`
- **Media.**
  - It serves files only inside the project or any video's footage folders, after `realpath`. Anything else is 403; a missing file is 404.
  - `Range: bytes=a-b` gives 206, with `Content-Range`, `Accept-Ranges: bytes` and `Content-Length`.
  - Content types: `.mp4` `video/mp4`, `.mov` `video/quicktime`, `.jpg` `image/jpeg`, `.png` `image/png`, `.webm` `audio/webm`, `.m4a` `audio/mp4`, `.wav` `audio/wav`; anything else `application/octet-stream`.
- **Voice notes.** Save the audio as `episodes/<n>/notes/voice-<uuid>.webm`, then `extractWav`, then `transcribeAudio` (transcriber at `<pluginData>/bin/wordedits-transcribe`). Return the text. When the transcriber isn't built yet → 503 `{ error: 'Speech recognition is still being set up. Try again in a minute, or type the note.' }`.
- **Arguments.** `main.ts` takes `--project <dir> --ui <dir> --data <dir>`. It closes when stdin ends or on SIGTERM.
- **Outside a Mirage project**, `main.ts` prints nothing, checks for `<project>/mirage.json` every 2 s, and calls `startViewer` once it appears. The monitor runs in every session (Task 11).

- [ ] **Step 1: Write the failing tests.** They start a real server on a temp project, with `say` collecting lines:
  - `refuses requests without the key or with a foreign Host` (403s; nothing said)
  - `prints its address first`
  - `keeps the last good view while the file is broken`
  - `streams a timeline event after an atomic rewrite of episode.json` (within 1 s)
  - `media: 200, Range 206, missing 404`, on `we proj 'q' #1 ✨/clip.mp4`
  - `media outside the roots is 403` (`../`, and a symlink outside)
  - `sending notes says the exact line and marks the round`
  - `pause now and resume with a correction write control.json`
  - `a correction while not paused is said to Claude`
- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/viewer/src/server`

  Expected: FAIL.
- [ ] **Step 3: Implement**, using `node:http`. There's no framework.
- [ ] **Step 4: Run the tests and typecheck**

  Run: `pnpm vitest run packages/viewer/src/server && pnpm typecheck`

  Expected: PASS.
- [ ] **Step 5: Commit**

  `git commit -s -m "feat(viewer): local server: live events, notes, control, media and messages to Claude"`

---

### Task 8: The viewer page: shell, Material 3 and the Edit tab

Invoke `ui-ux-pro-max:ui-ux-pro-max` first.

**Files:**
- Create: `packages/viewer/index.html`, `vite.config.ts`
- Create: `src/ui/main.tsx`, `App.tsx`, `api.ts`
- Create: `src/ui/theme/tokens.css`, `motion.ts`
- Create: `src/ui/components/*`: Button, IconButton, Card, TextField, Chip, Sheet, Dialog (Radix), WavyProgress, FloatingToolbar, Icon (Material Symbols Rounded)
- Create: `src/ui/edit/{LiveTimeline,StepList,RunBar,PauseSheet,StopDialog,CorrectionBox,InterruptedBanner}.tsx` (+tests)
- Create: `src/ui/theme/tokens.test.ts`

**Interfaces:**
- Consumes: the Task 7 API.
- Produces:
  - `api.ts`: `useEvents(video: number)`, which returns `{ timeline, steps, progress, versions, notes, control, report }`, kept live from SSE. Also `post(path, body)` and `get(path)`. The key is read from `location.search` once and sent as `x-mirage-key`.
  - Routes, by hash: `#/` (video list) and `#/v/<n>/(edit|review|versions|report)`.

**Decisions:**
- **Tokens and fonts.**
  - `tokens.css` holds every colour role from old §15's table, dark (default) and light, as `--md-sys-color-*`, plus the type, shape and motion tokens from §15.
  - Fonts: `@fontsource-variable/google-sans-flex` if it's on npm, else `@fontsource-variable/roboto-flex`, bundled with its OFL licence. Material Symbols Rounded comes from `material-symbols` (Apache-2.0).
- **Layout.**
  - The video list is cards with title, stage chip and delivery count.
  - A video page has tabs Edit · Review · Versions · Report, with Report only when one exists.
  - Narrow window (under 840 px): the step list goes below the timeline.
- **LiveTimeline:**
  - **Lanes:**
    - **Picture:** thumbnails sized by duration, with a beat-coloured top edge; quiet items hatched.
    - **On screen:** pills.
    - **Music:** bars with the track name.
    - **Narration:** slot outlines with their line, filled where voice is placed.
  - **Ruler and scrolling:** a time ruler on top. It fits the width, and scrolls inside the lanes past 60 items.
  - **New items** get `data-state="entering"`: opacity plus an 8 px rise, `cubic-bezier(0.05,0.7,0.1,1)` 300 ms.
  - **Removed items** stay 200 ms with `data-state="exiting"`.
  - **Moves** animate `transform` only. Reduced motion uses opacity only.
  - **While the file is broken** (`editing`), a "Being edited…" chip shows.
- **StepList:**
  - newest last
  - running: a spinner with `aria-live="polite"`
  - done: a check
  - failed: an error icon and the detail
  - denied: a pause icon with "Your correction was passed on"
- **RunBar:** a state chip (Working / Pausing / Paused / Stopping / Idle) from `control` and steps. While working: Pause (tonal) and Stop (text button in error colour). While paused: Resume (filled) and the CorrectionBox.
- **PauseSheet:** when a step is running with progress, two options:
  - "Pause after this step", with `“<label>” finishes in about <m> min`, where remaining = elapsed × (1−f)/f once f ≥ 0.02, else "finishes soon"
  - "Pause now", with `Stops “<label>” now. It can run again later.`

  Otherwise it pauses straight away.
- **StopDialog:** "Stop the edit?" / "Mirage goes back to the last finished step, “<label>”. Nothing before it is lost." Buttons: "Keep editing" and "Stop".
- **CorrectionBox:** placeholder "Tell Mirage what to change…", and "Resume with this".
- **InterruptedBanner** shows when the newest step line is `running`, there's no `turn-end` after it, and there's been no progress update for 120 s. It reads "This edit stopped at “<label>”." with:
  - "Go back to the last finished step" → `POST /api/restore` with the newest checkpoint
  - "Keep things as they are"

- [ ] **Step 1: Write the failing tests:**
  - `tokens.test.ts` (all §15 colour roles in both themes)
  - `LiveTimeline.test.tsx` (entering/exiting marks; "Being edited")
  - `PauseSheet.test.tsx` (both options, `finishes in about 3 min` for 150 s left)
  - `StepList.test.tsx` (failed detail; denied text)
  - `InterruptedBanner.test.tsx` (shown and hidden by the rule)
- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/viewer/src/ui`

  Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and the build**

  Run: `pnpm vitest run packages/viewer/src/ui && pnpm --filter @wordedits/viewer build`

  Expected: PASS, and `packages/viewer/dist-ui/index.html` exists.
- [ ] **Step 5: Commit**

  `git commit -s -m "feat(viewer): Material 3 page with the live Edit tab"`

---

### Task 9: The viewer page: Review, Versions and Report

Invoke `ui-ux-pro-max:ui-ux-pro-max` first.

**Files:**
- Create: `src/ui/review/{Player,NoteComposer,NotesList,VoiceoverDrop}.tsx` (+tests)
- Create: `src/ui/versions/VersionsList.tsx` (+test)
- Create: `src/ui/report/Report.tsx`

**Interfaces:**
- Consumes: the Task 7 API and `useEvents`.

**Decisions:**
- **Player.**
  - It plays the selected version's `video.mp4`. The default is the newest delivery, and a version picker sits above it.
  - The frame has radius 16, with §15's floating toolbar: play, a scrubber with note markers, and a tabular timecode.
- **Notes.**
  - **Clicking the picture** pauses it and opens the NoteComposer at `currentTime`. **Dragging** draws a box first, kept in 0..1 values.
  - The composer has a still preview, a text field, a hold-to-talk mic (MediaRecorder `audio/webm` → `/api/voice-note` → text into the field) and Add.
  - **NotesList:** time, text, thumbnail and a status chip: "Not sent", "Sent", "Done", "Done differently: <reason>" or "Couldn't: <reason>". Clicking a note seeks to it.
  - "Send notes (k)" → `/api/notes/send`. It's disabled when there are no unsent notes. After sending, the hint shows: "Sent to Claude. If nothing happens, type `/mirage:notes` in Claude Code."
- **VoiceoverDrop** shows on guide versions: "Play this guide and read the lines out loud as they come up. Record yourself with QuickTime or your phone, then drop the recording here." Dropping a file (or "Choose file") → `/api/voiceover` with the file's path.
- **VersionsList:**
  - deliveries as `V<k> · <label> · <date>`, plus "Before this edit" entries
  - "Show steps" reveals checkpoints
  - actions: Play (Review) and "Go back to this version", with the confirm "Go back to “<label>”? What's there now is kept as a version too." → `/api/restore`
- **Report** renders `report.md` with a minimal Markdown renderer (headings, lists, paragraphs) and an "Open the video" button.

**Dropped file paths.** A browser can't give a dropped file's path. A file `input`/drop gives only bytes. So `/api/voiceover` also accepts the bytes as `multipart/form-data`: the server saves them under `episodes/<n>/voiceover/<original name>` and uses that path. Implement the bytes form, and keep the `{ path }` JSON form for Claude-side use.

- [ ] **Step 1: Write the failing tests:**
  - `Player.test.tsx`: a click at 4.2 s opens the composer showing `0:04`; a drag records a box between 0 and 1.
  - `NotesList.test.tsx`: the status chips.
  - `VersionsList.test.tsx`: checkpoints hidden until "Show steps"; restore asks for confirmation first.
- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/viewer/src/ui/review packages/viewer/src/ui/versions`

  Expected: FAIL.
- [ ] **Step 3: Implement**, including the multipart voice-over upload on the server: extend `api.ts` from Task 7 and add `it('voiceover upload saves the file and says the line')` to `api.test.ts`.
- [ ] **Step 4: Run the tests**

  Run: `pnpm vitest run packages/viewer`

  Expected: PASS.
- [ ] **Step 5: Commit**

  `git commit -s -m "feat(viewer): review with click-on-video notes, versions, voice-over drop and the morning report"`

---

### Task 10: The skills

**Files:**
- Create: `plugin/skills/edit/SKILL.md`, `notes/SKILL.md`, `voiceover/SKILL.md`, `overnight/SKILL.md`, `setup/SKILL.md`, `status/SKILL.md`
- Create: `packages/core/src/mirage/report.ts` (+test)
- Delete: `.claude/skills/mirage-episode/` and `setup/connect-tools.md`. Their content moves into `edit` and `setup`.
- Modify: `packages/hooks/src/hook.ts` (use `buildReport`)

**Interfaces:**
- Produces: `buildReport(o: { videoTitle: string; steps: StepLine[]; log: LogEntry[]; delivered: VersionMeta | null; stoppedAt?: string }): string`, in Markdown.

**Decisions:**
- **`edit`** (frontmatter `name: edit`). Description: `Make or change a Mirage video: catalogue the clips, write the timeline, render the rough cut, write narration lines and the guide. Use when the person wants to make a video, drops footage, or asks for changes to a Mirage video.` The body is today's `mirage-episode` skill, rewritten for tools:
  - **Commands become tools:** every `pnpm mirage <cmd> <project> <n>` becomes `mcp__plugin_mirage_engine__<cmd>` with `{ video: n }`, and `init` becomes `new_project`.
  - **New first steps:**
    1. If there's no `mirage.json`, ask for the series title and call `new_project`.
    2. Ask the 3 questions (about / mention / hide) and the footage folders, then call `new_video`.
    3. Use the viewer address the monitor announced. If none has arrived yet, run `status`, which reads `.mirage/viewer.json`.
    4. Open the viewer's address: the desktop browser pane, or `open "<url>"` through Bash in the terminal.
  - **Privacy line:** once per project, say that frames, transcripts and audio go to Anthropic, and not to record secrets.
  - **Where live mode stops:** after `cut`. Say "Here's the rough cut in Mirage's viewer. Click on the video to leave notes, then press Send notes."
  - **Unchanged:** every ⚠ and ✖ rule in today's skill stays word for word, except command spellings.
  - **New closing rule:** "Never write inside footage folders. Never invent footage, numbers or events."
- **`notes`:** get the notes with `get_notes`, act on each, re-render with the same command as the version noted, and `note_status` each note.
- **`voiceover`:** `vo` with the path, then `render`. Report missing, partial and too-long lines plainly, using today's step-5 rules.
- **`overnight`:**
  1. Call `overnight` with the videos. On problems, relay them and stop.
  2. Ask the person to switch Claude Code to auto mode (Shift+Tab until "auto") and leave the lid open, plugged in. The screen may be off.
  3. For each video: run `edit` to the guide cut, following the never-ask rules:
     - make the best guess and call `log` with kind `guess`
     - things only the person can answer → `log` with kind `question`
     - doubts → `log` with kind `concern`
  4. A failed step is retried once, then move to the next video.
  5. End by saying "Done for tonight. Mirage's viewer has the morning report."
- **`setup`:** the content of `setup/connect-tools.md`, plus a first step that runs `status` and reads its tool lines.
  - **Required in Phase 1:** Node 22+, ffmpeg/ffprobe, and the Xcode Command Line Tools (`xcode-select -p` succeeds; install with `xcode-select --install`).
  - **Marked "later"**, and installed only if the person asks: Parakeet, HyperFrames, Chrome, Tella and Epidemic Sound. Each says which phase uses it.
  - The final table has a ✓ / – (later or optional) / ✗ row for each.
- **`status`:** run engine `status` and explain it in plain words.
- **`buildReport` sections**, in order (empty ones left out):
  - `# <title>: <"V<k> ready" | "Stopped at: <label>">`
  - `## What I did` (done labels, de-duplicated in order)
  - `## Things I wasn't sure about` (concern)
  - `## Choices I made for you` (guess)
  - `## Questions for you` (question)
  - `## Things to check` (warning, de-duplicated)
  - `## Next`, for a guide delivery: `Record the voice-over: open the video in Mirage's viewer, go to Review, and follow the steps there.`

- [ ] **Step 1: Write the failing tests:**
  - `report.test.ts` (section order, de-duplication, empty sections absent, the "Next" line for a guide)
  - `scripts/skills.test.ts`, which checks:
    - each skill's frontmatter parses, with `name` and `description`
    - `edit` names every engine tool it uses, and each one is in `TOOL_NAMES`
    - no skill mentions `pnpm mirage`
    - `edit` still contains every `⚠` rule line from the old skill, compared against a fixture copy taken before deletion: `scripts/fixtures/old-skill-warnings.txt`, written in this task from the old file's lines that start with `` - ` ``, `` `⚠ ``, or contain `⚠`
- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm vitest run packages/core/src/mirage/report.test.ts scripts/skills.test.ts`

  Expected: FAIL.
- [ ] **Step 3: Write the skills and `buildReport`.**
- [ ] **Step 4: Run the tests**

  Run: `pnpm vitest run packages/core/src/mirage/report.test.ts scripts/skills.test.ts`

  Expected: PASS.
- [ ] **Step 5: Commit**

  `git commit -s -m "feat(plugin): edit, notes, voiceover, overnight, setup and status skills"`

---

### Task 11: Assemble the plugin and the marketplace

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`, `plugin/.mcp.json`, `plugin/hooks/hooks.json`, `plugin/monitors/monitors.json`, `plugin/scripts/node`
- Create: `.claude-plugin/marketplace.json`
- Create: `scripts/build-plugin.ts`, `scripts/build-plugin.test.ts`
- Modify: root `package.json` (`build:plugin`), `README.md` (install section)

**Decisions:**
- **`plugin.json`:**

```json
{ "name": "mirage", "displayName": "Mirage", "version": "0.1.0",
  "description": "Edit build-story videos: drop footage, watch the edit live, leave notes on the video.",
  "author": { "name": "Mirage contributors" }, "license": "AGPL-3.0-or-later",
  "keywords": ["video", "editing", "youtube"] }
```

- **`.mcp.json`:**

```json
{ "mcpServers": { "engine": { "command": "${CLAUDE_PLUGIN_ROOT}/scripts/node",
  "args": ["${CLAUDE_PLUGIN_ROOT}/dist/engine.mjs"],
  "env": { "MIRAGE_PROJECT": "${CLAUDE_PROJECT_DIR}", "WORDEDITS_TRANSCRIBER": "${CLAUDE_PLUGIN_DATA}/bin/wordedits-transcribe" } } } }
```

- **`hooks/hooks.json`** (exec form):

```json
{ "hooks": {
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs", "session-start"] }] }],
  "PreToolUse":   [{ "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs", "pre"], "timeout": 86400 }] }],
  "PostToolUse":  [{ "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs", "post"] }] }],
  "Stop":         [{ "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs", "stop"], "timeout": 120 }] }] } }
```

- **`monitors/monitors.json`:**

```json
[{ "name": "viewer", "description": "Mirage's live viewer",
   "command": "\"${CLAUDE_PLUGIN_ROOT}/scripts/node\" \"${CLAUDE_PLUGIN_ROOT}/dist/viewer.mjs\" --project \"${CLAUDE_PROJECT_DIR}\" --ui \"${CLAUDE_PLUGIN_ROOT}/dist/viewer-ui\" --data \"${CLAUDE_PLUGIN_DATA}\"" }]
```

- **`.claude-plugin/marketplace.json`:**

```json
{ "name": "mirage", "owner": { "name": "Mirage contributors" },
  "plugins": [{ "name": "mirage", "source": "./plugin", "description": "Edit build-story videos in Claude Code" }] }
```

  Check the exact marketplace schema at https://code.claude.com/docs/en/plugins/marketplace-reference before writing it, and adjust the field names to it.
- **`build-plugin.ts`:**
  - esbuild bundles `packages/mcp/src/main.ts` → `plugin/dist/engine.mjs`, `packages/hooks/src/main.ts` → `hook.mjs`, and `packages/viewer/src/main.ts` → `viewer.mjs`, each with `platform: 'node'`, `format: 'esm'`, `target: 'node22'`, `external: ['ffmpeg-static','ffprobe-static']`, and a `createRequire` banner.
  - It builds the page with Vite into `plugin/dist/viewer-ui/`.
  - It copies `native/macos/transcribe.swift` → `plugin/native/`.
- **README "Install"** covers:
  1. Install Claude Code (https://claude.com/download) and sign in.
  2. `/plugin marketplace add <this repository>`, then `/plugin install mirage@mirage`.
  3. Start a new session and run `/mirage:setup`.
  4. Open Claude Code in a new folder and say "make a video".

  Also:
  - Mac only for now; Windows later
  - a privacy line
  - overnight: plugged in, lid open, auto mode
  - licence: AGPL-3.0, contributions with a DCO sign-off

- [ ] **Step 1: Write the failing test** `build-plugin.test.ts`. Run `buildPlugin()` into a temp copy, then check:
  - the three `.mjs` files and `viewer-ui/index.html` exist
  - each manifest parses
  - every `${CLAUDE_PLUGIN_ROOT}/…` path named in the manifests exists inside the plugin
  - `plugin-dist-fresh`: rebuilding into a temp dir gives byte-identical `dist/*.mjs` to the committed `plugin/dist/`
- [ ] **Step 2: Run it to verify it fails**

  Run: `pnpm vitest run scripts/build-plugin.test.ts`

  Expected: FAIL.
- [ ] **Step 3: Implement**, run `pnpm build:plugin`, and `chmod +x plugin/scripts/node`.
- [ ] **Step 4: Validate**

  Run: `pnpm vitest run scripts/build-plugin.test.ts && claude plugin validate ./plugin`

  Expected: PASS, and `Validation passed`. Fix any warning `--strict` would fail on.
- [ ] **Step 5: Commit**, including the generated `plugin/dist`.

  `git commit -s -m "build(plugin): mirage plugin, marketplace and bundled engine, hooks and viewer"`

---

### Task 12: End to end, then the real Claude Code check

**Files:**
- Create: `packages/viewer/e2e/edit.spec.ts`, `packages/viewer/e2e/driver.ts`, `packages/viewer/playwright.config.ts`
- Create: `docs/superpowers/research/2026-11-02-plugin-checks.md` (results of the real-Claude-Code checks)

**Decisions:**
- **`driver.ts`** acts as Claude Code would, without a model:
  - It runs `plugin/scripts/node plugin/dist/hook.mjs <event>` with JSON on stdin for every event.
  - It talks to `plugin/dist/engine.mjs` through an MCP stdio client.
  - It writes files itself for Write/Edit.
  - It starts `viewer.mjs` the way the monitor would, and reads its stdout lines.
- **The script** runs on a temp project with `fixtures/tone-6s.mp4` and `fixtures/silent-6s.mp4` in a folder named `my clips ✨`:
  1. SessionStart
  2. `new_project`
  3. `new_video`
  4. `ingest`
  5. Write `episode.json` (two items)
  6. `check`
  7. `cut`
- **Test 1** (Playwright Chromium on the viewer URL):
  - The Picture lane reaches 2 items.
  - The step list reaches "Rough cut rendered".
  - Versions shows "V1 · Rough cut".
  - Review's `<video>` reaches `readyState >= 2`.
  - Add a note "too dark" at the clicked time.
  - "Send notes (1)" → the viewer's stdout contains the exact send-notes line.
- **Test 2:**
  - The driver starts a slow `cut` (an episode with one 60 s item).
  - The page presses Pause → "Pause now", and the driver's next PreToolUse call is held.
  - The page types the correction "keep the intro" and presses "Resume with this". That call returns a deny whose reason contains `“keep the intro”`.
  - The page presses Stop, and the driver sends `stop`. `episode.json` equals the last checkpoint, and `episodes/1` has no `.work-*`.
- **The real Claude Code checks.** These spend a little of the person's own plan usage, so ask them before running. Record the results in the research file:
  1. `claude --plugin-dir ./plugin` in a temp folder: `/mirage:status` runs, and `/mcp` shows `plugin:mirage:engine` connected.
  2. A PreToolUse hold of 11 minutes (set `paused`, wait, resume) lets the step run afterwards.
  3. With `/mirage:edit` invoked, the viewer line arrives. Then, with Claude idle, POST a correction: does a new turn start in the terminal? In the desktop app?
  4. In the desktop app, the browser pane opens the `127.0.0.1` URL.
  5. With the desktop app launched from the Dock, `scripts/node` finds Node.

  A failed check switches to its fallback from spec §7, and the fix lands in this task.

- [ ] **Step 1: Write the e2e tests and the driver.**
- [ ] **Step 2: Run them to verify they fail before `pnpm build:plugin`**

  Run: `pnpm --filter @wordedits/viewer test:e2e`

  Expected: FAIL on a missing dist, or PASS if it's already built. In that case, break one assertion to see it fail, then restore it.
- [ ] **Step 3: Make them pass.**
- [ ] **Step 4: Run everything**

  Run: `pnpm build:plugin && pnpm test && pnpm typecheck && pnpm --filter @wordedits/viewer test:e2e && claude plugin validate ./plugin`

  Expected: all PASS.
- [ ] **Step 5: The real Claude Code checks** above, after the person says yes. Write down the results.
- [ ] **Step 6: Commit**

  `git commit -s -m "test(plugin): end-to-end edit, notes, pause, correction and stop; real Claude Code checks"`
