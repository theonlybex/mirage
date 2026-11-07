// SPDX-License-Identifier: MIT
import { spawnSync } from 'node:child_process';
import { chmodSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const LAUNCHER = resolve(import.meta.dirname, '../plugin/scripts/node');
const dirs: string[] = [];
const tmp = async () => {
  const d = realpathSync(await mkdtemp(join(tmpdir(), 'mirage-node-')));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** A stand-in `node` that reports `version` and otherwise prints which one it is and its arguments. */
async function fakeNode(path: string, version: string, name = version): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\necho "${name} $*"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Runs the launcher with a PATH of just the system tools plus `path`, no fixed Node locations, and an empty home. */
async function run(o: { path?: string[]; fixed?: string[]; home?: string; args?: string[]; env?: Record<string, string> } = {}) {
  const home = o.home ?? (await tmp());
  const r = spawnSync('/bin/sh', [LAUNCHER, ...(o.args ?? ['a script.mjs', 'two'])], {
    encoding: 'utf8',
    env: { PATH: [...(o.path ?? []), '/usr/bin', '/bin'].join(':'), HOME: home, MIRAGE_NODE_FIXED: (o.fixed ?? []).join(' '), ...o.env },
  });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

describe('plugin/scripts/node', () => {
  it('runs the Node on PATH with all its arguments when it is 22 or later', async () => {
    const bin = await tmp();
    await fakeNode(join(bin, 'node'), 'v22.4.1');
    expect(await run({ path: [bin] })).toEqual({ out: 'v22.4.1 a script.mjs two\n', err: '', code: 0 });
  });

  it('refuses a Node older than 22 and says how to fix it', async () => {
    const bin = await tmp();
    await fakeNode(join(bin, 'node'), 'v20.11.0');
    expect(await run({ path: [bin] })).toEqual({ out: '', err: 'Mirage needs Node.js 22 or later. Run /mirage:setup.\n', code: 1 });
  });

  it('says the same when there is no Node at all', async () => {
    expect(await run()).toEqual({ out: '', err: 'Mirage needs Node.js 22 or later. Run /mirage:setup.\n', code: 1 });
  });

  it('skips an old Node on PATH for a newer one in a fixed location', async () => {
    const bin = await tmp();
    const other = await tmp();
    await fakeNode(join(bin, 'node'), 'v18.0.0');
    const fixed = await fakeNode(join(other, 'node'), 'v24.0.0');
    expect((await run({ path: [bin], fixed: [fixed] })).out).toBe('v24.0.0 a script.mjs two\n');
  });

  it('takes the first fixed location that is 22 or later, in order', async () => {
    const d = await tmp();
    const old = await fakeNode(join(d, 'a/node'), 'v20.0.0');
    const first = await fakeNode(join(d, 'b/node'), 'v22.0.0');
    const second = await fakeNode(join(d, 'c/node'), 'v24.0.0');
    expect((await run({ fixed: [old, first, second] })).out).toBe('v22.0.0 a script.mjs two\n');
  });

  it('picks the newest nvm Node that is 22 or later, comparing versions as numbers', async () => {
    const home = await tmp();
    const base = join(home, '.nvm/versions/node');
    await fakeNode(join(base, 'v9.11.2/bin/node'), 'v9.11.2');
    await fakeNode(join(base, 'v22.9.0/bin/node'), 'v22.9.0');
    await fakeNode(join(base, 'v22.10.0/bin/node'), 'v22.10.0');
    await fakeNode(join(base, 'v20.18.0/bin/node'), 'v20.18.0');
    expect((await run({ home })).out).toBe('v22.10.0 a script.mjs two\n');
  });

  it('falls back to Volta, and an nvm Node is tried before it', async () => {
    const home = await tmp();
    await fakeNode(join(home, '.volta/bin/node'), 'v23.0.0');
    expect((await run({ home })).out).toBe('v23.0.0 a script.mjs two\n');
    await fakeNode(join(home, '.nvm/versions/node/v22.1.0/bin/node'), 'v22.1.0');
    expect((await run({ home })).out).toBe('v22.1.0 a script.mjs two\n');
  });

  it('falls back last to a Node unpacked in ~/.local/node', async () => {
    const home = await tmp();
    await fakeNode(join(home, '.local/node/bin/node'), 'v24.18.0');
    expect((await run({ home })).out).toBe('v24.18.0 a script.mjs two\n');
    await fakeNode(join(home, '.volta/bin/node'), 'v23.0.0');
    expect((await run({ home })).out).toBe('v23.0.0 a script.mjs two\n');
  });

  it('ignores a "node" that prints nothing like a version', async () => {
    const bin = await tmp();
    await fakeNode(join(bin, 'node'), 'banana');
    expect((await run({ path: [bin] })).code).toBe(1);
  });

  describe('with no Node, at the start of a session', () => {
    const NOTICE =
      "Mirage, the video-editing plugin, needs Node.js 22 or later, and this computer doesn't have it, so none of Mirage works yet. At the start of your first reply, before anything else, ask the person whether to install Node now, and say it runs Mirage itself: its engine and the viewer they watch their videos in. Use the mirage:setup skill (step 1) to install it. After Node is installed they need to start a new Claude Code session.";
    const JSON_LINE = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: NOTICE } }) + '\n';
    const start = (env: Record<string, string>) => run({ args: ['hook.mjs', 'session-start'], env });

    it('tells Claude to ask about installing Node, once, outside a project', async () => {
      const data = await tmp();
      const project = await tmp();
      const env = { CLAUDE_PLUGIN_DATA: join(data, 'plugin-data'), CLAUDE_PROJECT_DIR: project };
      expect(await start(env)).toEqual({ out: JSON_LINE, err: '', code: 0 });
      expect(await start(env)).toEqual({ out: '', err: '', code: 0 });
    });

    it('is valid SessionStart JSON carrying the notice', async () => {
      const r = await start({ CLAUDE_PLUGIN_DATA: await tmp(), CLAUDE_PROJECT_DIR: await tmp() });
      expect(JSON.parse(r.out)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: NOTICE } });
    });

    it('says it every time in a Mirage project', async () => {
      const data = await tmp();
      const project = await tmp();
      await writeFile(join(project, 'mirage.json'), '{}');
      const env = { CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: project };
      expect((await start(env)).out).toBe(JSON_LINE);
      expect(await start(env)).toEqual({ out: JSON_LINE, err: '', code: 0 });
    });

    it('says nothing outside a project when there is no data folder to remember in', async () => {
      expect(await start({ CLAUDE_PROJECT_DIR: await tmp() })).toEqual({ out: '', err: '', code: 0 });
    });

    it('looks in the current folder for mirage.json when CLAUDE_PROJECT_DIR is not set', async () => {
      const project = await tmp();
      await writeFile(join(project, 'mirage.json'), '{}');
      const r = spawnSync('/bin/sh', [LAUNCHER, 'hook.mjs', 'session-start'], { encoding: 'utf8', cwd: project, env: { PATH: '/usr/bin:/bin', HOME: await tmp(), MIRAGE_NODE_FIXED: '' } });
      expect(r.stdout).toBe(JSON_LINE);
    });

    it('keeps the old message for every other command', async () => {
      const env = { CLAUDE_PLUGIN_DATA: await tmp(), CLAUDE_PROJECT_DIR: await tmp() };
      expect(await run({ args: ['engine.mjs'], env })).toEqual({ out: '', err: 'Mirage needs Node.js 22 or later. Run /mirage:setup.\n', code: 1 });
      expect(await run({ args: ['hook.mjs', 'pre-tool'], env })).toEqual({ out: '', err: 'Mirage needs Node.js 22 or later. Run /mirage:setup.\n', code: 1 });
    });

    it('still runs the hook with a Node, and prints no notice', async () => {
      const bin = await tmp();
      await fakeNode(join(bin, 'node'), 'v22.4.1');
      const r = await run({ path: [bin], args: ['hook.mjs', 'session-start'], env: { CLAUDE_PLUGIN_DATA: await tmp(), CLAUDE_PROJECT_DIR: await tmp() } });
      expect(r).toEqual({ out: 'v22.4.1 hook.mjs session-start\n', err: '', code: 0 });
    });
  });
});
