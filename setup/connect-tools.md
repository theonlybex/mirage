# Connect Mirage's tools to Claude Code

**For the person:** open Claude Code in your video folder and type:

> Follow setup/connect-tools.md and connect everything Mirage needs.

Claude checks each tool, installs what's missing, and tells you when it needs you. Some steps only you can do: signing in to accounts, paying for a plan, creating a key, and installing a browser extension.

**For Claude:**

**How to work through it**
- Work through the steps in order.
- Run every check first. Skip whatever already works.
- Ask before each install, and say what it is and roughly how big it is.
- After each step, report ✓ connected, – skipped (optional), or ✗ needs the person, with what they must do.

**Keys and sign-ins**
- Never ask the person to paste a key, password or token into the chat.
- When a key is needed, tell them where to put it. Then check it exists without printing it, for example `test -n "$VAR" && echo set`.
- Sign-ins happen in the browser window each tool opens.

**Platforms:** macOS commands come first. Windows commands, for PowerShell, follow.

The seven jobs below come from a working "editor while I sleep" setup. Each tool does one job, and Claude Code coordinates all of them.

| # | Job | Tool | Needed? | Cost |
|---|---|---|---|---|
| 1 | Editor: picks takes, cuts, places graphics, runs the other tools | Claude Code | required | Claude plan or API key |
| 2 | Transcriber: words with timestamps, so Claude can "hear" the footage | Parakeet (NVIDIA), run through HyperFrames | required | free |
| 3 | Animator: titles, logos, diagrams, motion graphics | HyperFrames (HeyGen, Apache 2.0) | required | free |
| 4 | Researcher: screenshots of real pages and posts as proof on screen | Chrome with Claude in Chrome | recommended | needs a Claude plan |
| 5 | Screen editor: face + screen recordings, cuts, zooms, layouts | Tella (MCP) | optional | Tella account |
| 6 | Sound designer: music and sound effects | Epidemic Sound (MCP) | optional | Epidemic subscription to download |
| 7 | Finisher: joins, encodes, checks black frames and A/V sync | FFmpeg | required | free |

The steps below install them in the order they depend on each other, so the step numbers don't match the job numbers. Step 8 is the final check.

---

## Step 0 · What the others need first

**Check:**

```bash
node --version    # needs v22 or later
python3 --version # Parakeet runs on Python 3
```

**Install if missing:**
- **macOS:**
  - Homebrew from https://brew.sh (ask the person to paste the one-line installer into Terminal themselves).
  - Then `brew install node python`.
- **Windows:** `winget install OpenJS.NodeJS.LTS` and `winget install Python.Python.3.12`.

---

## Step 1 · Claude Code (job 1, the editor)

This step is the person's. It's already done if you're reading this inside Claude Code.

**Install:** use the Claude desktop app from https://claude.com/download (open the **Code** tab), or the terminal version:
- macOS: `curl -fsSL https://claude.ai/install.sh | bash`
- Windows: `irm https://claude.ai/install.ps1 | iex`

**Sign in:** use `/login` with a Claude plan (Pro, Max) or an API key.
- **With a plan:** you pay a fixed monthly price, and step 5 (the browser) works.
- **With an API key:** you pay per use, and the browser in step 5 can't be used.

**Check:**

```bash
claude --version
```

---

## Step 2 · FFmpeg (job 7, the finisher)

It comes early because HyperFrames needs it.

**Check:**

```bash
ffmpeg -version && ffprobe -version
```

**Install:**
- macOS: `brew install ffmpeg`
- Windows: `winget install --id Gyan.FFmpeg -e`, then open a new terminal so it's on PATH.

---

## Step 3 · HyperFrames (job 3, the animator)

HyperFrames needs Node 22+ and FFmpeg. It renders through headless Chrome, which it fetches itself.

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

## Step 4 · Parakeet (job 2, the transcriber)

Parakeet runs through HyperFrames' `transcribe` command. On a Mac, Mirage also has Apple's on-device speech recognition built in, so Parakeet matters most on Windows.

**Check:**

```bash
npx hyperframes transcribe --help
```

The help must list `parakeet` as an `--engine`.

**Install:**
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

## Step 5 · Chrome + Claude in Chrome (job 4, the researcher)

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

## Step 6 · Tella (job 5, the screen editor, optional)

Only for people who record screen tutorials in Tella. Everyone else can skip this and use plain recording files.

**Connect** (one of these):
- **In the terminal:**

  ```bash
  claude mcp add --transport http --scope user tella https://api.tella.com/mcp
  ```

  Then run `/mcp`, choose `tella`, and sign in to Tella in the browser.
- **In the Claude desktop app:** **Customize → Connectors**, search "Tella", click +, and sign in.

**Check:** `claude mcp list` shows `tella` connected.

**If sign-in gets stuck:** run `rm -rf ~/.mcp-auth` and connect again.

---

## Step 7 · Epidemic Sound (job 6, the sound designer, optional)

Searching and previewing is free. Downloading music or effects for a video needs an Epidemic Sound subscription. Without it, Mirage uses the person's own music folder and HyperFrames' free sound library.

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

## Step 8 · Final check

Run all of these and give the person one table, one row per job: ✓ / – / ✗ and what to do.

```bash
claude --version
ffmpeg -version | head -1
npx hyperframes --version
npx hyperframes transcribe --help | grep -i parakeet
claude mcp list
```

Then ask the person to run `/chrome` and read the status.

Finish with:
- "Start a new Claude Code session so everything loads."
- Which optional tools are off, and what each would add.

---

*Mirage's own part, the eighth piece (your style, the build-story format and the editing engine), comes as a Claude Code plugin. Until it's packaged, it's the `mirage-episode` skill and `pnpm mirage` in this repository.*

*Sources, checked 2026-11-02:*
- *[Tella MCP docs](https://www.tella.com/docs/mcp-server)*
- *[Epidemic Sound MCP docs](https://developers.epidemicsound.com/docs/mcp/)*
- *[HyperFrames on GitHub](https://github.com/heygen-com/hyperframes)*
- *[Claude Code with Chrome](https://code.claude.com/docs/en/chrome)*

*Parakeet's model-install command comes from current HyperFrames usage and isn't in its README. That's why step 4 checks `--help` first.*
