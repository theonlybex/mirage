---
name: update
description: "Check whether Mirage and the tools it uses (Node, FFmpeg, whisper.cpp, yt-dlp, Claude Code) have newer versions, list what is out of date, and update only what the person agrees to. Use when the session start says the weekly update check is due, or the person asks whether Mirage or its tools are up to date."
---

# Keeping Mirage's tools up to date

**For the person:** Mirage checks its tools for newer versions once a week, at the start of a session in a Mirage project. To check any time, type `/mirage:update`. Nothing is updated without your yes.

**For Claude:**

**Rules**
- Check everything first, then ask once. Never update before the person says yes, and update only what they name.
- Don't update while Mirage is cutting or rendering a video in this session. Wait until it's finished.
- Only check tools that are installed. A missing tool is the mirage:setup skill's job, not this one.
- The speech model and the Kokoro voice come with Mirage itself: Mirage picks their versions, so they aren't checked on their own. Updating Mirage updates them if it needs to.
- Don't print or ask for any key or password.

**Platforms:** macOS commands come first. The Windows commands are for PowerShell.

---

## Step 1 · Find what's out of date

Run these, then fill one row per installed tool: what the person has, and the newest version.

**Mirage itself**
- What's installed: the `version` in `.claude-plugin/plugin.json`, two folders up from this skill's folder.
- The newest: refresh the marketplace, then read the same file in its copy:

  ```bash
  claude plugin marketplace update mirage
  cat ~/.claude/plugins/marketplaces/mirage/plugin/.claude-plugin/plugin.json
  ```

  (Windows: the same folder under `$HOME\.claude\plugins\marketplaces\mirage`.) If that folder isn't there, `claude plugin marketplace list` shows the marketplace's name: use that folder instead. If no marketplace holds Mirage, it was loaded from a local folder (someone working on Mirage itself): skip this row and say so.

**On a Mac, the Homebrew tools** (FFmpeg, whisper.cpp, Node, yt-dlp). `brew update` refreshes the list of versions and can take a minute:

```bash
brew update --quiet
brew list --formula --versions ffmpeg-full ffmpeg whisper-cpp node yt-dlp 2>/dev/null
brew outdated --formula --verbose ffmpeg-full ffmpeg whisper-cpp node yt-dlp 2>/dev/null
```

The second line shows what's installed and the third what's out of date (`name (yours) < newest`). Names missing from the second line aren't installed through Homebrew: leave them out, except Node (below). Newer Homebrew calls whisper-cpp `whisper.cpp` and prints a rename warning; the old name still works with every Homebrew, so keep using it.

If the second line shows a plain `ffmpeg` and no `ffmpeg-full`, Mirage's FFmpeg can't draw captions: say so and point to mirage:setup step 3, rather than offering to update the plain one.

**On Windows** (Node, FFmpeg, yt-dlp):

```powershell
winget list --upgrade-available --accept-source-agreements | Select-String 'OpenJS.NodeJS|Gyan.FFmpeg|yt-dlp.yt-dlp'
```

This only lists: each matching line shows the ID, the version the person has and the newest one. No line means up to date (or not installed through winget). Don't use `winget upgrade --id …` to check: it installs.

whisper.cpp on Windows is the zip from mirage:setup step 4. Compare the date of the person's `whisper-cli.exe` with the newest build release that has the same zip:

```powershell
(Get-ChildItem "$env:LOCALAPPDATA\whisper-cpp" -Recurse -Filter whisper-cli.exe | Select-Object -First 1).LastWriteTime
(Invoke-RestMethod 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=10' | Where-Object { $_.assets.name -contains 'whisper-bin-x64.zip' } | Select-Object -First 1) | Select-Object tag_name, published_at
```

**Node not installed by Homebrew or winget** (nvm, Volta, the nodejs.org installer): compare `node --version` with the newest LTS:

```bash
curl -fsSL https://nodejs.org/dist/index.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).find(v=>v.lts);console.log(r.version,r.lts)})'
```

**Claude Code:** `claude --version`. The desktop app and the native installer update themselves, so only mention it if the person asks.

**On Linux**, whisper.cpp is built from its source folder, so say whether its folder is behind (`git -C <folder> fetch && git -C <folder> status -sb`) and leave rebuilding to the person.

---

## Step 2 · Tell the person, and ask once

- **Everything current:** say so in one line, for example "All of Mirage's tools are up to date." and stop.
- **Something is out of date:** give one short table, then ask one question naming what you'd update:

  | Tool | You have | Newest |
  |---|---|---|
  | FFmpeg | 8.0.1 | 8.1 |

  Under the table, add one plain line for anything that needs care:
  - A **major** version jump (Node 24 → 26, FFmpeg 8 → 9): this version of Mirage hasn't been tried with it yet. Suggest waiting unless the person wants it.
  - **yt-dlp:** YouTube changes its pages often, so an old yt-dlp is the usual reason `mirage:analyse` or `mirage:learn` stops working. Updating it is low-risk.
  - **Mirage:** it restarts nothing by itself. The person starts a new Claude Code session afterwards.

If the person says not now, do nothing: Mirage checks again next week, and `/mirage:update` works any time.

---

## Step 3 · Update what they agreed to

- **Mirage:** `claude plugin update mirage@mirage` (use the marketplace name from step 1 after the `@` if it differs). Then tell the person to start a new Claude Code session.
- **Mac, Homebrew tools:** `brew upgrade <names>`, only the names they agreed to, for example `brew upgrade ffmpeg-full yt-dlp`. Leave the plain `ffmpeg` alone if `ffmpeg-full` is the one Mirage uses.
- **Windows:** `winget upgrade --id <id> -e` for each agreed ID. Then start a new Claude Code session so Mirage sees the new PATH.
- **whisper.cpp on Windows:** run the download in mirage:setup step 4 again. It unzips over the old one.
- **Node outside Homebrew or winget:** tell the person how their installer updates (`nvm install --lts`, `volta install node@lts`, or the installer from https://nodejs.org). Then they quit Claude Code completely and open it again.

After a Node update on any platform, Mirage's engine is still running on the old Node: the person quits Claude Code completely and opens it again.

---

## Step 4 · Check

Call `mcp__plugin_mirage_engine__status` and read its tool lines (`ffmpeg: ok`, `transcriber: ok`, `Node: v… ok`, `tts: …`). Each one should still say ok. If one doesn't, follow that tool's step in mirage:setup.

Finish with one line per tool updated (old → new), and say if a restart is still needed.
