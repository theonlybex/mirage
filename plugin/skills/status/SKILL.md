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
- `Series “<name>” (series/<slug>/, <format>): videos <n>, <n> · open question: “…”`, one per series: the videos it groups, in order, and the question its latest episode left open, which the next episode starts from. `· no open question on record` means none was recorded yet: the mirage:edit skill records it after an episode's final render. The folder `series/<slug>/` holds what the series carries from episode to episode (`series.json`) and a `README.md` listing each episode's title, stage and files; the videos themselves stay in `episodes/<n>/`. A `✖ series/<slug>/series.json: <issue>` line means that file was edited and broke, so the series is left out: offer to fix what the line names.
- `Viewer: running at <url>`: offer to open it (in the Claude desktop app, the browser pane; in the terminal, `open "<url>"` with Bash). `Viewer: not running`: it starts the next time they open Claude Code in this folder.
- `Formats: <id>, <id>, …`: the kinds of video Mirage makes (build story, short, vlog …); mention them only if the person asks what Mirage can make. A `✖ plugin/formats/<file>: <issue>` line means that format file is broken and left out, while the other formats still work: if the person added or edited it, offer to fix what the line names; otherwise suggest reinstalling the Mirage plugin.
- `Formulas: <id>, <id>, …`: what Mirage has measured about why videos do well (the general procedure, how YouTube recommends, one per format); these are Mirage's own and can't be changed. `; yours: <id>, …` after them lists the formulas the person saved in the project's `formulas/` folder with the mirage:analyse skill. Mention them only if the person asks what Mirage knows about making videos do well, or where their analysis went. A `✖ formulas/<file>: <issue>` line means one of the person's formula files is broken and left out: offer to fix what the line names (`"<id>" is one of Mirage's own formulas, which can't be changed — save yours under another name`: rename the file and its `id`). A `✖ plugin/formulas/<file>: <issue>` line means one of Mirage's own is broken: suggest reinstalling the Mirage plugin.
- `Results: <k> videos posted · last read <day>`: how many videos the person said are live, and the last day Mirage read how they did (views, likes, comments). `· learn is due: video <n> (<read> read), …` after it names the videos with a read due: Mirage reads each posted video 3 days after it went up (the early read), at 7 days (the main read) and at 28 days (the late read). Offer to run the mirage:learn skill, which reads them and improves the person's formula. `· not read yet` means none was read so far. `Results: no video posted yet`: nothing to do; when a video goes live, the mirage:learn skill records it.
- The tool lines:
  - `ffmpeg: missing` or `ffprobe: missing`: Mirage can't read or render video. Suggest `/mirage:setup`.
  - `ffmpeg: can't draw captions — <path> was built without libass. <hint>`: Mirage can read video, but it can't draw captions or text, so it can't render. Say so in plain words, give the hint's install (on a Mac, Homebrew's complete build, `brew install ffmpeg-full`), and suggest `/mirage:setup`.
  - `transcriber: missing — …`: Mirage can't hear the footage. The rest of the line says which part of speech recognition is missing: `whisper-cli` (the whisper.cpp program), the speech model file, or both. Say which, in plain words, and suggest `/mirage:setup` (its step 4 installs them).
  - `Node: … is too old`: Mirage needs Node 22 or newer. Suggest `/mirage:setup`.
  - `tts: ok`: AI narration (the Kokoro voice) is ready. `tts: not downloaded yet …`: fine; the first AI narration downloads it (the line says how much). `tts: missing — …`: AI narration can't be set up; say what the line says and suggest `/mirage:setup`.

If everything is fine, say so in one line.

Mirage asks at the start of a session whether to install what's missing. When the person says "not now", `mcp__plugin_mirage_engine__setup_later` stops that for 7 days, so it doesn't nag. If they ask why Mirage stopped asking, that is why; `/mirage:setup` works any time.
