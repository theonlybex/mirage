---
name: setup
description: "Check and install what Mirage needs on this Mac (Node, FFmpeg, Xcode Command Line Tools), and connect the tools later versions use when the person asks. Use when the person sets Mirage up, or Mirage says a tool is missing."
---

# Setting up Mirage

**For the person:** in Claude Code, type `/mirage:setup`. Claude checks each tool, installs what's missing, and tells you when it needs you. Some steps only you can do: signing in to accounts, paying for a plan, creating a key, and installing a browser extension.

**For Claude:**

**How to work through it**
- Work through the steps in order.
- Run every check first. Skip whatever already works.
- Ask before each install, and say what it is and roughly how big it is.
- After each step, report ✓ connected, – later or optional, or ✗ needs the person, with what they must do.

**Required now, and later**
- This version of Mirage needs three things on the Mac: Node 22 or newer, FFmpeg (with ffprobe), and the Xcode Command Line Tools.
- The other tools are marked **later**: a later version of Mirage uses them, and each step says which. Don't install them unless the person asks. When they ask, follow that tool's step.

**Keys and sign-ins**
- Never ask the person to paste a key, password or token into the chat.
- When a key is needed, tell them where to put it. Then check it exists without printing it, for example `test -n "$VAR" && echo set`.
- Sign-ins happen in the browser window each tool opens.

**Platforms:** Mirage runs on a Mac for now, so macOS commands come first. The Windows commands, for PowerShell, are for the later tools.

The jobs below come from a working "editor while I sleep" setup. Each tool does one job, and Claude Code coordinates all of them.

| # | Job | Tool | Needed? | Cost |
|---|---|---|---|---|
| 1 | Editor: picks takes, cuts, places graphics, runs the other tools | Claude Code, with Mirage | required now | Claude plan or API key |
| 2 | Finisher: joins, encodes, checks black frames and A/V sync | FFmpeg | required now | free |
| 3 | Speech recognition on the Mac, so Claude can "hear" the footage | Mirage's speech helper, built with the Xcode Command Line Tools | required now | free |
| 4 | Transcriber on Windows, or as an option: words with timestamps | Parakeet (NVIDIA), run through HyperFrames | later (Phase 2) | free |
| 5 | Animator: titles, logos, diagrams, motion graphics | HyperFrames (HeyGen, Apache 2.0) | later (Phase 4) | free |
| 6 | Researcher: screenshots of real pages and posts as proof on screen | Chrome with Claude in Chrome | later (Phase 4) | needs a Claude plan |
| 7 | Screen editor: face + screen recordings, cuts, zooms, layouts | Tella (MCP) | later (Phase 2), optional | Tella account |
| 8 | Sound designer: music and sound effects | Epidemic Sound (MCP) | later (Phase 4), optional | Epidemic subscription to download |

The steps below go in the order the tools depend on each other. Step 9 is the final check.

---

## Step 0 · What Mirage sees

Call `mcp__plugin_mirage_engine__status` (no input; it works in any folder) and read its tool lines:
- `ffmpeg: ok` / `ffprobe: ok`, or `missing`: step 3.
- `transcriber: ok`, or `missing`: step 4.
- `Node: v… ok`, or `… is too old`: step 1.

If the engine tool isn't there at all, Mirage's engine didn't start, which usually means Node is missing or too old: start with step 1, then ask the person to start a new Claude Code session.

---

## Step 1 · Node.js 22 or newer (required now)

**Check:**

```bash
node --version    # needs v22 or later
```

**Install if missing:**
- **macOS:**
  - Homebrew from https://brew.sh (ask the person to paste the one-line installer into Terminal themselves).
  - Then `brew install node`.
- **Windows:** `winget install OpenJS.NodeJS.LTS`.

---

## Step 2 · Claude Code (job 1, the editor; required now)

This step is the person's. It's already done if you're reading this inside Claude Code, and so is Mirage.

**Install:** use the Claude desktop app from https://claude.com/download (open the **Code** tab), or the terminal version:
- macOS: `curl -fsSL https://claude.ai/install.sh | bash`
- Windows: `irm https://claude.ai/install.ps1 | iex`

**Sign in:** use `/login` with a Claude plan (Pro, Max) or an API key.
- **With a plan:** you pay a fixed monthly price, and the browser in step 7 works.
- **With an API key:** you pay per use, and the browser in step 7 can't be used.

**Check:**

```bash
claude --version
```

---

## Step 3 · FFmpeg (job 2, the finisher; required now)

**Check:**

```bash
ffmpeg -version && ffprobe -version
```

**Install:**
- macOS: `brew install ffmpeg`
- Windows: `winget install --id Gyan.FFmpeg -e`, then open a new terminal so it's on PATH.

---

## Step 4 · Xcode Command Line Tools (job 3, speech recognition; required now)

Mirage hears the footage with Apple's on-device speech recognition. Its small speech helper is built on the Mac the first time Claude Code starts with Mirage, and building it needs the Xcode Command Line Tools.

**Check:**

```bash
xcode-select -p
```

It succeeds (it prints a folder) when they are installed.

**Install:** run `xcode-select --install`. macOS opens a window: the person clicks Install and accepts the licence there (a download of about 1–2 GB, a few minutes). Wait until they say it has finished, then check again.

**Then:** the speech helper is built when Claude Code next starts (about 30 seconds the first time). Ask the person to start a new Claude Code session, then call `status` again: `transcriber: ok`.

---

## Step 5 · HyperFrames (job 5, the animator; later, Phase 4)

Only if the person asks. HyperFrames needs Node 22+ and FFmpeg. It renders through headless Chrome, which it fetches itself.

**Install its Claude Code plugin** (skills for writing animations):

```bash
claude plugin marketplace add heygen-com/hyperframes
claude plugin install hyperframes@hyperframes
```

**Check the command-line tool:**

```bash
npx hyperframes --version
npx hyperframes --help
```

Afterwards, tell the person to start a new Claude Code session, so the new skills load. They show up as `/hyperframes:…`.

---

## Step 6 · Parakeet (job 4, the transcriber; later, Phase 2)

Only if the person asks. Parakeet runs through HyperFrames' `transcribe` command (step 5 first), on Python 3. On a Mac, Mirage has Apple's on-device speech recognition built in, so Parakeet matters most on Windows.

**Check:**

```bash
python3 --version
npx hyperframes transcribe --help
```

The help must list `parakeet` as an `--engine`.

**Install:**
- Python, if missing: `brew install python` on macOS; `winget install Python.Python.3.12` on Windows.
- If the help lists a model install command, run it: `npx hyperframes models install parakeet` in current versions.
- If Python can't be found, set `HYPERFRAMES_PYTHON` to the Python 3 path (`which python3`).

**Test:** transcribe a 5-second test file.

```bash
ffmpeg -f lavfi -i "sine=frequency=440:duration=5" -ar 16000 -ac 1 /tmp/mirage-test.wav
npx hyperframes transcribe /tmp/mirage-test.wav --engine parakeet --json
```

A run that finishes, even with no words, means it works.

**Always pass `--engine parakeet`.** Otherwise HyperFrames may quietly fall back to Whisper.

---

## Step 7 · Chrome + Claude in Chrome (job 6, the researcher; later, Phase 4)

Only if the person asks.

**Needs:**
- a Claude plan sign-in (`/login`). API-key sign-in keeps the browser off.
- Google Chrome, Edge or another Chromium browser.

**The person:**
1. Installs the extension from https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn and signs in to the same Claude account.
2. In Claude Code, runs `/chrome` and chooses **Enabled by default**. Or they start with `claude --chrome`.
3. In the Claude desktop app, turns on the browser setting under **Settings → Claude Code** instead.

**Check:** `/chrome` shows "Status: Enabled" and "Extension: Installed". If Chrome was open during the first setup, restart it.

Research rule: show only real pages and posts, captured as they are, and never invent a source.

---

## Step 8 · Tella and Epidemic Sound (jobs 7 and 8; later, optional)

Only if the person asks.

### Tella (the screen editor, Phase 2)

Only for people who record screen tutorials in Tella. Everyone else can skip this and use plain recording files.

**Connect** (one of these):
- **In the terminal:**

  ```bash
  claude mcp add --transport http --scope user tella https://api.tella.com/mcp
  ```

  Then run `/mcp`, choose `tella`, and sign in to Tella in the browser.
- **In the Claude desktop app:** **Customize → Connectors**, search "Tella", click +, and sign in.

**Check:** `claude mcp list` shows `tella` connected.

**If sign-in gets stuck:** removing `~/.mcp-auth` clears the saved sign-ins and lets them connect again, but it signs them out of every other connected tool too. Ask the person first and say so; only on a yes, run `rm -rf ~/.mcp-auth` and connect again.

### Epidemic Sound (the sound designer, Phase 4)

Searching and previewing is free. Downloading music or effects for a video needs an Epidemic Sound subscription. Without it, Mirage uses the person's own music folder.

**For Claude Code, this uses an API key, not a sign-in.**

1. **The person creates a key.** It's at https://www.epidemicsound.com/account/api-keys, the **MCP Server** key, not the Developer Portal key. They save it in their shell profile themselves, never in the chat:
   - macOS: add `export EPIDEMIC_SOUND_MCP_API_KEY="…"` to `~/.zshrc`, then open a new terminal.
   - Windows: `setx EPIDEMIC_SOUND_MCP_API_KEY "…"`, then open a new terminal.
2. **Check that it's set:**

   ```bash
   test -n "$EPIDEMIC_SOUND_MCP_API_KEY" && echo set
   ```

3. **Connect.** Keep the single quotes, so the key stays out of the config file:

   ```bash
   claude mcp add -s user --transport http epidemic-sound https://www.epidemicsound.com/a/mcp-service/mcp \
     --header 'Authorization: Bearer ${EPIDEMIC_SOUND_MCP_API_KEY}'
   ```

4. **Check:** `claude mcp list` shows `epidemic-sound` connected. If it doesn't, the variable wasn't set in the terminal Claude Code was started from.

---

## Step 9 · Final check

Call `mcp__plugin_mirage_engine__status` again, and run:

```bash
node --version
claude --version
ffmpeg -version | head -1
xcode-select -p
```

For a later tool the person set up, also run its check (`npx hyperframes --version`, `npx hyperframes transcribe --help | grep -i parakeet`, `claude mcp list`, or ask them to run `/chrome` and read the status).

Then give the person one table, one row per tool, each with ✓ (working), – (later or optional, not set up) or ✗ (needs the person), and what to do:

| Tool | | What to do |
|---|---|---|
| Node.js 22+ | | |
| Claude Code | | |
| FFmpeg | | |
| Xcode Command Line Tools (speech) | | |
| HyperFrames | | |
| Parakeet | | |
| Chrome + Claude in Chrome | | |
| Tella | | |
| Epidemic Sound | | |

Finish with:
- "Start a new Claude Code session so everything loads."
- Which later tools are off, and what each will add.

---

*Sources, checked 2026-11-02:*
- *[Tella MCP docs](https://www.tella.com/docs/mcp-server)*
- *[Epidemic Sound MCP docs](https://developers.epidemicsound.com/docs/mcp/)*
- *[HyperFrames on GitHub](https://github.com/heygen-com/hyperframes)*
- *[Claude Code with Chrome](https://code.claude.com/docs/en/chrome)*

*Parakeet's model-install command comes from current HyperFrames usage and isn't in its README. That's why step 6 checks `--help` first.*
