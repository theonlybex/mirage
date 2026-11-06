# Mirage

Mirage edits build-story videos inside Claude Code: drop your footage, watch the edit appear live, and leave notes on the video itself. It runs in Claude Code.

## Install

Made and tested on the Mac. Speech recognition uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp), which also runs on Windows and Linux; the rest of the plugin isn't ready for Windows yet.

1. Install Claude Code (https://claude.com/download) and sign in.
2. In Claude Code, add this repository as a plugin marketplace, then install the plugin:

   ```
   /plugin marketplace add <this repository>
   /plugin install mirage@mirage
   ```

3. Start a new session and run `/mirage:setup`. Claude checks that Node, FFmpeg and whisper.cpp (with its speech model, about 574 MB) are installed, and installs what is missing after asking you.
4. Open Claude Code in a new folder and say "make a video".

**Privacy.** Your footage and project files stay on your Mac, and the live viewer listens only on your own computer. Claude reads still frames and speech text from your clips to describe them, and that goes to Anthropic like anything else in a Claude Code session, so don't record screens that show secrets.

**Overnight.** For long renders, keep the Mac plugged in with the lid open, and switch Claude Code to auto mode (press Shift+Tab until it says "auto") so nothing waits for a yes while you sleep. The screen can be off.

**Licence.** Mirage is MIT-licensed. Contributions are welcome under the same licence, with a DCO sign-off (`git commit -s`); see `CONTRIBUTING.md`.

## Develop

```bash
npm i -g pnpm
pnpm install          # also downloads ffmpeg/ffprobe static builds for dev
pnpm test             # unit + integration (uses fixtures/)
pnpm typecheck
pnpm build:plugin     # rebuilds plugin/dist (the engine, hooks and viewer bundles); commit the result
```

`pnpm install` runs the `ffmpeg-static` postinstall script because `pnpm-workspace.yaml` allows builds for `ffmpeg-static` and `esbuild` (pnpm 12 blocks postinstall scripts otherwise).

FFmpeg resolution order: `WORDEDITS_FFMPEG_DIR`, then PATH, then the `ffmpeg-static` package.

Speech recognition runs `whisper-cli` from whisper.cpp (macOS: `brew install whisper-cpp`; Windows: `whisper-bin-x64.zip` from its releases). It is found in `WORDEDITS_WHISPER_DIR`, then PATH, then `/opt/homebrew/bin`, `/usr/local/bin` or `%LOCALAPPDATA%\whisper-cpp`. The model is `WORDEDITS_WHISPER_MODEL`, by default `~/.local/share/whisper-cpp/models/ggml-large-v3-turbo-q5_0.bin` ([download](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin)). Without them the speech tests are skipped.

`pnpm build:plugin` also writes `plugin/LICENSE` and `plugin/THIRD_PARTY_NOTICES.txt` (the licence of every npm package bundled into `plugin/dist`).

### Developer CLI

For working on the engine without Claude Code, the same steps run from the command line. People making videos use the plugin; Claude runs these steps through its engine tools, never through `pnpm`.

```bash
pnpm mirage init ~/Mirage/weather-app --title "Weather app"
pnpm mirage ingest ~/Mirage/weather-app ~/Movies/weather-app/batch-1
pnpm mirage music ~/Mirage/weather-app        # with tracks in ~/Mirage/weather-app/music
pnpm mirage cut ~/Mirage/weather-app 1        # after writing episodes/1/episode.json
pnpm mirage vo ~/Mirage/weather-app 1 ~/Desktop/voiceover.m4a
pnpm mirage render ~/Mirage/weather-app 1
```

Paths may be relative to the folder you run `pnpm` from; every command but `init` needs a folder made by `init`, and `init` never touches an existing project. The workflow Claude follows is the plugin's `edit` skill, in `plugin/skills/edit/SKILL.md`.

Design: `docs/superpowers/specs/2026-11-02-mirage-plugin-design.md` (the plugin) and `docs/superpowers/specs/2026-11-02-mirage-product-design.md` (the product). Plans: `docs/superpowers/plans/`.

## Layout

- `packages/shared` – zod schemas and types for every project file
- `packages/sidecars` – ffmpeg/ffprobe and whisper.cpp location, spawning, parsing
- `packages/core` – the Mirage engine: catalog, timeline, render, voice-over (no Electron)
- `packages/mcp`, `packages/hooks`, `packages/viewer` – the plugin's engine server, hooks and live viewer
- `plugin/` – the Claude Code plugin (skills, manifests, and the generated `dist/`); `.claude-plugin/marketplace.json` makes this repository its own marketplace
- `fixtures/` – tiny generated MP4s for tests (`pnpm fixtures` regenerates), and a recorded whisper-cli result (`fixtures/whisper/`)
