// SPDX-License-Identifier: MIT
// Builds the generated half of plugin/: the engine, hook and viewer bundles (dist/*.mjs), the viewer page (dist/viewer-ui/),
// the licence (LICENSE) and the notices of every bundled npm package
// (THIRD_PARTY_NOTICES.txt). The output is the same on every run (no dates, no absolute paths in the banner), so a test can
// compare a rebuild with what is committed.
import { readdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as vite, type Plugin } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_DIR = join(ROOT, 'plugin');

const BUNDLES = [
  ['packages/mcp/src/main.ts', 'engine.mjs'],
  ['packages/hooks/src/main.ts', 'hook.mjs'],
  ['packages/viewer/src/main.ts', 'viewer.mjs'],
] as const;

/** Bundled CommonJS-only dependencies call require(): give them one. */
const BANNER = "import { createRequire as __mirageCreateRequire } from 'node:module'; const require = __mirageCreateRequire(import.meta.url);";

/** The folder of the npm package a bundled file comes from (the part up to its last node_modules/<name>), or null for our own code. */
export function packageDir(file: string): string | null {
  const m = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(file);
  return m ? m[1]! : null;
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;

type PackageNotice = { name: string; version: string; licence: string; texts: string[] };

/** A package's name, version, licence id and the text of each of its LICENSE/LICENCE/COPYING/NOTICE files. */
function packageNotice(dir: string): PackageNotice {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string; license?: unknown; licenses?: unknown };
  const id = (l: unknown): string => (typeof l === 'string' ? l : l && typeof l === 'object' && 'type' in l ? String((l as { type: unknown }).type) : '');
  const licence = id(pkg.license) || (Array.isArray(pkg.licenses) ? pkg.licenses.map(id).filter(Boolean).join(' OR ') : '') || 'UNKNOWN';
  const files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && LICENCE_FILE.test(e.name)).map((e) => e.name).sort();
  const texts = files.map((f) => `${f}:\n\n${readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trimEnd()}`);
  return { name: pkg.name, version: pkg.version, licence, texts };
}

const RULE = '='.repeat(80);

/** THIRD_PARTY_NOTICES.txt: every npm package with code in the bundles, by name and version, with its licence id and full text. */
export function thirdPartyNotices(inputs: Iterable<string>): string {
  const dirs = new Set<string>();
  for (const f of inputs) {
    const d = packageDir(f);
    if (d) dirs.add(d);
  }
  const byKey = new Map<string, PackageNotice>();
  for (const d of dirs) {
    const p = packageNotice(d);
    byKey.set(`${p.name}@${p.version}`, p);
  }
  const notices = [...byKey].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, p]) =>
    [RULE, key, `License: ${p.licence}`, '', p.texts.length ? p.texts.join(`\n\n${'-'.repeat(80)}\n`) : `(The package ships no licence file; its package.json says ${p.licence}.)`].join('\n'),
  );
  return [
    'Mirage is licensed under the MIT License (see LICENSE).',
    '',
    'The files in dist/ also contain the third-party packages below, each under its own licence. Each is listed with its',
    'version, its licence and the licence text it ships with. The font and icons of the viewer page have their licences in',
    'dist/viewer-ui/assets/licenses/ as well.',
    '',
    ...notices.map((n) => `${n}\n`),
  ].join('\n');
}

/** Records every module id the viewer page's build reads (Vite's equivalent of esbuild's metafile inputs). */
function moduleIds(into: Set<string>): Plugin {
  return {
    name: 'mirage-module-ids',
    apply: 'build',
    generateBundle() {
      for (const id of this.getModuleIds()) {
        const path = id.split('?')[0]!;
        if (isAbsolute(path)) into.add(path);
      }
    },
  };
}

/**
 * Writes dist/, native/, LICENSE and THIRD_PARTY_NOTICES.txt under `outRoot` (the plugin folder by default). The files
 * under plugin/ that are written by hand stay as they are. Returns every file the bundles were made from (absolute paths).
 */
export async function buildPlugin(outRoot: string = PLUGIN_DIR): Promise<{ inputs: string[] }> {
  const dist = join(outRoot, 'dist');
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  const inputs = new Set<string>();

  for (const [entry, out] of BUNDLES) {
    const r = await esbuild({
      absWorkingDir: ROOT,
      metafile: true,
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
    for (const f of Object.keys(r.metafile.inputs)) inputs.add(resolve(ROOT, f));
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
      plugins: [moduleIds(inputs)],
      build: { outDir: join(dist, 'viewer-ui'), emptyOutDir: true },
    });
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }

  await copyFile(join(ROOT, 'LICENSE'), join(outRoot, 'LICENSE'));
  await writeFile(join(outRoot, 'THIRD_PARTY_NOTICES.txt'), thirdPartyNotices(inputs));
  return { inputs: [...inputs].sort() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPlugin();
  console.log(`built ${join(PLUGIN_DIR, 'dist')}`);
}
