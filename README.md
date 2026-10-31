# WordEdits

Claude Code for video editing: describe the video, get a script, record one take, and the app cuts, captions, renders and uploads it.

## Make a Mirage episode (macOS 26+)

```bash
pnpm install && pnpm build:native
pnpm mirage init ~/Mirage/weather-app --title "Weather app"
pnpm mirage ingest ~/Mirage/weather-app ~/Movies/weather-app/batch-1
# put music in ~/Mirage/weather-app/music, then:
pnpm mirage music ~/Mirage/weather-app
```

Then ask Claude (in this repo) to make episode 1: it describes your clips, writes `episodes/1/episode.json`, and runs `pnpm mirage cut` so you can watch the rough cut. When the cut is right it writes the narration lines (`slots`) and renders `guide.mp4`. Play the guide, narrate along in one take, then:

```bash
pnpm mirage vo ~/Mirage/weather-app 1 ~/Desktop/voiceover.m4a
pnpm mirage render ~/Mirage/weather-app 1
```

`episodes/1/final.mp4` and `final.srt` are ready to upload. The workflow Claude follows is in `.claude/skills/mirage-episode/SKILL.md`.

Design spec: `docs/superpowers/specs/2026-09-28-wordedits-design.md`. Plans: `docs/superpowers/plans/`.

## Develop

```bash
npm i -g pnpm
pnpm install          # also downloads ffmpeg/ffprobe static builds for dev
pnpm test             # unit + integration (uses fixtures/)
pnpm typecheck
pnpm render <edl.json> <input.mp4> [preview|final]
```

`pnpm install` runs the `ffmpeg-static` postinstall script because `pnpm-workspace.yaml` allows builds for `ffmpeg-static` and `esbuild` (pnpm 12 blocks postinstall scripts otherwise).

FFmpeg resolution order: `WORDEDITS_FFMPEG_DIR`, then PATH, then the `ffmpeg-static` package.

## Layout

- `packages/shared` – zod schemas and types for every project file
- `packages/sidecars` – ffmpeg/ffprobe location, spawning, parsing
- `packages/core` – project store, EDL compiler, render orchestrator (no Electron)
- `fixtures/` – tiny generated MP4s for tests (`pnpm fixtures` regenerates)
