# Mirage

Mirage edits build-story videos inside Claude Code: drop your footage, watch the edit appear live, and leave notes on the video itself. It runs in Claude Code.

## Install

Mac only for now (macOS 26 or later). Windows comes later.

1. Install Claude Code (https://claude.com/download) and sign in.
2. In Claude Code, add this repository as a plugin marketplace, then install the plugin:

   ```
   /plugin marketplace add <this repository>
   /plugin install mirage@mirage
   ```

3. Start a new session and run `/mirage:setup`. Claude checks that Node, FFmpeg and the Xcode Command Line Tools are installed, and installs what is missing after asking you.
4. Open Claude Code in a new folder and say "make a video".

**Privacy.** Your footage and project files stay on your Mac, and the live viewer listens only on your own computer. Claude reads still frames and speech text from your clips to describe them, and that goes to Anthropic like anything else in a Claude Code session, so don't record screens that show secrets.

**Overnight.** For long renders, keep the Mac plugged in with the lid open, and switch Claude Code to auto mode (press Shift+Tab until it says "auto") so nothing waits for a yes while you sleep. The screen can be off.

**Licence.** Mirage is AGPL-3.0-or-later. Contributions are welcome under the same licence, with a DCO sign-off (`git commit -s`); see `CONTRIBUTING.md`.

## Make an episode from the command line (macOS 26+)

```bash
pnpm install && pnpm build:native
pnpm mirage init ~/Mirage/weather-app --title "Weather app"
pnpm mirage ingest ~/Mirage/weather-app ~/Movies/weather-app/batch-1
# put music in ~/Mirage/weather-app/music, then:
pnpm mirage music ~/Mirage/weather-app
```

Paths may be relative to the folder you run `pnpm` from; every command but `init` needs a folder made by `init`, and `init` never touches an existing project.

`music` writes `music/library.json` with each track's tempo. Set every track's `mood` (`punchy`, `light`, `tension`, `upbeat`, `riser`, `reveal`, `relaxed`) and `licence` there (Claude picks music by mood). Ingest extracts still frames from every clip into `frames/`, and Claude reads them (they are sent to Anthropic) to describe your footage: don't record screens showing secrets.

Then ask Claude (in this repo) to make episode 1: it describes your clips, writes `episodes/1/episode.json`, and runs `pnpm mirage cut` so you can watch the rough cut. When the cut is right it writes the narration lines (`slots`) and renders `guide.mp4`. Play the guide, narrate along in one take, then:

```bash
pnpm mirage vo ~/Mirage/weather-app 1 ~/Desktop/voiceover.m4a
pnpm mirage render ~/Mirage/weather-app 1
```

If some lines were missing, record just those (under a new file name, not over the first recording) and add them with `pnpm mirage vo ~/Mirage/weather-app 1 ~/Desktop/missing.m4a --add`. `episodes/1/final.mp4` and `final.srt` are ready to upload. The workflow Claude follows is the plugin's `edit` skill, in `plugin/skills/edit/SKILL.md`.

Design spec: `docs/superpowers/specs/2026-09-28-wordedits-design.md`. Plans: `docs/superpowers/plans/`.

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

## Layout

- `packages/shared` – zod schemas and types for every project file
- `packages/sidecars` – ffmpeg/ffprobe location, spawning, parsing
- `packages/core` – the Mirage engine: catalog, timeline, render, voice-over (no Electron)
- `packages/mcp`, `packages/hooks`, `packages/viewer` – the plugin's engine server, hooks and live viewer
- `plugin/` – the Claude Code plugin (skills, manifests, and the generated `dist/`); `.claude-plugin/marketplace.json` makes this repository its own marketplace
- `fixtures/` – tiny generated MP4s for tests (`pnpm fixtures` regenerates)
