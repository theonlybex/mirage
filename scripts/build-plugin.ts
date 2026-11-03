// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds the generated half of plugin/: the engine, hook and viewer bundles (dist/*.mjs), the viewer page (dist/viewer-ui/) and
// the speech helper source (native/transcribe.swift). The output is the same on every run (no dates, no absolute paths in the
// banner), so a test can compare a rebuild with what is committed.
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_DIR = join(ROOT, 'plugin');

const BUNDLES = [
  ['packages/mcp/src/main.ts', 'engine.mjs'],
  ['packages/hooks/src/main.ts', 'hook.mjs'],
  ['packages/viewer/src/main.ts', 'viewer.mjs'],
] as const;

/** Bundled CommonJS-only dependencies call require(): give them one. */
const BANNER = "import { createRequire as __mirageCreateRequire } from 'node:module'; const require = __mirageCreateRequire(import.meta.url);";

/** Writes dist/ and native/ under `outRoot` (the plugin folder by default). The files under plugin/ that are written by hand stay as they are. */
export async function buildPlugin(outRoot: string = PLUGIN_DIR): Promise<void> {
  const dist = join(outRoot, 'dist');
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  for (const [entry, out] of BUNDLES) {
    await esbuild({
      entryPoints: [join(ROOT, entry)],
      outfile: join(dist, out),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: ['ffmpeg-static', 'ffprobe-static'],
      banner: { js: BANNER },
      legalComments: 'none',
      logLevel: 'warning',
    });
  }

  // The page: packages/viewer/vite.config.ts says how (one script, everything under assets/), only the folder differs.
  // NODE_ENV decides which React build is bundled: it must be 'production' whoever calls this (vitest sets it to 'test').
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await vite({
      root: join(ROOT, 'packages/viewer'),
      configFile: join(ROOT, 'packages/viewer/vite.config.ts'),
      mode: 'production',
      logLevel: 'warn',
      build: { outDir: join(dist, 'viewer-ui'), emptyOutDir: true },
    });
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }

  await mkdir(join(outRoot, 'native'), { recursive: true });
  await copyFile(join(ROOT, 'native/macos/transcribe.swift'), join(outRoot, 'native/transcribe.swift'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPlugin();
  console.log(`built ${join(PLUGIN_DIR, 'dist')}`);
}
