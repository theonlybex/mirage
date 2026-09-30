# WordEdits

Claude Code for video editing: describe the video, get a script, record one take, and the app cuts, captions, renders and uploads it.

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
