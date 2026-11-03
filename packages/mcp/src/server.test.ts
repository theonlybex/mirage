// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  loadEpisode, readLog, readSessionState, saveCatalog, saveEpisode, sessionDir, snapshotVersion, writeClaudeProcess, writeControl, writeSessionState,
  type MediaTools,
} from '@wordedits/core';
import { EpisodeSchema } from '@wordedits/shared';
import { SidecarError } from '@wordedits/sidecars';
import { afterEach, describe, expect, it } from 'vitest';
import type { PreflightDeps } from './preflight.js';
import { createEngineServer, newestSessionId, TOOL_NAMES, type EngineContext } from './server.js';

const enc = { name: 'libx264' as const, extraArgs: [] };
const GB = 1024 ** 3;
const deps = (over: Partial<PreflightDeps> = {}): PreflightDeps => ({ onBattery: async () => false, freeBytes: async () => 500 * GB, footageBytes: async () => GB, which: async () => true, transcriber: async () => true, ...over });

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
      'new_project', 'new_video', 'ingest', 'music', 'check', 'cut', 'slots', 'guide', 'vo', 'render', 'versions', 'restore', 'get_notes', 'note_status', 'log', 'overnight', 'status',
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
    expect((await call('new_video', { title: 'Two', about: 'x', footage: [join(parent, 'clips'), join(dir, 'raw')] })).text).toBe('video 1 created');
  });

  it('new_video creates the video and records it in the session state', async () => {
    const dir = await projectWithVideo();
    const { call } = await connect(dir);
    const clips = await mkdtemp(join(tmpdir(), 'mirage-clips-'));
    const r = await call('new_video', { title: 'Two', about: 'the second', mention: 'the bug', footage: [clips] });
    expect(r).toEqual({ isError: false, text: 'video 2 created' });
    expect(JSON.parse(await readFile(join(dir, 'episodes', '2', 'video.json'), 'utf8'))).toMatchObject({ title: 'Two', mention: 'the bug', hide: '', footage: [clips] });
    expect((await readSessionState(dir, 's1')).video).toBe(2);
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

  it('logs to sessions/unknown when no session is known', async () => {
    const dir = await projectWithVideo({ overlays: [{ kind: 'label', text: 'late', start: 50, end: 51 }] });
    const { call } = await connect(dir, { sessionId: () => null });
    await call('check', { video: 1 });
    expect(await readLog(sessionDir(dir, 1, 'unknown'))).toHaveLength(1);
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
    const was = process.env.WORDEDITS_TRANSCRIBER;
    process.env.WORDEDITS_TRANSCRIBER = join(dir, 'no-transcriber');
    try {
      const { call } = await connect(dir, { preflightDeps: deps({ which: async (c) => c === 'ffmpeg' }) });
      const r = await call('status');
      expect(r.isError).toBe(false);
      const lines = r.text.split('\n');
      expect(lines).toContain('Project: My build');
      expect(lines).toContain('Video 1: rough · 1 delivery');
      expect(lines).toContain('Viewer: not running');
      expect(lines).toContain('ffmpeg: ok');
      expect(lines).toContain('ffprobe: missing');
      expect(lines).toContain('transcriber: missing');
      expect(lines.find((l) => l.startsWith('Node: '))).toMatch(/^Node: v\d+\.\d+\.\d+ ok$/);
      await mkdir(join(dir, '.mirage'), { recursive: true });
      await writeFile(join(dir, '.mirage', 'viewer.json'), JSON.stringify({ url: 'http://127.0.0.1:5123', pid: process.pid }));
      expect((await call('status')).text).toContain('Viewer: running at http://127.0.0.1:5123');
    } finally {
      if (was === undefined) delete process.env.WORDEDITS_TRANSCRIBER;
      else process.env.WORDEDITS_TRANSCRIBER = was;
    }
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
    expect((await a.call('new_video', { title: 'Two', about: 'x', footage: [footage] })).text).toBe('video 2 created');
    expect((await b.call('new_video', { title: 'Three', about: 'x', footage: [footage] })).text).toBe('video 3 created');
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
