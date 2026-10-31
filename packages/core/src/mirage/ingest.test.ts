import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProbeInfo, Transcript } from '@wordedits/shared';
import { run } from '@wordedits/sidecars';
import { beforeAll, describe, expect, it } from 'vitest';
import { realMediaTools, type MediaTools } from '../media-tools.js';
import { frameInterval, guessKind, ingestClips, loadCatalog } from './ingest.js';
import { acquireLock, LOCK_FILE } from './lock.js';

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
    expect(again.skipped.map((s) => [s.file, s.reason])).toEqual([['notes.txt', 'not a video Mirage reads (.mp4, .mov, .m4v, .mkv, .webm)'], ['phone.mov', 'already in the catalog'], ['screen.mp4', 'already in the catalog']]);
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

  it('clears WAVs left by a killed ingest, and refuses while another ingest holds the project', async () => {
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    await writeFile(join(project, '.tmp-c001.wav'), 'x');
    await writeFile(join(project, LOCK_FILE), JSON.stringify({ pid: 4_194_305, command: 'ingest', startedAt: new Date().toISOString(), token: 'dead' }));
    await ingestClips({ project, clipsDir: good, tools: { ...real, transcribe: async () => words(10, 3) } });
    expect(existsSync(join(project, '.tmp-c001.wav'))).toBe(false);
    expect(existsSync(join(project, LOCK_FILE))).toBe(false);
    const lock = await acquireLock(project, 'ingest', 'the project');
    try {
      await expect(ingestClips({ project, clipsDir: good, tools: real })).rejects.toMatchObject({ code: 'BUSY', message: expect.stringContaining('the project is busy: ingest') });
    } finally {
      await lock.release();
    }
  });

  it('keeps edits made to the catalog while it was transcribing (notes, moments, kind of other clips)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-two-'));
    await copyFile(join(good, 'phone.mov'), join(dir, 'a.mov'));
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir, 'b.mov')]);
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    let calls = 0;
    const tools: MediaTools = {
      ...real,
      transcribe: async () => {
        // While b.mov is transcribed, Claude describes a.mov (already saved as c001).
        if (++calls === 2) {
          const cat = JSON.parse(await readFile(join(project, 'catalog.json'), 'utf8'));
          Object.assign(cat.clips[0], { notes: 'Phone test card.', kind: 'camera', moments: [{ t: 1, label: 'beep' }] });
          await writeFile(join(project, 'catalog.json'), JSON.stringify(cat));
        }
        return words(10, 3);
      },
    };
    await ingestClips({ project, clipsDir: dir, tools });
    const cat = await loadCatalog(project);
    expect(cat.clips.map((c) => c.id)).toEqual(['c001', 'c002']);
    expect(cat.clips[0]).toMatchObject({ notes: 'Phone test card.', kind: 'camera', moments: [{ t: 1, label: 'beep' }] });
  });

  it('keeps notes, moments and kind written while it retried the transcript of a clip that moved', async () => {
    const from = await mkdtemp(join(tmpdir(), 'we-from-'));
    const to = await mkdtemp(join(tmpdir(), 'we-to-'));
    await copyFile(join(good, 'phone.mov'), join(from, 'clip.mov'));
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    await ingestClips({ project, clipsDir: from, tools: { ...real, transcribe: async () => { throw new Error('no speech model'); } } });
    await rename(join(from, 'clip.mov'), join(to, 'renamed.mov'));
    const tools: MediaTools = {
      ...real,
      transcribe: async () => {
        // While the retry transcribes, Claude describes the clip.
        const cat = JSON.parse(await readFile(join(project, 'catalog.json'), 'utf8'));
        Object.assign(cat.clips[0], { notes: 'Phone test card.', kind: 'camera', moments: [{ t: 1, label: 'beep' }] });
        await writeFile(join(project, 'catalog.json'), JSON.stringify(cat));
        return words(10, 3);
      },
    };
    await ingestClips({ project, clipsDir: to, tools });
    const [clip] = (await loadCatalog(project)).clips;
    expect(clip).toMatchObject({ id: 'c001', path: join(to, 'renamed.mov'), notes: 'Phone test card.', kind: 'camera', moments: [{ t: 1, label: 'beep' }] });
    expect(clip.transcript?.words).toHaveLength(10);
  });

  it('stops at once, naming the key, when catalog.json is edited into an invalid file while it works', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-two-'));
    await copyFile(join(good, 'phone.mov'), join(dir, 'a.mov'));
    await copyFile(join(good, 'phone.mov'), join(dir, 'b.mov'));
    await writeFile(join(dir, 'b.mov'), Buffer.from('x'), { flag: 'a' }); // another file, so not "already in the catalog"
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    await writeFile(join(project, 'catalog.json'), JSON.stringify({ version: 1, clips: [] }));
    let calls = 0;
    const tools: MediaTools = {
      ...real,
      transcribe: async () => {
        // While a.mov is transcribed, a misspelled key lands in catalog.json.
        if (++calls === 1) await writeFile(join(project, 'catalog.json'), JSON.stringify({ version: 1, clips: [], note: 'x' }));
        return words(10, 3);
      },
    };
    await expect(ingestClips({ project, clipsDir: dir, tools })).rejects.toMatchObject({
      message: expect.stringMatching(/^catalog\.json: unknown key "note"/),
      hint: expect.stringContaining('run ingest again'),
    });
    expect(calls).toBe(1);
    expect(existsSync(join(project, 'frames', 'c001'))).toBe(false);
    expect(existsSync(join(project, LOCK_FILE))).toBe(false);
  });

  it('extracts frames into a project whose path contains %', async () => {
    const project = await mkdtemp(join(tmpdir(), 'we 100%d %04d-'));
    const r = await ingestClips({ project, clipsDir: good, tools: { ...real, transcribe: async () => words(10, 3) } });
    expect(r.skipped).toEqual([]);
    expect(r.added[0].frames.length).toBeGreaterThanOrEqual(1);
    expect(r.added[0].frames.every((f) => existsSync(join(project, f.file)))).toBe(true);
  });

  it('says which files in the folder are not videos, ignoring dotfiles and subfolders', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-mixed-'));
    await copyFile(join(good, 'phone.mov'), join(dir, 'clip.mov'));
    for (const f of ['shot.png', 'old.avi', '.DS_Store']) await writeFile(join(dir, f), 'x');
    await mkdir(join(dir, 'exports'));
    const r = await ingestClips({ project: await mkdtemp(join(tmpdir(), 'we-proj-')), clipsDir: dir, tools: { ...real, transcribe: async () => words(10, 3) } });
    expect(r.added).toHaveLength(1);
    expect(r.skipped).toEqual([{ file: 'old.avi', reason: 'not a video Mirage reads (.mp4, .mov, .m4v, .mkv, .webm)' }, { file: 'shot.png', reason: 'not a video Mirage reads (.mp4, .mov, .m4v, .mkv, .webm)' }]);
  });

  it('skips a clip whose duration cannot be read instead of cataloguing 0 seconds', async () => {
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    const tools: MediaTools = { ...real, probe: async (f) => ({ ...(await real.probe(f)), durationSec: 0 }), transcribe: async () => words(10, 3) };
    const r = await ingestClips({ project, clipsDir: good, tools });
    expect(r.added).toEqual([]);
    expect(r.skipped).toEqual([{ file: 'phone.mov', reason: "its duration can't be read (a damaged or streamed recording) — re-export it, e.g. QuickTime → File → Export As" }]);
    expect((await loadCatalog(project)).clips).toEqual([]);
  });

  it("gives the tool's reason when a file can't be read, and names a clips folder that does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-bad-'));
    await writeFile(join(dir, 'bad.mp4'), Buffer.alloc(2048, 7));
    const r = await ingestClips({ project: await mkdtemp(join(tmpdir(), 'we-proj-')), clipsDir: dir, tools: real });
    expect(r.skipped[0].reason).toMatch(/^failed: ffprobe exited with code 1 — .*Invalid data found/);
    const missing = join(dir, 'nope');
    await expect(ingestClips({ project: await mkdtemp(join(tmpdir(), 'we-proj-')), clipsDir: missing, tools: real })).rejects.toMatchObject({ code: 'BAD_INPUT', message: `${missing} does not exist` });
    await expect(ingestClips({ project: await mkdtemp(join(tmpdir(), 'we-proj-')), clipsDir: join(dir, 'bad.mp4'), tools: real })).rejects.toMatchObject({ code: 'BAD_INPUT', message: `${join(dir, 'bad.mp4')} is a file, not a folder` });
  });
});

describe('ingestClips against the source clock (real ffmpeg)', () => {
  // Each source frame is a flat grey encoding its frame number at 10 fps: Y = 16 + 3N.
  const NUMBERED = (d: number) => `color=black:s=64x36:r=10:d=${d},format=gray,geq=lum='16+3*N',format=yuv420p`;
  const gen = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const shown = async (jpg: string) => {
    const raw = `${jpg}.gray`;
    await gen(['-i', jpg, '-vf', 'scale=1:1:flags=area,format=gray', '-f', 'rawvideo', raw]);
    // JPEG frames are full range: undo the 16–235 expansion.
    return Math.round(((await readFile(raw))[0] * 219) / 255 / 3);
  };
  let real: MediaTools;
  beforeAll(async () => {
    real = { ...(await realMediaTools()), transcribe: async () => words(0, 1) };
  });

  it('labels each catalog frame with the source time it shows, holding frames across a VFR gap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-vfr-'));
    // Frames 0–19 (0–1.9 s), nothing while the screen was still, then 51–59 (5.1–5.9 s).
    await gen(['-f', 'lavfi', '-i', `${NUMBERED(6)},select='not(between(t\\,2\\,5))'`, '-c:v', 'libx264', '-qp', '0', '-fps_mode', 'vfr', join(dir, 'gap.mp4')]);
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    const r = await ingestClips({ project, clipsDir: dir, tools: real });
    const frames = r.added[0].frames;
    expect(frames.map((f) => f.t)).toEqual([0, 2, 4]);
    expect(await Promise.all(frames.map((f) => shown(join(project, f.file))))).toEqual([0, 19, 19]);
  });

  it('gives a clip shorter than the frame interval one frame, from its middle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-short-'));
    await gen(['-f', 'lavfi', '-i', NUMBERED(0.8), '-c:v', 'libx264', '-qp', '0', join(dir, 'blip.mp4')]);
    const project = await mkdtemp(join(tmpdir(), 'we-proj-'));
    const r = await ingestClips({ project, clipsDir: dir, tools: real });
    expect(r.added[0].frames.map((f) => f.t)).toEqual([0.4]);
    expect(await shown(join(project, r.added[0].frames[0].file))).toBe(4);
  });

  it('warns about a clip cut short and a clip whose picture stops before its sound', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-damaged-'));
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'a-short-video.mp4')]);
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', join(dir, 'b-cut.mp4')]);
    await truncate(join(dir, 'b-cut.mp4'), Math.round((await stat(join(dir, 'b-cut.mp4'))).size * 0.5));
    const r = await ingestClips({ project: await mkdtemp(join(tmpdir(), 'we-proj-')), clipsDir: dir, tools: real });
    expect(r.added.map((c) => c.probe.videoDurationSec! < 4.5)).toEqual([true, true]);
    expect(r.warnings).toEqual([
      expect.stringMatching(/^a-short-video\.mp4: its picture stops at 3\.0 s but its sound runs to 8\.0 s — items can use only the first 3\.0 s$/),
      expect.stringMatching(/^b-cut\.mp4 looks cut short: its header promises more than the file holds, so only its first \d\.\d s can be used/),
    ]);
  });

  it('takes the sound from the loudest audio track when the first is silent, for the transcript and the kind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-tracks-'));
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=4', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=4',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '4', join(dir, 'screen.mov')]);
    // "Transcribes" a WAV with sound as steady speech, and a silent one as nothing said.
    const transcribe = async (wav: string) => {
      const pcm = (await readFile(wav)).subarray(44);
      let peak = 0;
      for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
      return peak > 1000 ? words(20, 4) : words(0, 1);
    };
    const r = await ingestClips({ project: await mkdtemp(join(tmpdir(), 'we-proj-')), clipsDir: dir, tools: { ...real, transcribe } });
    expect(r.added[0].probe).toMatchObject({ audioStreams: 2, audioStream: 1 });
    expect(r.added[0].transcript?.words).toHaveLength(20);
    expect(r.added[0].kind).toBe('talking');
    expect(r.warnings).toEqual(['screen.mov: its first audio track is silent, so its sound is taken from track 2']);
  });
});
