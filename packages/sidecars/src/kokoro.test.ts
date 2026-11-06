// SPDX-License-Identifier: MIT
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kokoroDir, locateNpm, ttsSetup } from './kokoro.js';

describe('kokoroDir', () => {
  it('is MIRAGE_KOKORO_DIR, else the plugin data folder, else ~/.cache/mirage', () => {
    expect(kokoroDir({ MIRAGE_KOKORO_DIR: '/k', MIRAGE_PLUGIN_DATA: '/data' })).toBe('/k');
    expect(kokoroDir({ MIRAGE_PLUGIN_DATA: '/data' })).toBe(join('/data', 'kokoro'));
    expect(kokoroDir({})).toBe(join(homedir(), '.cache', 'mirage', 'kokoro'));
  });
});

describe('locateNpm', () => {
  it('runs the npm that ships next to this Node with this Node, else finds npm on PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'mirage-npm-'));
    const cli = join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    mkdirSync(join(cli, '..'), { recursive: true });
    writeFileSync(cli, '');
    mkdirSync(join(root, 'bin'));
    expect(locateNpm(join(root, 'bin', 'node'), '')).toEqual({ file: join(root, 'bin', 'node'), args: [cli] });
    const path = mkdtempSync(join(tmpdir(), 'mirage-path-'));
    const npm = join(path, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    writeFileSync(npm, '');
    expect(locateNpm(join(path, 'nowhere', 'node'), path)).toEqual({ file: npm, args: [] });
    expect(locateNpm(join(path, 'nowhere', 'node'), '')).toBeNull();
  });
});

describe('ttsSetup', () => {
  it('is fetch until the packages and the model are there, then ok', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-kokoro-'));
    const fresh = ttsSetup(dir);
    expect(fresh.state).toBe('fetch');
    if (fresh.state === 'fetch') expect(fresh.text).toBe(`not downloaded yet — speak downloads the Kokoro packages (about 170 MB) and its voice model (92 MB) into ${dir} the first time it runs`);
    for (const p of ['kokoro-js', 'onnxruntime-node']) {
      mkdirSync(join(dir, 'node_modules', p), { recursive: true });
      writeFileSync(join(dir, 'node_modules', p, 'package.json'), '{}');
    }
    expect(ttsSetup(dir)).toEqual({ state: 'fetch', text: `not downloaded yet — speak downloads the Kokoro voice model (92 MB) into ${dir} the first time it runs` });
    const model = join(dir, 'models', 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx');
    mkdirSync(model, { recursive: true });
    writeFileSync(join(model, 'model_quantized.onnx'), '');
    expect(ttsSetup(dir)).toEqual({ state: 'ok' });
  });
});
