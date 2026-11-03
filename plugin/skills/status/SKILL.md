---
name: status
description: "Say where a Mirage project stands: each video's stage and versions, whether Mirage's viewer is running, and whether the tools Mirage needs are installed. Use when the person asks how their videos are doing, what is next, or whether Mirage is working."
---

# Where things stand

Call `mcp__plugin_mirage_engine__status` (no input) and explain what it says in a few plain lines. Don't paste its output.

- `Project: <title>`: the series. `No Mirage project here yet …`: offer to start one; making a video (the mirage:edit skill) begins with that.
- `Video <n> “<title>”: <stage> · <k> deliveries`, one per video. Say what each stage means and what comes next:
  - `new`: started, no cut yet. Next: the rough cut.
  - `rough`: the rough cut is ready to watch. Next: leave notes in Mirage's viewer, or ask for the narration lines.
  - `guide`: the guide cut is ready. Next: record the voice-over along with it and drop the recording in the viewer.
  - `final`: the finished video is ready.

  The deliveries are the versions they can watch in the viewer (V1, V2 …).
- `Viewer: running at <url>`: offer to open it (in the Claude desktop app, the browser pane; in the terminal, `open "<url>"` with Bash). `Viewer: not running`: it starts the next time they open Claude Code in this folder.
- The tool lines:
  - `ffmpeg: missing` or `ffprobe: missing`: Mirage can't read or render video. Suggest `/mirage:setup`.
  - `transcriber: missing`: run `xcode-select -p` with Bash. If it fails, say "Speech recognition needs Xcode Command Line Tools: run `xcode-select --install`". If it works, the speech helper is built when Claude Code starts (about 30 seconds the first time): suggest starting a new session in a minute.
  - `Node: … is too old`: Mirage needs Node 22 or newer. Suggest `/mirage:setup`.

If everything is fine, say so in one line.
