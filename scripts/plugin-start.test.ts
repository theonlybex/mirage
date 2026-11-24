// SPDX-License-Identifier: MIT
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript, no types
import { NOTICE, TOO_OLD, candidates, findNode, majorOf, start } from '../plugin/scripts/start.mjs';

const STARTER = resolve(import.meta.dirname, '../plugin/scripts/start.mjs');
const dirs: string[] = [];
const tmp = async () => {
  const d = realpathSync(await mkdtemp(join(tmpdir(), 'mirage-start-')));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** findNode over a made-up machine: `nodes` maps each existing binary to the version it prints. */
const pick = (nodes: Record<string, string>, o: { env?: Record<string, string>; platform?: string; home?: string; skip?: string } = {}) =>
  findNode({ env: { PATH: '', MIRAGE_NODE_FIXED: '', ...o.env }, platform: o.platform ?? 'darwin', home: o.home ?? '/home/x', skip: o.skip, exists: (p: string) => p in nodes, probe: (p: string) => nodes[p] ?? '' });

describe('scripts/start.mjs: which Node', () => {
  it('reads major versions, and nothing else', () => {
    expect(majorOf('v22.4.1\n')).toBe(22);
    expect(majorOf('v9.11.2')).toBe(9);
    expect(majorOf('banana')).toBeNull();
    expect(majorOf('')).toBeNull();
  });

  it('takes the Node on PATH when it is 22 or later', () => {
    expect(pick({ '/a/node': 'v22.4.1' }, { env: { PATH: '/a:/b' } })).toBe('/a/node');
  });

  it('skips an old Node, and the one already running, for a newer one further on', () => {
    expect(pick({ '/a/node': 'v18.0.0', '/b/node': 'v24.0.0' }, { env: { PATH: '/a:/b' } })).toBe('/b/node');
    expect(pick({ '/a/node': 'v24.0.0', '/b/node': 'v23.0.0' }, { env: { PATH: '/a:/b' }, skip: '/a/node' })).toBe('/b/node');
  });

  it('takes the first fixed location that is 22 or later, in order', () => {
    const fixed = ['/f1/node', '/f2/node', '/f3/node'].join(':');
    expect(pick({ '/f1/node': 'v20.0.0', '/f2/node': 'v22.0.0', '/f3/node': 'v24.0.0' }, { env: { MIRAGE_NODE_FIXED: fixed } })).toBe('/f2/node');
  });

  it('looks in Homebrew and /usr/local by default on a Mac', () => {
    const list = candidates({ env: { PATH: '' }, platform: 'darwin', home: '' });
    expect(list).toEqual(['/opt/homebrew/bin/node', '/usr/local/bin/node']);
  });

  it('picks the newest nvm Node that is 22 or later, comparing versions as numbers', async () => {
    const home = await tmp();
    const base = join(home, '.nvm/versions/node');
    for (const v of ['v9.11.2', 'v22.9.0', 'v22.10.0', 'v20.18.0']) await mkdir(join(base, v, 'bin'), { recursive: true });
    const nodes = Object.fromEntries(['9.11.2', '22.9.0', '22.10.0', '20.18.0'].map((v) => [join(base, `v${v}`, 'bin', 'node'), `v${v}`]));
    expect(pick(nodes, { home })).toBe(join(base, 'v22.10.0/bin/node'));
  });

  it('falls back to Volta, then to ~/.local/node, with nvm tried first', async () => {
    const home = await tmp();
    const volta = join(home, '.volta/bin/node');
    const local = join(home, '.local/node/bin/node');
    expect(pick({ [local]: 'v24.18.0' }, { home })).toBe(local);
    expect(pick({ [local]: 'v24.18.0', [volta]: 'v23.0.0' }, { home })).toBe(volta);
    await mkdir(join(home, '.nvm/versions/node/v22.1.0/bin'), { recursive: true });
    const nvm = join(home, '.nvm/versions/node/v22.1.0/bin/node');
    expect(pick({ [local]: 'v24.18.0', [volta]: 'v23.0.0', [nvm]: 'v22.1.0' }, { home })).toBe(nvm);
  });

  it('ignores a "node" that prints nothing like a version', () => {
    expect(pick({ '/a/node': 'banana' }, { env: { PATH: '/a' } })).toBeNull();
  });

  it('on Windows, looks for node.exe on PATH, in the installer folders, nvm-windows and Volta', () => {
    const env = { Path: 'C:\\Tools;C:\\Bin', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', NVM_SYMLINK: 'C:\\nvm4w\\nodejs' };
    const list: string[] = candidates({ env, platform: 'win32', home: 'C:\\Users\\x' });
    expect(list).toEqual([
      'C:\\Tools\\node.exe',
      'C:\\Bin\\node.exe',
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
      'C:\\Users\\x\\AppData\\Local\\Programs\\nodejs\\node.exe',
      'C:\\nvm4w\\nodejs\\node.exe',
      'C:\\Users\\x\\AppData\\Local\\Volta\\bin\\node.exe',
      'C:\\Users\\x\\.volta\\bin\\node.exe',
      'C:\\Users\\x\\.local\\node\\node.exe',
    ]);
    expect(win32.isAbsolute(list[0]!)).toBe(true);
  });

  it('on Windows, matches the running Node without regard to case', () => {
    expect(pick({ 'C:\\Node\\node.exe': 'v24.0.0' }, { platform: 'win32', env: { PATH: 'C:\\Node' }, home: '', skip: 'c:\\node\\NODE.EXE' })).toBeNull();
    expect(pick({ 'C:\\Node\\node.exe': 'v24.0.0' }, { platform: 'win32', env: { PATH: 'C:\\Node' }, home: '' })).toBe('C:\\Node\\node.exe');
  });
});

describe('scripts/start.mjs: starting a program', () => {
  /** A program that prints the arguments it sees and its parent's pid. */
  async function program(): Promise<string> {
    const file = join(await tmp(), 'prog.mjs');
    await writeFile(file, 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), ppid: process.ppid }));\n');
    return file;
  }

  it('runs the program in its own process, with its arguments where it expects them', async () => {
    const prog = await program();
    const r = spawnSync(process.execPath, [STARTER, prog, 'a b', 'two'], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    // Its parent is whoever started start.mjs (here this test; in the plugin, Claude Code): no Node in between.
    expect(JSON.parse(r.stdout)).toEqual({ args: ['a b', 'two'], ppid: process.pid });
  });

  it('hands the program to a newer Node when this one is too old', async () => {
    const calls: unknown[] = [];
    const code = await start(['/p/hook.mjs', 'pre'], {
      version: 'v20.11.0',
      env: { PATH: '/new', MIRAGE_NODE_FIXED: '' },
      platform: 'darwin',
      execPath: '/old/node',
      exists: (p: string) => p === '/new/node',
      probe: () => 'v24.1.0',
      runWith: (...a: unknown[]) => calls.push(a),
    });
    expect(code).toBeNull();
    expect(calls).toEqual([['/new/node', '/p/hook.mjs', ['pre'], { PATH: '/new', MIRAGE_NODE_FIXED: '' }]]);
  });

  describe('with no usable Node', () => {
    const JSON_LINE = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: NOTICE } }) + '\n';
    async function run(args: string[], env: Record<string, string>, cwd?: string) {
      let out = '';
      let err = '';
      const code = await start(args, { version: 'v18.0.0', env: { PATH: '', MIRAGE_NODE_FIXED: '', HOME: await tmp(), ...env }, platform: 'darwin', cwd: cwd ?? (await tmp()), exists: () => false, stdout: (s: string) => (out += s), stderr: (s: string) => (err += s) });
      return { out, err, code };
    }
    const sessionStart = (env: Record<string, string>, cwd?: string) => run(['hook.mjs', 'session-start'], env, cwd);

    it('tells Claude to ask about installing Node, once, outside a project', async () => {
      const env = { CLAUDE_PLUGIN_DATA: join(await tmp(), 'plugin-data'), CLAUDE_PROJECT_DIR: await tmp() };
      expect(await sessionStart(env)).toEqual({ out: JSON_LINE, err: '', code: 0 });
      expect(await sessionStart(env)).toEqual({ out: '', err: '', code: 0 });
    });

    it('is valid SessionStart JSON carrying the notice', async () => {
      const r = await sessionStart({ CLAUDE_PLUGIN_DATA: await tmp(), CLAUDE_PROJECT_DIR: await tmp() });
      expect(JSON.parse(r.out)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: NOTICE } });
    });

    it('says it every time in a Mirage project', async () => {
      const project = await tmp();
      await writeFile(join(project, 'mirage.json'), '{}');
      const env = { CLAUDE_PLUGIN_DATA: await tmp(), CLAUDE_PROJECT_DIR: project };
      expect((await sessionStart(env)).out).toBe(JSON_LINE);
      expect(await sessionStart(env)).toEqual({ out: JSON_LINE, err: '', code: 0 });
    });

    it('says nothing outside a project when there is no data folder to remember in', async () => {
      expect(await sessionStart({ CLAUDE_PROJECT_DIR: await tmp() })).toEqual({ out: '', err: '', code: 0 });
    });

    it('looks in the current folder for mirage.json when CLAUDE_PROJECT_DIR is not set', async () => {
      const project = await tmp();
      await writeFile(join(project, 'mirage.json'), '{}');
      expect((await sessionStart({}, project)).out).toBe(JSON_LINE);
    });

    it('says Node is too old for every other command', async () => {
      const env = { CLAUDE_PLUGIN_DATA: await tmp(), CLAUDE_PROJECT_DIR: await tmp() };
      expect(await run(['engine.mjs'], env)).toEqual({ out: '', err: `${TOO_OLD}\n`, code: 1 });
      expect(await run(['hook.mjs', 'pre'], env)).toEqual({ out: '', err: `${TOO_OLD}\n`, code: 1 });
    });
  });
});
