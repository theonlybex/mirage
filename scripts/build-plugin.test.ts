// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPlugin } from './build-plugin.js';

const ROOT = resolve(import.meta.dirname, '..');
const PLUGIN = join(ROOT, 'plugin');
const json = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));

/** Every file under `dir`, as paths relative to it, sorted. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p).map((f) => join(e.name, f)));
    else out.push(e.name);
  }
  return out.sort();
}

let built: string;
let inputs: string[];
beforeAll(async () => {
  built = realpathSync(await mkdtemp(join(tmpdir(), 'mirage-build-')));
  ({ inputs } = await buildPlugin(built));
}, 300_000);
afterAll(async () => {
  await rm(built, { recursive: true, force: true });
});

describe('buildPlugin', () => {
  it('writes the three bundles, the viewer page and the speech helper source', () => {
    for (const f of ['dist/engine.mjs', 'dist/hook.mjs', 'dist/viewer.mjs', 'dist/viewer-ui/index.html', 'native/transcribe.swift']) {
      expect(existsSync(join(built, f)), f).toBe(true);
    }
    expect(readFileSync(join(built, 'native/transcribe.swift'), 'utf8')).toBe(readFileSync(join(ROOT, 'native/macos/transcribe.swift'), 'utf8'));
  });

  it('keeps the viewer page under assets/ in one script, with no dynamic import', () => {
    const files = walk(join(built, 'dist/viewer-ui'));
    expect(files.filter((f) => f.endsWith('.js')).length).toBe(1);
    expect(files.filter((f) => !f.startsWith('assets/') && f !== 'index.html')).toEqual([]);
  });

  it('lists every bundled npm package in THIRD_PARTY_NOTICES.txt with its licence text, and ships the AGPL licence', () => {
    const notices = readFileSync(join(built, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    // Every file under node_modules that went into a bundle (esbuild's metafile inputs and the page's modules) names a package.
    const packages = new Set<string>();
    for (const f of inputs.filter((i) => /[\\/]node_modules[\\/]/.test(i))) {
      const parts = f.split(/[\\/]/);
      const at = parts.lastIndexOf('node_modules');
      const dir = parts.slice(0, at + (parts[at + 1]!.startsWith('@') ? 3 : 2)).join('/');
      const pkg = json(join(dir, 'package.json'));
      packages.add(`${pkg.name}@${pkg.version}`);
    }
    expect(packages.size).toBeGreaterThan(20);
    for (const p of [...packages, 'react@', 'zod@', 'fast-uri@', 'human-signals@']) expect(notices, p).toMatch(new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
    // The full texts: an MIT notice, fast-uri's BSD-3 and human-signals' Apache-2.0.
    expect(notices).toContain('Permission is hereby granted, free of charge');
    expect(notices).toMatch(/fast-uri@[^\n]+\nLicense: BSD-3-Clause\n[\s\S]*?Redistribution and use in source and binary forms/);
    expect(notices).toMatch(/human-signals@[^\n]+\nLicense: Apache-2\.0\n[\s\S]*?Apache License/);
    expect(notices).not.toContain(ROOT); // no absolute paths: the same on every machine
    expect(readFileSync(join(built, 'LICENSE'), 'utf8')).toBe(readFileSync(join(ROOT, 'LICENSE'), 'utf8'));
  });

  it('plugin-dist-fresh: the committed plugin/dist is what a rebuild gives', () => {
    expect(existsSync(join(PLUGIN, 'dist'))).toBe(true);
    expect(walk(join(PLUGIN, 'dist'))).toEqual(walk(join(built, 'dist')));
    for (const f of walk(join(built, 'dist'))) {
      const fresh = readFileSync(join(built, 'dist', f));
      const committed = readFileSync(join(PLUGIN, 'dist', f));
      expect(fresh.equals(committed), `plugin/dist/${f} is stale: run pnpm build:plugin`).toBe(true);
    }
    for (const f of ['native/transcribe.swift', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) {
      expect(existsSync(join(PLUGIN, f)), `plugin/${f} is missing: run pnpm build:plugin`).toBe(true);
      expect(readFileSync(join(PLUGIN, f), 'utf8'), `plugin/${f} is stale: run pnpm build:plugin`).toBe(readFileSync(join(built, f), 'utf8'));
    }
  });
});

describe('manifests', () => {
  const files = ['.claude-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'monitors/monitors.json'];

  it('parse', () => {
    for (const f of files) expect(() => json(join(PLUGIN, f)), f).not.toThrow();
    expect(() => json(join(ROOT, '.claude-plugin/marketplace.json'))).not.toThrow();
  });

  it('name only files that exist inside the plugin', () => {
    for (const f of files) {
      const text = readFileSync(join(PLUGIN, f), 'utf8');
      const paths = [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\\\s]+)/g)].map((m) => m[1]!);
      if (f !== '.claude-plugin/plugin.json') expect(paths.length, f).toBeGreaterThan(0);
      for (const p of paths) expect(existsSync(join(PLUGIN, p)), `${f}: ${p}`).toBe(true);
    }
  });

  it('plugin.json is the Mirage manifest', () => {
    const m = json(join(PLUGIN, '.claude-plugin/plugin.json'));
    expect(m).toMatchObject({ name: 'mirage', displayName: 'Mirage', version: '0.1.0', license: 'AGPL-3.0-or-later' });
  });

  it('the marketplace lists the plugin by relative path', () => {
    const m = json(join(ROOT, '.claude-plugin/marketplace.json'));
    expect(m.name).toBe('mirage');
    expect(m.owner.name).toBeTruthy();
    expect(m.plugins).toHaveLength(1);
    expect(m.plugins[0]).toMatchObject({ name: 'mirage', source: './plugin' });
    expect(existsSync(join(ROOT, m.plugins[0].source, '.claude-plugin/plugin.json'))).toBe(true);
  });

  it('registers the hooks, with a failed tool handled as a post event', () => {
    const h = json(join(PLUGIN, 'hooks/hooks.json')).hooks;
    expect(Object.keys(h).sort()).toEqual(['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionStart', 'Stop']);
    expect(h.PostToolUseFailure).toEqual(h.PostToolUse);
    expect(h.PreToolUse[0].hooks[0].timeout).toBe(86400);
    for (const ev of Object.values<any>(h)) {
      const hook = ev[0].hooks[0];
      expect(hook.type).toBe('command');
      expect(hook.command).toBe('${CLAUDE_PLUGIN_ROOT}/scripts/node');
      expect(hook.args[0]).toBe('${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs');
    }
  });

  it('runs the viewer monitor in every session (no `when`)', () => {
    const [m, ...rest] = json(join(PLUGIN, 'monitors/monitors.json'));
    expect(rest).toEqual([]);
    expect(m.name).toBe('viewer');
    expect('when' in m).toBe(false);
    expect(m.command).toContain('dist/viewer.mjs');
    expect(m.command).toContain('--data "${CLAUDE_PLUGIN_DATA}"');
  });

  it('points the engine at the project and the compiled speech helper', () => {
    const s = json(join(PLUGIN, '.mcp.json')).mcpServers.engine;
    expect(s.env).toEqual({ MIRAGE_PROJECT: '${CLAUDE_PROJECT_DIR}', WORDEDITS_TRANSCRIBER: '${CLAUDE_PLUGIN_DATA}/bin/wordedits-transcribe' });
  });

  it('ships the node launcher executable', () => {
    expect(statSync(join(PLUGIN, 'scripts/node')).mode & 0o111).not.toBe(0);
  });
});

describe('the bundles run', () => {
  it('the engine answers an MCP initialize over stdio', () => {
    const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    const out = execFileSync(process.execPath, [join(PLUGIN, 'dist/engine.mjs')], { input: `${msg}\n`, encoding: 'utf8', cwd: tmpdir(), timeout: 30_000, env: { ...process.env, MIRAGE_PROJECT: tmpdir() } });
    const reply = JSON.parse(out.split('\n')[0]!);
    expect(reply.id).toBe(1);
    expect(reply.result.serverInfo).toBeTruthy();
  });

  it('the viewer stays silent outside a Mirage project', async () => {
    const { spawn } = await import('node:child_process');
    const dir = await mkdtemp(join(tmpdir(), 'mirage-nowhere-'));
    const child = spawn(process.execPath, [join(PLUGIN, 'dist/viewer.mjs'), '--project', dir, '--ui', join(PLUGIN, 'dist/viewer-ui'), '--data', join(dir, 'data')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (err += d));
    await new Promise((r) => setTimeout(r, 1500));
    const alive = child.exitCode === null;
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    await rm(dir, { recursive: true, force: true });
    expect({ alive, out, err }).toEqual({ alive: true, out: '', err: '' });
  });
});
