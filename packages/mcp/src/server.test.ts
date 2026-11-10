// SPDX-License-Identifier: MIT
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
formatsDir, formulasDir, loadCatalog, loadEpisode, readLog, realMediaTools, readSessionState, saveCatalog, saveEpisode, sessionDir, snapshotVersion, writeClaudeProcess, writeControl, writeSessionState,
  type ChannelDeps, type MediaTools,
} from '@wordedits/core';
import { EpisodeSchema } from '@wordedits/shared';
import { run, SidecarError, type Speaker } from '@wordedits/sidecars';
import { afterEach, describe, expect, it } from 'vitest';
import type { PreflightDeps } from './preflight.js';
import { createEngineServer, newestSessionId, TOOL_NAMES, type EngineContext } from './server.js';

const enc = { name: 'libx264' as const, extraArgs: [] };
const GB = 1024 ** 3;
const BUILD_STORY = '(format build-story: cold-open → title → recap → new-toy → problem → montage → twist → truth → outro → blooper)';
const deps = (over: Partial<PreflightDeps> = {}): PreflightDeps => ({ onBattery: async () => false, freeBytes: async () => 500 * GB, footageBytes: async () => GB, which: async () => true, captions: async () => ({ ok: true, path: '/bin/ffmpeg' }), transcriber: async () => null, tts: async () => ({ state: 'ok' }), ...over });

const clients: Client[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()!.close();
});

/** A server on a temp project and a client wired to it in memory. */
async function connect(project: string, over: Partial<EngineContext> = {}) {
  const tools = { pickEncoder: async () => enc, runFfmpeg: async () => {}, probe: async () => { throw new Error('probe not stubbed'); } } as unknown as MediaTools;
  const server = createEngineServer({ project, tools, sessionId: () => 's1', preflightDeps: deps(), startAwake: () => 4242, ...over });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
    return { isError: r.isError === true, text: r.content.map((c) => c.text).join('\n') };
  };
  return { client, call };
}

/** A project with one clip and a one-item video 1. */
async function projectWithVideo(episodeExtra: object = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mirage-mcp-'));
  await writeFile(join(dir, 'mirage.json'), JSON.stringify({ version: 1, title: 'My build', createdAt: new Date().toISOString() }));
  await writeFile(join(dir, 'screen.mov'), '');
  await saveCatalog(dir, {
    version: 1,
    clips: [{
      id: 'c001', path: join(dir, 'screen.mov'), sha256: 'a'.repeat(64), kind: 'screen', transcript: null, frames: [], notes: '', moments: [],
      probe: { durationSec: 30, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: false, videoCodec: 'h264', audioCodec: null, colorTransfer: null },
    }],
  });
  await saveEpisode(dir, EpisodeSchema.parse({
    version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
    items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 3 } }], ...episodeExtra,
  }));
  return dir;
}

describe('engine tools', () => {
  it('lists exactly the engine tools', async () => {
    const { client } = await connect(await mkdtemp(join(tmpdir(), 'mirage-mcp-')));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual([...TOOL_NAMES].sort());
    expect([...TOOL_NAMES]).toEqual([
      'new_project', 'new_video', 'ingest', 'music', 'check', 'cut', 'slots', 'guide', 'vo', 'speak', 'render', 'versions', 'restore', 'get_notes', 'note_status', 'log', 'overnight', 'status', 'setup_later', 'formats', 'thumbnail', 'formulas', 'channel', 'posted', 'learn', 'predict', 'series',
    ]);
  });

  it('new_project creates mirage.json once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-mcp-'));
    const { call } = await connect(dir);
    const first = await call('new_project', { title: 'Weekend build' });
    expect(first.isError).toBe(false);
    expect(JSON.parse(await readFile(join(dir, 'mirage.json'), 'utf8'))).toMatchObject({ version: 1, title: 'Weekend build' });
    const again = await call('new_project', { title: 'Another' });
    expect(again).toEqual({ isError: false, text: 'already a Mirage project: Weekend build' });
    expect(JSON.parse(await readFile(join(dir, 'mirage.json'), 'utf8')).title).toBe('Weekend build');
  });

  it('new_video refuses a missing footage folder', async () => {
    const dir = await projectWithVideo();
    const { call } = await connect(dir);
    const gone = join(dir, 'nowhere');
    const r = await call('new_video', { title: 'Two', about: 'x', footage: [gone] });
    expect(r).toEqual({ isError: true, text: `✖ ${gone} does not exist` });
    expect(existsSync(join(dir, 'episodes', '2'))).toBe(false);
  });

  it('new_video refuses footage that is not a folder, or that is or holds the project (also through a symlink)', async () => {
    const parent = realpathSync(await mkdtemp(join(tmpdir(), 'mirage-clips-')));
    const dir = join(parent, 'series');
    await mkdir(dir);
    await writeFile(join(dir, 'mirage.json'), JSON.stringify({ version: 1, title: 'My build', createdAt: new Date().toISOString() }));
    await writeFile(join(parent, 'a.mov'), '');
    await symlink(parent, join(dir, 'clips-link'));
    const { call } = await connect(dir);
    const holds = (p: string) => `✖ ${p} holds this project. Make a new folder for the series, open Claude Code there, and add the clips folder from there.`;
    const file = join(parent, 'a.mov');
    const r = await call('new_video', { title: 'Two', about: 'x', footage: [file, dir, parent, join(dir, 'clips-link')] });
    expect(r).toEqual({ isError: true, text: [`✖ ${file} isn't a folder.`, holds(dir), holds(parent), holds(join(dir, 'clips-link'))].join('\n') });
    expect(existsSync(join(dir, 'episodes'))).toBe(false);
    // A folder beside the project, or inside it, is fine.
    await mkdir(join(parent, 'clips'));
    await mkdir(join(dir, 'raw'));
    expect((await call('new_video', { title: 'Two', about: 'x', footage: [join(parent, 'clips'), join(dir, 'raw')] })).text).toBe(`video 1 created ${BUILD_STORY}`);
  });

  it('new_video creates the video and records it in the session state', async () => {
    const dir = await projectWithVideo();
    const { call } = await connect(dir);
    const clips = await mkdtemp(join(tmpdir(), 'mirage-clips-'));
    const r = await call('new_video', { title: 'Two', about: 'the second', mention: 'the bug', footage: [clips] });
    expect(r).toEqual({ isError: false, text: `video 2 created ${BUILD_STORY}` });
    expect(JSON.parse(await readFile(join(dir, 'episodes', '2', 'video.json'), 'utf8'))).toMatchObject({ title: 'Two', mention: 'the bug', hide: '', footage: [clips] });
    expect((await readSessionState(dir, 's1')).video).toBe(2);
  });

  it('new_video keeps the idea answers the person gave in video.json, and no idea at all when none was given', async () => {
    const dir = await projectWithVideo();
    const { call } = await connect(dir);
    const clips = await mkdtemp(join(tmpdir(), 'mirage-clips-'));
    expect(await call('new_video', { title: 'Two', about: 'x', footage: [clips], idea: { question: 'Will it light?', stake: '£40 of parts', doubt: '' } })).toEqual({ isError: false, text: `video 2 created ${BUILD_STORY}` });
    expect(JSON.parse(await readFile(join(dir, 'episodes', '2', 'video.json'), 'utf8')).idea).toEqual({ question: 'Will it light?', stake: '£40 of parts' });
    await call('new_video', { title: 'Three', about: 'x', footage: [clips] });
    expect('idea' in JSON.parse(await readFile(join(dir, 'episodes', '3', 'video.json'), 'utf8'))).toBe(false);
    expect((await call('new_video', { title: 'Four', about: 'x', footage: [clips], idea: { stakes: 'a typo' } })).isError).toBe(false); // an unknown answer is dropped by the input schema
    expect('idea' in JSON.parse(await readFile(join(dir, 'episodes', '4', 'video.json'), 'utf8'))).toBe(false);
  });

  it('new_video keeps the video\'s experiment, all three parts or none', async () => {
    const dir = await projectWithVideo();
    const { call } = await connect(dir);
    const clips = await mkdtemp(join(tmpdir(), 'mirage-clips-'));
    const experiment = { rule: 'Open on the first word', change: 'opens on the result', expect: 'a higher percentage viewed' };
    expect((await call('new_video', { title: 'Two', about: 'x', footage: [clips], experiment })).isError).toBe(false);
    expect(JSON.parse(await readFile(join(dir, 'episodes', '2', 'video.json'), 'utf8')).experiment).toEqual(experiment);
    expect((await call('new_video', { title: 'Three', about: 'x', footage: [clips], experiment: { rule: 'r', change: 'c' } })).isError).toBe(true);
    expect(existsSync(join(dir, 'episodes', '3'))).toBe(false);
  });

  it('new_video in a format names the format and its beats, and numbers vlogs', async () => {
    const dir = await projectWithVideo();
    const { call } = await connect(dir);
    const clips = await mkdtemp(join(tmpdir(), 'mirage-clips-'));
    const vlog = { title: 'Ibiza day 1', about: 'the trip', footage: [clips], format: 'vlog', vlog: { name: 'Ibiza', date: '2026-07-01' } };
    expect(await call('new_video', vlog)).toEqual({ isError: false, text: 'video 2 created (format vlog: cold-open → title-card → premise → bit → headline → sponsor → plugs → tag)' });
    expect(await call('new_video', { ...vlog, title: 'Ibiza day 2', vlog: { name: 'Ibiza', date: '2026-07-02' }, targetSec: 600 })).toMatchObject({ isError: false });
    expect(JSON.parse(await readFile(join(dir, 'episodes', '2', 'video.json'), 'utf8'))).toMatchObject({ format: 'vlog', vlog: { name: 'Ibiza', number: 1, date: '2026-07-01' } });
    expect(JSON.parse(await readFile(join(dir, 'episodes', '3', 'video.json'), 'utf8'))).toMatchObject({ format: 'vlog', targetSec: 600, vlog: { name: 'Ibiza', number: 2, date: '2026-07-02' } });
    // Another name counts from 1; vlog without format vlog is refused, and no video is made.
    expect(await call('new_video', { ...vlog, title: 'Paris day 1', vlog: { name: 'Paris', date: '2026-08-01' } })).toMatchObject({ isError: false });
    expect(JSON.parse(await readFile(join(dir, 'episodes', '4', 'video.json'), 'utf8'))).toMatchObject({ vlog: { name: 'Paris', number: 1 } });
    expect(await call('new_video', { ...vlog, format: 'short' })).toEqual({ isError: true, text: '✖ vlog: { name, date } is for format vlog\n  Pass format: "vlog" with it, or leave vlog out.' });
    expect(existsSync(join(dir, 'episodes', '5'))).toBe(false);
  });

  it('new_video from a big video copies its footage and answers and is a short; from a short too; ✖ for a missing video or an unknown format', async () => {
    const dir = await projectWithVideo();
    const { call } = await connect(dir);
    const clips = await mkdtemp(join(tmpdir(), 'mirage-clips-'));
    await call('new_video', { title: 'The proposal', about: 'my brother proposes', mention: 'the ring', hide: 'the address', footage: [clips] });
    const SHORT = '(format short: hook → tease → pointer → payoff → loop)';
    expect(await call('new_video', { title: 'Did he say yes?', from: 2, mention: 'the cake' })).toEqual({ isError: false, text: `video 3 created ${SHORT}` });
    expect(JSON.parse(await readFile(join(dir, 'episodes', '3', 'video.json'), 'utf8'))).toMatchObject({
      title: 'Did he say yes?', about: 'my brother proposes', mention: 'the ring\nthe cake', hide: 'the address', footage: [clips], format: 'short', from: 2,
    });
    expect((await readSessionState(dir, 's1')).video).toBe(3);
    expect(await call('new_video', { title: 'Shorter', from: 3 })).toEqual({ isError: false, text: `video 4 created ${SHORT}` });
    expect(JSON.parse(await readFile(join(dir, 'episodes', '4', 'video.json'), 'utf8'))).toMatchObject({ footage: [clips], format: 'short', from: 3 });
    expect(await call('new_video', { title: 'x', from: 9 })).toEqual({ isError: true, text: '✖ there is no video 9\n  Run status to see the videos.' });
    expect(await call('new_video', { title: 'x', about: 'x', footage: [clips], format: 'reel' })).toEqual({ isError: true, text: '✖ unknown format "reel"\n  The formats are: build-story, short, vlog.' });
    expect(existsSync(join(dir, 'episodes', '5'))).toBe(false);
  });

  it('check of a short warns against its format', async () => {
    const dir = await projectWithVideo({ output: { width: 1080, height: 1920, fps: 30 }, items: [{ id: 'a', beat: 'title', clip: 'c001', src: { in: 0, out: 3 } }], captions: { style: 'pop', position: 'middle' } });
    const { call } = await connect(dir);
    await writeFile(join(dir, 'episodes', '1', 'video.json'), JSON.stringify({ version: 1, title: 't', about: '', mention: '', hide: '', footage: [], createdAt: new Date().toISOString(), format: 'short' }));
    const lines = (await call('check', { video: 1 })).text.split('\n');
    expect(lines).toContain('⚠ a short opens on its hook, not a title: item a');
  });

  it('check returns the timeline lines', async () => {
    const dir = await projectWithVideo();
    const { call } = await connect(dir);
    const r = await call('check', { video: 1 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('problem');
    expect(r.text).toContain('c001');
    expect(r.text).toMatch(/total .* · 1 items · 0 overlays · 0 music cues/);
  });

  it('check on a missing clip returns the engine error', async () => {
    const dir = await projectWithVideo({ items: [{ id: 'x', beat: 'problem', clip: 'c999', src: { in: 0, out: 1 } }] });
    const { call } = await connect(dir);
    const r = await call('check', { video: 1 });
    expect(r.isError).toBe(true);
    expect(r.text.startsWith('✖ ')).toBe(true);
    expect(r.text).toContain('c999');
    expect(r.text).toContain('\n  '); // the hint, indented
  });

  it('cut stops when the control file asks and says nothing was changed', async () => {
    const dir = await projectWithVideo();
    let started!: () => void;
    const inFfmpeg = new Promise<void>((r) => (started = r));
    const tools = {
      pickEncoder: async () => enc,
      runFfmpeg: async (_a: string[], o?: { signal?: AbortSignal }) => {
        started();
        await new Promise<void>((_, reject) => o!.signal!.addEventListener('abort', () => reject(new SidecarError('ffmpeg', 'CANCELLED', 'ffmpeg was stopped', 'Stopped on request.'))));
      },
    } as unknown as MediaTools;
    const { call } = await connect(dir, { tools });
    const running = call('cut', { video: 1 });
    await inFfmpeg;
    await new Promise((r) => setTimeout(r, 100));
    await writeControl(dir, 1, { pauseNow: true });
    const r = await running;
    expect(r).toEqual({ isError: true, text: '✖ Stopped by the person before it finished. Nothing was changed.' });
    expect(existsSync(join(dir, 'episodes', '1', 'rough.mp4'))).toBe(false);
    expect(existsSync(join(sessionDir(dir, 1, 's1'), 'progress.json'))).toBe(false);
    expect(await readdir(join(dir, 'episodes', '1'))).not.toContain('.mirage.lock');
  });

  it('cut is not stopped by a pauseNow from before it started, even when control.json is rewritten meanwhile', async () => {
    const dir = await projectWithVideo();
    await writeControl(dir, 1, { pauseNow: true });
    let started!: () => void;
    const inFfmpeg = new Promise<void>((r) => (started = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tools = {
      pickEncoder: async () => enc,
      probe: async () => ({ durationSec: 3, width: 960, height: 540, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', colorTransfer: null }),
      runFfmpeg: async (args: string[]) => {
        started();
        await gate;
        await writeFile(args[args.length - 1], 'video');
      },
    } as unknown as MediaTools;
    const { call } = await connect(dir, { tools });
    const running = call('cut', { video: 1 });
    await inFfmpeg;
    await writeControl(dir, 1, { correction: 'make the intro shorter' }); // bumps updatedAt, pauseNow still on from before
    await new Promise((r) => setTimeout(r, 600)); // more than two polls
    release();
    const r = await running;
    expect(r.isError).toBe(false);
    expect(r.text).toContain('rough.mp4');
  });

  it('cut stops on a pauseNow that was switched off and on again after it started', async () => {
    const dir = await projectWithVideo();
    await writeControl(dir, 1, { pauseNow: true });
    let started!: () => void;
    const inFfmpeg = new Promise<void>((r) => (started = r));
    const tools = {
      pickEncoder: async () => enc,
      runFfmpeg: async (_a: string[], o?: { signal?: AbortSignal }) => {
        started();
        await new Promise<void>((_, reject) => o!.signal!.addEventListener('abort', () => reject(new SidecarError('ffmpeg', 'CANCELLED', 'ffmpeg was stopped', 'Stopped on request.'))));
      },
    } as unknown as MediaTools;
    const { call } = await connect(dir, { tools });
    const running = call('cut', { video: 1 });
    await inFfmpeg;
    await writeControl(dir, 1, { pauseNow: false });
    await new Promise((r) => setTimeout(r, 400));
    await writeControl(dir, 1, { pauseNow: true });
    expect((await running).text).toBe('✖ Stopped by the person before it finished. Nothing was changed.');
  });

  it('ingest says the clips catalogued so far are kept when it is stopped', async () => {
    const dir = await projectWithVideo();
    const clips = join(dir, 'new clips');
    await mkdir(clips);
    await writeFile(join(clips, 'a.mov'), 'footage');
    let started!: () => void;
    const inFfmpeg = new Promise<void>((r) => (started = r));
    const tools = {
      probe: async () => ({ durationSec: 3, width: 960, height: 540, fps: 30, hasVideo: true, hasAudio: false, videoCodec: 'h264', audioCodec: null, colorTransfer: null }),
      runFfmpeg: async (_a: string[], o?: { signal?: AbortSignal }) => {
        started();
        await new Promise<void>((_, reject) => o!.signal!.addEventListener('abort', () => reject(new SidecarError('ffmpeg', 'CANCELLED', 'ffmpeg was stopped', 'Stopped on request.'))));
      },
    } as unknown as MediaTools;
    const { call } = await connect(dir, { tools });
    await call('new_video', { title: 'Two', about: 'x', footage: [clips] }); // the session now works on video 2
    const running = call('ingest', { folder: clips });
    await inFfmpeg;
    await new Promise((r) => setTimeout(r, 100));
    await writeControl(dir, 2, { stop: { at: new Date().toISOString() } });
    expect(await running).toEqual({ isError: true, text: '✖ Stopped by the person before it finished. Clips catalogued so far are kept.' });
  });

  it('logs a warning that is in the middle of a line, and a video-less warning to the newest video', async () => {
    const dir = await projectWithVideo();
    const { call } = await connect(dir);
    await call('slots', { video: 1 });
    const ep = await loadEpisode(dir, 1);
    await saveEpisode(dir, { ...ep, slots: ep.slots.map((s, i) => (i === 0 ? { ...s, line: Array(s.maxWords + 5).fill('word').join(' ') } : s)) });
    const r = await call('slots', { video: 1 });
    expect(r.text).toMatch(/ {2}.*⚠ over budget/);
    expect(await readLog(sessionDir(dir, 1, 's1'))).toMatchObject([{ kind: 'warning', text: expect.stringMatching(/^over budget \(/) }]);

    // ingest before the session has a video: the HDR warning goes to the newest video (here 1)
    const clips = join(dir, 'hdr clips');
    await mkdir(clips);
    await writeFile(join(clips, 'a.mov'), 'footage');
    const tools = {
      probe: async () => ({ durationSec: 3, width: 960, height: 540, fps: 30, hasVideo: true, hasAudio: false, videoCodec: 'h264', audioCodec: null, colorTransfer: 'smpte2084' }),
      runFfmpeg: async (_a: string[], o?: { cwd?: string }) => { await writeFile(join(o!.cwd!, 'f0001.jpg'), 'x'); },
    } as unknown as MediaTools;
    const other = await connect(dir, { tools });
    const ing = await other.call('ingest', { folder: clips });
    expect(ing.text).toContain('is HDR');
    expect((await readLog(sessionDir(dir, 1, 's1'))).map((e) => e.text)).toContainEqual(expect.stringMatching(/^a\.mov is HDR/));
  });

  it('cut ignores a stop from before it started', async () => {
    const dir = await projectWithVideo();
    await writeControl(dir, 1, { stop: { at: new Date().toISOString() }, pauseNow: true });
    await new Promise((r) => setTimeout(r, 20));
    const tools = {
      pickEncoder: async () => enc,
      probe: async () => ({ durationSec: 3, width: 960, height: 540, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', colorTransfer: null }),
      runFfmpeg: async (args: string[]) => { await writeFile(args[args.length - 1], 'video'); },
    } as unknown as MediaTools;
    const { call } = await connect(dir, { tools });
    const r = await call('cut', { video: 1 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('✓ ');
    expect(r.text).toContain('rough.mp4');
  });

  it('get_notes prints the newest round with boxes and stills', async () => {
    const dir = await projectWithVideo();
    const note = (id: string, round: number | null, extra: object = {}) => ({ id, versionId: 'v1', t: 12.34, text: `text of ${id}`, box: null, still: `notes/${id}.jpg`, createdAt: new Date().toISOString(), round, ...extra });
    await writeFile(join(dir, 'episodes', '1', 'notes.json'), JSON.stringify({
      version: 1,
      notes: [note('n1', 1), note('n2', 2, { box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }), note('n3', 2), note('n4', null)],
    }));
    const { call } = await connect(dir);
    const still = (id: string) => join(dir, 'episodes', '1', 'notes', `${id}.jpg`);
    const newest = await call('get_notes', { video: 1 });
    expect(newest.text).toBe(
      [
        `Note n2 at 12.3 s: text of n2\n(about the area 10%–40% across, 20%–60% down)\nStill: ${still('n2')}`,
        `Note n3 at 12.3 s: text of n3\nStill: ${still('n3')}`,
      ].join('\n\n'),
    );
    const first = await call('get_notes', { video: 1, round: 1 });
    expect(first.text).toBe(`Note n1 at 12.3 s: text of n1\nStill: ${still('n1')}`);
    expect((await call('get_notes', { video: 1, round: 9 })).text).toBe('no notes in round 9');
  });

  it('get_notes says so when nothing was sent', async () => {
    const dir = await projectWithVideo();
    const { call } = await connect(dir);
    expect(await call('get_notes', { video: 1 })).toEqual({ isError: false, text: 'no notes have been sent yet' });
  });

  it('note_status needs a reason unless done', async () => {
    const dir = await projectWithVideo();
    await writeFile(join(dir, 'episodes', '1', 'notes.json'), JSON.stringify({ version: 1, notes: [{ id: 'n1', versionId: 'v', t: 1, text: 'x', box: null, still: 'notes/n1.jpg', createdAt: new Date().toISOString(), round: 1 }] }));
    const { call } = await connect(dir);
    const bad = await call('note_status', { video: 1, noteId: 'n1', status: 'could-not' });
    expect(bad).toEqual({ isError: true, text: '✖ say why: reason is needed unless the note is done' });
    expect(await readLog(sessionDir(dir, 1, 's1'))).toEqual([]);
    expect(await call('note_status', { video: 1, noteId: 'n1', status: 'done-differently', reason: 'used a cut instead' })).toEqual({ isError: false, text: 'noted' });
    expect(await call('note_status', { video: 1, noteId: 'n1', status: 'done' })).toEqual({ isError: false, text: 'noted' });
    expect(await readLog(sessionDir(dir, 1, 's1'))).toMatchObject([
      { kind: 'note-status', noteId: 'n1', status: 'done-differently', text: 'used a cut instead' },
      { kind: 'note-status', noteId: 'n1', status: 'done', text: '' },
    ]);
    expect((await call('note_status', { video: 1, noteId: 'n9', status: 'done' })).isError).toBe(true);
  });

  it('log appends a guess, question or concern to the session log', async () => {
    const dir = await projectWithVideo();
    const { call } = await connect(dir);
    expect(await call('log', { video: 1, kind: 'guess', text: 'assumed the intro is 5 s' })).toEqual({ isError: false, text: 'noted' });
    expect(await readLog(sessionDir(dir, 1, 's1'))).toMatchObject([{ kind: 'guess', text: 'assumed the intro is 5 s' }]);
    expect((await call('log', { video: 1, kind: 'guess', text: '' })).isError).toBe(true);
  });

  it('a ⚠ warning from check goes into the session log', async () => {
    const dir = await projectWithVideo({ overlays: [{ kind: 'label', text: 'late', start: 50, end: 51 }] });
    const { call } = await connect(dir);
    const r = await call('check', { video: 1 });
    expect(r.text).toMatch(/⚠ overlay 1 \("late"\) starts at/);
    const log = await readLog(sessionDir(dir, 1, 's1'));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'warning' });
    expect(log[0].text).toMatch(/^overlay 1 \("late"\) starts at/);
  });

  it("a ✖ line from check (an unknown format, a broken format file) goes into the session log as a warning, with its hint", async () => {
    const dir = await projectWithVideo();
    await writeFile(join(dir, 'episodes', '1', 'video.json'), JSON.stringify({ version: 1, title: 't', about: '', mention: '', hide: '', footage: [], createdAt: new Date().toISOString(), format: 'reel' }));
    const { call } = await connect(dir);
    const r = await call('check', { video: 1 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('✖ video.json: unknown format "reel"\n  The formats are: build-story, short, vlog.');
    expect(await readLog(sessionDir(dir, 1, 's1'))).toMatchObject([{ kind: 'warning', text: 'video.json: unknown format "reel"\n  The formats are: build-story, short, vlog.' }]);
  });

  it('logs to sessions/unknown when no session is known', async () => {
    const dir = await projectWithVideo({ overlays: [{ kind: 'label', text: 'late', start: 50, end: 51 }] });
    const { call } = await connect(dir, { sessionId: () => null });
    await call('check', { video: 1 });
    expect(await readLog(sessionDir(dir, 1, 'unknown'))).toHaveLength(1);
  });

  it('speak reads the written lines with the voice it is given and fits them; it refuses a bad voice, speed or slot first', async () => {
    const dir = await projectWithVideo({ slots: [{ id: 'n1', start: 0, end: 2.8, maxWords: 7, line: 'Hello there.' }] });
    const read: string[] = [];
    const speaker: Speaker = {
      prepare: async (o) => o.onStep?.('Downloading the Kokoro voice model, once: 92 MB'),
      speak: async (text, o) => {
        read.push(`${o.voice}@${o.speed}: ${text}`);
        const samples = new Float32Array(24000);
        for (let i = 2400; i < 16800; i++) samples[i] = 0.3 * Math.sin(i / 10);
        return { samples, sampleRate: 24000 };
      },
    };
    const { call } = await connect(dir, { speaker });
    const bad = await call('speak', { video: 1, voice: 'zz_robot' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^✖ There is no voice zz_robot\n  Pick one of: af_heart, /);
    expect((await call('speak', { video: 1, speed: 5 })).text).toMatch(/^✖ Speed 5 is out of range/);
    expect((await call('speak', { video: 1, slots: ['n4'] })).text).toBe('✖ there is no slot n4\n  List slots from the slots tool.');
    expect(read).toEqual([]);

    const r = await call('speak', { video: 1, voice: 'bm_george', speed: 1.1 });
    expect(r.isError).toBe(false);
    const lines = r.text.split('\n');
    expect(lines[0]).toBe('• Downloading the Kokoro voice model, once: 92 MB');
    expect(lines).toContain('  n1  placed');
    expect(lines.find((l) => l.startsWith('• Read 1 line with bm_george: '))).toMatch(/saved as episodes\/1\/narration-1\.wav$/);
    expect(read).toEqual(['bm_george@1.1: Hello there.']);
    expect((await loadEpisode(dir, 1)).voiceover!.recording).toBe('episodes/1/narration-1.wav');
  });

  it('speak says there are no lines yet', async () => {
    const { call } = await connect(await projectWithVideo(), { speaker: { prepare: async () => {}, speak: async () => { throw new Error('nothing to read'); } } });
    expect((await call('speak', { video: 1 })).text).toBe('✖ No narration lines are written yet\n  Run slots and write a line for each slot first.');
  });

  it('versions lists deliveries as V<k> and the rest by label, with ids; restore goes back and keeps a backup', async () => {
    const dir = await projectWithVideo();
    await writeFile(join(dir, 'episodes', '1', 'rough.mp4'), 'x');
    const d = await snapshotVersion(dir, 1, { kind: 'delivery', label: 'Rough cut', render: 'rough' });
    const c = await snapshotVersion(dir, 1, { kind: 'checkpoint', label: 'Timeline written' });
    const { call } = await connect(dir);
    const r = await call('versions', { video: 1 });
    const lines = r.text.split('\n');
    expect(lines[0]).toMatch(new RegExp(`^V1 · Rough cut · \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d · ${d.id}$`));
    expect(lines[1]).toMatch(new RegExp(`^Timeline written · \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d · ${c.id}$`));
    const back = await call('restore', { video: 1, id: d.id });
    expect(back).toEqual({ isError: false, text: 'went back to “Rough cut” (what was there is kept as “Before going back to “Rough cut””)' });
    expect((await call('restore', { video: 1, id: 'nope' })).isError).toBe(true);
  });

  it('overnight lists what is wrong, one per line', async () => {
    const dir = await projectWithVideo();
    const { call } = await connect(dir, { preflightDeps: deps({ onBattery: async () => true, which: async (c) => c !== 'ffmpeg' }) });
    const r = await call('overnight', { videos: [1] });
    expect(r).toEqual({ isError: true, text: "Plug in your Mac. Overnight editing needs the power adapter.\nffmpeg isn't installed. Run /mirage:setup." });
    expect((await readSessionState(dir, 's1')).overnight).toBeNull();
  });

  it('overnight keeps the Mac awake and writes the session state', async () => {
    const dir = await projectWithVideo();
    let awake = 0;
    const { call } = await connect(dir, { startAwake: () => { awake++; return 4242; } });
    const r = await call('overnight', { videos: [1, 2] });
    expect(r).toEqual({ isError: false, text: 'ready: 2 videos, Mac kept awake until this session ends' });
    expect(awake).toBe(1);
    const state = await readSessionState(dir, 's1');
    expect(state.awakePid).toBe(4242);
    expect(state.overnight).toMatchObject({ videos: [1, 2] });
    expect(Date.parse(state.overnight!.startedAt)).toBeGreaterThan(0);
  });

  it('overnight does not start a second caffeinate while the first still runs', async () => {
    const dir = await projectWithVideo();
    let awake = 0;
    const { call } = await connect(dir, { startAwake: () => { awake++; return process.pid; } });
    await call('overnight', { videos: [1] });
    await call('overnight', { videos: [1, 2] });
    expect(awake).toBe(1);
    expect((await readSessionState(dir, 's1')).awakePid).toBe(process.pid);
  });

  it('status says where the project is: stage, deliveries, viewer and tools', async () => {
    const dir = await projectWithVideo();
    await writeFile(join(dir, 'episodes', '1', 'rough.mp4'), 'x');
    await snapshotVersion(dir, 1, { kind: 'delivery', label: 'Rough cut', render: 'rough' });
    {
      const { call } = await connect(dir, { preflightDeps: deps({ which: async (c) => c === 'ffmpeg', transcriber: async () => 'The speech model is missing (/m/ggml.bin).' }) });
      const r = await call('status');
      expect(r.isError).toBe(false);
      const lines = r.text.split('\n');
      expect(lines).toContain('Project: My build');
      expect(lines).toContain('Video 1: rough · 1 delivery');
      expect(lines).toContain('Viewer: not running');
      expect(lines).toContain('ffmpeg: ok');
      expect(lines).toContain('ffprobe: missing');
      expect(lines).toContain('transcriber: missing — The speech model is missing (/m/ggml.bin).');
      expect(lines.find((l) => l.startsWith('Node: '))).toMatch(/^Node: v\d+\.\d+\.\d+ ok$/);
      await mkdir(join(dir, '.mirage'), { recursive: true });
      await writeFile(join(dir, '.mirage', 'viewer.json'), JSON.stringify({ url: 'http://127.0.0.1:5123', pid: process.pid }));
      expect((await call('status')).text).toContain('Viewer: running at http://127.0.0.1:5123');
    }
    const noLibass = await connect(dir, { preflightDeps: deps({ captions: async () => ({ ok: false, path: '/opt/homebrew/bin/ffmpeg', hint: "Install Homebrew's complete build: brew install ffmpeg-full (Mirage finds it by itself)." }) }) });
    const noLibassLines = (await noLibass.call('status')).text.split('\n');
    expect(noLibassLines).toContain("ffmpeg: can't draw captions — /opt/homebrew/bin/ffmpeg was built without libass. Install Homebrew's complete build: brew install ffmpeg-full (Mirage finds it by itself).");
    expect(noLibassLines).not.toContain('ffmpeg: ok');
    const { call } = await connect(dir, { preflightDeps: deps() });
    expect((await call('status')).text.split('\n')).toContain('transcriber: ok');
    expect((await call('status')).text.split('\n')).toContain('tts: ok');
    const later = await connect(dir, { preflightDeps: deps({ tts: async () => ({ state: 'fetch', text: 'not downloaded yet — speak downloads it' }) }) });
    expect((await later.call('status')).text.split('\n')).toContain('tts: not downloaded yet — speak downloads it');
    const never = await connect(dir, { preflightDeps: deps({ tts: async () => ({ state: 'missing', text: 'npm was not found.' }) }) });
    expect((await never.call('status')).text.split('\n')).toContain('tts: missing — npm was not found.');
  });

  it('setup_later holds off asking about setup for 7 days, in a folder that is not a project too', async () => {
    const data = await mkdtemp(join(tmpdir(), 'mirage-data-'));
    const { call } = await connect(await mkdtemp(join(tmpdir(), 'mirage-mcp-')), { pluginData: data, now: () => new Date('2026-11-06T10:30:00.000Z') });
    expect(await call('setup_later')).toEqual({
      isError: false,
      text: "OK — Mirage won't ask about setup again until 2026-11-13. /mirage:setup installs the tools any time.",
    });
    expect(JSON.parse(await readFile(join(data, 'setup.json'), 'utf8'))).toEqual({ laterUntil: '2026-11-13T10:30:00.000Z' });
  });

  it('setup_later keeps what else setup.json holds', async () => {
    const data = await mkdtemp(join(tmpdir(), 'mirage-data-'));
    await writeFile(join(data, 'setup.json'), JSON.stringify({ askedVersion: '0.3.0' }));
    const { call } = await connect(await mkdtemp(join(tmpdir(), 'mirage-mcp-')), { pluginData: data, now: () => new Date('2026-12-28T00:00:00.000Z') });
    expect((await call('setup_later')).text).toContain('until 2027-01-04.');
    expect(JSON.parse(await readFile(join(data, 'setup.json'), 'utf8'))).toEqual({ askedVersion: '0.3.0', laterUntil: '2027-01-04T00:00:00.000Z' });
  });

  it('setup_later without a data folder says it cannot remember, and that Mirage will ask again', async () => {
    const was = process.env.MIRAGE_PLUGIN_DATA;
    delete process.env.MIRAGE_PLUGIN_DATA;
    try {
      const { call } = await connect(await mkdtemp(join(tmpdir(), 'mirage-mcp-')));
      expect(await call('setup_later')).toEqual({ isError: true, text: "✖ Mirage has no data folder here, so it can't remember that.\n  It will ask again next session." });
    } finally {
      if (was !== undefined) process.env.MIRAGE_PLUGIN_DATA = was;
    }
  });

  it('status lists the formats', async () => {
    const dir = await projectWithVideo();
    const { call } = await connect(dir);
    expect((await call('status')).text.split('\n')).toContain('Formats: build-story, short, vlog');
    const bare = await connect(await mkdtemp(join(tmpdir(), 'mirage-mcp-')));
    expect((await bare.call('status')).text.split('\n')).toContain('Formats: build-story, short, vlog');
    // The formulas come right after: Mirage's own, in a project and outside one.
    for (const c of [call, bare.call]) {
      const lines = (await c('status')).text.split('\n');
      expect(lines[lines.indexOf('Formats: build-story, short, vlog') + 1]).toBe('Formulas: algorithm, episode, instagram, short, tiktok, vlog, youtube');
    }
  });

  describe('formats', () => {
    const FM = { id: 'demo', name: 'Demo', describe: 'A demo format.', words: ['demo', 'try'], beats: ['open', 'close'] };
    async function formatsFolder(files: Record<string, string>) {
      const dir = await mkdtemp(join(tmpdir(), 'mirage-formats-'));
      for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
      return dir;
    }

    it('lists one line per format, in a folder that is not a project too', async () => {
      const { call } = await connect(await mkdtemp(join(tmpdir(), 'mirage-mcp-')));
      const r = await call('formats');
      expect(r.isError).toBe(false);
      expect(r.text.split('\n')).toEqual([
        'build-story — Build story: A build told as a story: the stakes, the failures, a montage, the reveal. (words: build, episode, part, series, project, devlog)',
        'short — Short: A vertical video that opens on its hook and is as long as its story needs; made from a big video it\'s a teaser that answers one small question and leaves the big one open. (words: short, shorts, reel, reels, tiktok, teaser, clip)',
        'vlog — Vlog: A day or a week of someone\'s life told as a few funny bits, ending on the headline bit. (words: vlog, day in the life, trip, week, hanging out, weekend)',
      ]);
    });

    it('with an id gives the whole file', async () => {
      const { call } = await connect(await mkdtemp(join(tmpdir(), 'mirage-mcp-')));
      const r = await call('formats', { id: 'short' });
      expect(r.isError).toBe(false);
      expect(r.text).toBe(await readFile(join(formatsDir(), 'short.md'), 'utf8'));
      expect(r.text.startsWith('---\n{')).toBe(true);
    });

    it('says an unknown id is unknown and names the ids', async () => {
      const { call } = await connect(await mkdtemp(join(tmpdir(), 'mirage-mcp-')));
      expect(await call('formats', { id: 'podcast' })).toEqual({ isError: true, text: '✖ unknown format "podcast"\n  The formats are: build-story, short, vlog.' });
    });

    it('a broken file is one ✖ line and the rest still list (and status shows it too)', async () => {
      const dir = await formatsFolder({
        'demo.md': `---\n${JSON.stringify(FM)}\n---\nRules.\n`,
        'bad.md': `---\n${JSON.stringify({ ...FM, id: 'bad', wrods: [] })}\n---\nRules.\n`,
      });
      const { call } = await connect(await mkdtemp(join(tmpdir(), 'mirage-mcp-')), { formatsDir: dir });
      const bad = '✖ plugin/formats/bad.md: unknown key "wrods" (valid keys: id, name, describe, words, beats, targetSec, warnPastSec, output, captions, short, playbook)';
      expect(await call('formats')).toEqual({ isError: false, text: ['demo — Demo: A demo format. (words: demo, try)', bad].join('\n') });
      expect((await call('formats', { id: 'demo' })).isError).toBe(false);
      expect((await call('formats', { id: 'bad' })).text).toBe(`✖ unknown format "bad"\n  The formats are: demo.\n  ${bad}`);
      const lines = (await call('status')).text.split('\n');
      expect(lines).toContain('Formats: demo');
      expect(lines).toContain(bad);
    });
  });

  it('status on a folder that is not a project yet says so', async () => {
    const { call } = await connect(await mkdtemp(join(tmpdir(), 'mirage-mcp-')));
    expect((await call('status')).text).toMatch(/^No Mirage project here yet/);
  });

  it('status says a broken mirage.json is broken, and treats a dead viewer pid as not running', async () => {
    const dir = await projectWithVideo();
    await writeFile(join(dir, 'mirage.json'), JSON.stringify({ version: 1, title: 4 }));
    await mkdir(join(dir, '.mirage'), { recursive: true });
    await writeFile(join(dir, '.mirage', 'viewer.json'), JSON.stringify({ url: 'http://127.0.0.1:1', pid: 2 ** 22 + 12345 }));
    const { call } = await connect(dir);
    const lines = (await call('status')).text.split('\n');
    expect(lines[0]).toMatch(/^✖ mirage\.json/);
    expect(lines).toContain('Viewer: not running');
  });

  it('every other tool says there is no project when there is none', async () => {
    const { call } = await connect(await mkdtemp(join(tmpdir(), 'mirage-mcp-')));
    const r = await call('check', { video: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^✖ no Mirage project at /);
  });
});

describe('session identity', () => {
  it('two sessions in one project: each engine follows its own Claude Code process, whatever session file is newest', async () => {
    const dir = await projectWithVideo();
    await writeClaudeProcess(dir, 111, 'sess-a');
    await writeClaudeProcess(dir, 222, 'sess-b');
    await writeSessionState(dir, 'sess-a', {});
    await writeSessionState(dir, 'sess-b', {}); // the newest session file: the old guess picked it for both
    const a = await connect(dir, { sessionId: undefined, ppid: 111 });
    const b = await connect(dir, { sessionId: undefined, ppid: 222 });
    await a.call('log', { video: 1, kind: 'guess', text: 'from a' });
    await b.call('log', { video: 1, kind: 'question', text: 'from b' });
    expect((await readLog(sessionDir(dir, 1, 'sess-a'))).map((e) => e.text)).toEqual(['from a']);
    expect((await readLog(sessionDir(dir, 1, 'sess-b'))).map((e) => e.text)).toEqual(['from b']);
    const footage = await mkdtemp(join(tmpdir(), 'mirage-footage-'));
    expect((await a.call('new_video', { title: 'Two', about: 'x', footage: [footage] })).text).toBe(`video 2 created ${BUILD_STORY}`);
    expect((await b.call('new_video', { title: 'Three', about: 'x', footage: [footage] })).text).toBe(`video 3 created ${BUILD_STORY}`);
    expect([(await readSessionState(dir, 'sess-a')).video, (await readSessionState(dir, 'sess-b')).video]).toEqual([2, 3]);
    expect(existsSync(join(dir, '.mirage', 'sessions', 'unknown.json'))).toBe(false);
  });

  it('without a file for its process, the engine takes the session file touched last', async () => {
    const dir = await projectWithVideo();
    await writeClaudeProcess(dir, 111, 'sess-a');
    await writeSessionState(dir, 'sess-a', {});
    await writeSessionState(dir, 'sess-b', {});
    const old = new Date(Date.now() - 3 * 24 * 3600_000);
    await utimes(join(dir, '.mirage', 'sessions', 'sess-a.json'), old, old);
    const { call } = await connect(dir, { sessionId: undefined, ppid: 333 });
    await call('log', { video: 1, kind: 'guess', text: 'guessed' });
    expect((await readLog(sessionDir(dir, 1, 'sess-b'))).map((e) => e.text)).toEqual(['guessed']);
  });
});

describe('formulas', () => {
  const FM = { id: 'mine', name: 'My channel', describe: 'What works for my audience.', formats: ['short'], source: '@me (latest 80 videos), measured 2026-11-09' };
  const file = (fm: object, body = 'Rules.\n') => `---\n${JSON.stringify(fm)}\n---\n${body}`;
  const OWN = [
    "algorithm — The algorithm: The procedure under every format: one question the viewer can't answer without watching, raised fast, kept open, and answered late on a human face. (formats: build-story, short, vlog; measured on: David Dobrik's and Mat Armstrong's channels (titles and views of 769 videos, 48 thumbnails, a 9-video breakdown, the captions of 3 videos), measured 2026-11-09) (Mirage's, can't be changed)",
    "episode — Episode formula: A project told over several videos (a build, a repair, a challenge): will this broken or unfinished thing ever work? (formats: build-story; measured on: Mat Armstrong's channel (latest 200 videos, 24 thumbnails, the captions of 3 videos), measured 2026-11-09) (Mirage's, can't be changed)",
    "instagram — How Instagram ranks Reels: How Instagram says it ranks Reels: will they share it, watch it through, like it; plus the rules that keep a reel out of recommendations. (formats: short; measured on: Instagram's blog, Creators pages and Meta's Transparency Center and Ads Guide, with Adam Mosseri's 2025 statements as reported by the press, read 2026-11-09) (Mirage's, can't be changed)",
    "short — Shorts rules: What makes a short vertical video stay on screen and spread, each rule marked with how far to trust it. (formats: short; measured on: YouTube's own statements, Paddy Galloway's study of about 5,400 Shorts, and vendor rules of thumb, read 2026-11-09) (Mirage's, can't be changed)",
    "tiktok — How TikTok recommends: How TikTok says its For You feed picks videos: what you do with a video counts most, finishing a longer one counts strongly, follower count is not a direct factor. (formats: short; measured on: TikTok's Newsroom, Transparency Center, Community Guidelines, developer and ads pages, with its Help Center and Creator Academy only as quoted in search results, read 2026-11-09) (Mirage's, can't be changed)",
    "vlog — Vlog formula: Videos about people and a day, a week or a trip: how will this person react? (formats: vlog; measured on: David Dobrik's channel (all 569 videos, 24 thumbnails, a 9-video breakdown), measured 2026-11-09) (Mirage's, can't be changed)",
    "youtube — How YouTube recommends: How YouTube's recommendation system judges a video, long or Short, in YouTube's own words: chose to watch, stuck around, enjoyed it. (formats: build-story, short, vlog; measured on: YouTube's Help pages and public statements by its two product leads, read 2026-11-09) (Mirage's, can't be changed)",
  ];
  async function projectWithFormulas(files: Record<string, string>) {
    const dir = await projectWithVideo();
    await mkdir(join(dir, 'formulas'), { recursive: true });
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, 'formulas', name), text);
    return dir;
  }

  it('lists Mirage\'s own, one line each, in a folder that is not a project too', async () => {
    const { call } = await connect(await mkdtemp(join(tmpdir(), 'mirage-mcp-')));
    expect(await call('formulas')).toEqual({ isError: false, text: OWN.join('\n') });
  });

  it('lists the person\'s own after Mirage\'s, marked yours, and status names them', async () => {
    const dir = await projectWithFormulas({ 'mine.md': file(FM), 'another.md': file({ ...FM, id: 'another', formats: [] }) });
    const { call } = await connect(dir);
    expect((await call('formulas')).text.split('\n')).toEqual([
      ...OWN,
      'another — My channel: What works for my audience. (formats: none; measured on: @me (latest 80 videos), measured 2026-11-09) (yours)',
      'mine — My channel: What works for my audience. (formats: short; measured on: @me (latest 80 videos), measured 2026-11-09) (yours)',
    ]);
    expect((await call('status')).text.split('\n')).toContain('Formulas: algorithm, episode, instagram, short, tiktok, vlog, youtube; yours: another, mine');
  });

  it('a formulas folder in a folder that is no project is not read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-mcp-'));
    await mkdir(join(dir, 'formulas'));
    await writeFile(join(dir, 'formulas', 'mine.md'), file(FM));
    const { call } = await connect(dir);
    expect((await call('formulas')).text.split('\n')).toEqual(OWN);
    expect((await call('status')).text.split('\n')).toContain('Formulas: algorithm, episode, instagram, short, tiktok, vlog, youtube');
  });

  it('with an id gives the whole file, Mirage\'s or the person\'s', async () => {
    const dir = await projectWithFormulas({ 'mine.md': file(FM, '# Mine\n') });
    const { call } = await connect(dir);
    const own = await call('formulas', { id: 'episode' });
    expect(own).toEqual({ isError: false, text: await readFile(join(formulasDir(), 'episode.md'), 'utf8') });
    expect(own.text.startsWith('---\n{')).toBe(true);
    expect(await call('formulas', { id: 'mine' })).toEqual({ isError: false, text: file(FM, '# Mine\n') });
  });

  it('says an unknown id is unknown and names the ids', async () => {
    const dir = await projectWithFormulas({ 'mine.md': file(FM) });
    const { call } = await connect(dir);
    expect(await call('formulas', { id: 'podcast' })).toEqual({ isError: true, text: '✖ unknown formula "podcast"\n  The formulas are: algorithm, episode, instagram, short, tiktok, vlog, youtube, mine.' });
  });

  it('a project file named like one of Mirage\'s never replaces it, and a broken one is one ✖ line (status shows both too)', async () => {
    const dir = await projectWithFormulas({ 'episode.md': file({ ...FM, id: 'episode' }, 'Theirs.\n'), 'bad.md': file({ ...FM, id: 'bad', wrods: [] }), 'mine.md': file(FM) });
    const { call } = await connect(dir);
    const problems = [
      '✖ formulas/bad.md: unknown key "wrods" (valid keys: id, name, describe, formats, source, playbook)',
      '✖ formulas/episode.md: "episode" is one of Mirage\'s own formulas, which can\'t be changed — save yours under another name',
    ];
    expect((await call('formulas')).text.split('\n')).toEqual([...OWN, 'mine — My channel: What works for my audience. (formats: short; measured on: @me (latest 80 videos), measured 2026-11-09) (yours)', ...problems]);
    expect((await call('formulas', { id: 'episode' })).text).toBe(await readFile(join(formulasDir(), 'episode.md'), 'utf8'));
    expect((await call('formulas', { id: 'bad' })).text).toBe(`✖ unknown formula "bad"\n  The formulas are: algorithm, episode, instagram, short, tiktok, vlog, youtube, mine.\n  ${problems.join('\n  ')}`);
    const lines = (await call('status')).text.split('\n');
    expect(lines).toContain('Formulas: algorithm, episode, instagram, short, tiktok, vlog, youtube; yours: mine');
    for (const p of problems) expect(lines).toContain(p);
  });

  it('a broken file of Mirage\'s own is one ✖ line and the rest still list', async () => {
    const own = await mkdtemp(join(tmpdir(), 'mirage-formulas-'));
    await writeFile(join(own, 'demo.md'), file({ ...FM, id: 'demo' }));
    await writeFile(join(own, 'bad.md'), 'no front matter\n');
    const { call } = await connect(await mkdtemp(join(tmpdir(), 'mirage-mcp-')), { formulasDir: own });
    expect((await call('formulas')).text.split('\n')).toEqual([
      "demo — My channel: What works for my audience. (formats: short; measured on: @me (latest 80 videos), measured 2026-11-09) (Mirage's, can't be changed)",
      '✖ plugin/formulas/bad.md: no front matter: the file must start with a --- line, a JSON object, and a --- line',
    ]);
  });
});

describe('channel', () => {
  const LIST = ['aaaaaaaaaa1|600|9000|I BOUGHT A WRECK', 'aaaaaaaaaa2|1200|4000|Fixing it | part 2', 'aaaaaaaaaa3|300|1000|I BOUGHT ANOTHER', 'aaaaaaaaaa4|NA|NA|Upcoming'].join('\n');
  function fakes(over: Partial<ChannelDeps> = {}) {
    const calls = { ytDlp: [] as string[][], fetched: [] as string[], ffmpeg: [] as string[][] };
    const channel: ChannelDeps = {
      ytDlp: async (args) => {
        calls.ytDlp.push(args);
        if (args.includes('--flat-playlist')) return LIST;
        const out = args[args.indexOf('-P') + 1]!;
        const vid = args.at(-1)!.split('v=')[1]!;
        await writeFile(join(out, `${vid}.info.json`), JSON.stringify({ title: 'I BOUGHT A WRECK', duration: 600, heatmap: [{ start_time: 540, end_time: 560, value: 1 }] }));
        if (vid !== 'aaaaaaaaaa2') await writeFile(join(out, `${vid}.en.json3`), JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: 'Here is the wreck.' }] }] }));
        return '';
      },
      fetchImage: async (url) => { calls.fetched.push(url); return url.includes('aaaaaaaaaa3') ? null : new Uint8Array([1]); },
      runFfmpeg: async (args) => { calls.ffmpeg.push(args); await writeFile(args.at(-1)!, 'sheet'); },
      ...over,
    };
    return { channel, calls };
  }
  const SHAPES = '  One of: { url, videos? } · { name, patterns: [{ label, regex }] } · { name, thumbnails: "top" | "newest" | "lowest" } · { name, captions: [ids] }.';

  it('with a url lists the channel, writes analysis/<name>/videos.json and reports, logging its ⚠ for the person', async () => {
    const dir = await projectWithVideo();
    const { channel, calls } = fakes();
    const { call } = await connect(dir, { channel, now: () => new Date('2026-11-09T12:00:00Z') });
    const r = await call('channel', { url: '@Demo', videos: 50 });
    expect(r.isError).toBe(false);
    expect(calls.ytDlp).toEqual([['--flat-playlist', '--playlist-end', '50', '--print', '%(id)s|%(duration)s|%(view_count)s|%(title)s', 'https://www.youtube.com/@Demo/videos']]);
    const lines = r.text.split('\n');
    expect(lines.slice(0, 5)).toEqual([
      'Channel demo: 4 videos gathered, newest first (analysis/demo/videos.json). Use name "demo" in the next channel calls.',
      'Median views: 4.0K (all 4)',
      'Length, all 4: 5:00 shortest · 10:00 quarter · 10:00 middle · 20:00 three-quarters · 20:00 longest',
      'Median views by length, all 4: 4–8 min 1.0K (1) · 8–15 min 9.0K (1) · 15–30 min 4.0K (1)',
      'Titles, all 4: 1–5 words, 4 typical, about 16 characters · ALL CAPS on 2 of 4 (50%)',
    ]);
    const warning = '1 of 4 videos have no view count (members-only, upcoming or live) — they are left out of the medians and the most and least viewed lists';
    expect(lines).toContain(`⚠ ${warning}`);
    expect(lines).toContain('  1. 9.0K · 10:00 · aaaaaaaaaa1 · I BOUGHT A WRECK');
    expect(JSON.parse(await readFile(join(dir, 'analysis', 'demo', 'videos.json'), 'utf8'))).toMatchObject({ version: 1, gatheredAt: '2026-11-09T12:00:00.000Z', videos: [{ id: 'aaaaaaaaaa1' }, { id: 'aaaaaaaaaa2', title: 'Fixing it | part 2' }, {}, { views: null }] });
    expect(await readLog(sessionDir(dir, 1, 's1'))).toMatchObject([{ kind: 'warning', text: warning }]);
  });

  it('with name and patterns compares titles; a bad regex names its label', async () => {
    const dir = await projectWithVideo();
    const { call } = await connect(dir, { channel: fakes({ ytDlp: async () => Array.from({ length: 8 }, (_, i) => `aaaaaaaaaa${i}|60|${(i + 1) * 1000}|${i % 2 ? 'I BOUGHT IT' : 'Fixing it'}`).join('\n') }).channel });
    await call('channel', { url: '@demo' });
    expect(await call('channel', { name: 'demo', patterns: [{ label: 'I BOUGHT', regex: '^i bought' }, { label: 'a price', regex: '[£$]\\d' }] })).toEqual({
      isError: false,
      text: [
        'Channel demo: 2 title patterns. × is the median views of the videos whose title matches against the rest: it shows what goes with more views, not what causes them.',
        'I BOUGHT (/^i bought/i)',
        '  all 8: 4 match · 5.0K with · 4.0K without · ×1.25',
        'a price (/[£$]\\d/i)',
        '  all 8: 0 match · too few to compare',
      ].join('\n'),
    });
    const bad = await call('channel', { name: 'demo', patterns: [{ label: 'a price', regex: '([£$' }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^✖ pattern "a price": its regex can't be read \(.+\)\n {2}Fix that regex and run it again; nothing was compared\.$/);
  });

  it('with name and thumbnails writes the sheet and lists its tiles, a missing one as a ⚠', async () => {
    const dir = await projectWithVideo();
    const { channel, calls } = fakes();
    const { call } = await connect(dir, { channel });
    await call('channel', { url: '@demo' });
    expect(await call('channel', { name: 'demo', thumbnails: 'top' })).toEqual({
      isError: false,
      text: [
        'wrote analysis/demo/thumbs-top.jpg (2 tiles, 4 across, in reading order: the most viewed)',
        '  1. 9.0K · 10:00 · aaaaaaaaaa1 · I BOUGHT A WRECK',
        '  2. 4.0K · 20:00 · aaaaaaaaaa2 · Fixing it | part 2',
        '⚠ no thumbnail could be fetched for aaaaaaaaaa3 (I BOUGHT ANOTHER) — it is left out of the sheet',
      ].join('\n'),
    });
    expect(calls.fetched[0]).toBe('https://i.ytimg.com/vi/aaaaaaaaaa1/maxresdefault.jpg');
    expect(calls.ffmpeg).toHaveLength(1);
    expect(existsSync(join(dir, 'analysis', 'demo', 'thumbs-top.jpg'))).toBe(true);
  });

  it('with name and captions writes each transcript and says which video has none', async () => {
    const dir = await projectWithVideo();
    const { channel, calls } = fakes();
    const { call } = await connect(dir, { channel });
    await call('channel', { url: '@demo' });
    const r = await call('channel', { name: 'demo', captions: ['aaaaaaaaaa1', 'aaaaaaaaaa2'] });
    expect(r).toEqual({
      isError: false,
      text: [
        'aaaaaaaaaa1 “I BOUGHT A WRECK”: 10:00, 4 words (analysis/demo/aaaaaaaaaa1.txt)',
        '  Words a minute, per 5-minute block: 0–5 min 1 · 5–10 min 0',
        '  Most replayed, strongest first: 92% (9:10)',
        '  Chapters: none set',
        '  First 150 s: Here is the wreck.',
        '  Last 100 s: ',
        '⚠ aaaaaaaaaa2 “I BOUGHT A WRECK”: no English captions — no transcript for this video',
        '  Most replayed, strongest first: 92% (9:10)',
        '  Chapters: none set',
      ].join('\n'),
    });
    expect(calls.ytDlp[1]!.slice(0, 7)).toEqual(['--skip-download', '--write-auto-subs', '--sub-langs', 'en', '--sub-format', 'json3', '--write-info-json']);
    expect(await readFile(join(dir, 'analysis', 'demo', 'aaaaaaaaaa1.txt'), 'utf8')).toBe('[0:01] Here is the wreck.\n');
  });

  it('says how to install yt-dlp when it is missing', async () => {
    const dir = await projectWithVideo();
    const missing = new SidecarError('yt-dlp', 'NOT_FOUND', 'yt-dlp was not found', 'Install yt-dlp (macOS: brew install yt-dlp; Windows: winget install yt-dlp) or set WORDEDITS_YTDLP_DIR to a folder containing yt-dlp.');
    const { call } = await connect(dir, { channel: fakes({ ytDlp: async () => { throw missing; } }).channel });
    expect(await call('channel', { url: '@demo' })).toEqual({
      isError: true,
      text: '✖ yt-dlp was not found\n  Install yt-dlp (macOS: brew install yt-dlp; Windows: winget install yt-dlp) or set WORDEDITS_YTDLP_DIR to a folder containing yt-dlp.',
    });
    expect(existsSync(join(dir, 'analysis'))).toBe(false);
  });

  it('does one thing per call, and says what it needs', async () => {
    const dir = await projectWithVideo();
    const { channel, calls } = fakes();
    const { call } = await connect(dir, { channel });
    expect(await call('channel', {})).toEqual({ isError: true, text: `✖ channel does one thing per call\n${SHAPES}` });
    expect(await call('channel', { url: '@demo', thumbnails: 'top' })).toEqual({ isError: true, text: `✖ channel does one thing per call\n${SHAPES}` });
    expect(await call('channel', { name: 'demo', thumbnails: 'top', captions: ['aaaaaaaaaa1'] })).toEqual({ isError: true, text: `✖ channel does one thing per call\n${SHAPES}` });
    expect(await call('channel', { url: '@demo', name: 'demo' })).toEqual({ isError: true, text: `✖ give url or name, not both: the name comes from the url\n${SHAPES}` });
    expect(await call('channel', { thumbnails: 'top' })).toEqual({ isError: true, text: `✖ name is needed: which gathered channel this is about\n  Run channel with the channel's url first; its report says the name to use. ${SHAPES.trim()}` });
    expect(await call('channel', { name: 'demo', thumbnails: 'top', videos: 5 })).toEqual({ isError: true, text: `✖ videos goes with url (how many videos to list)\n${SHAPES}` });
    expect(await call('channel', { name: 'demo', thumbnails: 'top' })).toEqual({
      isError: true, text: "✖ no channel \"demo\" has been gathered in this project\n  Run channel with the channel's url first; its report says the name to use.",
    });
    expect(await call('channel', { url: 'https://example.com/@demo' })).toEqual({
      isError: true, text: "✖ \"https://example.com/@demo\" isn't a YouTube channel address\n  Give the channel's address, e.g. https://www.youtube.com/@handle, or just @handle.",
    });
    expect((await call('channel', { name: 'demo', captions: [] })).isError).toBe(true);
    expect((await call('channel', { name: 'demo', captions: ['1', '2', '3', '4', '5', '6'] })).isError).toBe(true);
    expect((await call('channel', { url: '@demo', videos: 1001 })).isError).toBe(true);
    expect(calls.ytDlp).toEqual([]);
  });

  it('needs a project', async () => {
    const { call } = await connect(await mkdtemp(join(tmpdir(), 'mirage-mcp-')), { channel: fakes().channel });
    expect((await call('channel', { url: '@demo' })).text).toMatch(/^✖ no Mirage project at /);
  });
});

describe('posted and learn', () => {
  const ADDRESS = 'https://www.youtube.com/watch?v=aaaaaaaaaa1';
  const probe = async () => ({ durationSec: 3, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', colorTransfer: null });
  const tools = { pickEncoder: async () => enc, runFfmpeg: async () => {}, probe } as unknown as MediaTools;
  /** A yt-dlp that gives every video the same numbers. */
  function fakes(info: object = { title: 'I BUILT IT', upload_date: '20261030', duration: 3, view_count: 2000, like_count: 100, comment_count: 4 }) {
    const calls: string[][] = [];
    const channel: ChannelDeps = {
      ytDlp: async (args) => { calls.push(args); return JSON.stringify(info); },
      fetchImage: async () => null,
      runFfmpeg: async () => {},
    };
    return { channel, calls };
  }
  /** A project whose video 1 has a video.json and a final render. */
  async function finished() {
    const dir = await projectWithVideo();
    await writeFile(join(dir, 'episodes', '1', 'video.json'), JSON.stringify({ version: 1, title: 'The lamp', about: 'a', mention: '', hide: '', footage: [], createdAt: '2026-10-01T00:00:00Z' }));
    await writeFile(join(dir, 'episodes', '1', 'final.mp4'), 'x');
    return dir;
  }

  it('posted records the address and writes the snapshot of the cut; learn reads the numbers and status says where things stand', async () => {
    const dir = await finished();
    const { channel, calls } = fakes();
    let today = '2026-11-09';
    const { call } = await connect(dir, { tools, channel, now: () => new Date(`${today}T12:00:00Z`) });
    expect((await call('status')).text.split('\n')).toContain('Results: no video posted yet');
    expect(await call('posted', { video: 1, url: 'https://youtu.be/aaaaaaaaaa1?si=share' })).toEqual({
      isError: false,
      text: [
        `video 1 “The lamp” is posted at ${ADDRESS}`,
        'wrote episodes/1/features.json: build-story · 1920×1080 · 0:03 · no words · 0.0 cuts a minute · typical shot 3.0 s · 0 words a minute · longest stretch without words 3.0 s · music under 0% · 0 overlays · captions phrase · no thumbnail',
        'Run learn to read its numbers.',
      ].join('\n'),
    });
    expect(JSON.parse(await readFile(join(dir, 'episodes', '1', 'video.json'), 'utf8')).posted).toEqual({ url: ADDRESS, id: 'aaaaaaaaaa1', at: '2026-11-09' });
    expect(JSON.parse(await readFile(join(dir, 'episodes', '1', 'features.json'), 'utf8'))).toMatchObject({ video: 1, at: '2026-11-09', format: 'build-story', lengthSec: 3, items: [{ id: 'a', beat: 'problem', start: 0, end: 3 }] });
    // Posted today: no read is due before the early one, 3 days on.
    expect((await call('status')).text.split('\n')).toContain('Results: 1 video posted · not read yet');

    const r = await call('learn', { studio: { video: 1, clickRate: 4.2, percentViewed: 38 } });
    expect(r).toEqual({
      isError: false,
      text: [
        'Format build-story: 1 posted video, read 2026-11-09',
        '  Video 1 “I BUILT IT”: 10 days old, main read · 2.0K views · 200 a day · 50.0 likes per 1,000 views · 2.0 comments per 1,000 views · Studio (2026-11-09): click rate 4.2% · 38% viewed',
        '  Most replayed: YouTube shows none for video 1',
        '  too few to compare: 1 video — 3 more needed',
        '  Confidence, build-story: 1 posted video — a weak signal',
        'The better and weaker halves show what goes with more views, never what causes them. The same evidence is in results/evidence.json.',
      ].join('\n'),
    });
    expect(calls).toEqual([['--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings', ADDRESS]]);
    expect(JSON.parse(await readFile(join(dir, 'results', '1.json'), 'utf8'))).toMatchObject({ id: 'aaaaaaaaaa1', snapshots: [{ at: '2026-11-09', views: 2000 }], studio: [{ at: '2026-11-09', clickRate: 4.2, percentViewed: 38 }] });
    expect(JSON.parse(await readFile(join(dir, 'results', 'evidence.json'), 'utf8'))).toMatchObject({ at: '2026-11-09', formats: [{ format: 'build-story', confidence: 'weak', halves: null }] });
    expect((await call('status')).text.split('\n')).toContain('Results: 1 video posted · last read 2026-11-09');
    // YouTube says it went up on 30 October: read at 10 days old (the main read), so the late read is due at 28 days.
    today = '2026-11-26';
    expect((await call('status')).text.split('\n')).toContain('Results: 1 video posted · last read 2026-11-09');
    today = '2026-11-27';
    expect((await call('status')).text.split('\n')).toContain('Results: 1 video posted · last read 2026-11-09 · learn is due: video 1 (late read)');
  });

  it('check and cut print the playbook section, whose misses are no warnings; predict forecasts the cut, writes prediction.json and logs only its ⚠', async () => {
    const dir = await finished();
    const { call } = await connect(dir, { tools: { ...tools, probe: async () => ({ ...(await probe()), durationSec: 9 }) } as unknown as MediaTools, now: () => new Date('2026-11-09T12:00:00Z') });
    const playbook = [
      'Playbook (build-story):',
      '  ✓ opens on the picture (item a)',
      '  ✗ the idea has no gap and no question on record — the playbook asks for the gap and the question before cutting',
      '  – the title: not measured — no title is chosen yet (titles.chosen in episodes/1/video.json)',
      '  ✓ longest stretch with nothing new 3.0 s — the playbook allows 8 s',
      '  ✗ 0 words a minute — the playbook asks for 145–200; the longest stretch without words is 0:00.0–0:03.0 (item a)',
      '  ✗ no truth beat in the cut — the playbook asks for the answer on screen',
      '  ✗ ends on problem (item a), not on outro or blooper',
    ];
    const check = await call('check', { video: 1 });
    expect(check.isError).toBe(false);
    expect(check.text.split('\n').slice(-8)).toEqual(playbook);
    // A miss is not a warning: nothing goes into the session log for the morning report.
    expect(await readLog(sessionDir(dir, 1, 's1'))).toEqual([]);

    const r = await call('predict', { video: 1 });
    expect(r.isError).toBe(false);
    const lines = r.text.split('\n');
    expect(lines[0]).toBe('Forecast for video 1 “The lamp” (build-story), from the final render: an approximate reading of the cut against the playbook — not a promise, and not a view count');
    for (const line of [
      'Chosen (will they choose to watch): 3/10', 'Stayed (will they keep watching): 6/10', 'Satisfied (will they be glad they watched): 0/10', 'Weakest step: Satisfied',
      ...playbook.slice(1),
      'No band: this forecast compares against the playbook only — no posted build-story video has results yet, and 4 are needed (4 more)',
      'wrote episodes/1/prediction.json',
      'Fix the weakest moments, run predict again, then post.',
    ]) expect(lines, line).toContain(line);
    expect(JSON.parse(await readFile(join(dir, 'episodes', '1', 'prediction.json'), 'utf8'))).toMatchObject({ video: 1, at: '2026-11-09', format: 'build-story', cut: 'final', weakest: 'satisfied', band: null });
    const warning = 'the timeline is 3.0 s long and final.mp4 is 9.0 s — the timeline changed after that render, so this forecast is of the timeline, not of the file: render again before posting';
    expect(lines).toContain(`⚠ ${warning}`);
    expect(await readLog(sessionDir(dir, 1, 's1'))).toMatchObject([{ kind: 'warning', text: warning }]);
    // It changes nothing in the video.
    expect(await call('predict', { video: 5 })).toEqual({ isError: true, text: '✖ there is no video 5\n  Run status to see the videos.' });
    expect((await call('predict', {})).isError).toBe(true);
  });

  it('posted refuses a video without a final render, or an address that is not a video; its ⚠ goes into the session log', async () => {
    const dir = await projectWithVideo();
    await writeFile(join(dir, 'episodes', '1', 'video.json'), JSON.stringify({ version: 1, title: 'The lamp', about: 'a', mention: '', hide: '', footage: [], createdAt: '2026-10-01T00:00:00Z' }));
    const { call } = await connect(dir, { tools: { ...tools, probe: async () => ({ ...(await probe()), durationSec: 9 }) } as unknown as MediaTools });
    expect(await call('posted', { video: 1, url: ADDRESS })).toEqual({ isError: true, text: '✖ video 1 has no final render yet\n  Run render first: a video is posted from its final.mp4.' });
    expect(await call('posted', { video: 1, url: 'https://www.youtube.com/@demo' })).toEqual({
      isError: true, text: '✖ "https://www.youtube.com/@demo" isn\'t a YouTube video address\n  Give the video\'s own address, e.g. https://www.youtube.com/watch?v=…, https://youtu.be/… or https://www.youtube.com/shorts/….',
    });
    expect(await call('posted', { video: 5, url: ADDRESS })).toEqual({ isError: true, text: '✖ there is no video 5\n  Run status to see the videos.' });
    expect(existsSync(join(dir, 'episodes', '1', 'features.json'))).toBe(false);
    await writeFile(join(dir, 'episodes', '1', 'final.mp4'), 'x');
    const warning = 'the timeline is 3.0 s long and final.mp4 is 9.0 s — the timeline changed after the final render, so features.json may not describe the video that was posted';
    expect((await call('posted', { video: 1, url: ADDRESS })).text.split('\n')).toContain(`⚠ ${warning}`);
    expect(await readLog(sessionDir(dir, 1, 's1'))).toMatchObject([{ kind: 'warning', text: warning }]);
  });

  it('learn says to use posted first when nothing is posted, how to install yt-dlp when it is missing, and refuses bad Studio numbers', async () => {
    const dir = await finished();
    const missing = new SidecarError('yt-dlp', 'NOT_FOUND', 'yt-dlp was not found', 'Install yt-dlp (macOS: brew install yt-dlp; Windows: winget install yt-dlp) or set WORDEDITS_YTDLP_DIR to a folder containing yt-dlp.');
    const { call } = await connect(dir, { tools, channel: { ...fakes().channel, ytDlp: async () => { throw missing; } } });
    const hint = '  When a video is live, call posted with its number and its YouTube address, then learn.';
    expect(await call('learn')).toEqual({ isError: true, text: `✖ no video is posted yet\n${hint}` });
    expect(await call('learn', { studio: { video: 1, clickRate: 4 } })).toEqual({ isError: true, text: `✖ video 1 isn't posted yet, so it has no Studio numbers to keep\n${hint}` });
    await call('posted', { video: 1, url: ADDRESS });
    expect(await call('learn', { studio: { video: 1 } })).toEqual({
      isError: true, text: "✖ studio needs at least one number\n  Give clickRate, percentViewed, avgViewSec, viewedVsSwiped, drops or spikes (for Instagram or TikTok also views, likes, comments, shares or saves) with the video's number, or leave studio out.",
    });
    expect((await call('learn', { studio: { video: 1, clickRate: 120 } })).isError).toBe(true);
    expect((await call('learn', { studio: { video: 1, percentViewed: -1 } })).isError).toBe(true);
    expect(await call('learn')).toEqual({
      isError: true,
      text: '✖ yt-dlp was not found\n  Install yt-dlp (macOS: brew install yt-dlp; Windows: winget install yt-dlp) or set WORDEDITS_YTDLP_DIR to a folder containing yt-dlp.',
    });
  });

  it('learn leaves out a video yt-dlp cannot read, with a ⚠ that goes into the session log', async () => {
    const dir = await finished();
    const gone = new SidecarError('yt-dlp', 'EXIT', 'yt-dlp exited with code 1', 'ERROR: [youtube] aaaaaaaaaa1: Private video');
    const { call } = await connect(dir, { tools, channel: { ...fakes().channel, ytDlp: async () => { throw gone; } }, now: () => new Date('2026-11-09T12:00:00Z') });
    await call('posted', { video: 1, url: ADDRESS });
    const warning = "video 1 (aaaaaaaaaa1): yt-dlp couldn't read it (yt-dlp exited with code 1 — ERROR: [youtube] aaaaaaaaaa1: Private video) — it is left out";
    expect(await call('learn')).toEqual({ isError: false, text: `⚠ ${warning}\nNo posted video could be read, so there is nothing to compare yet.` });
    expect(await readLog(sessionDir(dir, 1, 's1'))).toMatchObject([{ kind: 'warning', text: warning }]);
  });

  it('learn says the numbers read so far are kept when it is stopped', async () => {
    const dir = await finished();
    const clips = await mkdtemp(join(tmpdir(), 'mirage-clips-'));
    let asked = 0;
    const stop = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const channel: ChannelDeps = { ...fakes().channel, ytDlp: async () => { if (asked++) throw stop; return JSON.stringify({ view_count: 7 }); } };
    const { call } = await connect(dir, { tools, channel });
    await call('new_video', { title: 'Two', about: 'x', footage: [clips] });
    await saveEpisode(dir, EpisodeSchema.parse({ version: 2, number: 2, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 3 } }] }));
    await writeFile(join(dir, 'episodes', '2', 'final.mp4'), 'x');
    await call('posted', { video: 1, url: ADDRESS });
    await call('posted', { video: 2, url: 'https://youtu.be/aaaaaaaaaa2' });
    expect(await call('learn')).toEqual({ isError: true, text: '✖ Stopped by the person before it finished. The numbers read so far are kept.' });
    expect(JSON.parse(await readFile(join(dir, 'results', '1.json'), 'utf8')).snapshots).toHaveLength(1);
    expect(existsSync(join(dir, 'results', '2.json'))).toBe(false);
  });

  it('both need a project', async () => {
    const { call } = await connect(await mkdtemp(join(tmpdir(), 'mirage-mcp-')), { channel: fakes().channel });
    expect((await call('posted', { video: 1, url: ADDRESS })).text).toMatch(/^✖ no Mirage project at /);
    expect((await call('learn')).text).toMatch(/^✖ no Mirage project at /);
  });
});

describe('thumbnail', () => {
  const twoItems = [
    { id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 10 } },
    { id: 'b', beat: 'reveal', clip: 'c001', src: { in: 10, out: 14 } },
  ];
  async function withCut(file: string | null) {
    const dir = await projectWithVideo({ items: twoItems });
    const catalog = await loadCatalog(dir);
    await saveCatalog(dir, { ...catalog, clips: [{ ...catalog.clips[0]!, moments: [{ t: 2.5, label: 'big laugh' }] }] });
    if (file) {
      const out = join(dir, 'episodes', '1', file);
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:r=30:d=14', '-pix_fmt', 'yuv420p', out]);
    }
    return dir;
  }

  it('writes the candidate frames and lists each with its time, the at that writes it, and its reason', async () => {
    const dir = await withCut('rough.mp4');
    const { call } = await connect(dir, { tools: await realMediaTools() });
    const r = await call('thumbnail', { video: 1 });
    expect(r).toEqual({
      isError: false,
      text: [
        'wrote 11 candidate frames to episodes/1/thumbs/ (from rough.mp4)',
        'cand-01.jpg  0:02.5  at 2.517  moment: big laugh',
        'cand-02.jpg  0:12.0  at 12.017  reveal beat (item b)',
        'cand-03.jpg  0:00.6  at 0.583  even spacing',
        'cand-04.jpg  0:04.1  at 4.083  even spacing',
        'cand-05.jpg  0:05.3  at 5.25  even spacing',
        'cand-06.jpg  0:06.4  at 6.417  even spacing',
        'cand-07.jpg  0:07.6  at 7.583  even spacing',
        'cand-08.jpg  0:08.8  at 8.75  even spacing',
        'cand-09.jpg  0:09.9  at 9.917  even spacing',
        'cand-10.jpg  0:13.4  at 13.417  even spacing',
        'cand-11.jpg  0:11.0  at 10.95  even spacing',
      ].join('\n'),
    });
    expect((await readdir(join(dir, 'episodes', '1', 'thumbs'))).sort()).toEqual(Array.from({ length: 11 }, (_, i) => `cand-${String(i + 1).padStart(2, '0')}.jpg`));
    expect(existsSync(join(sessionDir(dir, 1, 's1'), 'progress.json'))).toBe(false);
  });

  it('warns, and logs the warning, when the timeline changed after the cut', async () => {
    const dir = await withCut('rough.mp4'); // the cut is 14 s
    await saveEpisode(dir, EpisodeSchema.parse({ ...(await loadEpisode(dir, 1)), items: twoItems.map((i) => (i.id === 'b' ? { ...i, src: { in: 10, out: 12 } } : i)) }));
    const { call } = await connect(dir, { tools: await realMediaTools() });
    const r = await call('thumbnail', { video: 1 });
    expect(r.isError).toBe(false);
    const warning = 'the timeline changed after rough.mp4 was made — run cut again for frames that match';
    expect(r.text.split('\n').at(-1)).toBe(`⚠ ${warning}`);
    expect(await readLog(sessionDir(dir, 1, 's1'))).toMatchObject([{ kind: 'warning', text: warning }]);
  });

  it('writes the thumbnail from the source frame at a time, with text and a focus', async () => {
    const dir = await withCut(null);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=30', '-pix_fmt', 'yuv420p', '-f', 'mp4', join(dir, 'screen.mov')]);
    const { call } = await connect(dir, { tools: await realMediaTools() });
    expect(await call('thumbnail', { video: 1, at: 12.4 })).toEqual({ isError: false, text: 'wrote episodes/1/thumbnail.jpg (1280×720, from c001 at 12.4 s)' });
    expect(await call('thumbnail', { video: 1, at: 1, text: 'Ship it', focus: { x: 0, y: 1 } })).toEqual({ isError: false, text: 'wrote episodes/1/thumbnail.jpg (1280×720, from c001 at 1 s)' });
    expect(existsSync(join(dir, 'episodes', '1', 'thumbnail.jpg'))).toBe(true);
    expect(existsSync(join(dir, 'episodes', '1', 'thumbs'))).toBe(false);
  });

  it('says what is wrong with the time, the text or the focus', async () => {
    const { call } = await connect(await withCut('rough.mp4'), { tools: await realMediaTools() });
    expect(await call('thumbnail', { video: 1, at: 14 })).toEqual({ isError: true, text: '✖ 14 s is outside the video (0–14 s)' });
    expect(await call('thumbnail', { video: 1, at: 1, text: 'one two three four five' })).toEqual({ isError: true, text: '✖ thumbnail text is 5 words — keep it to 4 or fewer' });
    expect(await call('thumbnail', { video: 1, text: 'Ship it' })).toEqual({
      isError: true, text: '✖ text and focus go with at (the second of the video the thumbnail shows)\n  Run thumbnail without them to pick a frame, then again with at.',
    });
    expect((await call('thumbnail', { video: 1, at: 1, focus: { x: 2, y: 0 } })).isError).toBe(true);
  });

  it('says there is no cut yet, with what to run', async () => {
    const { call } = await connect(await withCut(null), { tools: await realMediaTools() });
    expect(await call('thumbnail', { video: 1 })).toEqual({ isError: true, text: '✖ video 1 has no cut yet\n  Run cut (or render) first.' });
  });

  it('is stopped when the person stops it, and says nothing was changed', async () => {
    const dir = await withCut('rough.mp4');
    const tools = { ...(await realMediaTools()), runFfmpeg: async (_a: string[], o?: { signal?: AbortSignal }) => { await new Promise((_r, rej) => o?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('stopped'), { name: 'AbortError' })))); } } as unknown as MediaTools;
    const { call } = await connect(dir, { tools });
    const running = call('thumbnail', { video: 1 });
    await new Promise((r) => setTimeout(r, 100));
    await writeControl(dir, 1, { pauseNow: true });
    expect(await running).toEqual({ isError: true, text: '✖ Stopped by the person before it finished. Nothing was changed.' });
  });
});

describe('series', () => {
  it('new_video starts a series or adds a video to one, the series tool lists, shows and updates it, and status names it', async () => {
    const dir = await projectWithVideo();
    const footage = join(dir, '..', `${dir.split('/').pop()}-footage`);
    await mkdir(footage, { recursive: true });
    const { call } = await connect(dir);
    expect(await call('series')).toEqual({ isError: false, text: 'no series yet — new_video with series starts one' });
    expect(await call('new_video', { title: 'The lamp, part 2', about: 'a lamp', footage: [footage], series: { name: 'The Lamp', question: 'Will the lamp ever light?', thumbnail: { face: 'left' } } })).toEqual({
      isError: false, text: 'video 2 created (format build-story: cold-open → title → recap → new-toy → problem → montage → twist → truth → outro → blooper)\nstarted the series “The Lamp” (series/the-lamp/) as episode 1 · no open question on record',
    });
    expect(JSON.parse(await readFile(join(dir, 'episodes', '2', 'video.json'), 'utf8')).series).toBe('the-lamp');
    // After the final render the skill records what the episode leaves open, and the counts.
    const saved = await call('series', { name: 'the-lamp', openQuestion: 'Will the new switch fit?', video: 2, counts: { 'cost so far': { value: 55, unit: '£' } }, signOff: 'See you in the shed.' });
    expect(saved.text.split('\n')).toEqual([
      'saved series/the-lamp/series.json',
      'Series “The Lamp” (series/the-lamp/, build-story): video 2 · open question: “Will the new switch fit?”',
      '  The big question: Will the lamp ever light?',
      '  The open question was left by video 2',
      '  Running counts: cost so far 55 £',
      '  Sign-off: See you in the shed.',
      '  Title shape: none on record',
      '  Thumbnail layout: the face on the left, 34% of the width',
      '  Video 2 “The lamp, part 2”: new',
      '  The grouped view is series/the-lamp/README.md',
    ]);
    // The next episode joins by the series' name; fields given for a series that exists are not applied, and that is said.
    const next = await call('new_video', { title: 'The lamp, part 3', about: 'a lamp', footage: [footage], series: { name: 'The Lamp', signOff: 'Bye.' } });
    expect(next.text.split('\n').slice(1)).toEqual([
      'added to the series “The Lamp” (series/the-lamp/) as episode 2 · open question: “Will the new switch fit?”',
      '⚠ the series “The Lamp” already exists, so signOff was not applied — change a series with the series tool',
    ]);
    expect((await call('series')).text).toBe('Series “The Lamp” (series/the-lamp/, build-story): videos 2, 3 · open question: “Will the new switch fit?”');
    expect((await call('series', { name: 'The Lamp' })).text).toContain('  Sign-off: See you in the shed.');
    const status = (await call('status')).text.split('\n');
    expect(status[status.findIndex((l) => l.startsWith('Video 3')) + 1]).toBe('Series “The Lamp” (series/the-lamp/, build-story): videos 2, 3 · open question: “Will the new switch fit?”');
    expect(await readFile(join(dir, 'series', 'the-lamp', 'README.md'), 'utf8')).toContain('2. Video 3 “The lamp, part 3”: new');
    // check says so in the playbook of a video in the series.
    await saveEpisode(dir, EpisodeSchema.parse({ version: 2, number: 3, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 3 } }] }));
    expect((await call('check', { video: 3 })).text.split('\n').at(-1)).toBe('  ✓ the series “The Lamp” has an open question on record, left by video 2: “Will the new switch fit?”');

    expect(await call('series', { name: 'the-car' })).toEqual({ isError: true, text: '✖ there is no series "the-car"\n  The series are: the-lamp. new_video with series starts one.' });
    expect(await call('series', { openQuestion: 'Q?' })).toEqual({ isError: true, text: '✖ name is needed: which series to change\n  Run series with no input to list them.' });
    expect(await call('series', { name: 'the-lamp', video: 2 })).toEqual({ isError: true, text: '✖ video goes with openQuestion (the episode whose outro left it)' });
    expect(await call('series', { name: 'the-lamp', openQuestion: 'Q?', video: 1 })).toEqual({ isError: true, text: '✖ video 1 isn\'t an episode of the series "The Lamp"\n  Its episodes are: video 2, video 3.' });
    // A series file that broke is one ✖ line in the list and in status; a video can't join it.
    await mkdir(join(dir, 'series', 'bad'));
    await writeFile(join(dir, 'series', 'bad', 'series.json'), '{"version":1}');
    expect((await call('series')).text.split('\n')[1]).toMatch(/^✖ series\/bad\/series\.json: /);
    expect((await call('status')).text).toMatch(/\n✖ series\/bad\/series\.json: /);
    expect((await call('new_video', { title: 'X', about: 'x', footage: [footage], series: { name: 'bad' } })).isError).toBe(true);
    expect(existsSync(join(dir, 'episodes', '4'))).toBe(false);
  });

  it('thumbnail builds from two sources in the layout the series keeps, and posted records where else a short went', async () => {
    const dir = await projectWithVideo({ items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 10 } }, { id: 'b', beat: 'truth', clip: 'c001', src: { in: 10, out: 14 } }] });
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=30', '-pix_fmt', 'yuv420p', '-f', 'mp4', join(dir, 'screen.mov')]);
    await writeFile(join(dir, 'episodes', '1', 'video.json'), JSON.stringify({ version: 1, title: 'The lamp', about: '', mention: '', hide: '', footage: [], createdAt: '2026-11-01T00:00:00Z', series: 'the-lamp' }));
    await mkdir(join(dir, 'series', 'the-lamp'), { recursive: true });
    await writeFile(join(dir, 'series', 'the-lamp', 'series.json'), JSON.stringify({ version: 1, slug: 'the-lamp', name: 'The Lamp', format: 'build-story', counts: {}, thumbnail: { face: 'right', share: 0.3 }, episodes: [1], createdAt: '2026-11-01T00:00:00Z' }));
    const { call } = await connect(dir, { tools: await realMediaTools(), now: () => new Date('2026-11-09T10:00:00Z') });
    expect(await call('thumbnail', { video: 1, face: { at: 2 }, subject: { at: 12, focus: { x: 0.5, y: 0.5 } }, text: 'It works' })).toEqual({
      isError: false, text: 'wrote episodes/1/thumbnail.jpg (1280×720, from two sources: the face (c001 at 2 s) on the right, 30% of the width, and the subject (c001 at 12 s) filling the rest)',
    });
    const other = await call('thumbnail', { video: 1, face: { at: 2 }, subject: { at: 12 }, side: 'left' });
    expect(other.text.split('\n')[1]).toBe("⚠ this thumbnail has the face on the left at 30% of the width, and the series “The Lamp” keeps it on the right at 30% — leave side and share out so every episode matches, or change the series' layout with the series tool");
    expect(await call('thumbnail', { video: 1, face: { at: 2 } })).toEqual({
      isError: true, text: '✖ a thumbnail from two sources takes face and subject (each with at or image, and its own focus), and no at or focus of its own\n  Give both face and subject, or call thumbnail with at for one frame.',
    });
    expect((await call('thumbnail', { video: 1, at: 1, face: { at: 2 }, subject: { at: 12 } })).isError).toBe(true);
    expect(await call('thumbnail', { video: 1, face: { image: 'photos/me.jpg' }, subject: { at: 12 } })).toEqual({
      isError: true, text: "✖ the face's picture photos/me.jpg is missing\n  Put the picture (a PNG or JPEG) in the project folder and give its path from there, e.g. photos/me.jpg.",
    });

    await writeFile(join(dir, 'episodes', '1', 'final.mp4'), '');
    const tools = { probe: async () => ({ durationSec: 14, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: false, videoCodec: 'h264', audioCodec: null, colorTransfer: null }) } as unknown as MediaTools;
    const { call: call2 } = await connect(dir, { tools, now: () => new Date('2026-11-09T10:00:00Z') });
    const posted = await call2('posted', { video: 1, url: 'https://youtu.be/abcdefghijk', also: [{ platform: 'instagram', url: 'https://www.instagram.com/reel/Cx1/' }] });
    expect(posted.text.split('\n')[1]).toBe('also posted on Instagram (https://www.instagram.com/reel/Cx1/) — Mirage reads no numbers there: give learn the ones you see in the app, as studio with platform');
    expect(posted.text).toContain('a thumbnail from two sources (face on the left) without text');
    expect(await call2('posted', { video: 1, url: 'https://youtu.be/abcdefghijk', also: [{ platform: 'instagram', url: 'https://example.com/reel' }] })).toEqual({
      isError: true, text: '✖ also: "https://example.com/reel" isn\'t an address on Instagram\n  Give the video\'s own https address on that platform, or leave it out.',
    });
  });
});

describe('newestSessionId', () => {
  it('is the session file touched last, however long ago', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-mcp-'));
    expect(newestSessionId(dir)).toBeNull();
    const sessions = join(dir, '.mirage', 'sessions');
    await mkdir(sessions, { recursive: true });
    const touch = async (name: string, ageMs: number) => {
      await writeFile(join(sessions, name), '{}');
      const t = new Date(Date.now() - ageMs);
      await utimes(join(sessions, name), t, t);
    };
    await touch('old.json', 25 * 3600_000);
    expect(newestSessionId(dir)).toBe('old');
    await touch('a.json', 3600_000);
    await touch('b.json', 60_000);
    await touch('unknown.json', 1000);
    await touch('notes.txt', 500);
    expect(newestSessionId(dir)).toBe('b');
  });
});
