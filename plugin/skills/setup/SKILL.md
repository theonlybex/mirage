---
name: setup
description: "Check and install what Mirage needs (Node, FFmpeg, whisper.cpp and its speech model, the Kokoro AI voice), and connect the tools later versions use when the person asks. Use when the person sets Mirage up, or Mirage says a tool is missing."
---

# Setting up Mirage

**For the person:** in Claude Code, type `/mirage:setup`. Claude checks each tool, installs what's missing, and tells you when it needs you. Some steps only you can do: signing in to accounts, paying for a plan, creating a key, and installing a browser extension.

**For Claude:**

**Asking first**

When the session start says tools are missing (or that Node is), ask before doing anything else. Ask in one message, with one plain sentence per missing tool, from this list:
- **Node.js** — runs Mirage itself: its engine and the viewer you watch your videos in.
- **FFmpeg** — does the actual video work: cutting, joining, captions, music and the final export.
- **whisper.cpp and its speech model (about 574 MB)** — lets Claude hear what's said in your clips, so it can pick the best takes and write captions; it runs on your computer, nothing is uploaded.
- **Kokoro AI voice (about 260 MB, optional)** — reads narration aloud if you don't record your own; it downloads the first time you use it, so there's nothing to install now.

Add what the person has to do themselves, for example pasting the Homebrew installer into Terminal.
- On yes: do the steps below for those tools only.
- On "not now": call `mcp__plugin_mirage_engine__setup_later`, then say `/mirage:setup` works any time. Mirage doesn't ask again for 7 days. If Node is the missing tool, don't call it (it needs Node, so it isn't there): just say `/mirage:setup` works any time.

**How to work through it**
- Work through the steps in order.
- Run every check first. Skip whatever already works.
- Ask before each install, and say what it is and roughly how big it is.
- After each step, report ✓ connected, – later or optional, or ✗ needs the person, with what they must do.

**Required now, and later**
- This version of Mirage needs three things: Node 22 or newer, FFmpeg (with ffprobe), and whisper.cpp with its speech model.
- The other tools are marked **later**: a later version of Mirage uses them, and each step says which. Don't install them unless the person asks. When they ask, follow that tool's step.

**Keys and sign-ins**
- Never ask the person to paste a key, password or token into the chat.
- When a key is needed, tell them where to put it. Then check it exists without printing it, for example `test -n "$VAR" && echo set`.
- Sign-ins happen in the browser window each tool opens.

**Platforms:** Mirage is made on the Mac, so macOS commands come first. The Windows commands are for PowerShell.

The jobs below come from a working "editor while I sleep" setup. Each tool does one job, and Claude Code coordinates all of them.

| # | Job | Tool | Needed? | Cost |
|---|---|---|---|---|
| 1 | Editor: picks takes, cuts, places graphics, runs the other tools | Claude Code, with Mirage | required now | Claude plan or API key |
| 2 | Finisher: joins, encodes, checks black frames and A/V sync | FFmpeg | required now | free |
| 3 | Speech recognition, so Claude can "hear" the footage: words with timestamps, on this computer | whisper.cpp (`whisper-cli`) with the large-v3-turbo model | required now | free |
| 3b | Narrator: an AI voice that reads the narration lines, for footage without a voice of its own | Kokoro (`kokoro-js`, Apache 2.0), on this computer | optional, fetched by Mirage on first use | free |
| 4 | Animator: titles, logos, diagrams, motion graphics | HyperFrames (HeyGen, Apache 2.0) | later (Phase 4) | free |
| 5 | Researcher: screenshots of real pages and posts as proof on screen | Chrome with Claude in Chrome | later (Phase 4) | needs a Claude plan |
| 6 | Screen editor: face + screen recordings, cuts, zooms, layouts | Tella (MCP) | later (Phase 2), optional | Tella account |
| 7 | Sound designer: music and sound effects | Epidemic Sound (MCP) | later (Phase 4), optional | Epidemic subscription to download |

The steps below go in the order the tools depend on each other. Step 8 is the final check.

---

## Step 0 · What Mirage sees

Call `mcp__plugin_mirage_engine__status` (no input; it works in any folder) and read its tool lines:
- `ffmpeg: ok` / `ffprobe: ok`, or `missing`: step 3.
- `transcriber: ok`, or `missing — …` (it names what is missing: whisper-cli, the model, or both): step 4.
- `Node: v… ok`, or `… is too old`: step 1.
- `tts: ok`, `tts: not downloaded yet …` or `tts: missing — …`: step 4b.

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

**If `node --version` works in the terminal but Mirage still says it needs Node:** the Claude desktop app, opened from the Dock, may not see the terminal's PATH. Mirage then looks in `/opt/homebrew/bin`, `/usr/local/bin`, the newest nvm Node, `~/.volta/bin` and `~/.local/node/bin`. Run `command -v node`. If it's somewhere else, Homebrew's Node (`brew install node`) is the simplest fix.

---

## Step 2 · Claude Code (job 1, the editor; required now)

This step is the person's. It's already done if you're reading this inside Claude Code, and so is Mirage.

**Install:** use the Claude desktop app from https://claude.com/download (open the **Code** tab), or the terminal version:
- macOS: `curl -fsSL https://claude.ai/install.sh | bash`
- Windows: `irm https://claude.ai/install.ps1 | iex`

**Sign in:** use `/login` with a Claude plan (Pro, Max) or an API key.
- **With a plan:** you pay a fixed monthly price, and the browser in step 6 works.
- **With an API key:** you pay per use, and the browser in step 6 can't be used.

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

## Step 4 · whisper.cpp and its speech model (job 3, speech recognition; required now)

Mirage hears the footage with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), on this computer: no audio is uploaded. It needs two things, and `status` names whichever is missing:
- the `whisper-cli` program. Mirage looks in `WORDEDITS_WHISPER_DIR` if set, then PATH, then `/opt/homebrew/bin`, `/usr/local/bin`, and on Windows `%LOCALAPPDATA%\whisper-cpp` (and its `Release` folder).
- the speech model, `ggml-large-v3-turbo-q5_0.bin` (about 574 MB), at `~/.local/share/whisper-cpp/models/` on every platform, or wherever `WORDEDITS_WHISPER_MODEL` points.

**Check:**
- macOS:

  ```bash
  command -v whisper-cli || ls /opt/homebrew/bin/whisper-cli
  ls -lh ~/.local/share/whisper-cpp/models/ggml-large-v3-turbo-q5_0.bin
  ```

- Windows (PowerShell):

  ```powershell
  Get-Command whisper-cli -ErrorAction SilentlyContinue; Get-ChildItem "$env:LOCALAPPDATA\whisper-cpp" -Recurse -Filter whisper-cli.exe -ErrorAction SilentlyContinue
  Test-Path "$HOME\.local\share\whisper-cpp\models\ggml-large-v3-turbo-q5_0.bin"
  ```

**Install whisper-cli:**
- **macOS:** `brew install whisper-cpp`. It uses the Mac's GPU.
- **Windows:** the prebuilt zips are on the build releases (`b…` tags) of https://github.com/ggml-org/whisper.cpp/releases. `whisper-bin-x64.zip` runs on any 64-bit PC. With an NVIDIA graphics card, the CUDA build is much faster: `whisper-bin-win-cuda-12.4.0-x64.zip` (called `whisper-cublas-12.4.0-bin-x64.zip` in older releases); it needs a current NVIDIA driver. This unzips the newest CPU build where Mirage looks (use the CUDA name instead for the CUDA build):

  ```powershell
  $name = 'whisper-bin-x64.zip'
  $rel = Invoke-RestMethod 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=10' | Where-Object { $_.assets.name -contains $name } | Select-Object -First 1
  $zip = Join-Path $env:TEMP $name
  Invoke-WebRequest ($rel.assets | Where-Object name -eq $name).browser_download_url -OutFile $zip
  Expand-Archive $zip "$env:LOCALAPPDATA\whisper-cpp" -Force
  Get-ChildItem "$env:LOCALAPPDATA\whisper-cpp" -Recurse -Filter whisper-cli.exe
  ```

  If `whisper-cli.exe` landed in another subfolder, set `WORDEDITS_WHISPER_DIR` to that folder (`setx WORDEDITS_WHISPER_DIR "<folder>"`), then restart Claude Code.
- **Linux:** build it (`git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp && cmake -B build && cmake --build build -j --config Release`), then put `build/bin` on PATH or point `WORDEDITS_WHISPER_DIR` at it.

**Download the model** (about 574 MB; ask first):
- macOS and Linux:

  ```bash
  mkdir -p ~/.local/share/whisper-cpp/models
  curl -L --fail -o ~/.local/share/whisper-cpp/models/ggml-large-v3-turbo-q5_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
  ```

- Windows:

  ```powershell
  New-Item -ItemType Directory -Force "$HOME\.local\share\whisper-cpp\models" | Out-Null
  Invoke-WebRequest https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin -OutFile "$HOME\.local\share\whisper-cpp\models\ggml-large-v3-turbo-q5_0.bin"
  ```

Another model from the same page works too: set `WORDEDITS_WHISPER_MODEL` to its file. Keep its `ggml-<name>.bin` file name, which tells Mirage how to time the words; a renamed or fine-tuned model still works, with rougher word times.

**Then:** call `status` again: `transcriber: ok`. Installing needs no restart; setting a `WORDEDITS_WHISPER_*` variable does (start a new Claude Code session).

---

## Step 4b · Kokoro, the AI narration voice (optional; Mirage fetches it)

Mirage reads narration lines aloud with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) when the person doesn't record a voice-over (the `speak` tool). It runs on this computer with Node, on macOS, Windows and Linux: no account, no key, nothing uploaded. Nothing to install by hand: the first `speak` installs the `kokoro-js` packages with npm (about 170 MB) and downloads the voice model (`onnx-community/Kokoro-82M-v1.0-ONNX`, 8-bit, 92 MB) into Mirage's data folder, once. Synthesis takes about half a minute per minute of narration on a recent Mac.

**Check:** the `tts:` line of `status`.
- `tts: ok`: ready.
- `tts: not downloaded yet — speak downloads … into <folder> the first time it runs`: nothing to do now. Tell the person the first AI narration downloads about 260 MB.
- `tts: missing — npm was not found …`: Mirage needs the npm that comes with Node. Check `npm --version`; if it's missing, reinstall Node (step 1), which brings npm.

**If a download failed half-way** (`Kokoro could not be loaded …`): check the internet connection and run `speak` again. If it keeps failing, delete the folder the `tts:` line named and run `speak` again; it starts over.

---

## Step 5 · HyperFrames (job 4, the animator; later, Phase 4)

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

## Step 6 · Chrome + Claude in Chrome (job 5, the researcher; later, Phase 4)

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

## Step 7 · Tella and Epidemic Sound (jobs 6 and 7; later, optional)

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

## Step 8 · Final check

Call `mcp__plugin_mirage_engine__status` again, and run:

```bash
node --version
claude --version
ffmpeg -version | head -1
```

The `transcriber:` line of `status` is the speech check, and its `tts:` line the AI voice check.

For a later tool the person set up, also run its check (`npx hyperframes --version`, `claude mcp list`, or ask them to run `/chrome` and read the status).

Then give the person one table, one row per tool, each with ✓ (working), – (later or optional, not set up) or ✗ (needs the person), and what to do:

| Tool | | What to do |
|---|---|---|
| Node.js 22+ | | |
| Claude Code | | |
| FFmpeg | | |
| whisper.cpp + model (speech) | | |
| Kokoro (AI narration voice) | | |
| HyperFrames | | |
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
- *[whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) (checked 2026-11-05: Windows zips are on the `b…` build releases) and [models](https://huggingface.co/ggerganov/whisper.cpp)*
