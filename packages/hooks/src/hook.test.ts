// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendLog, listVersions, newVideo, readControl, readLog, readSessionState, readSteps, sessionDir, writeControl, writeSessionState,
} from '@wordedits/core';
import { describe, expect, it } from 'vitest';
import { runHook, type HookDeps, type HookInput } from './hook.js';

const E = (x: string) => `mcp__plugin_mirage_engine__${x}`;
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../../plugin/dist/hook.mjs');
const ALLOW = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
const deny = (reason: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const STOP = 'The person stopped the edit. Stop now and say in one line what was finished.';

const tmp = async (prefix = 'mirage-hook-') => realpathSync(await mkdtemp(join(tmpdir(), prefix)));

/** Fake deps: a clock that `sleep` advances, and a swiftc that only records its calls. */
async function fakeDeps(over: Partial<HookDeps> = {}) {
  let t = Date.parse('2026-11-02T22:00:00.000Z');
  const sleeps: number[] = [];
  const compiles: [string, string][] = [];
  const deps: HookDeps = {
    now: () => new Date(t),
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    pluginData: await tmp('mirage-data-'),
    pluginRoot: await tmp('mirage-root-'),
    swiftc: async (src, out) => {
      compiles.push([src, out]);
      return true;
    },
    ...over,
  };
  return { deps, sleeps, compiles };
}

/** A project with video 1 (footage in its own folder) and an episode.json. */
async function project(title = 'My build') {
  const dir = await tmp();
  const footage = await tmp('mirage-footage-');
  await writeFile(join(dir, 'mirage.json'), JSON.stringify({ version: 1, title, createdAt: new Date().toISOString() }));
  const n = await newVideo(dir, { title: 'Desk lamp', about: 'a lamp', mention: '', hide: '', footage: [footage] });
  await writeFile(join(dir, 'episodes', '1', 'episode.json'), '{"v":"A"}');
  return { dir, footage, n };
}

let ids = 0;
const input = (cwd: string, o: Partial<HookInput> = {}): HookInput => ({ session_id: 's1', cwd, hook_event_name: 'PreToolUse', tool_use_id: `toolu_${++ids}`, ...o });
const versions = async (dir: string, n = 1) => (await listVersions(dir, n)).map((v) => [v.kind, v.label]);

describe('runHook', () => {
  it('does nothing outside a Mirage project', async () => {
    const { deps, compiles } = await fakeDeps();
    const dir = await tmp();
    for (const ev of ['pre', 'post', 'stop'] as const) {
      expect(await runHook(ev, input(dir, { tool_name: 'Write', tool_input: { file_path: join(dir, 'x') } }), deps)).toEqual({ stdout: '', exitCode: 0 });
    }
    expect(await runHook('session-start', input(dir, { hook_event_name: 'SessionStart' }), deps)).toEqual({ stdout: '', exitCode: 0 });
    expect(existsSync(join(dir, '.mirage'))).toBe(false);
    expect(compiles).toEqual([]); // no transcribe.swift in this plugin root
  });

  it.skipIf(!existsSync(DIST))('does nothing outside a Mirage project, fast, through the bundled script', async () => {
    const dir = await tmp();
    const json = JSON.stringify(input(dir, { tool_name: 'Read', tool_input: { file_path: 'x' } }));
    execFileSync(process.execPath, [DIST, 'pre'], { input: json }); // warm the disk cache
    const start = performance.now();
    const out = execFileSync(process.execPath, [DIST, 'pre'], { input: json, encoding: 'utf8' });
    expect(performance.now() - start).toBeLessThan(150);
    expect(out).toBe('');
  });

  it('compiles the speech helper at session start when it is missing or older than its source, without waiting', async () => {
    let finish!: (ok: boolean) => void;
    const { deps, compiles } = await fakeDeps();
    deps.swiftc = (src, out) => {
      compiles.push([src, out]);
      return new Promise((r) => (finish = r)); // never settles during the hook
    };
    const src = join(deps.pluginRoot, 'native', 'transcribe.swift');
    await mkdir(dirname(src), { recursive: true });
    await writeFile(src, '// swift');
    const out = join(deps.pluginData, 'bin', 'wordedits-transcribe');
    const elsewhere = await tmp();
    expect((await runHook('session-start', input(elsewhere), deps)).stdout).toBe('');
    expect(compiles).toEqual([[src, out]]);
    expect(existsSync(dirname(out))).toBe(true);
    finish(true);

    // Up to date: no compile.
    await writeFile(out, 'bin');
    const past = new Date(Date.now() - 60_000);
    await utimes(src, past, past);
    await runHook('session-start', input(elsewhere), deps);
    expect(compiles).toHaveLength(1);

    // The source is newer again.
    const future = new Date(Date.now() + 60_000);
    await utimes(src, future, future);
    await runHook('session-start', input(elsewhere), deps);
    expect(compiles).toHaveLength(2);
  });

  it('writes the session file and tells Claude about the project at session start', async () => {
    const { deps } = await fakeDeps();
    const { dir } = await project('Lamp series');
    await newVideo(dir, { title: 'Second', about: '', mention: '', hide: '', footage: [] });
    const r = await runHook('session-start', input(dir, { session_id: 'sess-9', hook_event_name: 'SessionStart' }), deps);
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'This folder is a Mirage project (“Lamp series”, 2 videos). Use the mirage:edit skill to make or change a video.',
      },
    });
    expect(existsSync(join(dir, '.mirage', 'sessions', 'sess-9.json'))).toBe(true);
    // A resumed session keeps its video.
    await writeSessionState(dir, 'sess-9', { video: 2 });
    await runHook('session-start', input(dir, { session_id: 'sess-9', hook_event_name: 'SessionStart' }), deps);
    expect((await readSessionState(dir, 'sess-9')).video).toBe(2);
  });

  it('ignores unknown tools and odd input', async () => {
    const { deps } = await fakeDeps();
    const { dir } = await project();
    for (const ev of ['pre', 'post'] as const) {
      expect((await runHook(ev, input(dir, { tool_name: 'SomethingNew', tool_input: { a: 1 } }), deps)).stdout).toBe('');
      expect((await runHook(ev, input(dir, { tool_name: 'Write' }), deps)).stdout).toBe('');
      expect((await runHook(ev, input(dir, { tool_name: 'Edit', tool_input: 'not an object' }), deps)).stdout).toBe('');
      expect((await runHook(ev, input(dir, { tool_name: 'Read', tool_input: null }), deps)).stdout).toBe('');
      expect((await runHook(ev, input(dir, { tool_name: 'Write', tool_input: { file_path: 'C:\\Users\\me\\episodes\\1\\episode.json' } }), deps)).stdout).toBe('');
      expect((await runHook(ev, input(dir, {}), deps)).stdout).toBe('');
    }
    expect((await runHook('stop', input(dir, {}), deps)).stdout).toBe('');
    // None of these had a video: no steps written.
    expect(existsSync(join(dir, 'episodes', '1', 'sessions'))).toBe(false);
    // A tool of a video with no session folder yet still runs.
    expect((await runHook('pre', input(dir, { tool_name: E('check'), tool_input: { video: 7 } }), deps)).stdout).toBe(ALLOW);
    expect(existsSync(join(dir, 'episodes', '7'))).toBe(false); // nothing is written for a video that isn't there
  });

  it('denies writing into a footage folder (including through a symlink)', async () => {
    const { deps } = await fakeDeps();
    const { dir, footage } = await project();
    const reason = deny('Footage folders are read-only in Mirage.');
    expect((await runHook('pre', input(dir, { tool_name: 'Write', tool_input: { file_path: join(footage, 'new.mov') } }), deps)).stdout).toBe(reason);
    symlinkSync(footage, join(dir, 'clips'));
    expect((await runHook('pre', input(dir, { tool_name: 'Edit', tool_input: { file_path: 'clips/notes.txt' } }), deps)).stdout).toBe(reason);
    expect((await runHook('pre', input(dir, { tool_name: 'Read', tool_input: { file_path: join(footage, 'new.mov') } }), deps)).stdout).toBe('');
  });

  it('denies writes to a path with a .. segment', async () => {
    const { deps } = await fakeDeps();
    const { dir, footage } = await project();
    symlinkSync(footage, join(dir, 'episodes', '1', 'l'));
    const reason = deny('Use a plain path inside the project (no “..”).');
    for (const tool_name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect((await runHook('pre', input(dir, { tool_name, tool_input: { file_path: 'episodes/1/l/../episode.json' } }), deps)).stdout).toBe(reason);
    }
    expect((await runHook('pre', input(dir, { tool_name: 'Write', tool_input: { file_path: `${dir}/episodes/1/../1/summary.md` } }), deps)).stdout).toBe(reason);
    expect((await runHook('pre', input(dir, { tool_name: 'Edit', tool_input: { file_path: 'episodes\\1\\..\\x.json' } }), deps)).stdout).toBe(reason);
    // A name that merely contains dots is fine.
    expect((await runHook('pre', input(dir, { tool_name: 'Write', tool_input: { file_path: 'episodes/1/..notes' } }), deps)).stdout).toBe('');
    // Reads are not guarded.
    expect((await runHook('pre', input(dir, { tool_name: 'Read', tool_input: { file_path: 'episodes/1/../1/episode.json' } }), deps)).stdout).toBe('');
  });

  it('auto-approves engine tools and timeline writes', async () => {
    const { deps } = await fakeDeps();
    const { dir } = await project();
    const pre = (tool_name: string, tool_input: unknown) => runHook('pre', input(dir, { tool_name, tool_input }), deps).then((r) => r.stdout);
    expect(await pre(E('check'), { video: 1 })).toBe(ALLOW);
    expect(await pre(E('new_project'), { title: 'x' })).toBe(ALLOW);
    expect(await pre(E('status'), {})).toBe(ALLOW);
    expect(await pre('Write', { file_path: join(dir, 'catalog.json') })).toBe(ALLOW);
    expect(await pre('Edit', { file_path: join(dir, 'episodes', '1', 'episode.json') })).toBe(ALLOW);
    expect(await pre('MultiEdit', { file_path: 'episodes/1/summary.md' })).toBe(ALLOW);
    expect(await pre('Write', { file_path: join(dir, 'episodes', '1', 'other.txt') })).toBe('');
    expect(await pre('Bash', { command: 'ls' })).toBe('');
    expect(await pre('mcp__plugin_hyperframes_studio__render', {})).toBe('');

    // Steps: a running line for each one with a video, with the tool_use_id.
    const steps = await readSteps(sessionDir(dir, 1, 's1'));
    expect(steps.map((s) => ('label' in s ? [s.label, s.status] : s.type))).toEqual([
      ['Checking the timeline', 'running'],
      ['Writing the timeline', 'running'],
      ['Saving summary.md', 'running'],
      ['Saving other.txt', 'running'],
    ]);
    // The first changing step of this session took a `before` version, once.
    expect(await versions(dir)).toEqual([['before', 'Before this edit']]);
    await runHook('pre', input(dir, { session_id: 's2', tool_name: E('check'), tool_input: { video: 1 } }), deps);
    expect(await versions(dir)).toEqual([['before', 'Before this edit'], ['before', 'Before this edit']]);
  });

  it('takes no before version for a read-only step', async () => {
    const { deps } = await fakeDeps();
    const { dir } = await project();
    await runHook('pre', input(dir, { tool_name: E('versions'), tool_input: { video: 1 } }), deps);
    await runHook('pre', input(dir, { tool_name: 'Read', tool_input: { file_path: join(dir, 'episodes', '1', 'episode.json') } }), deps);
    expect(await versions(dir)).toEqual([]);
  });

  it('holds the next step while paused and denies it with the correction', async () => {
    const { dir } = await project();
    let sleepsSeen = 0;
    const { deps, sleeps } = await fakeDeps();
    const fakeSleep = deps.sleep;
    deps.sleep = async (ms) => {
      await fakeSleep(ms);
      if (++sleepsSeen === 3) await writeControl(dir, 1, { paused: false, correction: 'Use the drone shot first' });
    };
    await writeControl(dir, 1, { paused: true });
    const r = await runHook('pre', input(dir, { tool_name: E('cut'), tool_input: { video: 1 } }), deps);
    expect(sleeps).toEqual([250, 250, 250]);
    expect(r.stdout).toBe(deny("The person paused the edit and said: “Use the drone shot first”. Act on this before you carry on. The step you were about to run didn't run."));
    const steps = await readSteps(sessionDir(dir, 1, 's1'));
    expect(steps.map((s) => ('label' in s ? [s.label, s.status] : s.type))).toEqual([['Rendering the rough cut', 'denied']]);
    expect((await readControl(dir, 1)).correction).toBeNull();
    expect(await versions(dir)).toEqual([]); // the denied step changed nothing

    // Resumed without text: the step runs.
    await writeControl(dir, 1, { paused: true });
    sleepsSeen = 0;
    deps.sleep = async (ms) => {
      await fakeSleep(ms);
      if (++sleepsSeen === 2) await writeControl(dir, 1, { paused: false });
    };
    expect((await runHook('pre', input(dir, { tool_name: E('cut'), tool_input: { video: 1 } }), deps)).stdout).toBe(ALLOW);
  });

  it('gives up holding after 23 h 50 m', async () => {
    const { deps, sleeps } = await fakeDeps();
    const { dir } = await project();
    const clock = deps.now;
    let skew = 0;
    deps.now = () => new Date(clock().getTime() + skew);
    const fakeSleep = deps.sleep;
    deps.sleep = async (ms) => {
      await fakeSleep(ms);
      skew += 3600_000 - ms; // each wait takes an hour, so the test doesn't read control.json 343 200 times
    };
    await writeSessionState(dir, 's1', { video: 1 });
    await writeControl(dir, 1, { paused: true });
    const r = await runHook('pre', input(dir, { tool_name: 'Bash', tool_input: { command: 'ls' } }), deps);
    expect(r.stdout).toBe(deny('The edit has been paused for almost a day. Stop here and say in one line what was finished; the person will resume it later.'));
    expect(sleeps).toHaveLength(24);
    const control = await readControl(dir, 1);
    expect([control.paused, control.stop, control.correction]).toEqual([true, null, null]); // left as it was
  });

  it('stop denies tools and the Stop hook restores the last checkpoint', async () => {
    const { deps } = await fakeDeps();
    const { dir } = await project();
    const ep = join(dir, 'episodes', '1', 'episode.json');
    // A check stage: before (A), then the stage leaves B, checkpoint B.
    expect((await runHook('pre', input(dir, { tool_name: E('check'), tool_input: { video: 1 }, tool_use_id: 't1' }), deps)).stdout).toBe(ALLOW);
    await writeFile(ep, '{"v":"B"}');
    await runHook('post', input(dir, { hook_event_name: 'PostToolUse', tool_name: E('check'), tool_input: { video: 1 }, tool_use_id: 't1', tool_response: [{ type: 'text', text: 'total 0:03' }] }), deps);
    // A later timeline write: work in progress, no checkpoint.
    const write = { tool_name: 'Write', tool_input: { file_path: ep, content: '{"v":"C"}' }, tool_use_id: 't2' };
    expect((await runHook('pre', input(dir, write), deps)).stdout).toBe(ALLOW);
    await writeFile(ep, '{"v":"C"}');
    await runHook('post', input(dir, { hook_event_name: 'PostToolUse', ...write, tool_response: { filePath: ep } }), deps);
    expect(await versions(dir)).toEqual([['before', 'Before this edit'], ['checkpoint', 'Timeline checked']]);

    await writeSessionState(dir, 's1', { video: 1 });
    await writeControl(dir, 1, { stop: { at: new Date().toISOString() } });
    expect((await runHook('pre', input(dir, { tool_name: 'Read', tool_input: { file_path: join(dir, 'catalog.json') } }), deps)).stdout).toBe(deny(STOP));
    expect((await runHook('pre', input(dir, { tool_name: E('cut'), tool_input: { video: 1 } }), deps)).stdout).toBe(deny(STOP));

    expect((await runHook('stop', input(dir, { hook_event_name: 'Stop' }), deps)).stdout).toBe('');
    expect(await readFile(ep, 'utf8')).toBe('{"v":"B"}');
    const all = await listVersions(dir, 1);
    const backup = all.at(-1)!;
    expect(backup.label).toBe('Before going back to “Timeline checked”');
    expect(await readFile(join(dir, 'episodes', '1', 'versions', backup.id, 'episode.json'), 'utf8')).toBe('{"v":"C"}');
    const control = await readControl(dir, 1);
    expect([control.stop, control.paused, control.pauseNow]).toEqual([null, false, false]);
    const steps = await readSteps(sessionDir(dir, 1, 's1'));
    expect(steps.at(-1)).toMatchObject({ type: 'turn-end' });
    // The next edit runs.
    expect((await runHook('pre', input(dir, { tool_name: E('cut'), tool_input: { video: 1 } }), deps)).stdout).toBe(ALLOW);
  });

  it('a stop on a video this session never changed is cleared without going back', async () => {
    const { deps } = await fakeDeps();
    const { dir } = await project();
    await writeSessionState(dir, 's1', { video: 1 });
    await writeControl(dir, 1, { stop: { at: new Date().toISOString() } });
    expect((await runHook('pre', input(dir, { tool_name: 'Bash', tool_input: {} }), deps)).stdout).toBe(deny(STOP));
    await runHook('stop', input(dir, { hook_event_name: 'Stop' }), deps);
    expect(await versions(dir)).toEqual([]);
    expect((await readControl(dir, 1)).stop).toBeNull();
    expect(await readFile(join(dir, 'episodes', '1', 'episode.json'), 'utf8')).toBe('{"v":"A"}');
  });

  it('post takes a checkpoint after an engine stage, none after a timeline write, and a delivery after cut', async () => {
    const { deps } = await fakeDeps();
    const { dir } = await project();
    const post = (tool_name: string, tool_input: unknown, tool_response: unknown) =>
      runHook('post', input(dir, { hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response }), deps);
    await post(E('check'), { video: 1 }, { content: [{ type: 'text', text: 'ok' }] });
    await post('Write', { file_path: join(dir, 'episodes', '1', 'episode.json') }, { type: 'update' });
    expect(await versions(dir)).toEqual([['checkpoint', 'Timeline checked']]);
    await writeFile(join(dir, 'episodes', '1', 'rough.mp4'), 'video bytes');
    await post(E('cut'), { video: 1 }, [{ type: 'text', text: '✓ rendered' }]);
    const all = await listVersions(dir, 1);
    expect(all.map((v) => [v.kind, v.label, v.delivery, v.render?.mode ?? null, v.sessionId])).toEqual([
      ['checkpoint', 'Timeline checked', null, null, 's1'],
      ['checkpoint', 'Rough cut rendered', null, null, 's1'],
      ['delivery', 'Rough cut', 1, 'rough', 's1'],
    ]);
    // A failed stage: a failed line with the ✖ line as detail, and no versions.
    await post(E('guide'), { video: 1 }, { content: [{ type: 'text', text: '• checking\n✖ episodes/1/episode.json does not exist\n  Ask Claude…' }], isError: true });
    await writeFile(join(dir, 'episodes', '1', 'final.mp4'), 'video bytes');
    await post(E('render'), { video: 1 }, { result: '✖ ffmpeg failed\n  Try again.' });
    expect(await listVersions(dir, 1)).toHaveLength(3);
    const steps = await readSteps(sessionDir(dir, 1, 's1'));
    expect(steps.map((s) => ('label' in s ? [s.label, s.status, s.detail ?? null] : s.type))).toEqual([
      ['Timeline checked', 'done', null],
      ['Timeline written', 'done', null],
      ['Rough cut rendered', 'done', null],
      ['Rendering the guide video', 'failed', '✖ episodes/1/episode.json does not exist'],
      ['Rendering the final video', 'failed', '✖ ffmpeg failed'],
    ]);
  });

  it('post sees an engine error in a bare content array: no checkpoint, no delivery', async () => {
    const { deps } = await fakeDeps();
    const { dir } = await project();
    await writeFile(join(dir, 'episodes', '1', 'rough.mp4'), 'an older render');
    await runHook('post', input(dir, {
      hook_event_name: 'PostToolUse', tool_name: E('cut'), tool_input: { video: 1 },
      tool_response: [{ type: 'text', text: '\n✖ episodes/1/episode.json: item 3 has no clip\n  Fix the timeline.' }],
    }), deps);
    expect(await listVersions(dir, 1)).toEqual([]);
    const steps = await readSteps(sessionDir(dir, 1, 's1'));
    expect(steps).toMatchObject([{ label: 'Rendering the rough cut', status: 'failed', detail: '✖ episodes/1/episode.json: item 3 has no clip' }]);
    // A ✖ further down a successful report is not a failure.
    await runHook('post', input(dir, { hook_event_name: 'PostToolUse', tool_name: E('check'), tool_input: { video: 1 }, tool_response: [{ type: 'text', text: 'total 0:03\n✖ not the first line' }] }), deps);
    expect(await versions(dir)).toEqual([['checkpoint', 'Timeline checked']]);
    // Claude's own Write echoes the file's content: a file that starts with ✖ is not a failed write.
    await runHook('post', input(dir, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(dir, 'episodes', '1', 'summary.md') }, tool_response: { type: 'create', content: '✖ marks the cut' } }), deps);
    expect((await readSteps(sessionDir(dir, 1, 's1'))).at(-1)).toMatchObject({ label: 'Saved summary.md', status: 'done' });
  });

  it('a stop still clears when going back fails, and the log says to go back by hand', async () => {
    const { deps } = await fakeDeps();
    const { dir } = await project();
    await runHook('post', input(dir, { hook_event_name: 'PostToolUse', tool_name: E('check'), tool_input: { video: 1 }, tool_response: 'ok' }), deps);
    const [cp] = await listVersions(dir, 1);
    // Break the checkpoint: its episode.json is a folder, so it can't be read back.
    const saved = join(dir, 'episodes', '1', 'versions', cp!.id, 'episode.json');
    await rm(saved);
    await mkdir(saved);
    await writeControl(dir, 1, { stop: { at: new Date().toISOString() } });
    await runHook('stop', input(dir, { hook_event_name: 'Stop' }), deps);
    expect((await readControl(dir, 1)).stop).toBeNull();
    const log = await readLog(sessionDir(dir, 1, 's1'));
    expect(log).toHaveLength(1);
    expect(log[0]!.kind).toBe('warning');
    expect(log[0]!.text).toMatch(/^Couldn’t go back to the last finished step: .+\. Use the viewer’s Versions tab to go back by hand\.$/);
    expect(await readFile(join(dir, 'episodes', '1', 'episode.json'), 'utf8')).toBe('{"v":"A"}');
  });

  it('does nothing at all without a session id', async () => {
    const { deps, compiles } = await fakeDeps();
    const { dir } = await project();
    const src = join(deps.pluginRoot, 'native', 'transcribe.swift');
    await mkdir(dirname(src), { recursive: true });
    await writeFile(src, '// swift');
    await writeControl(dir, 1, { stop: { at: new Date().toISOString() } });
    for (const session_id of [undefined, 42, null, '']) {
      for (const ev of ['session-start', 'pre', 'post', 'stop'] as const) {
        const i = { ...input(dir, { tool_name: E('check'), tool_input: { video: 1 }, tool_response: 'ok' }), session_id } as unknown as HookInput;
        expect(await runHook(ev, i, deps)).toEqual({ stdout: '', exitCode: 0 });
      }
    }
    expect(compiles).toEqual([]);
    expect(existsSync(join(dir, '.mirage'))).toBe(false);
    expect(await readdir(join(dir, 'episodes', '1'))).toEqual(expect.not.arrayContaining(['sessions', 'versions']));
    expect((await readControl(dir, 1)).stop).not.toBeNull();
  });

  it('post records the video new_video made', async () => {
    const { deps } = await fakeDeps();
    const { dir } = await project();
    await writeSessionState(dir, 's1', { video: 1 });
    await newVideo(dir, { title: 'Two', about: '', mention: '', hide: '', footage: [] });
    await runHook('post', input(dir, { hook_event_name: 'PostToolUse', tool_name: E('new_video'), tool_input: { title: 'Two' }, tool_response: [{ type: 'text', text: 'video 2 created' }] }), deps);
    expect((await readSessionState(dir, 's1')).video).toBe(2);
    const steps = await readSteps(sessionDir(dir, 2, 's1'));
    expect(steps.map((s) => ('label' in s ? [s.label, s.status] : s.type))).toEqual([['Video set up', 'done']]);
  });

  it('writes the morning report at the end of an overnight turn', async () => {
    const { deps } = await fakeDeps();
    const { dir } = await project();
    await writeSessionState(dir, 's1', { video: 1, overnight: { videos: [1], startedAt: new Date(Date.now() - 1000).toISOString() } });
    const sdir = sessionDir(dir, 1, 's1');
    await runHook('pre', input(dir, { tool_name: E('check'), tool_input: { video: 1 }, tool_use_id: 'a' }), deps);
    await runHook('post', input(dir, { hook_event_name: 'PostToolUse', tool_name: E('check'), tool_input: { video: 1 }, tool_use_id: 'a', tool_response: 'ok' }), deps);
    await writeFile(join(dir, 'episodes', '1', 'guide.mp4'), 'v');
    await runHook('post', input(dir, { hook_event_name: 'PostToolUse', tool_name: E('guide'), tool_input: { video: 1 }, tool_use_id: 'b', tool_response: 'ok' }), deps);
    await appendLog(sdir, { at: new Date().toISOString(), kind: 'guess', text: 'Used the slow track' });
    await runHook('stop', input(dir, { hook_event_name: 'Stop' }), deps);
    const md = await readFile(join(sdir, 'report.md'), 'utf8');
    expect(md).toBe([
      '# Desk lamp: V1 ready', '', '## What I did', '', '- Timeline checked', '- Guide video rendered', '',
      '## Choices I made for you', '', '- Used the slow track', '',
      '## Next', '', "Record the voice-over: open the video in Mirage's viewer, go to Review, and follow the steps there.", '',
    ].join('\n'));
  });

  it('no report outside overnight', async () => {
    const { deps } = await fakeDeps();
    const { dir } = await project();
    await writeSessionState(dir, 's1', { video: 1 });
    await runHook('post', input(dir, { hook_event_name: 'PostToolUse', tool_name: E('check'), tool_input: { video: 1 }, tool_response: 'ok' }), deps);
    await runHook('stop', input(dir, { hook_event_name: 'Stop' }), deps);
    expect(existsSync(join(sessionDir(dir, 1, 's1'), 'report.md'))).toBe(false);
  });
});

describe('main.ts', () => {
  const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), 'main.ts');
  const run = (event: string, stdin: string, env: Record<string, string> = {}) =>
    execFileSync(process.execPath, ['--import', 'tsx', MAIN, event], { input: stdin, encoding: 'utf8', env: { ...process.env, ...env } });

  it('exits 0 printing nothing on bad input, with one line in hook-errors.log', async () => {
    const data = await tmp('mirage-data-');
    expect(run('pre', 'not json', { CLAUDE_PLUGIN_DATA: data })).toBe('');
    const log = await readFile(join(data, 'hook-errors.log'), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(log).toMatch(/ pre SyntaxError/);
    expect(run('nonsense', '{}')).toBe('');
  });

  it('prints the decision in a project', async () => {
    const { dir } = await project();
    const out = run('pre', JSON.stringify(input(dir, { tool_name: E('status'), tool_input: {} })), { CLAUDE_PLUGIN_DATA: await tmp('mirage-data-') });
    expect(out).toBe(ALLOW);
  });
});
