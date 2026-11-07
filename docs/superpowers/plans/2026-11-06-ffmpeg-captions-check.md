# FFmpeg That Can Draw Captions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirage only counts FFmpeg as installed when it can draw captions and text (it has libass's `ass` filter), finds Homebrew's complete `ffmpeg-full` build, and setup installs that build on macOS — so a new user can't pass setup and then fail every render.

**Why:** every render's last pass draws `overlays.ass` with FFmpeg's `ass` filter. Homebrew's plain `ffmpeg` (9.0.2 here) is built without libass (no `ass`, `subtitles` or `drawtext` filter), and the setup skill tells macOS users to `brew install ffmpeg`. Homebrew's `ffmpeg-full` (keg-only, `/opt/homebrew/opt/ffmpeg-full/bin`) has libass. The person's own project works because it sets `WORDEDITS_FFMPEG_DIR` to an FFmpeg 6.0 with libass.

**Architecture:** `locate` in sidecars gains the `ffmpeg-full` keg folders and a captions check (`ffmpeg -hide_banner -filters` lists `ass`), preferring a found FFmpeg that can draw captions. The engine's `status`, preflight and render report a captions-less FFmpeg clearly, and record what they found in the plugin's `setup.json`; the SessionStart notice reads that record (it can't run FFmpeg itself) and asks for "FFmpeg with caption support". The setup skill installs `ffmpeg-full` on macOS.

**Tech Stack:** TypeScript (Node 22), vitest, execa (sidecars' `run`), pnpm monorepo.

**Spec:** `docs/superpowers/specs/2026-11-06-editing-tools-and-vlog-design.md`, part 8 (asking before setup), extended by this finding.

## Global Constraints
- `WORDEDITS_FFMPEG_DIR`, when set, is the only place looked (as today) — the person's project keeps its FFmpeg 6.0.
- Search order otherwise: PATH, then `/opt/homebrew/opt/ffmpeg-full/bin`, `/usr/local/opt/ffmpeg-full/bin`, `/home/linuxbrew/.linuxbrew/opt/ffmpeg-full/bin` (macOS/Linux only). Among the FFmpegs found, the first that can draw captions wins; if none can, the first found is used and reported as lacking captions.
- `ffprobe` comes from the same folder as the chosen `ffmpeg` when that folder has one; otherwise today's lookup.
- The captions check runs `ffmpeg -hide_banner -filters` once per FFmpeg file per engine process (cached by path and mtime), with a 10 s timeout; a failed run counts as "can't draw captions".
- The SessionStart hook still never spawns a process; it reads only `setup.json`.
- `setup.json` gains `ffmpeg?: { path: string; mtimeMs: number; captions: boolean }` (zod-free reader in `@wordedits/shared/setup-state`, like the other fields; wrong types dropped).
- Exact texts:
  - status line: `ffmpeg: can't draw captions — <path> was built without libass. <hint>`
  - preflight problem and render error message: `FFmpeg can't draw captions or text: <path> was built without libass.` with hint `<hint>`
  - hint: macOS `Install Homebrew's complete build: brew install ffmpeg-full (Mirage finds it by itself).`; Windows `Install the full build: winget install --id Gyan.FFmpeg -e.`; Linux `Install an FFmpeg built with libass (your distribution's ffmpeg package usually is), or set WORDEDITS_FFMPEG_DIR to one.`
  - notice list item: `FFmpeg with caption support`
  - setup skill reason line (added under the FFmpeg one): `- **FFmpeg with caption support** — the plain Homebrew FFmpeg can't draw captions or text on the video, so Mirage needs Homebrew's complete build, ffmpeg-full; it's a bigger install because it brings the caption and font libraries.`
- Cross-platform; commits with `git commit -s` and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; nothing pushed.

## Review Focus
- **FFmpeg on PATH without libass and `ffmpeg-full` installed:** `ffmpeg-full` is chosen, `status` says ok. Pinned in Task 1.
- **`setup.json` records an FFmpeg that has since been replaced** (different mtime or path): the hook ignores the stale record. Pinned in Task 2.
- **FFmpeg that hangs or crashes on `-filters`:** counted as no captions within 10 s, no hang. Pinned in Task 1.
- **`WORDEDITS_FFMPEG_DIR` set to an FFmpeg without libass:** reported, never silently swapped for another. Pinned in Task 1.

---

### Task 1: The engine finds and checks an FFmpeg that can draw captions

**Files:**
- Modify: `packages/sidecars/src/locate.ts` (+ export from `index.ts`), `packages/mcp/src/server.ts` (status line), `packages/mcp/src/preflight.ts`, `packages/core/src/mirage/render-episode.ts` (refuse before any work), `packages/shared/src/setup-state.ts` (the `ffmpeg` field)
- Test: `packages/sidecars/src/locate.test.ts`, `packages/mcp/src/server.test.ts`, `packages/mcp/src/preflight.test.ts`, `packages/core/src/mirage/render-episode.test.ts`

**Interfaces:**
- Produces: `ffmpegCaptions(): Promise<{ ok: true; path: string } | { ok: false; path: string; hint: string }>`; `captionsHint(platform?: NodeJS.Platform): string`; `locate('ffmpeg'|'ffprobe')` keeps its signature with the new order; `SetupState.ffmpeg`.
- The engine writes `setup.json`'s `ffmpeg` record (to `MIRAGE_PLUGIN_DATA`, when set) each time it runs the check.

- [ ] **Step 1: Write the failing tests** — fake `ffmpeg` scripts (sh, skip on win32) that print a filter list with or without ` ass ` / that sleep 20 s / that exit 1: PATH-without-libass + keg-with-libass → the keg one; only PATH-without-libass → `{ ok: false, path, hint }`; override dir without libass → reported, keg ignored; hanging fake → `ok: false` in ≤ 11 s; result cached (the fake counts its runs in a file); ffprobe taken from the chosen folder. `status` prints the exact line; preflight lists the exact problem; `renderEpisode` throws the exact `MirageError` before creating its work folder; the engine writes `{ path, mtimeMs, captions }`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `pnpm build:plugin && pnpm test && pnpm typecheck`.**
- [ ] **Step 5: Commit** — `fix(ffmpeg): only an FFmpeg that can draw captions counts as installed`.

### Task 2: The setup question and the setup skill know about it

**Files:**
- Modify: `packages/hooks/src/setup-notice.ts` (keg folders in the lookup; the `setup.json` record), `plugin/skills/setup/SKILL.md` (step 3, "Asking first", step 0's status line), `plugin/skills/status/SKILL.md` if it lists status lines
- Test: `packages/hooks/src/setup-notice.test.ts`, `scripts/skills.test.ts`

**Interfaces:**
- Consumes: `SetupState.ffmpeg` (Task 1).
- Produces: `MissingTool` gains `'ffmpeg-captions'`, listed as `FFmpeg with caption support` (instead of `FFmpeg` when ffmpeg is present but recorded as captions-less).

- [ ] **Step 1: Write the failing tests:** found `ffmpeg` (same path and mtime as the record, `captions: false`) → `'ffmpeg-captions'` and the notice names `FFmpeg with caption support`; record with another mtime or path → ignored; `captions: true` → nothing; the keg folder is searched after PATH. Skills test: step 3 says `brew install ffmpeg-full` for macOS and no longer `brew install ffmpeg` alone; the reason line above is in "Asking first".
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement**, and update the setup skill: step 3 macOS install becomes `brew install ffmpeg-full` (keg-only; Mirage finds it in `/opt/homebrew/opt/ffmpeg-full/bin` by itself, nothing to put on PATH); the check becomes `ffmpeg -hide_banner -filters | grep -w ass` (or `status`'s ffmpeg line); step 0 lists the new status line and sends it to step 3; "Asking first" gets the reason line. Keep old rule lines word for word.
- [ ] **Step 4: `pnpm build:plugin && pnpm test && pnpm typecheck`.**
- [ ] **Step 5: Real check:** with the built engine over stdio and `PATH=/opt/homebrew/bin:/usr/bin:/bin` (no `WORDEDITS_FFMPEG_DIR`), `status` shows the captions-less line for Homebrew's 9.0.2 and writes the record; then the bundled hook's session-start (same PATH, the same data folder, outside a project after deleting `askedVersion`) names `FFmpeg with caption support`. Don't install anything.
- [ ] **Step 6: Commit** — `fix(setup): ask for an FFmpeg that can draw captions`.
