import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type Catalog, type MusicLibrary } from '@wordedits/shared';
import { run } from '@wordedits/sidecars';
import { beforeAll, describe, expect, it } from 'vitest';
import { realMediaTools, type MediaTools } from '../media-tools.js';
import { ingestClips } from './ingest.js';
import { analyzeLibrary, loadLibrary } from './music.js';
import { buildVoiceTrack, episodeFinalArgs, itemChunkArgs, musicTrackArgs, renderEpisode, saveEpisode, sourcesFor } from './render-episode.js';
import { layoutTimeline, timelineDuration } from './timeline.js';

const enc = { name: 'libx264' as const, extraArgs: [] };
const clipOf = (id: string, dur: number, hasAudio: boolean) => ({
  id, path: `/clips/${id}.mp4`, sha256: 'a'.repeat(64),
  probe: { durationSec: dur, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio, videoCodec: 'h264', audioCodec: hasAudio ? 'aac' : null },
  kind: 'screen' as const, transcript: null, frames: [], notes: '', moments: [],
});
const cat: Catalog = { version: 1, clips: [clipOf('c001', 10, true), clipOf('c002', 600, false)] };
const ep = (items: object[], extra: object = {}) =>
  EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items, ...extra });

describe('sourcesFor', () => {
  it('stops with BAD_ITEM for a missing clip or a range past the clip end', () => {
    expect(() => sourcesFor(ep([{ id: 'x', beat: 'problem', clip: 'c999', src: { in: 0, out: 1 } }]), cat)).toThrow(expect.objectContaining({ code: 'BAD_ITEM', message: expect.stringContaining('x') }));
    expect(() => sourcesFor(ep([{ id: 'y', beat: 'problem', clip: 'c001', src: { in: 5, out: 12 } }]), cat)).toThrow(expect.objectContaining({ code: 'BAD_ITEM' }));
  });
});

describe('itemChunkArgs', () => {
  const e = ep([
    { id: 'a', beat: 'cold-open', clip: 'c001', src: { in: 1, out: 3 }, audio: 'keep', zoom: 1.2 },
    { id: 'b', beat: 'montage', clip: 'c002', src: { in: 0, out: 60 }, speed: 20, audio: 'keep' },
  ]);
  const args = itemChunkArgs(layoutTimeline(e), { width: 960, height: 540, fps: 30 }, sourcesFor(e, cat), '/w/chunk-000.mov');
  const graph = args[args.indexOf('-filter_complex') + 1];
  it('seeks each item and reads only the source it needs at its speed', () => {
    expect(args.slice(0, 8)).toEqual(['-threads', '1', '-ss', '1', '-t', '2.033333', '-i', '/clips/c001.mp4']);
    expect(args.slice(8, 16)).toEqual(['-threads', '1', '-ss', '0', '-t', '60.666667', '-i', '/clips/c002.mp4']);
  });
  it('speeds up, punches in, letterboxes and cuts to exact frames', () => {
    expect(graph).toContain('[0:v]setpts=(PTS-STARTPTS)/1,crop=trunc(iw/1.2/2)*2:trunc(ih/1.2/2)*2,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,tpad=stop=-1:stop_mode=clone,trim=end_frame=60,setpts=PTS-STARTPTS[v0]');
    expect(graph).toContain('[1:v]setpts=(PTS-STARTPTS)/20,');
  });
  it('keeps live audio only at real-time speed; sped-up items get silence', () => {
    expect(graph).toContain('[0:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end=2,apad,atrim=end=2,asetpts=PTS-STARTPTS[a0]');
    expect(graph).toContain('anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end=3,aformat=sample_fmts=fltp:channel_layouts=stereo[a1]');
    expect(graph).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[vcat][acat]');
    expect(args.at(-1)).toBe('/w/chunk-000.mov');
  });
  it('cuts live audio at the end of the source before padding silence under a hold', () => {
    const h = ep([{ id: 'h', beat: 'problem', clip: 'c001', src: { in: 1, out: 3 }, audio: 'keep', hold: 0.5 }]);
    const g = itemChunkArgs(layoutTimeline(h), { width: 960, height: 540, fps: 30 }, sourcesFor(h, cat), '/w/c.mov');
    expect(g[g.indexOf('-filter_complex') + 1]).toContain('aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end=2,apad,atrim=end=2.5,asetpts=PTS-STARTPTS[a0]');
  });
});

describe('musicTrackArgs', () => {
  const lib: MusicLibrary = { version: 1, tracks: [{ file: 'a.mp3', mood: 'upbeat', licence: '', bpm: 120, beatOffset: 0, durationSec: 8 }] };
  it('loops, offsets, normalises, fades and places each cue; zero fades add no filter', () => {
    const args = musicTrackArgs([{ track: 'a.mp3', start: 2, end: 12, gainDb: -18, fadeIn: 0, fadeOut: 1, offset: 0.5 }], lib, '/m', 15, -14, '/w/music.wav');
    expect(args.slice(0, 6)).toEqual(['-stream_loop', '-1', '-ss', '0.5', '-i', '/m/a.mp3']);
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('[0:a]asetpts=N/SR/TB,atrim=duration=10,');
    expect(graph).toContain('loudnorm=I=-32:TP=-2:LRA=11');
    expect(graph).not.toContain('afade=t=in');
    expect(graph).toContain('afade=t=out:st=9:d=1');
    expect(graph).toContain('adelay=delays=2000:all=1');
    expect(graph).toContain('amix=inputs=1:duration=longest:normalize=0,apad,atrim=end=15[out]');
  });
  it('clamps the loudnorm target to the range ffmpeg accepts', () => {
    const args = musicTrackArgs([{ track: 'a.mp3', start: 0, end: 4, gainDb: -60, fadeIn: 0, fadeOut: 0, offset: 0 }], lib, '/m', 4, -14, '/w/m.wav');
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('loudnorm=I=-70:TP=-2:LRA=11');
  });
  it('throws NO_MUSIC_TRACK for a cue whose track is not in the library', () => {
    expect(() => musicTrackArgs([{ track: 'zz.mp3', start: 0, end: 1, gainDb: -18, fadeIn: 0, fadeOut: 0, offset: 0 }], lib, '/m', 2, -14, '/w/m.wav')).toThrow(expect.objectContaining({ code: 'NO_MUSIC_TRACK' }));
  });
});

describe('buildVoiceTrack', () => {
  it('places kept segments at their output time', () => {
    const rec = new Float32Array(100).fill(0.5);
    const out = buildVoiceTrack({ recording: rec, sampleRate: 10, lines: [{ slot: 'n1', at: 1, src: { in: 2, out: 6 }, cuts: [[3, 4]] }], durationSec: 8 });
    expect(out.length).toBe(80);
    expect(out[5]).toBe(0);
    expect(out[15]).toBeCloseTo(0.5);
    expect(out[50]).toBe(0);
  });
});

describe('episodeFinalArgs', () => {
  it('builds speech and ducked music buses from relative file names', () => {
    const args = episodeFinalArgs({ chunkList: 'chunks.txt', output: '/o/final.mp4.partial', encoder: enc, mode: 'final', width: 1920, height: 1080, fps: 30, durationSec: 20, loudnessLufs: -14, assFile: 'overlays.ass', fontsDir: '/System/Library/Fonts', musicWav: 'music.wav', voiceRaw: 'vo.f32' });
    expect(args).toEqual(expect.arrayContaining(['-f', 'concat', '-safe', '0', '-i', 'chunks.txt', '-i', 'music.wav', '-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', 'vo.f32']));
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('[0:v]ass=overlays.ass:fontsdir=/System/Library/Fonts[vout]');
    expect(graph).toContain('[live][vo]amix=inputs=2:duration=first:normalize=0[speechraw]');
    expect(graph).toContain('[speechraw]highpass=f=90,loudnorm=I=-14:TP=-1:LRA=11');
    expect(graph).toContain('[mus][skey]sidechaincompress=threshold=0.03:ratio=8:attack=150:release=900[duck]');
    expect(args).toEqual(expect.arrayContaining(['-b:v', '8M', '-t', '20']));
    expect(args.at(-1)).toBe('/o/final.mp4.partial');
  });
  it('has no music or voice inputs when there are none', () => {
    const args = episodeFinalArgs({ chunkList: 'chunks.txt', output: '/o.mp4', encoder: enc, mode: 'preview', width: 960, height: 540, fps: 30, durationSec: 5, loudnessLufs: -14, assFile: 'overlays.ass' });
    expect(args.filter((a) => a === '-i')).toHaveLength(1);
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('[0:a]anull[speechraw]');
  });
  it('clamps the speech loudnorm target', () => {
    const lo = episodeFinalArgs({ chunkList: 'c.txt', output: '/o.mp4', encoder: enc, mode: 'preview', width: 960, height: 540, fps: 30, durationSec: 5, loudnessLufs: -90, assFile: 'o.ass' });
    expect(lo[lo.indexOf('-filter_complex') + 1]).toContain('loudnorm=I=-70:TP=-1');
    const hi = episodeFinalArgs({ chunkList: 'c.txt', output: '/o.mp4', encoder: enc, mode: 'preview', width: 960, height: 540, fps: 30, durationSec: 5, loudnessLufs: 0, assFile: 'o.ass' });
    expect(hi[hi.indexOf('-filter_complex') + 1]).toContain('loudnorm=I=-5:TP=-1');
  });
});

describe('renderEpisode (real ffmpeg)', () => {
  let tools: MediaTools;
  let project: string;
  beforeAll(async () => {
    tools = { ...(await realMediaTools()), transcribe: async () => ({ words: [], segments: [], speech: [] }) };
    project = await mkdtemp(join(tmpdir(), "we proj 'q' ✨ "));
    const clips = join(project, 'raw clips');
    await mkdir(clips, { recursive: true });
    const gen = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(clips, 'a-talk.mp4')]);
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(clips, 'b-phone.mp4')]);
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=60', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(clips, 'c-long.mp4')]);
    await ingestClips({ project, clipsDir: clips, tools });
    await mkdir(join(project, 'music'), { recursive: true });
    await gen(['-f', 'lavfi', '-i', "aevalsrc='0.6*sin(2*PI*440*t)*exp(-20*mod(t,0.5))':s=44100:d=8", join(project, 'music', 'loop.wav')]);
    await analyzeLibrary(join(project, 'music'), tools);
  }, 300_000);

  it('renders a rough cut of 31 items (2 chunks) with a portrait clip, a 20x item, overlays and looping music', async () => {
    const items = [
      { id: 'talk', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 3 }, audio: 'keep' },
      { id: 'phone', beat: 'recap', clip: 'c002', src: { in: 0, out: 2 } },
      { id: 'fast', beat: 'montage', clip: 'c003', src: { in: 0, out: 40 }, speed: 20 },
      ...Array.from({ length: 28 }, (_, i) => ({ id: `m${i}`, beat: 'montage', clip: 'c003', src: { in: i, out: i + 0.3 } })),
    ];
    const e = ep(items, {
      overlays: [{ kind: 'callout', text: '3 DAYS', start: 0.5, end: 1.5 }, { kind: 'badge', text: 'FAILED', start: 3, end: 5, tone: 'fail' }],
      music: [{ track: 'loop.wav', start: 3, end: 15 }],
    });
    await saveEpisode(project, e);
    const r = await renderEpisode({ project, episode: 1, mode: 'rough', tools });
    const p = await tools.probe(r.outputPath);
    expect(Math.abs(p.durationSec - timelineDuration(e))).toBeLessThanOrEqual(0.1);
    expect([p.width, p.height]).toEqual([960, 540]);
    expect(p.hasAudio).toBe(true);
    expect(r.outputPath.endsWith(join('episodes', '1', 'rough.mp4'))).toBe(true);
    expect((await readdir(join(project, 'episodes', '1'))).filter((f) => f.startsWith('.work-') || f.includes('.partial-'))).toEqual([]);
  }, 300_000);

  it('ends a looping cue with an offset on time: it fades out and is silent after its end', async () => {
    const out = join(project, 'loop-offset.wav');
    const musicDir = join(project, 'music');
    const cue = { track: 'loop.wav', start: 2, end: 22, gainDb: -18, fadeIn: 0.5, fadeOut: 1, offset: 3 };
    await tools.runFfmpeg(['-y', ...musicTrackArgs([cue], await loadLibrary(musicDir), musicDir, 25, -14, out)], { expectedDurationSec: 25 });
    const maxVolume = async (ss: number, t: number) => {
      const { stderr } = await run('ffmpeg', ['-hide_banner', '-ss', String(ss), '-t', String(t), '-i', out, '-af', 'volumedetect', '-f', 'null', '-']);
      const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(stderr);
      return m && m[1] !== '-inf' ? Number(m[1]) : -Infinity;
    };
    expect(await maxVolume(9.5, 1)).toBeGreaterThan(-40);
    expect(await maxVolume(22.2, 2.8)).toBeLessThan(-60);
    expect((await tools.probe(out)).durationSec).toBeCloseTo(25, 1);
  }, 120_000);

  it('stops with NO_EPISODE before rendering when a final cut has a voice-over but no voice-over transcript', async () => {
    await saveEpisode(project, ep([{ id: 'v', beat: 'problem', clip: 'c001', src: { in: 0, out: 1 } }], { number: 2, voiceover: { recording: 'vo.m4a', lines: [] } }));
    await expect(renderEpisode({ project, episode: 2, mode: 'final', tools })).rejects.toMatchObject({ code: 'NO_EPISODE', message: expect.stringContaining('voiceover.transcript.json') });
    expect((await readdir(join(project, 'episodes', '2'))).filter((f) => f.startsWith('.work-') || f.includes('.partial-'))).toEqual([]);
  }, 60_000);
});
