<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Mirage plugin: end-to-end and real Claude Code checks

Plan: `docs/superpowers/plans/2026-11-02-mirage-plugin-phase-1.md`, Task 12. Spec: `docs/superpowers/specs/2026-11-02-mirage-plugin-design.md` (§5.3, §7).

## What the automated end-to-end test proves

`pnpm --filter @wordedits/viewer test:e2e` (Playwright, Chromium; not part of `pnpm test`). Run `pnpm build:plugin` first: it uses the built `plugin/`.

`packages/viewer/e2e/driver.ts` plays Claude Code's part, without a model, from the plugin's own manifests:

- **Hooks:** for every event it runs the command `plugin/hooks/hooks.json` gives (`plugin/scripts/node plugin/dist/hook.mjs <session-start|pre|post|stop>`), with the event's JSON on stdin (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`, `tool_response` or `error`). A failed tool gets `PostToolUseFailure`, as Claude Code sends it.
- **Engine:** it starts `plugin/.mcp.json`'s server (`scripts/node dist/engine.mjs`, with `MIRAGE_PROJECT` and `WORDEDITS_TRANSCRIBER` expanded the way Claude Code does) and calls its tools over MCP stdio. An engine call is PreToolUse → (if not denied) the MCP call → PostToolUse/PostToolUseFailure, with the tool named `mcp__plugin_mirage_engine__<tool>`.
- **Write:** it writes the file itself, between PreToolUse and PostToolUse, with `file_path`/`content`.
- **Viewer:** it runs `plugin/monitors/monitors.json`'s command through `/bin/sh -c` with `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `CLAUDE_PROJECT_DIR` set, and reads its stdout lines, as Claude Code hears a monitor.

Each test runs on a fresh temp project, with its footage in a separate temp folder named `my clips ✨` (`fixtures/tone-6s.mp4`, `fixtures/silent-6s.mp4`). `CLAUDE_PLUGIN_DATA` is a temp folder holding a copy of the speech helper. `WORDEDITS_FFMPEG_DIR` points at ffmpeg-static and ffprobe-static, linked side by side, because ffmpeg isn't on PATH on the build machine.

**Test 1: an edit shows up live, and notes reach Claude.** SessionStart, `new_project`, `new_video`, `ingest`, Write `episode.json` (two items), `check`, `cut`, with the page open on the Edit tab from `new_video` on. It proves:
- the monitor's viewer starts once `mirage.json` appears, and its first line carries the `?k=` address
- the Picture lane reaches 2 items, and the step list reaches "Rough cut rendered" (the hooks' step lines, streamed by the viewer)
- Versions shows "V1 · Rough cut" (the PostToolUse delivery)
- Review's `<video>` reaches `readyState >= 2` (the render is served and plays)
- clicking the picture at 2.5 s opens a note at 0:02; "too dark" is added
- "Send notes (1)" makes the viewer print exactly `Mirage viewer: the person sent 1 note(s) on video 1 (Rough cut). Use the mirage:notes skill for video 1.`
- the engine's `get_notes` then gives `Note n1 at 2.5 s: too dark`

**Test 2: pause now, a correction on resume, then stop.** The same set-up, with a 60 s clip added. Then:
1. Write a two-item `episode.json`, and `check` (its checkpoint is the last finished step).
2. Write a 60 s, 4K, 60 fps one-item `episode.json`, and start `cut`.
3. On the page: Pause, then "Pause now" in the sheet. The cut ends with "Stopped by the person", and the bar shows Paused.
4. The driver's next PreToolUse (`cut` again) is held: it hasn't answered after 2 s.
5. On the page: type "keep the intro" and press "Resume with this". The held call returns a deny whose reason contains `“keep the intro”`.
6. On the page: Stop, confirmed in the dialog (the bar shows Stopping). The driver sends the Stop hook.

It proves:
- `episode.json` equals the session's last checkpoint ("Timeline checked")
- `episodes/1` has no `.work-*` left by the cancelled render
- the stop is cleared afterwards

**What it doesn't prove:** anything about Claude Code itself. It doesn't show that Claude Code expands the variables, runs the hooks and monitor, honours the PreToolUse decision and timeout, or turns a monitor line into a turn the way the driver assumes. The checks below cover that.

## Real Claude Code checks (not run yet — needs the person's go-ahead)

These spend a little of the person's own plan usage, so they wait for a yes. Run them from the worktree, with `plugin/` built (`pnpm build:plugin`). On this machine ffmpeg isn't on PATH. Start Claude Code with `WORDEDITS_FFMPEG_DIR` set to a folder holding `ffmpeg` and `ffprobe`, or install ffmpeg (`brew install ffmpeg`).

Helpers used below (run in the project folder, once the viewer is up):

```sh
URL=$(node -p "require('./.mirage/viewer.json').url"); BASE=${URL%%/\?k=*}; KEY=${URL##*k=}
ctl() { curl -s -X POST "$BASE/api/control" -H "x-mirage-key: $KEY" -H 'content-type: application/json' -d "$1"; echo; }
```

- [ ] **1. The plugin loads; the engine connects.**
  - Steps:
    ```sh
    PLUGIN="$PWD/plugin"          # in the worktree
    mkdir -p /tmp/mirage-check-1 && cd /tmp/mirage-check-1
    claude --plugin-dir "$PLUGIN"
    ```
    Then, in Claude Code: `/mirage:status`, then `/mcp`.
  - Expected:
    - `/mirage:status` runs and says there's no Mirage project here yet, and how the tools stand.
    - `/mcp` lists `plugin:mirage:engine` as connected.
    - No `${CLAUDE_PLUGIN_DATA}/hook-errors.log` appears.
  - If it fails: §7 has no fallback for this one. It's a blocker, fixed in this task. Run `claude --debug --plugin-dir "$PLUGIN"` to see why the server or hooks didn't start, and check that `claude plugin validate ./plugin` passes. Look for a variable not expanded, or Node not found (see check 5).

- [ ] **2. A PreToolUse hold of 11 minutes lets the step run afterwards.**
  - Steps:
    1. In a Mirage project with a video (make one with `/mirage:edit` on two short clips, or reuse the one from check 3), with Claude Code idle:
       ```sh
       ctl '{"video":1,"pause":"after-step"}'
       ```
    2. Ask Claude: "run the check on video 1". The step list shows it held, with no step line yet.
    3. Wait 11 minutes, then:
       ```sh
       ctl '{"video":1,"resume":{}}'
       ```
  - Expected:
    - The `check` tool runs within a second of the resume and Claude reports its result.
    - Claude Code didn't time the hook out or cancel the turn during the 11 minutes.
  - If it fails (the hold is cut short near 10 minutes): use §7's fallback, a hold re-armed every 9 minutes. The hook waits at most 9 minutes, then denies with a reason that tells Claude the edit is paused and to call the same tool again. The next PreToolUse holds again. The fix lands in `packages/hooks/src/hook.ts` (`MAX_HOLD_MS` and a new "still paused" reason), with its unit tests and a `pnpm build:plugin`.

- [ ] **3. A monitor line wakes an idle session.**
  - Steps:
    1. In a new folder: `claude --plugin-dir "$PLUGIN"`, then `/mirage:edit`. Answer the questions with a folder of two short clips. The viewer line (`Mirage viewer: http://127.0.0.1:…/?k=…`) arrives.
    2. When Claude is idle (its turn over, waiting for you), send a correction while not paused:
       ```sh
       ctl '{"video":1,"resume":{"correction":"make the intro shorter"}}'
       ```
       The viewer prints `Mirage viewer: the person says about video 1: “make the intro shorter”`.
    3. Repeat in the terminal and in the desktop app (Code tab).
  - Expected: a new turn starts on its own in both, with Claude acting on the line. Write down terminal: yes/no, desktop app: yes/no.
  - If it fails (the line waits until the person types): use §7's fallback, the "Tell Claude: …" text. When Claude is idle, the viewer shows the text to paste into Claude Code (with a Copy button) instead of relying on the line. This applies to sent notes, corrections, a dropped voice-over and overnight. The fix lands in the viewer page (`packages/viewer/src/ui`, the notes, correction and voice-over controls) and in `api.ts`'s answers, with tests and a `pnpm build:plugin`.

- [ ] **4. The desktop app's browser pane opens the viewer.**
  - Steps: in the desktop app, in a Mirage project, run `/mirage:edit` (or ask "open Mirage's viewer"). Claude opens the `http://127.0.0.1:<port>/?k=…` address in the browser pane.
  - Expected: the page loads in the pane, the video list or Edit tab shows, and the timeline updates live.
  - If it fails (the pane refuses `127.0.0.1`, or loads it without the event stream): use §7's fallback, the system browser. The edit skill and the viewer's first line say to run `open "<url>"` in the desktop app too. The fix lands in `plugin/skills/edit/SKILL.md` and the line in `packages/viewer/src/server/server.ts`, with a `pnpm build:plugin`.

- [ ] **5. With the desktop app launched from the Dock, `scripts/node` finds Node.**
  - Steps:
    1. Quit the Claude desktop app completely, then start it from the Dock (not from a terminal), so it gets launchd's short PATH.
    2. Open a Mirage project folder in the Code tab, then run `/mcp` and `/mirage:status`.
  - Expected:
    - `plugin:mirage:engine` shows as connected.
    - `/mirage:status` shows `Node: v2x… ok` and the viewer as running.
    - The hooks write step lines (the viewer's step list fills as Claude works).
    - There's no "Mirage needs Node.js 22 or later" message.
  - If it fails: §7 has no separate fallback. `scripts/node` is itself the fallback for a missing PATH, so the fix is to add the location this Mac's Node is at to the list it searches. To find it, run `command -v node` in a terminal, and `ls ~/.nvm/versions/node ~/.volta/bin 2>/dev/null`. The fix lands in `plugin/scripts/node`, with its test, and `/mirage:setup` says where it looks.

### Results

Run 2026-11-03 with Claude Code 2.1.284 (terminal) and the desktop app (Claude Code 2.1.309).

- **1. Plugin loads (partial).** `claude -p --plugin-dir ./plugin --output-format stream-json` reports `plugin:mirage:engine` as `connected`, the 17 engine tools and the six `mirage:*` skills. The plugin's data folder is `~/.claude/plugins/data/mirage-inline`, and no `hook-errors.log` appeared. The model turn didn't run because the terminal `claude` sign-in had expired, so `/mirage:status` is still to do.
- **4. Browser pane: passed.** The desktop app's browser pane opened `http://127.0.0.1:<port>/?k=…` from a real engine, viewer and hooks run (the e2e driver's set-up). The video list and the Edit tab showed, a new step appeared live 40 s later through the event stream, and the rough cut played on Review (`readyState` 4). No fallback is needed.
- **5. Node from the Dock: fixed.** This app's own `claude` gets a full PATH (it includes `~/.local/node/bin`). With launchd's short PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), though, `scripts/node` found no Node: this Mac's Node is in `~/.local/node/bin`, which wasn't on its list. It now looks there last, with a test, and `/mirage:setup` says where it looks (commit e2bdea4).
