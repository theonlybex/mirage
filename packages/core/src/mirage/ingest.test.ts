import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProbeInfo, Transcript } from '@wordedits/shared';
import { run } from '@wordedits/sidecars';
import { beforeAll, describe, expect, it } from 'vitest';
import { realMediaTools, type MediaTools } from '../media-tools.js';
import { frameInterval, guessKind, ingestClips, loadCatalog } from './ingest.js';

const probe = (o: Partial<ProbeInfo>): ProbeInfo => ({ durationSec: 10, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', colorTransfer: null, ...o });
const words = (n: number, dur: number): Transcript => ({
  words: Array.from({ length: n }, (_, i) => ({ w: `w${i}`, start: (i * dur) / n, end: (i * dur) / n + 0.1, conf: 1 })),
  segments: [],
  speech: [],
});

describe('guessKind', () => {
  it('calls steady speech talking, long silent footage a timelapse, portrait a camera clip, the rest screen', () => {
    expect(guessKind(probe({ durationSec: 10 }), words(30, 10))).toBe('talking');
    expect(guessKind(probe({ durationSec: 3600 }), null)).toBe('timelapse');
    expect(guessKind(probe({ width: 1080, height: 1920 }), null)).toBe('camera');
    expect(guessKind(probe({}), words(3, 10))).toBe('screen');
  });
});

describe('frameInterval', () => {
  it('aims for about 40 frames, between 2 and 20 s apart', () => {
    expect(frameInterval(4)).toBe(2);
    expect(frameInterval(400)).toBe(10);
    expect(frameInterval(7200)).toBe(20);
  });
});

describe('ingestClips', () => {
  let tools: MediaTools;
  let clips: string;
  beforeAll(async () => {
    const real = await realMediaTools();
    tools = { ...real, transcribe: async () => words(10, 3) };
    clips = await mkdtemp(join(tmpdir(), "we clips 'q' "));
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(clips, 'screen.mp4')]);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(clips, 'phone.mov')]);
    await writeFile(join(clips, 'notes.txt'), 'not a clip');
    await writeFile(join(clips, '.hidden.mp4'), 'not a clip');
  });

  it('catalogs new clips with frames and transcripts, and skips known ones on re-run', async () => {
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    const r = await ingestClips({ project, clipsDir: clips, tools });
    expect(r.added.map((c) => [c.id, c.kind])).toEqual([['c001', 'talking'], ['c002', 'screen']]);
    const cat = await loadCatalog(project);
    expect(cat.clips[0].path).toBe(join(clips, 'phone.mov'));
    expect(cat.clips[0].transcript?.words).toHaveLength(10);
    expect(cat.clips[1].transcript).toBeNull();
    expect(cat.clips[1].frames.length).toBeGreaterThanOrEqual(2);
    expect(cat.clips[1].frames[1].t).toBe(2);
    expect(cat.clips[1].frames.every((f) => existsSync(join(project, f.file)))).toBe(true);

    const again = await ingestClips({ project, clipsDir: clips, tools });
    expect(again.added).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual(['already in the catalog', 'already in the catalog']);
  });
});

describe('ingestClips resilience', () => {
  let real: MediaTools;
  let good: string;
  beforeAll(async () => {
    real = await realMediaTools();
    good = await mkdtemp(join(tmpdir(), 'we-good-'));
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(good, 'phone.mov')]);
  });

  it('skips a corrupt file with a failed reason and still ingests later clips', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-bad-'));
    await writeFile(join(dir, 'bad.mp4'), Buffer.alloc(2048, 7));
    await copyFile(join(good, 'phone.mov'), join(dir, 'zgood.mov'));
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    const tools: MediaTools = { ...real, transcribe: async () => words(10, 3) };
    const r = await ingestClips({ project, clipsDir: dir, tools });
    expect(r.added.map((c) => c.id)).toEqual(['c001']);
    expect(r.added[0].path).toBe(join(dir, 'zgood.mov'));
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].file).toBe('bad.mp4');
    expect(r.skipped[0].reason.startsWith('failed:')).toBe(true);
    const cat = await loadCatalog(project);
    expect(cat.clips.map((c) => c.id)).toEqual(['c001']);
    expect(existsSync(join(project, 'frames', 'c001'))).toBe(true);
    expect(existsSync(join(project, 'frames', 'c002'))).toBe(false);
    expect(cat.clips[0].frames.every((f) => !f.file.includes('\\'))).toBe(true);
  });

  it('keeps a clip as silent footage when transcription throws', async () => {
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    const steps: string[] = [];
    const tools: MediaTools = { ...real, transcribe: async () => { throw new Error('no speech model'); } };
    const r = await ingestClips({ project, clipsDir: good, tools, onStep: (m) => steps.push(m) });
    expect(r.skipped).toEqual([]);
    expect(r.added).toHaveLength(1);
    expect(r.added[0].transcript).toBeNull();
    expect(steps.some((m) => m.includes('transcription failed, kept as silent footage'))).toBe(true);
  });

  it('updates the path of a catalogued clip whose file moved, instead of skipping it', async () => {
    const from = await mkdtemp(join(tmpdir(), 'we-from-'));
    const to = await mkdtemp(join(tmpdir(), 'we-to-'));
    await copyFile(join(good, 'phone.mov'), join(from, 'clip.mov'));
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    const tools: MediaTools = { ...real, transcribe: async () => words(10, 3) };
    await ingestClips({ project, clipsDir: from, tools });
    await rename(join(from, 'clip.mov'), join(to, 'renamed.mov'));
    const steps: string[] = [];
    const r = await ingestClips({ project, clipsDir: to, tools, onStep: (m) => steps.push(m) });
    expect(r.added).toEqual([]);
    expect(steps).toContain('renamed.mov: moved, path updated');
    const cat = await loadCatalog(project);
    expect(cat.clips.map((c) => [c.id, c.path])).toEqual([['c001', join(to, 'renamed.mov')]]);
  });

  it('warns when transcription fails, and retries that clip on the next ingest', async () => {
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    const fail: MediaTools = { ...real, transcribe: async () => { throw new Error('no speech model'); } };
    const first = await ingestClips({ project, clipsDir: good, tools: fail });
    expect(first.warnings).toEqual([expect.stringMatching(/^phone\.mov: transcription failed .*run ingest again/)]);
    expect((await loadCatalog(project)).clips[0].transcript).toBeNull();
    const steps: string[] = [];
    const second = await ingestClips({ project, clipsDir: good, tools: { ...real, transcribe: async () => words(10, 3) }, onStep: (m) => steps.push(m) });
    expect(second.warnings).toEqual([]);
    expect(steps).toContain('phone.mov: transcribed');
    const cat = await loadCatalog(project);
    expect(cat.clips).toHaveLength(1);
    expect(cat.clips[0].transcript?.words).toHaveLength(10);
  });

  it('keeps a transcript with no words, so a silent clip is not transcribed again on every ingest', async () => {
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    let calls = 0;
    const tools: MediaTools = { ...real, transcribe: async () => { calls += 1; return words(0, 3); } };
    await ingestClips({ project, clipsDir: good, tools });
    await ingestClips({ project, clipsDir: good, tools });
    expect(calls).toBe(1);
    expect((await loadCatalog(project)).clips[0].transcript?.words).toEqual([]);
  });

  it('transcribes long clips, with a timeout that grows with their length', async () => {
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    const seen: (number | undefined)[] = [];
    const tools: MediaTools = {
      ...real,
      probe: async (f) => ({ ...(await real.probe(f)), durationSec: 3 * 3600 }),
      transcribe: async (_a, opts) => { seen.push(opts?.timeoutMs); return words(10, 3); },
    };
    const r = await ingestClips({ project, clipsDir: good, tools });
    expect(r.added[0].transcript?.words).toHaveLength(10);
    expect(seen).toEqual([3 * 3600 * 2 * 1000]);
  });

  it('warns about HDR clips (HLG or PQ)', async () => {
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    const tools: MediaTools = { ...real, probe: async (f) => ({ ...(await real.probe(f)), colorTransfer: 'arib-std-b67' }), transcribe: async () => words(10, 3) };
    const r = await ingestClips({ project, clipsDir: good, tools });
    expect(r.warnings).toEqual(['phone.mov is HDR (arib-std-b67); colours will look washed out — export it as SDR (e.g. Photos → Export → "Most Compatible")']);
    const sdr = await ingestClips({ project: await mkdtemp(join(tmpdir(), 'we-proj-')), clipsDir: good, tools: { ...real, transcribe: async () => words(10, 3) } });
    expect(sdr.warnings).toEqual([]);
  });

  it('reports an unreadable entry (a directory named like a clip) as failed and continues', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-dir-'));
    await mkdir(join(dir, 'aaa.mp4'));
    await copyFile(join(good, 'phone.mov'), join(dir, 'zgood.mov'));
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    const tools: MediaTools = { ...real, transcribe: async () => words(10, 3) };
    const r = await ingestClips({ project, clipsDir: dir, tools });
    expect(r.added.map((c) => [c.id, c.path])).toEqual([['c001', join(dir, 'zgood.mov')]]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].file).toBe('aaa.mp4');
    expect(r.skipped[0].reason.startsWith('failed:')).toBe(true);
  });

  it('removes frames/<id> when frame extraction fails after the directory was created', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-ff-'));
    await copyFile(join(good, 'phone.mov'), join(dir, 'a.mov'));
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'b.mp4')]);
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    let calls = 0;
    const tools: MediaTools = {
      ...real,
      transcribe: async () => words(10, 3),
      runFfmpeg: async (args, opts) => {
        calls += 1;
        if (calls === 2) throw new Error('ffmpeg blew up');
        return real.runFfmpeg(args, opts);
      },
    };
    const r = await ingestClips({ project, clipsDir: dir, tools });
    expect(r.added.map((c) => c.id)).toEqual(['c001']);
    expect(r.skipped).toEqual([{ file: 'b.mp4', reason: 'failed: ffmpeg blew up' }]);
    expect(existsSync(join(project, 'frames', 'c001'))).toBe(true);
    expect(existsSync(join(project, 'frames', 'c002'))).toBe(false);
  });
});
