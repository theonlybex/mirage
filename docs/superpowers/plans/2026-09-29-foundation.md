# WordEdits Foundation (Sub-project 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A headless TypeScript core that takes an `edl.json` plus a source video and produces a verified MP4 through FFmpeg, with typed schemas, a project store, and sidecar wrappers that every later sub-project builds on.

**Architecture:** pnpm monorepo with four packages. `shared` holds zod schemas and types; `sidecars` locates and runs ffmpeg/ffprobe and parses their output; `core` holds the project store, the EDL compiler (EDL → FFmpeg args) and the render orchestrator, depending on sidecars only through a `MediaTools` interface so tests can stub it. No Electron in this sub-project: everything runs from vitest and a small `tsx` script.

**Tech Stack:** Node 24, pnpm, TypeScript 5 (ESM, NodeNext), zod 4, execa 9, vitest, tsx, `ffmpeg-static` + `ffprobe-static` (dev-time binaries; locator also accepts `WORDEDITS_FFMPEG_DIR` or PATH).

**Spec:** `docs/superpowers/specs/2026-09-28-wordedits-design.md` (sections 4, 5, 6 Render, 7 Export, 10, 11 item 1)

## Global Constraints

- Node `>=22`; ESM only (`"type": "module"`), `module: NodeNext`, `strict: true`.
- No Python, no bundled browser, no database. Project data is JSON files in one folder per project (spec §3.7, §5).
- `packages/core` must not import `electron` or `@wordedits/sidecars` directly; it reaches sidecars only via the `MediaTools` interface (spec §4 module boundaries).
- All JSON files are validated with zod on read and write (spec §5).
- Sidecar processes are spawned with argument arrays, never shell strings; every call has a timeout and captured stderr, and failures become a structured error `{ tool|stage, code, message, hint }` (spec §9).
- Render output follows the YouTube spec: MP4 `+faststart`, H.264 High, closed GOP, 2 B-frames where the encoder supports it, yuv420p, BT.709; 1080p ≤40 fps → 8 Mbps, 1080p >40 fps → 12 Mbps, 2160p → 40 Mbps; AAC-LC 48 kHz 384 kbps stereo; fps = source (spec §7 Export).
- Audio chain on the final mix: high-pass 90 Hz → loudnorm to −14 LUFS, true peak −1 dBTP (spec §7 Audio; denoise/compressor are added by sub-project 3).
- Encoder: `h264_videotoolbox` on Apple Silicon, `h264_nvenc` on NVIDIA, `libx264` fallback, chosen by a real test encode (spec §4).
- Commit after every task with the attribution line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **Source file with no audio track** → import/render must stop with error code `NO_AUDIO` and a hint, not an FFmpeg crash. Pinned in Task 5 (probe reports `hasAudio: false`) and Task 9 (render throws `RenderError NO_AUDIO`).
2. **EDL with impossible ranges** (`src.out <= src.in`, a cut outside its scene, a cut that removes the whole scene) → schema or compiler rejects with a message naming the scene, never a broken concat. Pinned in Task 2 (schema) and Task 8 (compiler `EMPTY_SCENE`).
3. **Paths with spaces, quotes or non-ASCII** (project titles like `My Video: "Test" ✨`) → slug is safe, and files inside such a folder render. Pinned in Task 7 (slug) and Task 9 (render inside a directory containing a space and a quote).
4. **Fractional frame rates** (`30000/1001` from phones and cameras) → probe reports 29.97 and the output keeps it. Pinned in Task 5 (`parseFps`) and Task 8 (fps filter uses the source fps).
5. **FFmpeg missing or broken** → a clear error with an install hint instead of `ENOENT`. Pinned in Task 3.

---

### Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.npmrc`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/index.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: workspace package name `@wordedits/shared` importable from other packages; root scripts `pnpm test`, `pnpm typecheck`.

- [ ] **Step 1: Install pnpm**

Run:
```bash
npm i -g pnpm && pnpm --version
```
Expected: a version ≥ 10 prints.

- [ ] **Step 2: Write the root files**

`package.json`:
```json
{
  "name": "wordedits",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b packages/shared packages/sidecars packages/core",
    "fixtures": "tsx scripts/make-fixtures.ts",
    "render": "tsx scripts/render.ts"
  }
}
```
(`packages/sidecars` and `packages/core` are added in Tasks 3 and 7; `tsc -b` on a missing path fails until then, which is expected.)

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
```

`.npmrc`:
```
auto-install-peers=true
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true,
    "sourceMap": true,
    "types": ["node"]
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
```

Append to `.gitignore`:
```
packages/*/dist/
*.tsbuildinfo
fixtures/tmp/
```

- [ ] **Step 3: Write the shared package**

`packages/shared/package.json`:
```json
{
  "name": "@wordedits/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    }
  }
}
```

`packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/shared/src/index.ts`:
```ts
export const WORDEDITS_VERSION = '0.0.1';
```

`packages/shared/src/index.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { WORDEDITS_VERSION } from './index.js';

describe('shared', () => {
  it('exports a version', () => {
    expect(WORDEDITS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 4: Install dev dependencies and run the test**

Run:
```bash
pnpm add -Dw typescript vitest tsx @types/node && pnpm test
```
Expected: `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: pnpm workspace with shared package and vitest

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Schemas for every project file

**Files:**
- Create: `packages/shared/src/schemas/edl.ts`, `script.ts`, `brief.ts`, `project.ts`, `transcript.ts`, `takes.ts`, `probe.ts`
- Create: `packages/shared/src/schemas/edl.test.ts`, `packages/shared/src/schemas/project.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces (all exported from `@wordedits/shared`): `EdlSchema`, `SceneSchema`, types `Edl`, `Scene`, `Zoom`; `ScriptSchema`/`Script`/`ScriptBlock`; `BriefSchema`/`Brief`; `ProjectSchema`/`Project`/`Stage`; `TranscriptSchema`/`Transcript`/`Word`; `TakesSchema`/`Takes`; `ProbeInfoSchema`/`ProbeInfo`.

- [ ] **Step 1: Add zod**

Run:
```bash
pnpm --filter @wordedits/shared add zod@^4
```

- [ ] **Step 2: Write the failing EDL tests**

`packages/shared/src/schemas/edl.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { EdlSchema } from './edl.js';

const base = {
  version: 1,
  output: { width: 1920, height: 1080, fps: 30 },
  scenes: [{ id: 's1', src: { in: 0.5, out: 2.5 }, cuts: [[1.0, 1.4]] }],
};

describe('EdlSchema', () => {
  it('parses a minimal EDL and fills defaults', () => {
    const edl = EdlSchema.parse(base);
    expect(edl.scenes[0].zoom).toEqual({ scale: 1, anchor: { x: 0.5, y: 0.4 } });
    expect(edl.scenes[0].captions).toBe(true);
    expect(edl.audio.loudnessLufs).toBe(-14);
    expect(edl.endScreen.seconds).toBe(12);
  });

  it('rejects src.out <= src.in and names the scene', () => {
    const r = EdlSchema.safeParse({ ...base, scenes: [{ id: 'bad', src: { in: 2, out: 2 } }] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('scene bad');
  });

  it('rejects a cut outside the scene range', () => {
    const r = EdlSchema.safeParse({
      ...base,
      scenes: [{ id: 's1', src: { in: 1, out: 2 }, cuts: [[0.5, 1.5]] }],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('outside');
  });

  it('rejects an empty scene list', () => {
    expect(EdlSchema.safeParse({ ...base, scenes: [] }).success).toBe(false);
  });

  it('rejects zoom scale above 2', () => {
    const r = EdlSchema.safeParse({
      ...base,
      scenes: [{ id: 's1', src: { in: 0, out: 1 }, zoom: { scale: 2.5 } }],
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run packages/shared/src/schemas/edl.test.ts`
Expected: FAIL, cannot find module `./edl.js`.

- [ ] **Step 4: Write the EDL schema**

`packages/shared/src/schemas/edl.ts`:
```ts
import { z } from 'zod';

export const ZoomSchema = z.object({
  scale: z.number().min(1).max(2),
  anchor: z
    .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
    .default({ x: 0.5, y: 0.4 }),
});
export type Zoom = z.infer<typeof ZoomSchema>;

export const SceneSchema = z
  .object({
    id: z.string().min(1),
    blockId: z.string().optional(),
    src: z.object({ in: z.number().min(0), out: z.number().positive() }),
    cuts: z.array(z.tuple([z.number(), z.number()])).default([]),
    zoom: ZoomSchema.default({ scale: 1, anchor: { x: 0.5, y: 0.4 } }),
    title: z.object({ text: z.string(), style: z.enum(['section', 'lower-third']) }).optional(),
    captions: z.boolean().default(true),
    markers: z.array(z.string()).default([]),
  })
  .superRefine((s, ctx) => {
    if (s.src.out <= s.src.in) {
      ctx.addIssue({ code: 'custom', message: `scene ${s.id}: src.out must be greater than src.in` });
    }
    for (const [a, b] of s.cuts) {
      if (a >= b || a < s.src.in || b > s.src.out) {
        ctx.addIssue({ code: 'custom', message: `scene ${s.id}: cut [${a}, ${b}] is outside the scene range` });
      }
    }
  });
export type Scene = z.infer<typeof SceneSchema>;

export const EdlSchema = z.object({
  version: z.literal(1),
  output: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
  }),
  scenes: z.array(SceneSchema).min(1),
  audio: z
    .object({
      music: z.object({ track: z.string(), gainDb: z.number(), duck: z.boolean() }).nullable(),
      loudnessLufs: z.number(),
    })
    .default({ music: null, loudnessLufs: -14 }),
  captions: z
    .object({ style: z.string(), maxChars: z.number().int().positive(), lines: z.number().int().positive() })
    .default({ style: 'clean-bottom', maxChars: 38, lines: 2 }),
  endScreen: z.object({ seconds: z.number().min(0).max(20) }).default({ seconds: 12 }),
});
export type Edl = z.infer<typeof EdlSchema>;
```

- [ ] **Step 5: Run the EDL test to verify it passes**

Run: `pnpm vitest run packages/shared/src/schemas/edl.test.ts`
Expected: 5 passed.

- [ ] **Step 6: Write the failing project test**

`packages/shared/src/schemas/project.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ProjectSchema } from './project.js';

describe('ProjectSchema', () => {
  it('parses a new project', () => {
    const p = ProjectSchema.parse({
      id: 'abc123',
      title: 'My Video',
      createdAt: '2026-09-29T10:00:00.000Z',
      stage: 'start',
      format: 'talking-head',
      source: null,
    });
    expect(p.stage).toBe('start');
  });

  it('rejects an unknown stage', () => {
    expect(
      ProjectSchema.safeParse({
        id: 'x', title: 't', createdAt: '2026-09-29T10:00:00.000Z',
        stage: 'timeline', format: 'talking-head', source: null,
      }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `pnpm vitest run packages/shared/src/schemas/project.test.ts`
Expected: FAIL, cannot find module `./project.js`.

- [ ] **Step 8: Write the remaining schemas**

`packages/shared/src/schemas/project.ts`:
```ts
import { z } from 'zod';

export const StageSchema = z.enum(['start', 'script', 'import', 'review', 'publish']);
export type Stage = z.infer<typeof StageSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().datetime(),
  stage: StageSchema,
  format: z.literal('talking-head'),
  source: z.object({ path: z.string(), sha256: z.string().length(64) }).nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;
```

`packages/shared/src/schemas/script.ts`:
```ts
import { z } from 'zod';

export const ScriptBlockSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['hook', 'section', 'cta']),
  title: z.string().optional(),
  text: z.string(),
  order: z.number().int().min(0),
});
export type ScriptBlock = z.infer<typeof ScriptBlockSchema>;

export const ScriptSchema = z.object({ blocks: z.array(ScriptBlockSchema) });
export type Script = z.infer<typeof ScriptSchema>;
```

`packages/shared/src/schemas/brief.ts`:
```ts
import { z } from 'zod';

export const BriefSchema = z.object({
  tone: z.string(),
  targetMinutes: z.number().positive(),
  audience: z.string(),
  pacing: z.enum(['natural', 'fast', 'extra-fast']),
  styleRefs: z.array(z.string()).default([]),
});
export type Brief = z.infer<typeof BriefSchema>;
/** Partially filled brief while the interview is in progress. */
export const BriefDraftSchema = BriefSchema.partial();
export type BriefDraft = z.infer<typeof BriefDraftSchema>;
```

`packages/shared/src/schemas/transcript.ts`:
```ts
import { z } from 'zod';

export const WordSchema = z.object({
  w: z.string(),
  start: z.number().min(0),
  end: z.number().min(0),
  conf: z.number().min(0).max(1),
});
export type Word = z.infer<typeof WordSchema>;

export const TranscriptSchema = z.object({
  words: z.array(WordSchema),
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
  speech: z.array(z.tuple([z.number(), z.number()])),
});
export type Transcript = z.infer<typeof TranscriptSchema>;
```

`packages/shared/src/schemas/takes.ts`:
```ts
import { z } from 'zod';

export const TakeSchema = z.object({
  id: z.string().min(1),
  start: z.number().min(0),
  end: z.number().min(0),
  score: z.number().min(0).max(1),
  text: z.string(),
});
export type Take = z.infer<typeof TakeSchema>;

export const TakesSchema = z.object({
  blocks: z.array(
    z.object({
      blockId: z.string().min(1),
      takes: z.array(TakeSchema),
      chosen: z.string().nullable(),
    }),
  ),
});
export type Takes = z.infer<typeof TakesSchema>;
```

`packages/shared/src/schemas/probe.ts`:
```ts
import { z } from 'zod';

export const ProbeInfoSchema = z.object({
  durationSec: z.number().min(0),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  fps: z.number().min(0),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
});
export type ProbeInfo = z.infer<typeof ProbeInfoSchema>;
```

Replace `packages/shared/src/index.ts`:
```ts
export const WORDEDITS_VERSION = '0.0.1';
export * from './schemas/edl.js';
export * from './schemas/script.js';
export * from './schemas/brief.js';
export * from './schemas/project.js';
export * from './schemas/transcript.js';
export * from './schemas/takes.js';
export * from './schemas/probe.js';
```

- [ ] **Step 9: Run all tests and typecheck**

Run: `pnpm test && pnpm tsc -p packages/shared`
Expected: 8 passed; tsc exits 0.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat(shared): zod schemas for project, script, brief, transcript, takes, edl, probe

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Sidecar locator and runner

**Files:**
- Create: `packages/sidecars/package.json`, `packages/sidecars/tsconfig.json`, `packages/sidecars/src/vendor.d.ts`
- Create: `packages/sidecars/src/errors.ts`, `packages/sidecars/src/locate.ts`, `packages/sidecars/src/run.ts`, `packages/sidecars/src/index.ts`
- Create: `packages/sidecars/src/locate.test.ts`, `packages/sidecars/src/run.test.ts`

**Interfaces:**
- Produces: `class SidecarError extends Error { tool: string; code: string; message: string; hint: string; stderr: string }`; `locate(tool: 'ffmpeg' | 'ffprobe'): Promise<string>` (absolute path); `run(tool, args: string[], opts?: { timeoutMs?: number; onStdoutLine?: (line: string) => void }): Promise<{ stdout: string; stderr: string }>`.

- [ ] **Step 1: Create the package and install deps**

`packages/sidecars/package.json`:
```json
{
  "name": "@wordedits/sidecars",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" }
  }
}
```

`packages/sidecars/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../shared" }]
}
```

`packages/sidecars/src/vendor.d.ts`:
```ts
declare module 'ffmpeg-static' {
  const ffmpegPath: string | null;
  export default ffmpegPath;
}
declare module 'ffprobe-static' {
  export const path: string;
}
```

Run:
```bash
pnpm --filter @wordedits/sidecars add execa@^9 ffmpeg-static ffprobe-static @wordedits/shared@workspace:*
```
Expected: installs; `ffmpeg-static` downloads a binary for this platform during install (≈80 MB).

- [ ] **Step 2: Write the failing locate test**

`packages/sidecars/src/locate.test.ts`:
```ts
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { locate, _resetLocateCache } from './locate.js';
import { SidecarError } from './errors.js';

afterEach(() => {
  delete process.env.WORDEDITS_FFMPEG_DIR;
  _resetLocateCache();
});

describe('locate', () => {
  it('finds ffmpeg and ffprobe as existing files', async () => {
    await expect(access(await locate('ffmpeg'))).resolves.toBeUndefined();
    await expect(access(await locate('ffprobe'))).resolves.toBeUndefined();
  });

  it('prefers WORDEDITS_FFMPEG_DIR when the binary exists there', async () => {
    const real = await locate('ffmpeg');
    _resetLocateCache();
    process.env.WORDEDITS_FFMPEG_DIR = dirname(real);
    expect(await locate('ffmpeg')).toBe(real);
  });

  it('throws a SidecarError with an install hint when the override dir is wrong', async () => {
    process.env.WORDEDITS_FFMPEG_DIR = '/definitely/not/here';
    await expect(locate('ffmpeg')).rejects.toMatchObject({
      name: 'SidecarError',
      code: 'NOT_FOUND',
      hint: expect.stringContaining('WORDEDITS_FFMPEG_DIR'),
    });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run packages/sidecars/src/locate.test.ts`
Expected: FAIL, cannot find module `./locate.js`.

- [ ] **Step 4: Write errors and locate**

`packages/sidecars/src/errors.ts`:
```ts
export class SidecarError extends Error {
  override name = 'SidecarError';
  constructor(
    public tool: string,
    public code: 'NOT_FOUND' | 'EXIT' | 'TIMEOUT' | 'PARSE',
    message: string,
    public hint: string,
    public stderr = '',
  ) {
    super(message);
  }
}
```

`packages/sidecars/src/locate.ts`:
```ts
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { SidecarError } from './errors.js';

export type Tool = 'ffmpeg' | 'ffprobe';

const cache = new Map<Tool, string>();
export function _resetLocateCache(): void {
  cache.clear();
}

const exe = (tool: Tool) => (process.platform === 'win32' ? `${tool}.exe` : tool);

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function fromStaticPackage(tool: Tool): Promise<string | null> {
  try {
    if (tool === 'ffmpeg') {
      const mod = await import('ffmpeg-static');
      return mod.default;
    }
    const mod = await import('ffprobe-static');
    return mod.path;
  } catch {
    return null;
  }
}

/**
 * Resolution order: WORDEDITS_FFMPEG_DIR (if set, it must contain the binary),
 * then PATH, then the ffmpeg-static / ffprobe-static packages.
 */
export async function locate(tool: Tool): Promise<string> {
  const cached = cache.get(tool);
  if (cached) return cached;

  const override = process.env.WORDEDITS_FFMPEG_DIR;
  if (override) {
    const p = join(override, exe(tool));
    if (await exists(p)) return remember(tool, p);
    throw new SidecarError(
      tool, 'NOT_FOUND',
      `${tool} not found in WORDEDITS_FFMPEG_DIR (${override})`,
      `Put ${exe(tool)} in that folder or unset WORDEDITS_FFMPEG_DIR.`,
    );
  }

  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const p = join(dir, exe(tool));
    if (await exists(p)) return remember(tool, p);
  }

  const bundled = await fromStaticPackage(tool);
  if (bundled && (await exists(bundled))) return remember(tool, bundled);

  throw new SidecarError(
    tool, 'NOT_FOUND',
    `${tool} was not found`,
    `Install FFmpeg (macOS: brew install ffmpeg; Windows: winget install ffmpeg) or set WORDEDITS_FFMPEG_DIR to a folder containing ${exe(tool)}.`,
  );
}

function remember(tool: Tool, p: string): string {
  cache.set(tool, p);
  return p;
}
```

- [ ] **Step 5: Run the locate test to verify it passes**

Run: `pnpm vitest run packages/sidecars/src/locate.test.ts`
Expected: 3 passed.

- [ ] **Step 6: Write the failing run test**

`packages/sidecars/src/run.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { run } from './run.js';

describe('run', () => {
  it('runs ffmpeg -version and returns stdout', async () => {
    const { stdout } = await run('ffmpeg', ['-version']);
    expect(stdout).toContain('ffmpeg version');
  });

  it('turns a non-zero exit into a SidecarError with stderr', async () => {
    await expect(run('ffmpeg', ['-i', '/no/such/file.mp4', '-f', 'null', '-'])).rejects.toMatchObject({
      name: 'SidecarError',
      code: 'EXIT',
      stderr: expect.stringContaining('No such file'),
    });
  });

  it('times out with code TIMEOUT', async () => {
    await expect(
      run('ffmpeg', ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=60', '-c:v', 'libx264', '-preset', 'veryslow', '-f', 'null', '-'], { timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('streams stdout lines to the callback', async () => {
    const lines: string[] = [];
    await run('ffmpeg', ['-f', 'lavfi', '-i', 'testsrc2=duration=1', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-'], {
      onStdoutLine: (l) => lines.push(l),
    });
    expect(lines.some((l) => l.startsWith('out_time_us='))).toBe(true);
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `pnpm vitest run packages/sidecars/src/run.test.ts`
Expected: FAIL, cannot find module `./run.js`.

- [ ] **Step 8: Write run**

`packages/sidecars/src/run.ts`:
```ts
import { execa } from 'execa';
import { SidecarError } from './errors.js';
import { locate, type Tool } from './locate.js';

export interface RunOptions {
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export async function run(tool: Tool, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const bin = await locate(tool);
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  const child = execa(bin, args, { timeout, reject: false, all: false, stripFinalNewline: false });

  if (opts.onStdoutLine && child.stdout) {
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        opts.onStdoutLine!(buf.slice(0, i).trimEnd());
        buf = buf.slice(i + 1);
      }
    });
  }

  const res = await child;
  const stderr = String(res.stderr ?? '');
  if (res.timedOut) {
    throw new SidecarError(tool, 'TIMEOUT', `${tool} exceeded ${timeout} ms`, 'The file may be very long or the machine is busy. Try again.', stderr);
  }
  if (res.exitCode !== 0) {
    throw new SidecarError(
      tool, 'EXIT',
      `${tool} exited with code ${res.exitCode}`,
      lastMeaningfulLine(stderr),
      stderr,
    );
  }
  return { stdout: String(res.stdout ?? ''), stderr };
}

function lastMeaningfulLine(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? 'No details from the tool.';
}
```

`packages/sidecars/src/index.ts`:
```ts
export { SidecarError } from './errors.js';
export { locate, type Tool } from './locate.js';
export { run, type RunOptions, type RunResult } from './run.js';
```

- [ ] **Step 9: Run all sidecar tests**

Run: `pnpm vitest run packages/sidecars`
Expected: 7 passed.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat(sidecars): locate and run ffmpeg/ffprobe with structured errors

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Test fixtures

**Files:**
- Create: `scripts/make-fixtures.ts`
- Create (generated, committed): `fixtures/tone-6s.mp4`, `fixtures/tone-6s-2997.mp4`, `fixtures/noaudio-6s.mp4`, `fixtures/silent-6s.mp4`
- Create: `fixtures/README.md`

**Interfaces:**
- Produces: four small MP4s (~100–300 KB each) used by every later integration test. `tone-6s.mp4`: 640×360 @30 fps, `testsrc2` pattern, 440 Hz sine. `tone-6s-2997.mp4`: same at 30000/1001 fps. `noaudio-6s.mp4`: video only. `silent-6s.mp4`: video plus digital silence.

- [ ] **Step 1: Write the generator**

`scripts/make-fixtures.ts`:
```ts
import { mkdir } from 'node:fs/promises';
import { run } from '@wordedits/sidecars';

const out = 'fixtures';
await mkdir(out, { recursive: true });

const video = (rate: string) => ['-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${rate}:duration=6`];
const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6'];
const silence = ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '6'];
const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', '-y'];

const jobs: [string, string[]][] = [
  ['tone-6s.mp4', [...video('30'), ...tone, ...enc]],
  ['tone-6s-2997.mp4', [...video('30000/1001'), ...tone, ...enc]],
  ['noaudio-6s.mp4', [...video('30'), ...enc.filter((a) => !['-c:a', 'aac', '-b:a', '96k'].includes(a)), '-an']],
  ['silent-6s.mp4', [...video('30'), ...silence, ...enc]],
];

for (const [name, args] of jobs) {
  await run('ffmpeg', [...args, `${out}/${name}`]);
  console.log('wrote', name);
}
```

Root `package.json` needs the sidecars package resolvable from `scripts/`: run
```bash
pnpm add -w @wordedits/sidecars@workspace:*
```

- [ ] **Step 2: Generate and inspect**

Run:
```bash
pnpm fixtures && ls -la fixtures && du -sh fixtures
```
Expected: four files, total under 2 MB.

- [ ] **Step 3: Write the README**

`fixtures/README.md`:
```markdown
# Test fixtures

Generated by `pnpm fixtures` (scripts/make-fixtures.ts). Do not edit by hand; regenerate and commit.

| File | Content |
|---|---|
| tone-6s.mp4 | 640x360 @30 fps testsrc2 pattern, 440 Hz sine, 6 s |
| tone-6s-2997.mp4 | same at 30000/1001 fps |
| noaudio-6s.mp4 | video only, no audio stream |
| silent-6s.mp4 | video plus digital silence |
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test: generated MP4 fixtures and generator script

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: ffprobe wrapper

**Files:**
- Create: `packages/sidecars/src/ffprobe.ts`, `packages/sidecars/src/ffprobe.test.ts`
- Modify: `packages/sidecars/src/index.ts`

**Interfaces:**
- Consumes: `run`, `SidecarError`, `ProbeInfoSchema`/`ProbeInfo` from `@wordedits/shared`.
- Produces: `probe(file: string): Promise<ProbeInfo>`; `parseFps(rate: string): number` (`"30000/1001"` → 29.97).

- [ ] **Step 1: Write the failing test**

`packages/sidecars/src/ffprobe.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseFps, probe } from './ffprobe.js';

describe('parseFps', () => {
  it('parses integer and fractional rates', () => {
    expect(parseFps('30/1')).toBe(30);
    expect(parseFps('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFps('0/0')).toBe(0);
    expect(parseFps('garbage')).toBe(0);
  });
});

describe('probe', () => {
  it('reads duration, size, fps and streams from a fixture', async () => {
    const info = await probe('fixtures/tone-6s.mp4');
    expect(info.durationSec).toBeCloseTo(6, 0);
    expect(info.width).toBe(640);
    expect(info.height).toBe(360);
    expect(info.fps).toBe(30);
    expect(info.hasVideo).toBe(true);
    expect(info.hasAudio).toBe(true);
    expect(info.videoCodec).toBe('h264');
    expect(info.audioCodec).toBe('aac');
  });

  it('reports fractional fps', async () => {
    const info = await probe('fixtures/tone-6s-2997.mp4');
    expect(info.fps).toBeCloseTo(29.97, 2);
  });

  it('reports hasAudio=false for a video-only file', async () => {
    const info = await probe('fixtures/noaudio-6s.mp4');
    expect(info.hasAudio).toBe(false);
    expect(info.audioCodec).toBeNull();
  });

  it('throws SidecarError for a missing file', async () => {
    await expect(probe('fixtures/nope.mp4')).rejects.toMatchObject({ name: 'SidecarError', tool: 'ffprobe' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/sidecars/src/ffprobe.test.ts`
Expected: FAIL, cannot find module `./ffprobe.js`.

- [ ] **Step 3: Write ffprobe**

`packages/sidecars/src/ffprobe.ts`:
```ts
import { ProbeInfoSchema, type ProbeInfo } from '@wordedits/shared';
import { SidecarError } from './errors.js';
import { run } from './run.js';

export function parseFps(rate: string): number {
  const m = /^(\d+)\/(\d+)$/.exec(rate.trim());
  if (!m) return 0;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!den || !num) return 0;
  return Math.round((num / den) * 1000) / 1000;
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
}
interface RawProbe {
  format?: { duration?: string };
  streams?: RawStream[];
}

export async function probe(file: string): Promise<ProbeInfo> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], { timeoutMs: 60_000 });

  let raw: RawProbe;
  try {
    raw = JSON.parse(stdout) as RawProbe;
  } catch {
    throw new SidecarError('ffprobe', 'PARSE', 'ffprobe returned invalid JSON', 'The file may be corrupt.', stdout);
  }

  const v = raw.streams?.find((s) => s.codec_type === 'video');
  const a = raw.streams?.find((s) => s.codec_type === 'audio');
  const info = {
    durationSec: Number(raw.format?.duration ?? 0),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps: v ? parseFps(v.avg_frame_rate ?? v.r_frame_rate ?? '0/0') : 0,
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
  };
  return ProbeInfoSchema.parse(info);
}
```

Add to `packages/sidecars/src/index.ts`:
```ts
export { probe, parseFps } from './ffprobe.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/sidecars/src/ffprobe.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(sidecars): ffprobe wrapper with fps parsing and stream detection

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: ffmpeg wrapper: progress, encoder pick, proxy, loudness

**Files:**
- Create: `packages/sidecars/src/ffmpeg.ts`, `packages/sidecars/src/ffmpeg.test.ts`
- Modify: `packages/sidecars/src/index.ts`

**Interfaces:**
- Consumes: `run`, `probe`.
- Produces:
  - `runFfmpeg(args: string[], opts: { expectedDurationSec?: number; timeoutMs?: number; onProgress?: (fraction: number) => void }): Promise<void>` — appends `-progress pipe:1 -nostats -y` itself.
  - `type Encoder = { name: 'h264_videotoolbox' | 'h264_nvenc' | 'libx264'; extraArgs: string[] }`; `pickEncoder(): Promise<Encoder>` — cached; does a real 0.1 s test encode of each candidate in platform order.
  - `makeProxy(src: string, out: string, opts?: { height?: number; onProgress?: (f: number) => void }): Promise<void>` — 540p H.264 ultrafast, AAC 128k.
  - `measureLoudness(file: string): Promise<{ integratedLufs: number; truePeakDb: number }>` via `ebur128`.

- [ ] **Step 1: Write the failing test**

`packages/sidecars/src/ffmpeg.test.ts`:
```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeProxy, measureLoudness, pickEncoder, runFfmpeg } from './ffmpeg.js';
import { probe } from './ffprobe.js';

describe('pickEncoder', () => {
  it('returns a working encoder for this machine', async () => {
    const enc = await pickEncoder();
    expect(['h264_videotoolbox', 'h264_nvenc', 'libx264']).toContain(enc.name);
    const dir = await mkdtemp(join(tmpdir(), 'we-enc-'));
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=0.5', '-c:v', enc.name, ...enc.extraArgs, '-pix_fmt', 'yuv420p', join(dir, 'x.mp4')]);
    expect((await probe(join(dir, 'x.mp4'))).videoCodec).toBe('h264');
  });
});

describe('makeProxy', () => {
  it('writes a 540p proxy and reports progress up to ~1', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-proxy-'));
    const out = join(dir, 'proxy.mp4');
    const seen: number[] = [];
    await makeProxy('fixtures/tone-6s.mp4', out, { onProgress: (f) => seen.push(f) });
    const info = await probe(out);
    expect(info.height).toBe(540);
    expect(info.width).toBe(960);
    expect(info.hasAudio).toBe(true);
    expect(info.durationSec).toBeCloseTo(6, 0);
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(0.9);
    expect(seen.every((f) => f >= 0 && f <= 1)).toBe(true);
  });
});

describe('measureLoudness', () => {
  it('measures a sine tone at a plausible level', async () => {
    const r = await measureLoudness('fixtures/tone-6s.mp4');
    expect(r.integratedLufs).toBeLessThan(0);
    expect(r.integratedLufs).toBeGreaterThan(-70);
    expect(r.truePeakDb).toBeLessThan(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/sidecars/src/ffmpeg.test.ts`
Expected: FAIL, cannot find module `./ffmpeg.js`.

- [ ] **Step 3: Write ffmpeg.ts**

`packages/sidecars/src/ffmpeg.ts`:
```ts
import { run } from './run.js';
import { SidecarError } from './errors.js';
import { probe } from './ffprobe.js';

export interface FfmpegOptions {
  expectedDurationSec?: number;
  timeoutMs?: number;
  onProgress?: (fraction: number) => void;
}

/** Runs ffmpeg with progress reporting. Callers pass everything except -progress/-nostats/-y. */
export async function runFfmpeg(args: string[], opts: FfmpegOptions = {}): Promise<void> {
  const expected = opts.expectedDurationSec ?? 0;
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-y', ...args], {
    timeoutMs: opts.timeoutMs,
    onStdoutLine: (line) => {
      if (!opts.onProgress) return;
      if (line.startsWith('out_time_us=')) {
        const us = Number(line.slice('out_time_us='.length));
        if (expected > 0 && Number.isFinite(us)) {
          opts.onProgress(Math.min(1, Math.max(0, us / 1e6 / expected)));
        }
      } else if (line === 'progress=end') {
        opts.onProgress(1);
      }
    },
  });
}

export type EncoderName = 'h264_videotoolbox' | 'h264_nvenc' | 'libx264';
export interface Encoder {
  name: EncoderName;
  extraArgs: string[];
}

const CANDIDATES: Encoder[] = [
  { name: 'h264_videotoolbox', extraArgs: ['-allow_sw', '1', '-profile:v', 'high'] },
  { name: 'h264_nvenc', extraArgs: ['-preset', 'p5', '-profile:v', 'high', '-bf', '2'] },
  { name: 'libx264', extraArgs: ['-preset', 'medium', '-profile:v', 'high', '-bf', '2', '-flags', '+cgop'] },
];

let encoderCache: Encoder | null = null;
export function _resetEncoderCache(): void {
  encoderCache = null;
}

/** Picks the first candidate that actually encodes on this machine (real 0.1 s test encode). */
export async function pickEncoder(): Promise<Encoder> {
  if (encoderCache) return encoderCache;
  const order = CANDIDATES.filter((c) =>
    c.name === 'libx264' ||
    (c.name === 'h264_videotoolbox' && process.platform === 'darwin') ||
    (c.name === 'h264_nvenc' && process.platform !== 'darwin'),
  );
  for (const cand of order) {
    try {
      await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=30:d=0.1',
        '-c:v', cand.name, ...cand.extraArgs, '-pix_fmt', 'yuv420p', '-f', 'null', '-',
      ], { timeoutMs: 30_000 });
      encoderCache = cand;
      return cand;
    } catch {
      // try the next candidate
    }
  }
  throw new SidecarError('ffmpeg', 'EXIT', 'No H.264 encoder works', 'Your FFmpeg build has no usable H.264 encoder. Reinstall FFmpeg with libx264.');
}

export async function makeProxy(
  src: string,
  out: string,
  opts: { height?: number; onProgress?: (f: number) => void; expectedDurationSec?: number } = {},
): Promise<void> {
  const h = opts.height ?? 540;
  await runFfmpeg([
    '-i', src,
    '-vf', `scale=-2:${h}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart',
    out,
  ], { onProgress: opts.onProgress, expectedDurationSec: opts.expectedDurationSec ?? (await probe(src)).durationSec });
}

export async function measureLoudness(file: string): Promise<{ integratedLufs: number; truePeakDb: number }> {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ], { timeoutMs: 5 * 60_000 });
  const i = /I:\s+(-?[\d.]+)\s+LUFS/.exec(stderr);
  const p = /Peak:\s+(-?[\d.]+)\s+dBFS/.exec(stderr);
  if (!i || !p) {
    throw new SidecarError('ffmpeg', 'PARSE', 'Could not read loudness from ebur128 output', 'The file may have no audio.', stderr);
  }
  return { integratedLufs: Number(i[1]), truePeakDb: Number(p[1]) };
}
```

Add to `packages/sidecars/src/index.ts`:
```ts
export { runFfmpeg, pickEncoder, makeProxy, measureLoudness, _resetEncoderCache, type Encoder, type EncoderName, type FfmpegOptions } from './ffmpeg.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/sidecars/src/ffmpeg.test.ts`
Expected: 3 passed. On this MacBook `pickEncoder` should return `h264_videotoolbox`; if the static build lacks VideoToolbox it falls back to `libx264`, which is also a pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(sidecars): ffmpeg runner with progress, encoder detection, proxy and loudness

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Core package: MediaTools interface and project store

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `packages/core/src/media-tools.ts`, `packages/core/src/project-store.ts`, `packages/core/src/project-store.test.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: schemas from `@wordedits/shared`; sidecars only inside `realMediaTools()`.
- Produces:
  - `interface MediaTools { probe(file): Promise<ProbeInfo>; runFfmpeg(args, opts): Promise<void>; pickEncoder(): Promise<Encoder>; makeProxy(src, out, opts?): Promise<void>; measureLoudness(file): Promise<{integratedLufs:number; truePeakDb:number}> }` and `realMediaTools(): Promise<MediaTools>` (dynamic import of sidecars so core has no static dependency).
  - `slugify(title: string): string`
  - `createProject(rootDir: string, title: string): Promise<ProjectHandle>` where `ProjectHandle = { dir: string; project: Project }`
  - `openProject(dir: string): Promise<ProjectHandle>`
  - `readJsonFile<T>(path: string, schema: ZodType<T>): Promise<T>`, `writeJsonFile<T>(path, schema, value): Promise<void>`
  - `saveEdl(handle: ProjectHandle, edl: Edl): Promise<{ snapshot: string }>` — writes `edl.json` and `history/edl.NNNN.json`.
  - `loadEdl(handle): Promise<Edl>`

- [ ] **Step 1: Create the package**

`packages/core/package.json`:
```json
{
  "name": "@wordedits/core",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" }
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../shared" }, { "path": "../sidecars" }]
}
```

Run:
```bash
pnpm --filter @wordedits/core add @wordedits/shared@workspace:* @wordedits/sidecars@workspace:* zod@^4
```
(`sidecars` is a runtime dependency only through the dynamic import in `realMediaTools`; tests stub it.)

- [ ] **Step 2: Write the failing project store test**

`packages/core/src/project-store.test.ts`:
```ts
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdlSchema } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { createProject, loadEdl, openProject, saveEdl, slugify } from './project-store.js';

const edl = EdlSchema.parse({
  version: 1,
  output: { width: 1920, height: 1080, fps: 30 },
  scenes: [{ id: 's1', src: { in: 0, out: 1 } }],
});

describe('slugify', () => {
  it('makes a safe folder name from a messy title', () => {
    expect(slugify('My Video: "Test" ✨ 2026')).toBe('my-video-test-2026');
    expect(slugify('   ')).toBe('untitled');
    expect(slugify('Ünïcödé')).toBe('unicode');
  });
});

describe('project store', () => {
  it('creates a project folder with project.json and reopens it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'we root with space-'));
    const h = await createProject(root, 'My Video: "Test"');
    expect(h.dir).toBe(join(root, 'my-video-test'));
    expect(h.project.stage).toBe('start');
    expect(h.project.title).toBe('My Video: "Test"');
    const again = await openProject(h.dir);
    expect(again.project.id).toBe(h.project.id);
  });

  it('adds a numeric suffix when the slug already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'we-'));
    await createProject(root, 'Same');
    const second = await createProject(root, 'Same');
    expect(second.dir).toBe(join(root, 'same-2'));
  });

  it('saves the EDL with numbered history snapshots and loads it back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'we-'));
    const h = await createProject(root, 'Hist');
    const a = await saveEdl(h, edl);
    const b = await saveEdl(h, { ...edl, endScreen: { seconds: 5 } });
    expect(a.snapshot.endsWith('edl.0001.json')).toBe(true);
    expect(b.snapshot.endsWith('edl.0002.json')).toBe(true);
    expect((await readdir(join(h.dir, 'history'))).sort()).toEqual(['edl.0001.json', 'edl.0002.json']);
    expect((await loadEdl(h)).endScreen.seconds).toBe(5);
    expect(JSON.parse(await readFile(join(h.dir, 'edl.json'), 'utf8')).version).toBe(1);
  });

  it('refuses to write an invalid EDL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'we-'));
    const h = await createProject(root, 'Bad');
    await expect(saveEdl(h, { ...edl, scenes: [] })).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/project-store.test.ts`
Expected: FAIL, cannot find module `./project-store.js`.

- [ ] **Step 4: Write media-tools.ts and project-store.ts**

`packages/core/src/media-tools.ts`:
```ts
import type { ProbeInfo } from '@wordedits/shared';

export type EncoderName = 'h264_videotoolbox' | 'h264_nvenc' | 'libx264';
export interface Encoder {
  name: EncoderName;
  extraArgs: string[];
}

export interface FfmpegRunOptions {
  expectedDurationSec?: number;
  timeoutMs?: number;
  onProgress?: (fraction: number) => void;
}

/** Everything core needs from the sidecars. Tests pass a stub; the app passes realMediaTools(). */
export interface MediaTools {
  probe(file: string): Promise<ProbeInfo>;
  runFfmpeg(args: string[], opts?: FfmpegRunOptions): Promise<void>;
  pickEncoder(): Promise<Encoder>;
  makeProxy(src: string, out: string, opts?: { height?: number; onProgress?: (f: number) => void }): Promise<void>;
  measureLoudness(file: string): Promise<{ integratedLufs: number; truePeakDb: number }>;
}

export async function realMediaTools(): Promise<MediaTools> {
  const s = await import('@wordedits/sidecars');
  return {
    probe: s.probe,
    runFfmpeg: s.runFfmpeg,
    pickEncoder: s.pickEncoder,
    makeProxy: s.makeProxy,
    measureLoudness: s.measureLoudness,
  };
}
```

`packages/core/src/project-store.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EdlSchema, ProjectSchema, type Edl, type Project } from '@wordedits/shared';
import type { ZodType } from 'zod';

export interface ProjectHandle {
  dir: string;
  project: Project;
}

export function slugify(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'untitled';
}

export async function readJsonFile<T>(path: string, schema: ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export async function writeJsonFile<T>(path: string, schema: ZodType<T>, value: T): Promise<void> {
  const parsed = schema.parse(value);
  await writeFile(path, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function createProject(rootDir: string, title: string): Promise<ProjectHandle> {
  const base = slugify(title);
  let dir = join(rootDir, base);
  for (let n = 2; await exists(dir); n++) dir = join(rootDir, `${base}-${n}`);

  await mkdir(join(dir, 'source'), { recursive: true });
  await mkdir(join(dir, 'renders'), { recursive: true });
  await mkdir(join(dir, 'history'), { recursive: true });

  const project: Project = {
    id: randomUUID(),
    title,
    createdAt: new Date().toISOString(),
    stage: 'start',
    format: 'talking-head',
    source: null,
  };
  await writeJsonFile(join(dir, 'project.json'), ProjectSchema, project);
  return { dir, project };
}

export async function openProject(dir: string): Promise<ProjectHandle> {
  const project = await readJsonFile(join(dir, 'project.json'), ProjectSchema);
  return { dir, project };
}

export async function saveProject(handle: ProjectHandle): Promise<void> {
  await writeJsonFile(join(handle.dir, 'project.json'), ProjectSchema, handle.project);
}

export async function saveEdl(handle: ProjectHandle, edl: Edl): Promise<{ snapshot: string }> {
  const parsed = EdlSchema.parse(edl);
  const histDir = join(handle.dir, 'history');
  await mkdir(histDir, { recursive: true });
  const count = (await readdir(histDir)).filter((f) => /^edl\.\d{4}\.json$/.test(f)).length;
  const snapshot = join(histDir, `edl.${String(count + 1).padStart(4, '0')}.json`);
  await writeJsonFile(snapshot, EdlSchema, parsed);
  await writeJsonFile(join(handle.dir, 'edl.json'), EdlSchema, parsed);
  return { snapshot };
}

export async function loadEdl(handle: ProjectHandle): Promise<Edl> {
  return readJsonFile(join(handle.dir, 'edl.json'), EdlSchema);
}
```

`packages/core/src/index.ts`:
```ts
export * from './media-tools.js';
export * from './project-store.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/project-store.test.ts`
Expected: 5 passed.

- [ ] **Step 6: Typecheck everything**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(core): MediaTools interface and JSON project store with EDL history

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: EDL compiler

**Files:**
- Create: `packages/core/src/edl-compiler.ts`, `packages/core/src/edl-compiler.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Edl`, `Scene` from shared; `Encoder` from `media-tools.ts`.
- Produces:
  - `class EdlError extends Error { code: 'EMPTY_SCENE' | 'NO_SCENES'; sceneId?: string; hint: string }`
  - `sceneSegments(scene: Scene): Array<{ start: number; end: number }>` — kept ranges after cuts, sorted; throws `EdlError EMPTY_SCENE` if nothing remains.
  - `edlDuration(edl: Edl): number` — seconds of output.
  - `bitrateFor(width: number, height: number, fps: number): string` — `'8M' | '12M' | '40M' | '5M'`.
  - `compileEdl(edl: Edl, opts: CompileOptions): string[]` where `CompileOptions = { input: string; output: string; encoder: Encoder; mode: 'preview' | 'final'; sourceFps: number }`. Returns the ffmpeg argument array (without `-progress`/`-y`, which `runFfmpeg` adds).
  - `buildFilterGraph(edl: Edl, opts: { mode: 'preview' | 'final'; sourceFps: number }): string`

- [ ] **Step 1: Write the failing test**

`packages/core/src/edl-compiler.test.ts`:
```ts
import { EdlSchema } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { bitrateFor, buildFilterGraph, compileEdl, edlDuration, sceneSegments } from './edl-compiler.js';

const twoScenes = EdlSchema.parse({
  version: 1,
  output: { width: 1920, height: 1080, fps: 30 },
  scenes: [
    { id: 's1', src: { in: 0.5, out: 2.5 }, cuts: [[1.0, 1.4]] },
    { id: 's2', src: { in: 3.0, out: 5.5 }, zoom: { scale: 1.2, anchor: { x: 0.5, y: 0.4 } } },
  ],
});
const enc = { name: 'libx264' as const, extraArgs: ['-preset', 'medium'] };

describe('sceneSegments', () => {
  it('splits a scene around its cuts', () => {
    expect(sceneSegments(twoScenes.scenes[0])).toEqual([
      { start: 0.5, end: 1.0 },
      { start: 1.4, end: 2.5 },
    ]);
  });

  it('returns the whole scene when there are no cuts', () => {
    expect(sceneSegments(twoScenes.scenes[1])).toEqual([{ start: 3.0, end: 5.5 }]);
  });

  it('merges overlapping cuts and ignores zero-length leftovers', () => {
    const s = { ...twoScenes.scenes[0], cuts: [[0.5, 1.0], [0.9, 1.5]] as [number, number][] };
    expect(sceneSegments(s)).toEqual([{ start: 1.5, end: 2.5 }]);
  });

  it('throws EMPTY_SCENE when cuts remove everything', () => {
    const s = { ...twoScenes.scenes[0], cuts: [[0.5, 2.5]] as [number, number][] };
    expect(() => sceneSegments(s)).toThrow(expect.objectContaining({ code: 'EMPTY_SCENE', sceneId: 's1' }));
  });
});

describe('edlDuration', () => {
  it('sums kept segments', () => {
    expect(edlDuration(twoScenes)).toBeCloseTo(1.6 + 2.5, 5);
  });
});

describe('bitrateFor', () => {
  it('follows the YouTube table', () => {
    expect(bitrateFor(1920, 1080, 30)).toBe('8M');
    expect(bitrateFor(1920, 1080, 60)).toBe('12M');
    expect(bitrateFor(3840, 2160, 30)).toBe('40M');
    expect(bitrateFor(1280, 720, 30)).toBe('5M');
  });
});

describe('buildFilterGraph', () => {
  it('trims, zooms, scales and concatenates every segment', () => {
    const g = buildFilterGraph(twoScenes, { mode: 'final', sourceFps: 30 });
    expect(g).toContain('[0:v]trim=start=0.5:end=1,setpts=PTS-STARTPTS');
    expect(g).toContain('[0:v]trim=start=1.4:end=2.5,setpts=PTS-STARTPTS');
    expect(g).toContain('crop=trunc(iw/1.2/2)*2:trunc(ih/1.2/2)*2:(iw-iw/1.2)*0.5:(ih-ih/1.2)*0.4');
    expect(g).toContain('scale=1920:1080:flags=bicubic,setsar=1,fps=30');
    expect(g).toContain('concat=n=3:v=1:a=1[vcat][acat]');
    expect(g).toContain('[acat]highpass=f=90,loudnorm=I=-14:TP=-1:LRA=11[aout]');
  });

  it('uses the source fps and preview size in preview mode', () => {
    const g = buildFilterGraph(twoScenes, { mode: 'preview', sourceFps: 29.97 });
    expect(g).toContain('scale=960:540:flags=bicubic,setsar=1,fps=29.97');
  });
});

describe('compileEdl', () => {
  it('produces the full argument list for a final render', () => {
    const args = compileEdl(twoScenes, { input: 'in.mp4', output: 'out.mp4', encoder: enc, mode: 'final', sourceFps: 30 });
    expect(args).toMatchSnapshot();
    expect(args).toContain('-filter_complex');
    expect(args.slice(-1)[0]).toBe('out.mp4');
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-b:v', '8M', '-c:a', 'aac', '-b:a', '384k', '-ar', '48000', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709']));
  });

  it('uses crf ultrafast libx264 for previews regardless of the picked encoder', () => {
    const args = compileEdl(twoScenes, { input: 'in.mp4', output: 'p.mp4', encoder: { name: 'h264_videotoolbox', extraArgs: [] }, mode: 'preview', sourceFps: 30 });
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28']));
    expect(args).not.toContain('h264_videotoolbox');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/edl-compiler.test.ts`
Expected: FAIL, cannot find module `./edl-compiler.js`.

- [ ] **Step 3: Write the compiler**

`packages/core/src/edl-compiler.ts`:
```ts
import type { Edl, Scene } from '@wordedits/shared';
import type { Encoder } from './media-tools.js';

export class EdlError extends Error {
  override name = 'EdlError';
  constructor(
    public code: 'EMPTY_SCENE' | 'NO_SCENES',
    message: string,
    public hint: string,
    public sceneId?: string,
  ) {
    super(message);
  }
}

export interface Segment {
  start: number;
  end: number;
}

const EPS = 1e-6;

/** Kept ranges of a scene after removing its cuts. Cuts may overlap; results are sorted. */
export function sceneSegments(scene: Scene): Segment[] {
  const cuts = [...scene.cuts].sort((a, b) => a[0] - b[0]);
  const out: Segment[] = [];
  let cursor = scene.src.in;
  for (const [a, b] of cuts) {
    if (a - cursor > EPS) out.push({ start: cursor, end: a });
    cursor = Math.max(cursor, b);
  }
  if (scene.src.out - cursor > EPS) out.push({ start: cursor, end: scene.src.out });
  if (out.length === 0) {
    throw new EdlError('EMPTY_SCENE', `scene ${scene.id}: cuts remove the whole scene`, 'Remove a cut or delete the scene.', scene.id);
  }
  return out;
}

export function edlDuration(edl: Edl): number {
  return edl.scenes.flatMap(sceneSegments).reduce((sum, s) => sum + (s.end - s.start), 0);
}

export function bitrateFor(width: number, height: number, fps: number): string {
  const longSide = Math.max(width, height);
  if (longSide >= 3840) return '40M';
  if (longSide >= 1920) return fps > 40 ? '12M' : '8M';
  return '5M';
}

const num = (n: number) => String(Math.round(n * 1000) / 1000);

export interface GraphOptions {
  mode: 'preview' | 'final';
  sourceFps: number;
}

export function buildFilterGraph(edl: Edl, opts: GraphOptions): string {
  if (edl.scenes.length === 0) throw new EdlError('NO_SCENES', 'EDL has no scenes', 'Add at least one scene.');
  const [W, H] = opts.mode === 'preview' ? [960, 540] : [edl.output.width, edl.output.height];
  const fps = num(opts.sourceFps > 0 ? opts.sourceFps : edl.output.fps);

  const chains: string[] = [];
  const labels: string[] = [];
  let k = 0;
  for (const scene of edl.scenes) {
    const S = scene.zoom.scale;
    const { x: ax, y: ay } = scene.zoom.anchor;
    const crop =
      S > 1 + EPS
        ? `crop=trunc(iw/${num(S)}/2)*2:trunc(ih/${num(S)}/2)*2:(iw-iw/${num(S)})*${num(ax)}:(ih-ih/${num(S)})*${num(ay)},`
        : '';
    for (const seg of sceneSegments(scene)) {
      chains.push(
        `[0:v]trim=start=${num(seg.start)}:end=${num(seg.end)},setpts=PTS-STARTPTS,${crop}scale=${W}:${H}:flags=bicubic,setsar=1,fps=${fps}[v${k}]`,
      );
      chains.push(`[0:a]atrim=start=${num(seg.start)}:end=${num(seg.end)},asetpts=PTS-STARTPTS[a${k}]`);
      labels.push(`[v${k}][a${k}]`);
      k++;
    }
  }
  chains.push(`${labels.join('')}concat=n=${k}:v=1:a=1[vcat][acat]`);
  chains.push(`[acat]highpass=f=90,loudnorm=I=${num(edl.audio.loudnessLufs)}:TP=-1:LRA=11[aout]`);
  return chains.join(';');
}

export interface CompileOptions extends GraphOptions {
  input: string;
  output: string;
  encoder: Encoder;
}

export function compileEdl(edl: Edl, opts: CompileOptions): string[] {
  const graph = buildFilterGraph(edl, opts);
  const video =
    opts.mode === 'preview'
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28']
      : ['-c:v', opts.encoder.name, ...opts.encoder.extraArgs, '-b:v', bitrateFor(edl.output.width, edl.output.height, opts.sourceFps), '-g', String(Math.round((opts.sourceFps || edl.output.fps) * 2))];
  const audio = opts.mode === 'preview' ? ['-c:a', 'aac', '-b:a', '128k'] : ['-c:a', 'aac', '-b:a', '384k'];
  return [
    '-i', opts.input,
    '-filter_complex', graph,
    '-map', '[vcat]', '-map', '[aout]',
    ...video,
    '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    ...audio, '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    opts.output,
  ];
}
```

Add to `packages/core/src/index.ts`:
```ts
export * from './edl-compiler.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/edl-compiler.test.ts`
Expected: 11 passed; a snapshot file is written at `packages/core/src/__snapshots__/edl-compiler.test.ts.snap`. Open it and confirm the argument list reads sensibly (input, filter graph, encoder, output last).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): EDL compiler producing an FFmpeg filter graph and encode args

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Render orchestrator and dev CLI

**Files:**
- Create: `packages/core/src/render.ts`, `packages/core/src/render.test.ts`, `scripts/render.ts`
- Modify: `packages/core/src/index.ts`, root `package.json` (add `@wordedits/core` dependency)

**Interfaces:**
- Consumes: `MediaTools`, `compileEdl`, `edlDuration`, `EdlError`, `ProjectHandle`.
- Produces:
  - `class RenderError extends Error { code: 'NO_AUDIO' | 'NO_VIDEO' | 'DURATION_MISMATCH' | 'EDL'; hint: string; cause?: unknown }`
  - `renderEdl(opts: RenderOptions): Promise<RenderResult>` where
    `RenderOptions = { edl: Edl; input: string; outputDir: string; mode: 'preview' | 'final'; tools: MediaTools; onProgress?: (fraction: number) => void }` and
    `RenderResult = { outputPath: string; expectedDurationSec: number; probe: ProbeInfo }`.
    Output file name: `${mode}-${edlHash8}.mp4` inside `outputDir`. Verifies the rendered duration is within 0.25 s of `edlDuration`.
  - `edlHash(edl: Edl): string` — sha256 hex of the canonical JSON, first 8 chars.

- [ ] **Step 1: Write the failing test**

`packages/core/src/render.test.ts`:
```ts
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdlSchema } from '@wordedits/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { realMediaTools, type MediaTools } from './media-tools.js';
import { edlHash, renderEdl } from './render.js';

const edl = EdlSchema.parse({
  version: 1,
  output: { width: 640, height: 360, fps: 30 },
  scenes: [
    { id: 's1', src: { in: 0.5, out: 2.5 }, cuts: [[1.0, 1.4]] },
    { id: 's2', src: { in: 3.0, out: 5.5 }, zoom: { scale: 1.2 } },
  ],
});

let tools: MediaTools;
beforeAll(async () => {
  tools = await realMediaTools();
});

describe('edlHash', () => {
  it('is stable and 8 hex chars', () => {
    expect(edlHash(edl)).toMatch(/^[0-9a-f]{8}$/);
    expect(edlHash(edl)).toBe(edlHash(JSON.parse(JSON.stringify(edl))));
    expect(edlHash({ ...edl, endScreen: { seconds: 3 } })).not.toBe(edlHash(edl));
  });
});

describe('renderEdl', () => {
  it('renders a two-scene EDL to an MP4 of the expected length (final)', async () => {
    const dir = await mkdtemp(join(tmpdir(), "we render 'quoted' -"));
    const input = join(dir, "my take 'one'.mp4");
    await cp('fixtures/tone-6s.mp4', input);
    const seen: number[] = [];
    const r = await renderEdl({ edl, input, outputDir: dir, mode: 'final', tools, onProgress: (f) => seen.push(f) });
    expect(r.expectedDurationSec).toBeCloseTo(4.1, 5);
    expect(r.probe.durationSec).toBeGreaterThan(4.1 - 0.25);
    expect(r.probe.durationSec).toBeLessThan(4.1 + 0.25);
    expect(r.probe.width).toBe(640);
    expect(r.probe.height).toBe(360);
    expect(r.probe.fps).toBe(30);
    expect(r.probe.hasAudio).toBe(true);
    expect(r.outputPath).toBe(join(dir, `final-${edlHash(edl)}.mp4`));
    expect(Math.max(...seen)).toBe(1);
    const loud = await tools.measureLoudness(r.outputPath);
    expect(loud.integratedLufs).toBeGreaterThan(-16.5);
    expect(loud.integratedLufs).toBeLessThan(-11.5);
    expect(loud.truePeakDb).toBeLessThanOrEqual(-0.5);
  });

  it('renders a 540p preview quickly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-prev-'));
    const r = await renderEdl({ edl, input: 'fixtures/tone-6s.mp4', outputDir: dir, mode: 'preview', tools });
    expect(r.probe.height).toBe(540);
    expect(r.outputPath.endsWith(`preview-${edlHash(edl)}.mp4`)).toBe(true);
  });

  it('keeps a fractional source frame rate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-2997-'));
    const r = await renderEdl({ edl, input: 'fixtures/tone-6s-2997.mp4', outputDir: dir, mode: 'preview', tools });
    expect(r.probe.fps).toBeCloseTo(29.97, 2);
  });

  it('refuses a source with no audio track with code NO_AUDIO', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-noaudio-'));
    await expect(renderEdl({ edl, input: 'fixtures/noaudio-6s.mp4', outputDir: dir, mode: 'preview', tools })).rejects.toMatchObject({
      name: 'RenderError',
      code: 'NO_AUDIO',
      hint: expect.stringContaining('audio'),
    });
  });

  it('surfaces EDL errors with code EDL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-edl-'));
    const bad = { ...edl, scenes: [{ ...edl.scenes[0], cuts: [[0.5, 2.5]] as [number, number][] }] };
    await expect(renderEdl({ edl: bad, input: 'fixtures/tone-6s.mp4', outputDir: dir, mode: 'preview', tools })).rejects.toMatchObject({
      name: 'RenderError',
      code: 'EDL',
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/render.test.ts`
Expected: FAIL, cannot find module `./render.js`.

- [ ] **Step 3: Write render.ts**

`packages/core/src/render.ts`:
```ts
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EdlSchema, type Edl, type ProbeInfo } from '@wordedits/shared';
import { compileEdl, EdlError, edlDuration } from './edl-compiler.js';
import type { MediaTools } from './media-tools.js';

export class RenderError extends Error {
  override name = 'RenderError';
  constructor(
    public code: 'NO_AUDIO' | 'NO_VIDEO' | 'DURATION_MISMATCH' | 'EDL',
    message: string,
    public hint: string,
    public override cause?: unknown,
  ) {
    super(message);
  }
}

export function edlHash(edl: Edl): string {
  const canonical = JSON.stringify(EdlSchema.parse(edl), Object.keys(flatten(edl)).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

// Collects every key so JSON.stringify's replacer array sorts keys at all depths.
function flatten(v: unknown, acc: Record<string, true> = {}): Record<string, true> {
  if (Array.isArray(v)) v.forEach((x) => flatten(x, acc));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      acc[k] = true;
      flatten(x, acc);
    }
  }
  return acc;
}

export interface RenderOptions {
  edl: Edl;
  input: string;
  outputDir: string;
  mode: 'preview' | 'final';
  tools: MediaTools;
  onProgress?: (fraction: number) => void;
}

export interface RenderResult {
  outputPath: string;
  expectedDurationSec: number;
  probe: ProbeInfo;
}

const DURATION_TOLERANCE_SEC = 0.25;

export async function renderEdl(opts: RenderOptions): Promise<RenderResult> {
  const { tools } = opts;
  const src = await tools.probe(opts.input);
  if (!src.hasVideo) throw new RenderError('NO_VIDEO', 'The source file has no video stream', 'Choose a video file.');
  if (!src.hasAudio) {
    throw new RenderError('NO_AUDIO', 'The source file has no audio track', 'WordEdits needs your voice to cut the video. Re-export the recording with audio.');
  }

  let expected: number;
  let args: string[];
  try {
    expected = edlDuration(opts.edl);
    const encoder = opts.mode === 'final' ? await tools.pickEncoder() : { name: 'libx264' as const, extraArgs: [] };
    await mkdir(opts.outputDir, { recursive: true });
    const outputPath = join(opts.outputDir, `${opts.mode}-${edlHash(opts.edl)}.mp4`);
    args = compileEdl(opts.edl, { input: opts.input, output: outputPath, encoder, mode: opts.mode, sourceFps: src.fps });
    await tools.runFfmpeg(args, {
      expectedDurationSec: expected,
      timeoutMs: Math.max(60_000, expected * 20 * 1000),
      onProgress: opts.onProgress,
    });
    const probe = await tools.probe(outputPath);
    if (Math.abs(probe.durationSec - expected) > DURATION_TOLERANCE_SEC) {
      throw new RenderError('DURATION_MISMATCH', `Rendered ${probe.durationSec}s but expected ${expected}s`, 'The source may be shorter than the EDL assumes. Re-import the file.');
    }
    return { outputPath, expectedDurationSec: expected, probe };
  } catch (e) {
    if (e instanceof EdlError) throw new RenderError('EDL', e.message, e.hint, e);
    throw e;
  }
}
```

Add to `packages/core/src/index.ts`:
```ts
export * from './render.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/render.test.ts`
Expected: 6 passed. If the loudness assertion fails by a small margin on the sine fixture, widen only that assertion to ±3 LUFS and note it in the commit message; a failure of the duration or codec checks is a real bug.

- [ ] **Step 5: Write the dev CLI**

Run:
```bash
pnpm add -w @wordedits/core@workspace:*
```

`scripts/render.ts`:
```ts
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { EdlSchema } from '@wordedits/shared';
import { realMediaTools, renderEdl } from '@wordedits/core';

const [edlPath, input, mode = 'preview'] = process.argv.slice(2);
if (!edlPath || !input || (mode !== 'preview' && mode !== 'final')) {
  console.error('usage: pnpm render <edl.json> <input.mp4> [preview|final]');
  process.exit(2);
}

const edl = EdlSchema.parse(JSON.parse(await readFile(edlPath, 'utf8')));
const tools = await realMediaTools();
let last = -1;
const r = await renderEdl({
  edl, input: resolve(input), outputDir: resolve(dirname(edlPath), 'renders'), mode, tools,
  onProgress: (f) => {
    const pct = Math.floor(f * 100);
    if (pct !== last) { last = pct; process.stdout.write(`\r${pct}%`); }
  },
});
console.log(`\nwrote ${r.outputPath} (${r.probe.durationSec}s, ${r.probe.width}x${r.probe.height}@${r.probe.fps})`);
```

Try it:
```bash
mkdir -p fixtures/tmp && cat > fixtures/tmp/edl.json <<'EOF'
{ "version": 1, "output": { "width": 640, "height": 360, "fps": 30 },
  "scenes": [ { "id": "s1", "src": { "in": 0.5, "out": 2.5 }, "cuts": [[1.0, 1.4]] },
              { "id": "s2", "src": { "in": 3.0, "out": 5.5 }, "zoom": { "scale": 1.2 } } ] }
EOF
pnpm render fixtures/tmp/edl.json fixtures/tone-6s.mp4 final
```
Expected: progress to 100 % and a line `wrote .../fixtures/tmp/renders/final-XXXXXXXX.mp4 (4.1s, 640x360@30)`. Open the file in QuickTime to eyeball it: the second scene should be visibly zoomed in.

- [ ] **Step 6: Full suite, typecheck, commit**

Run: `pnpm test && pnpm typecheck`
Expected: all green.

```bash
git add -A && git commit -m "feat(core): render orchestrator with verification and a dev render CLI

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Repo docs and CI

**Files:**
- Create: `README.md`, `.github/workflows/ci.yml`

- [ ] **Step 1: Write the README**

`README.md`:
```markdown
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

FFmpeg resolution order: `WORDEDITS_FFMPEG_DIR`, then PATH, then the `ffmpeg-static` package.

## Layout

- `packages/shared` – zod schemas and types for every project file
- `packages/sidecars` – ffmpeg/ffprobe location, spawning, parsing
- `packages/core` – project store, EDL compiler, render orchestrator (no Electron)
- `fixtures/` – tiny generated MP4s for tests (`pnpm fixtures` regenerates)
```

- [ ] **Step 2: Write CI**

`.github/workflows/ci.yml`:
```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    strategy:
      matrix:
        os: [macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm i -g pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: README and CI for macOS and Windows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Follow-up plans (one per sub-project, written when reached)

2. **Transcribe + align** — whisper.cpp sidecar (model download on first run, `--dtw` word timestamps), Silero VAD via onnxruntime-node, WAV extraction in Import, Smith–Waterman alignment producing `takes.json`, speech fixtures generated with macOS `say`.
3. **Format profile + plan** — deterministic talking-head rules (spec §7), Claude take selection with strict tool output, captions (`.ass`), title overlays, music bed with sidechain ducking, denoise/compressor in the audio chain; extends the EDL compiler.
4. **Shell + chat** — Electron main/renderer, typed IPC, chat panel with streaming and multiple-choice cards, agent with gates, interview and script generation, block editor. Frontend work invokes the UI/UX Pro Max skill first.
5. **Review** — scene list, proxy player, trim handles, undo/redo over `history/`, keyboard shortcuts, chat edit tools, pacing/caption presets, per-scene partial preview renders.
6. **Export + publish** — final render at source resolution, SRT, FCPXML and CMX3600 EDL, YouTube OAuth (loopback + PKCE) and resumable upload, metadata drafting.
7. **Polish** — Apple-style pass, error paths from spec §9, Windows build with NVENC, electron-builder packaging with LGPL FFmpeg.
