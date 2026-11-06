# Asking a New User Before Setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When someone has just installed Mirage and tools it needs are missing, Claude asks at the start of the session whether to install them, explaining each in one plain sentence; the question doesn't nag.

**Architecture:** The SessionStart hook (`packages/hooks/src/main.ts`) gains a fast, core-free check (`setup-notice.ts`) that runs in every session, Mirage project or not, and adds one paragraph of additional context when something required is missing. A small state file in the plugin's data folder (`setup.json`) remembers which version already asked and any "not now"; a new engine tool `setup_later` writes the "not now". When Node itself is missing, the POSIX launcher prints the notice instead.

**Tech Stack:** TypeScript (Node 22, ESM), vitest, POSIX sh, pnpm monorepo, esbuild bundle (`pnpm build:plugin`).

**Spec:** `docs/superpowers/specs/2026-11-06-editing-tools-and-vlog-design.md`, part 8.

## Global Constraints
- Cross-platform: no Mac-only tools. (The POSIX launcher already doesn't run on Windows; out of scope, listed as a follow-up.)
- The hook outside a Mirage project must stay fast: no `@wordedits/core` import, no process spawn; only `existsSync`/`statSync`/`readFileSync` calls. The existing `<150 ms` bundled-hook test stays green and gets a session-start sibling.
- Every hook event still always exits 0 and prints nothing on failure (errors go to `hook-errors.log`).
- When it asks: the first session after the plugin is installed or updated to a new version, in any folder; after that only in sessions inside a Mirage project, and only while something required is missing; never for 7 days after "not now".
- Required tools: Node 22+, FFmpeg (`ffmpeg` and `ffprobe`), whisper.cpp (`whisper-cli`) and its speech model. Kokoro is optional and never triggers the question.
- The person's text never goes into the context: the notice is built only from fixed strings.
- Commits with `git commit -s`, ending with the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line; nothing pushed.

## Review Focus
- **`setup.json` is missing, empty, unreadable or not JSON:** treated as no state (asks per the rules); never throws out of the hook. Pinned in Task 1.
- **`CLAUDE_PLUGIN_DATA` is empty** (hook run by hand, old Claude Code): no state can be kept, so the notice shows only inside a Mirage project, never in other folders. Pinned in Task 2.
- **The plugin's `plugin.json` can't be read** (`CLAUDE_PLUGIN_ROOT` unset): version `unknown`, still asks once. Pinned in Task 2.
- **`laterUntil` is in the past, or not a date:** ignored. Pinned in Task 1.
- **Tools installed in a session after the notice:** the next session says nothing (the check is live, not cached). Pinned in Task 1.

---

### Task 1: The setup state and the notice

**Files:**
- Create: `packages/shared/src/setup-state.ts`
- Modify: `packages/shared/package.json` (add the `"./setup-state"` export, same shape as `"."`)
- Create: `packages/hooks/src/setup-notice.ts`
- Test: `packages/hooks/src/setup-notice.test.ts`

**Interfaces:**
- Produces (shared, zod-free so the hook stays fast):
  - `SETUP_FILE = 'setup.json'`, `LATER_DAYS = 7`
  - `interface SetupState { askedVersion?: string; laterUntil?: string }` (`laterUntil` an ISO date)
  - `readSetupState(dataDir: string): SetupState` — `{}` for a missing or broken file; drops fields of the wrong type.
  - `writeSetupState(dataDir: string, patch: SetupState): void` — merges into the file, creates `dataDir`; never throws.
- Produces (hooks):
  - `type MissingTool = 'ffmpeg' | 'ffprobe' | 'whisper-cli' | 'speech-model'`
  - `missingTools(o: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string }): MissingTool[]`
  - `setupNotice(o: { dataDir: string; version: string; inProject: boolean; now: Date; missing: MissingTool[] }): string | null` — also records `askedVersion` when it shows the notice outside a project.

- [ ] **Step 1: Write the failing tests** in `setup-notice.test.ts`:

```ts
it('finds the tools the engine finds: override folders, then PATH; whisper also in installer folders', () => {
  // temp dirs with executable files named ffmpeg / ffprobe / whisper-cli (".exe" on win32)
  expect(missingTools({ env: { PATH: bin }, platform: process.platform, home })).toEqual(['speech-model']);
  expect(missingTools({ env: { PATH: '' }, platform: process.platform, home })).toEqual(['ffmpeg', 'ffprobe', 'whisper-cli', 'speech-model']);
  expect(missingTools({ env: { PATH: '', WORDEDITS_FFMPEG_DIR: bin, WORDEDITS_WHISPER_DIR: bin, WORDEDITS_WHISPER_MODEL: modelFile }, platform: process.platform, home })).toEqual([]);
  // the default model place: <home>/.local/share/whisper-cpp/models/ggml-large-v3-turbo-q5_0.bin
});

it('asks once anywhere per version, then only in a Mirage project', () => {
  const o = { dataDir, version: '0.2.0', now, missing: ['ffmpeg'] as MissingTool[] };
  expect(setupNotice({ ...o, inProject: false })).toContain('FFmpeg');
  expect(setupNotice({ ...o, inProject: false })).toBeNull();
  expect(setupNotice({ ...o, inProject: true })).not.toBeNull();
  expect(setupNotice({ ...o, version: '0.3.0', inProject: false })).not.toBeNull();
});

it('says nothing when nothing is missing, and nothing for 7 days after not now', () => {
  expect(setupNotice({ dataDir, version: 'v', inProject: true, now, missing: [] })).toBeNull();
  writeSetupState(dataDir, { laterUntil: new Date(now.getTime() + 86_400_000).toISOString() });
  expect(setupNotice({ dataDir, version: 'v', inProject: true, now, missing: ['ffmpeg'] })).toBeNull();
  writeSetupState(dataDir, { laterUntil: 'soon' });
  expect(setupNotice({ dataDir, version: 'v', inProject: true, now, missing: ['ffmpeg'] })).not.toBeNull();
});

it('reads a missing, empty or broken setup.json as no state', () => {
  for (const text of [null, '', '{', '[]', '{"askedVersion":3}']) { /* write or not */ expect(readSetupState(dir)).toEqual({}); }
});

it('builds the notice from fixed text only', () => {
  expect(setupNotice({ dataDir, version: 'v', inProject: false, now, missing: ['ffprobe', 'speech-model'] })).toBe(FIRST_NOTICE_FFPROBE_AND_MODEL);
});
```

`FIRST_NOTICE_FFPROBE_AND_MODEL` is the exact text from Step 3 with the list `FFmpeg (ffprobe) and whisper.cpp's speech model`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run packages/hooks/src/setup-notice.test.ts`
Expected: FAIL (modules don't exist).

- [ ] **Step 3: Implement** `setup-state.ts` and `setup-notice.ts`.
  - Tool lookup mirrors the engine: `ffmpeg`/`ffprobe` in `WORDEDITS_FFMPEG_DIR` if set (only there), else PATH (`locate.ts`; ffmpeg-static isn't shipped in the plugin). `whisper-cli` in `WORDEDITS_WHISPER_DIR` if set, else PATH, then `/opt/homebrew/bin`, `/usr/local/bin`, `/home/linuxbrew/.linuxbrew/bin` (on Windows `%LOCALAPPDATA%\whisper-cpp` and its `Release`), as in `whisper.ts`. The model is `WORDEDITS_WHISPER_MODEL` or the default path. Executables are `<name>.exe` on win32. Use `existsSync` + `statSync().isFile()`.
  - Plain names in the list: `ffmpeg`+`ffprobe` → `FFmpeg`, one of them → `FFmpeg (ffprobe)`, `whisper-cli` → `whisper.cpp`, `speech-model` → `whisper.cpp's speech model` (when `whisper-cli` is missing too: `whisper.cpp and its speech model`). Joined with `, ` and ` and `.
  - Text outside a project (exact copy):
    `Mirage, the video-editing plugin, was just installed or updated, and it can't edit videos until <list> <is|are> installed. At the start of your first reply, before anything else, ask the person whether Mirage may install <it|them> now. Use the mirage:setup skill: it says in one plain sentence what each tool is for and about how big it is, and how to install it. Install only what they agree to. If they say not now, call mcp__plugin_mirage_engine__setup_later.`
  - Text inside a project: the same, starting `This Mirage project can't edit videos until <list> <is|are> installed.` instead of the first sentence.

- [ ] **Step 4: Run the tests to see them pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit** — `feat(setup): the notice and state for asking before setup`.

### Task 2: The SessionStart hook says it

**Files:**
- Modify: `packages/hooks/src/main.ts` (session-start runs the notice before the project check)
- Modify: `packages/hooks/src/hook.ts` (`HookDeps.setupNotice?: string | null`; `sessionStart()` appends it to the project line, separated by a space)
- Test: `packages/hooks/src/hook.test.ts`

**Interfaces:**
- Consumes: `missingTools`, `setupNotice` (Task 1).
- Produces: SessionStart stdout `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext": …}}` — outside a project the notice alone; inside, `<project line> <notice>`.

- [ ] **Step 1: Write the failing tests** in `hook.test.ts`:
  - `runHook('session-start', …)` in a project with `deps.setupNotice = 'NOTICE'` → `additionalContext` is `This folder is a Mirage project (“Lamp series”, 2 videos). Use the mirage:edit skill to make or change a video. NOTICE`; with `null` it is unchanged from today.
  - Bundled script (`DIST`, `skipIf(!existsSync(DIST))`): session-start outside a project with `CLAUDE_PLUGIN_DATA` a temp dir, `PATH=''` and `HOME` an empty temp dir prints the outside-project notice once, then `''` on the second run; under 150 ms like the `pre` test.
  - Same with `CLAUDE_PLUGIN_DATA` unset → `''` outside a project (Review Focus).
  - `CLAUDE_PLUGIN_ROOT` unset → version `unknown`, still asks once (Review Focus).

- [ ] **Step 2: Run them to see them fail** — `pnpm vitest run packages/hooks/src/hook.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** In `main.ts`, for `session-start` only: `inProject = findProject(...) !== null`; version from `JSON.parse(readFileSync(join(CLAUDE_PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))).version` (else `'unknown'`); `notice = pluginData || inProject ? setupNotice({ dataDir: pluginData, version, inProject, now: new Date(), missing: missingTools({ env: process.env, platform: process.platform, home: homedir() }) }) : null` (no data folder → nothing outside a project; inside, it still shows but records nothing). Outside a project print the JSON if `notice`; inside pass it as `deps.setupNotice`. Wrap in the existing try/catch so a failure logs and prints nothing.

- [ ] **Step 4: Rebuild and run** — `pnpm build:plugin && pnpm vitest run packages/hooks`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(setup): the session start asks to install what's missing`.

### Task 3: `setup_later`, the launcher, and the setup skill

**Files:**
- Modify: `packages/mcp/src/server.ts` (new tool, `TOOL_NAMES`)
- Modify: `packages/hooks/src/policy.ts` only if a test requires every engine tool to have a label (check `policy.test.ts`); it's not a stage.
- Modify: `plugin/scripts/node`
- Modify: `plugin/skills/setup/SKILL.md`, `plugin/skills/status/SKILL.md` (one line)
- Test: `packages/mcp/src/server.test.ts`, `scripts/plugin-node.test.ts`, `scripts/skills.test.ts` (if it lists tools)

**Interfaces:**
- Consumes: `writeSetupState`, `LATER_DAYS` from `@wordedits/shared/setup-state`.
- Produces: engine tool `setup_later {}` (works without a project), replying `OK — Mirage won't ask about setup again until <YYYY-MM-DD>. /mirage:setup installs the tools any time.`; writes `laterUntil` = now + 7 days into `$MIRAGE_PLUGIN_DATA/setup.json`. With no `MIRAGE_PLUGIN_DATA`: `✖ Mirage has no data folder here, so it can't remember that.` and a hint `It will ask again next session.`

- [ ] **Step 1: Write the failing tests:**
  - `server.test.ts`: calling `setup_later` with a temp `MIRAGE_PLUGIN_DATA` (via `EngineContext.pluginData?: string`, default `process.env.MIRAGE_PLUGIN_DATA`) writes `laterUntil` 7 days after a fixed `now`; `TOOL_NAMES` ends `…, 'status', 'setup_later'`; works in a folder without `mirage.json`.
  - `plugin-node.test.ts`: with no Node, `run` with args `['hook.mjs', 'session-start']`, `CLAUDE_PLUGIN_DATA` a temp dir and `CLAUDE_PROJECT_DIR` a folder without `mirage.json` → stdout is SessionStart JSON whose `additionalContext` is the Node notice, exit 0, empty stderr; a second run → stdout `''`, exit 0; with `mirage.json` in `CLAUDE_PROJECT_DIR` → the notice every time. Other args (`engine.mjs`) keep today's stderr message and exit 1.

- [ ] **Step 2: Run them to see them fail** — `pnpm vitest run packages/mcp/src/server.test.ts scripts/plugin-node.test.ts`. Expected: new tests FAIL.

- [ ] **Step 3: Implement.**
  - Launcher: when no Node is found and the last argument is `session-start`: if `${CLAUDE_PROJECT_DIR:-$PWD}/mirage.json` exists, or `$CLAUDE_PLUGIN_DATA` is set and `$CLAUDE_PLUGIN_DATA/node-notice-shown` doesn't exist (then `mkdir -p` and touch it), print the JSON and exit 0; otherwise print nothing and exit 0. Node notice text (exact, a single JSON line written with `printf '%s\n'`):
    `Mirage, the video-editing plugin, needs Node.js 22 or later, and this computer doesn't have it, so none of Mirage works yet. At the start of your first reply, before anything else, ask the person whether to install Node now, and say it runs Mirage itself: its engine and the viewer they watch their videos in. Use the mirage:setup skill (step 1) to install it. After Node is installed they need to start a new Claude Code session.`
  - Setup skill: a new section near the top, **"Asking first"**: when the session start says tools are missing, ask before anything else in one message, one plain sentence per missing tool, from this list (exact):
    - **Node.js** — runs Mirage itself: its engine and the viewer you watch your videos in.
    - **FFmpeg** — does the actual video work: cutting, joining, captions, music and the final export.
    - **whisper.cpp and its speech model (about 574 MB)** — lets Claude hear what's said in your clips, so it can pick the best takes and write captions; it runs on your computer, nothing is uploaded.
    - **Kokoro AI voice (about 260 MB, optional)** — reads narration aloud if you don't record your own; it downloads the first time you use it, so there's nothing to install now.

    plus what the person must do themselves (e.g. paste the Homebrew installer). On yes: the steps for those tools. On "not now": call `mcp__plugin_mirage_engine__setup_later` and say `/mirage:setup` works any time.
  - Status skill: one line saying `setup_later` exists and why.

- [ ] **Step 4: Run everything** — `pnpm test && pnpm typecheck && pnpm build:plugin`. Expected: all pass.

- [ ] **Step 5: Real check.** With the built plugin: run `plugin/dist/hook.mjs session-start` through `plugin/scripts/node` with `CLAUDE_PLUGIN_DATA` an empty temp dir, `CLAUDE_PLUGIN_ROOT=plugin`, `PATH` without ffmpeg/whisper, stdin `{"session_id":"s","cwd":"<temp>","hook_event_name":"SessionStart"}` → the notice; again → nothing. Then call `setup_later` through the bundled engine over stdio and see `setup.json`.

- [ ] **Step 6: Commit** — `feat(setup): setup_later, the no-Node notice, and the setup skill's reasons`.
