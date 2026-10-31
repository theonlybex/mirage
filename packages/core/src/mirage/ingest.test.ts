import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProbeInfo, Transcript } from '@wordedits/shared';
import { run } from '@wordedits/sidecars';
import { beforeAll, describe, expect, it } from 'vitest';
import { realMediaTools, type MediaTools } from '../media-tools.js';
import { frameInterval, guessKind, ingestClips, loadCatalog } from './ingest.js';

const probe = (o: Partial<ProbeInfo>): ProbeInfo => ({ durationSec: 10, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', ...o });
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
