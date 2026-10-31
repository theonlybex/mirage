import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type Catalog, type MusicLibrary } from '@wordedits/shared';
import { run } from '@wordedits/sidecars';
import { beforeAll, describe, expect, it } from 'vitest';
import { realMediaTools, type MediaTools } from '../media-tools.js';
import { ingestClips, loadCatalog, sha256File } from './ingest.js';
import { acquireLock, LOCK_FILE } from './lock.js';
import { analyzeLibrary, loadLibrary } from './music.js';
import { buildVoiceTrack, chunkItems, chunkSize, chunkTimeoutMs, episodeFinalArgs, itemChunkArgs, loadEpisode, musicTrackArgs, renderEpisode, saveEpisode, sourcesFor } from './render-episode.js';
import { layoutTimeline, timelineDuration } from './timeline.js';
import { fitVoiceover } from './voiceover.js';

const enc = { name: 'libx264' as const, extraArgs: [] };
// Clip files must exist: sourcesFor refuses a catalogued clip whose file is gone.
const CLIPS = mkdtempSync(join(tmpdir(), 'we-unit-clips-'));
for (const id of ['c001', 'c002']) writeFileSync(join(CLIPS, `${id}.mp4`), '');
const clipOf = (id: string, dur: number, hasAudio: boolean) => ({
  id, path: join(CLIPS, `${id}.mp4`), sha256: 'a'.repeat(64),
  probe: { durationSec: dur, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio, videoCodec: 'h264', audioCodec: hasAudio ? 'aac' : null, colorTransfer: null },
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
  it('stops with BAD_ITEM for a range past the end of the video, even when the audio runs on', () => {
    const short: Catalog = { version: 1, clips: [{ ...clipOf('c001', 10, true), probe: { ...clipOf('c001', 10, true).probe, videoDurationSec: 3 } }] };
    expect(() => sourcesFor(ep([{ id: 'v', beat: 'problem', clip: 'c001', src: { in: 2, out: 5 } }]), short)).toThrow(
      expect.objectContaining({ code: 'BAD_ITEM', message: 'item v: c001 has video only until 3.0 s (src.out is 5 s)', hint: 'End the item by 3.0 s; the rest of c001 is sound only.' }),
    );
    expect(sourcesFor(ep([{ id: 'v', beat: 'problem', clip: 'c001', src: { in: 0, out: 3 } }]), short).size).toBe(1);
    // A catalog written before the video duration was recorded: the clip duration still applies.
    expect(sourcesFor(ep([{ id: 'v', beat: 'problem', clip: 'c001', src: { in: 0, out: 10 } }]), cat).size).toBe(1);
  });
  it('stops with BAD_ITEM when the clip file is gone', () => {
    const gone: Catalog = { version: 1, clips: [{ ...clipOf('c001', 10, true), path: join(CLIPS, 'moved.mp4') }] };
    expect(() => sourcesFor(ep([{ id: 'z', beat: 'problem', clip: 'c001', src: { in: 0, out: 1 } }]), gone)).toThrow(
      expect.objectContaining({ code: 'BAD_ITEM', message: `item z: clip file ${join(CLIPS, 'moved.mp4')} is missing`, hint: 'Reconnect the drive or re-ingest the folder it moved to' }),
    );
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
    expect(args.slice(0, 7)).toEqual(['-threads', '1', '-noaccurate_seek', '-ss', '1', '-i', join(CLIPS, 'c001.mp4')]);
    // Sped-up items decode with more threads: they read far more source than they output.
    expect(args.slice(7, 14)).toEqual(['-threads', '4', '-noaccurate_seek', '-ss', '0', '-i', join(CLIPS, 'c002.mp4')]);
  });
  it('speeds up, punches in, letterboxes and cuts to exact frames', () => {
    expect(graph).toContain('[0:v]setpts=PTS/1,fps=30:start_time=0:round=up,trim=end_frame=61,crop=trunc(iw/1.2/2)*2:trunc(ih/1.2/2)*2,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,tpad=stop=-1:stop_mode=clone,trim=end_frame=60,setpts=PTS-STARTPTS[v0]');
    // Frames are dropped to the output rate before any scaling, so a 20x item scales 1 frame in 20.
    expect(graph).toContain('[1:v]setpts=PTS/20,fps=30:start_time=0:round=up,trim=end_frame=91,scale=960:540:');
  });
  it('keeps live audio only at real-time speed; sped-up items get silence', () => {
    expect(graph).toContain('[0:a:0]aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end=2,apad,atrim=end=2,asetpts=PTS-STARTPTS[a0]');
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

describe('chunkSize', () => {
  it('puts fewer items in a chunk when a source is larger than 1080p', () => {
    const src = (width: number, height: number) => ({ path: '/x', hasAudio: false, durationSec: 1, width, height });
    expect(chunkSize(new Map([['a', src(1920, 1080)], ['b', src(1080, 1920)]]))).toBe(30);
    expect(chunkSize(new Map([['a', src(1920, 1080)], ['b', src(3840, 2160)]]))).toBe(12);
    expect(chunkItems(layoutTimeline(ep(Array.from({ length: 25 }, (_, i) => ({ id: `i${i}`, beat: 'montage', clip: 'c001', src: { in: 0, out: 1 } })))), 12).map((c) => c.length)).toEqual([12, 12, 1]);
  });
});

describe('chunkTimeoutMs', () => {
  it('scales with the source seconds read and the output seconds written, at least 2 minutes', () => {
    const e = ep([
      { id: 'a', beat: 'montage', clip: 'c002', src: { in: 0, out: 400 }, speed: 100 },
      { id: 'b', beat: 'montage', clip: 'c001', src: { in: 0, out: 2 } },
    ]);
    // 402 s of source × 3 s + 6 s of output × 30 s
    expect(chunkTimeoutMs(layoutTimeline(e), 30)).toBe((402 * 3 + 6 * 30) * 1000);
    expect(chunkTimeoutMs(layoutTimeline(ep([{ id: 'c', beat: 'montage', clip: 'c001', src: { in: 0, out: 1 } }])), 30)).toBe(120_000);
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
  it('measures a cue shorter than 3 s over 3.1 s of its looping track, then cuts it to length', () => {
    const args = musicTrackArgs([{ track: 'a.mp3', start: 0, end: 1, gainDb: -5, fadeIn: 0, fadeOut: 0, offset: 0 }], lib, '/m', 2, -14, '/w/m.wav');
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('[0:a]asetpts=N/SR/TB,atrim=duration=3.1,');
    expect(graph).toMatch(/loudnorm=I=-19:TP=-2:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=1,adelay/);
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

describe('buildVoiceTrack with several recordings', () => {
  it('takes each line from its own recording', () => {
    const recordings = new Map([['vo.m4a', new Float32Array(100).fill(0.5)], ['n2.m4a', new Float32Array(100).fill(-0.25)]]);
    const out = buildVoiceTrack({
      recording: recordings, defaultRecording: 'vo.m4a', sampleRate: 10, durationSec: 8,
      lines: [{ slot: 'n1', at: 0, src: { in: 0, out: 2 }, cuts: [] }, { slot: 'n2', at: 4, src: { in: 0, out: 2 }, cuts: [], recording: 'n2.m4a' }],
    });
    expect(out[10]).toBeCloseTo(0.5);
    expect(out[50]).toBeCloseTo(-0.25);
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
    expect(graph).toContain('[mus][skey]sidechaincompress=threshold=0.025:ratio=12:attack=150:release=900[duck]');
    expect(args).toEqual(expect.arrayContaining(['-b:v', '8M', '-t', '20']));
    expect(args.at(-1)).toBe('/o/final.mp4.partial');
  });
  it('has no music or voice inputs when there are none', () => {
    const args = episodeFinalArgs({ chunkList: 'chunks.txt', output: '/o.mp4', encoder: enc, mode: 'preview', width: 960, height: 540, fps: 30, durationSec: 5, loudnessLufs: -14, assFile: 'overlays.ass' });
    expect(args.filter((a) => a === '-i')).toHaveLength(1);
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('[0:a]anull[speechraw]');
  });
  it('does not loudnorm a silent speech bus or an episode under 3 s (loudnorm returns NaN on short silence)', () => {
    const graph = (o: object) => { const a = episodeFinalArgs({ chunkList: 'c.txt', output: '/o.mp4', encoder: enc, mode: 'preview', width: 960, height: 540, fps: 30, durationSec: 5, loudnessLufs: -14, assFile: 'o.ass', ...o }); return a[a.indexOf('-filter_complex') + 1]; };
    expect(graph({ liveAudio: false })).toContain('[speechraw]highpass=f=90,aresample=48000');
    expect(graph({ liveAudio: false, voiceRaw: 'vo.f32' })).toContain('loudnorm=I=-14');
    expect(graph({ durationSec: 2.5 })).not.toContain('loudnorm');
    expect(graph({})).toContain('loudnorm=I=-14');
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

  it('plays music on its own around -19 LUFS and ducks it at least 12 dB under live speech', async () => {
    // Music is high (2.5/3.3 kHz) and the live "speech" is a 300 Hz tone, so a high-pass isolates the music under speech.
    // Speech comes first so the speech bus's single-pass loudnorm is already at -14 LUFS while it keys the ducking.
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "aevalsrc='0.25*sin(2*PI*2500*t)+0.25*sin(2*PI*3300*t)':s=44100:d=8", join(project, 'music', 'pad.wav')]);
    await analyzeLibrary(join(project, 'music'), tools);
    const e = ep(
      [
        { id: 'talk', beat: 'problem', clip: 'c001', src: { in: 0, out: 5 }, audio: 'keep' },
        { id: 'quiet', beat: 'problem', clip: 'c002', src: { in: 0, out: 4 } },
      ],
      { number: 3, music: [{ track: 'pad.wav', start: 0, end: 9, fadeIn: 0, fadeOut: 0 }] },
    );
    expect(e.music[0].gainDb).toBe(-5);
    await saveEpisode(project, e);
    const r = await renderEpisode({ project, episode: 3, mode: 'rough', tools });
    const segment = async (ss: number, t: number, af: string) =>
      (await run('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(ss), '-t', String(t), '-i', r.outputPath, '-map', '0:a:0', '-af', af, '-f', 'null', '-'])).stderr;
    const lufs = Number(/I:\s+(-?[\d.]+)\s+LUFS/.exec((await segment(6.5, 2.5, 'ebur128')).split('Summary:').at(-1)!)![1]);
    const HIGH = 'highpass=f=1500:poles=2,highpass=f=1500:poles=2,highpass=f=1500:poles=2,astats=metadata=0';
    const rms = async (ss: number, t: number) => Number(/Overall[\s\S]*?RMS level dB:\s+(-?[\d.]+)/.exec(await segment(ss, t, HIGH))![1]);
    const under = await rms(1, 3.5);
    const alone = await rms(6.5, 2.5);
    console.log(`music alone ${lufs} LUFS (high band ${alone} dB), under speech ${under} dB: ducked ${(alone - under).toFixed(1)} dB`);
    expect(lufs).toBeGreaterThanOrEqual(-22);
    expect(lufs).toBeLessThanOrEqual(-16);
    expect(alone - under).toBeGreaterThanOrEqual(12);
  }, 120_000);

  const counting = () => {
    const calls: string[][] = [];
    return { calls, tools: { ...tools, runFfmpeg: async (args: string[], opts?: object) => { calls.push(args); return tools.runFfmpeg(args, opts); } } };
  };
  const one = [{ id: 'v', beat: 'problem', clip: 'c001', src: { in: 0, out: 1 } }];

  it('fails instead of finishing when the rendered picture is shorter than the timeline', async () => {
    await saveEpisode(project, ep([{ id: 'v', beat: 'problem', clip: 'c001', src: { in: 0, out: 1 }, audio: 'keep' }], { number: 9 }));
    const shortPicture: MediaTools = { ...tools, probe: async (f) => {
      const p = await tools.probe(f);
      return f.includes('.partial-') ? { ...p, videoDurationSec: 0.5 } : p;
    } };
    await expect(renderEpisode({ project, episode: 9, mode: 'rough', tools: shortPicture })).rejects.toMatchObject({ code: 'DURATION_MISMATCH', message: 'Rendered 0.5s of picture but the timeline is 1s' });
    expect(existsSync(join(project, 'episodes', '9', 'rough.mp4'))).toBe(false);
  }, 60_000);

  it('renders episodes under 3 s with no live sound, with silent live sound, and with a 1 s music cue', async () => {
    const gen = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    await gen(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '6', join(project, 'music', 'hush.wav')]);
    await analyzeLibrary(join(project, 'music'), tools);
    const cases: [object[], object][] = [
      [[{ id: 'p', beat: 'problem', clip: 'c002', src: { in: 0, out: 2.5 } }], {}],
      [[{ id: 'k', beat: 'problem', clip: 'c001', src: { in: 0, out: 2 }, audio: 'keep' }], { music: [{ track: 'hush.wav', start: 0, end: 1 }] }],
      [[{ id: 'm', beat: 'problem', clip: 'c003', src: { in: 0, out: 2 } }], { music: [{ track: 'loop.wav', start: 0.5, end: 1.5 }] }],
    ];
    for (const [items, extra] of cases) {
      await saveEpisode(project, ep(items, { number: 10, ...extra }));
      for (const mode of ['rough', 'guide'] as const) {
        const r = await renderEpisode({ project, episode: 10, mode, tools });
        expect(Math.abs((await tools.probe(r.outputPath)).durationSec - r.durationSec)).toBeLessThanOrEqual(0.1);
      }
    }
  }, 120_000);

  it('stops before rendering anything when a music cue is not in the library or its file is gone', async () => {
    await saveEpisode(project, ep(one, { number: 4, music: [{ track: 'nope.wav', start: 0, end: 1 }] }));
    const a = counting();
    await expect(renderEpisode({ project, episode: 4, mode: 'rough', tools: a.tools })).rejects.toMatchObject({ code: 'NO_MUSIC_TRACK', message: expect.stringContaining('nope.wav is not in music/library.json') });
    expect(a.calls).toEqual([]);

    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=2', join(project, 'music', 'gone.wav')]);
    await analyzeLibrary(join(project, 'music'), tools);
    await rm(join(project, 'music', 'gone.wav'));
    await saveEpisode(project, ep(one, { number: 4, music: [{ track: 'gone.wav', start: 0, end: 1 }] }));
    const b = counting();
    await expect(renderEpisode({ project, episode: 4, mode: 'rough', tools: b.tools })).rejects.toMatchObject({ code: 'NO_MUSIC_TRACK', message: 'music cue 1: gone.wav is missing from music/' });
    expect(b.calls).toEqual([]);
  }, 60_000);

  it('stops before rendering a final cut whose voice-over recording is gone', async () => {
    await saveEpisode(project, ep(one, { number: 5, voiceover: { recording: 'gone.m4a', lines: [] } }));
    await writeFile(join(project, 'episodes', '5', 'voiceover.transcript.json'), JSON.stringify({ words: [], segments: [], speech: [] }));
    const a = counting();
    await expect(renderEpisode({ project, episode: 5, mode: 'final', tools: a.tools })).rejects.toMatchObject({ code: 'BAD_ITEM', message: `voice-over recording ${join(project, 'gone.m4a')} is missing` });
    expect(a.calls).toEqual([]);
  }, 60_000);

  it('stops before rendering a final cut whose recording was overwritten since vo fitted it', async () => {
    await writeFile(join(project, 'take.m4a'), 'the take that was fitted');
    const sha = await sha256File(join(project, 'take.m4a'));
    const vo = { recording: 'take.m4a', transcripts: { 'take.m4a': 't.json' }, recordingSha256: { 'take.m4a': sha }, lines: [{ slot: 'n1', at: 0, src: { in: 0, out: 0.5 } }] };
    await saveEpisode(project, ep(one, { number: 11, voiceover: vo }));
    await mkdir(join(project, 'episodes', '11'), { recursive: true });
    await writeFile(join(project, 'episodes', '11', 't.json'), JSON.stringify({ words: [], segments: [], speech: [] }));
    await writeFile(join(project, 'take.m4a'), 'another take saved over it');
    const a = counting();
    await expect(renderEpisode({ project, episode: 11, mode: 'final', tools: a.tools })).rejects.toMatchObject({
      code: 'BAD_ITEM',
      message: `voice-over recording ${join(project, 'take.m4a')} changed since vo fitted it`,
    });
    expect(a.calls).toEqual([]);
    // An episode from before recordingSha256 is checked against its transcript's name.
    const older = { recording: 'take.m4a', transcripts: { 'take.m4a': `voiceover.${sha.slice(0, 16)}.transcript.json` }, lines: vo.lines };
    await saveEpisode(project, ep(one, { number: 11, voiceover: older }));
    await writeFile(join(project, 'episodes', '11', older.transcripts['take.m4a']), JSON.stringify({ words: [], segments: [], speech: [] }));
    await expect(renderEpisode({ project, episode: 11, mode: 'final', tools: a.tools })).rejects.toMatchObject({ message: expect.stringContaining('changed since vo fitted it') });
    expect(a.calls).toEqual([]);
  }, 60_000);

  it('refuses a final render when the cut changed after the voice-over was fitted', async () => {
    const words = 'This is the line.'.split(' ').map((w, i) => ({ w, start: i * 0.3, end: i * 0.3 + 0.25, conf: 1 }));
    const base = ep([{ id: 'v', beat: 'problem', clip: 'c001', src: { in: 0, out: 5 } }], { number: 7, slots: [{ id: 'n1', start: 0.5, end: 4, maxWords: 8, line: 'This is the line.' }] });
    const fitted = fitVoiceover({ episode: base, catalog: await loadCatalog(project), recording: 'vo.wav', transcript: { words, segments: [], speech: [] } }).episode;
    await saveEpisode(project, { ...fitted, items: [{ ...fitted.items[0], src: { in: 0, out: 4.5 } }] });
    const a = counting();
    await expect(renderEpisode({ project, episode: 7, mode: 'final', tools: a.tools })).rejects.toMatchObject({
      code: 'BAD_ITEM',
      message: 'The cut changed after the voice-over was fitted',
      hint: 'Run: pnpm mirage slots <project> <n>, then pnpm mirage vo <project> <n> <recording> (it reuses the saved transcript)',
    });
    expect(a.calls).toEqual([]);
  }, 60_000);

  it('renders a final cut whose lines come from two recordings, with written-line captions', async () => {
    const gen = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    await gen(['-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000:duration=3', join(project, 'take1.wav')]);
    await gen(['-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000:duration=3', join(project, 'take2.wav')]);
    const dir = join(project, 'episodes', '8');
    await mkdir(dir, { recursive: true });
    const said = (text: string) => ({ words: text.split(' ').map((w, i) => ({ w, start: 0.2 + i * 0.4, end: 0.5 + i * 0.4, conf: 1 })), segments: [], speech: [] });
    await writeFile(join(dir, 't1.json'), JSON.stringify(said('First line here.')));
    await writeFile(join(dir, 't2.json'), JSON.stringify(said('Second 2 here.')));
    const e = ep([{ id: 'v', beat: 'problem', clip: 'c003', src: { in: 0, out: 6 } }], {
      number: 8,
      // n2's line was edited after the fit: the render plays and captions what was fitted, and says so.
      slots: [{ id: 'n1', start: 0, end: 3, maxWords: 8, line: 'First line here.' }, { id: 'n2', start: 3, end: 6, maxWords: 8, line: 'Second line, edited.' }],
      voiceover: {
        recording: 'take1.wav', transcripts: { 'take1.wav': 't1.json', 'take2.wav': 't2.json' },
        lines: [
          { slot: 'n1', at: 0.2, src: { in: 0, out: 1.6 }, text: 'First line here.' },
          { slot: 'n2', at: 3.2, src: { in: 0, out: 1.6 }, recording: 'take2.wav', text: 'Second two here.' },
        ],
      },
    });
    await saveEpisode(project, e);
    const r = await renderEpisode({ project, episode: 8, mode: 'final', tools });
    expect(Math.abs((await tools.probe(r.outputPath)).durationSec - 6)).toBeLessThanOrEqual(0.1);
    const srt = await readFile(r.srtPath!, 'utf8');
    expect(srt).toContain('First line here.');
    expect(srt).toContain('Second two here.');
    expect(r.warnings).toEqual(['n2\'s line changed since vo — it plays and is captioned as fitted ("Second two here."); re-record it with vo --add --slots n2']);
    const peakHz = async (ss: number, f: number) => {
      const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(ss), '-t', '1', '-i', r.outputPath, '-map', '0:a:0', '-af', `bandpass=f=${f}:width_type=q:w=8,astats=metadata=0`, '-f', 'null', '-']);
      return Number(/Overall[\s\S]*?RMS level dB:\s+(-?[\d.]+)/.exec(stderr)![1]);
    };
    expect(await peakHz(0.5, 500)).toBeGreaterThan((await peakHz(0.5, 700)) + 10);
    expect(await peakHz(3.5, 700)).toBeGreaterThan((await peakHz(3.5, 500)) + 10);
  }, 120_000);

  it('clears work folders, partial files and temp files left by a command that was killed, taking over its lock', async () => {
    const dir = join(project, 'episodes', '6');
    await saveEpisode(project, ep(one, { number: 6, music: [{ track: 'nope.wav', start: 0, end: 1 }] }));
    await mkdir(join(dir, '.work-dead'), { recursive: true });
    await writeFile(join(dir, '.work-dead', 'chunk-000.mov'), 'x');
    await writeFile(join(dir, 'rough.mp4.partial-dead.mp4'), 'x');
    await writeFile(join(dir, '.vo-0f8fad5b-d9cb-469f-a165-70867728950e.wav'), 'x');
    const tmp = (name: string) => `${name}.tmp-0f8fad5b-d9cb-469f-a165-70867728950e`;
    await writeFile(join(dir, tmp('old.transcript.json')), 'x');
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(join(dir, tmp('old.transcript.json')), old, old);
    // A check saving right now (it takes no lock) must not lose its temp file.
    await writeFile(join(dir, tmp('episode.json')), 'x');
    await writeFile(join(dir, LOCK_FILE), JSON.stringify({ pid: 4_194_305, command: 'render', startedAt: new Date().toISOString(), token: 'dead' }));
    await expect(renderEpisode({ project, episode: 6, mode: 'rough', tools })).rejects.toMatchObject({ code: 'NO_MUSIC_TRACK' });
    expect((await readdir(dir)).sort()).toEqual(['episode.json', tmp('episode.json')]);
  }, 60_000);

  it("refuses to render an episode another live render is working on, and leaves that render's work alone", async () => {
    const dir = join(project, 'episodes', '7');
    await saveEpisode(project, ep(one, { number: 7 }));
    await mkdir(join(dir, '.work-live'), { recursive: true });
    await writeFile(join(dir, 'final.mp4.partial-live.mp4'), 'x');
    const lock = await acquireLock(dir, 'render', 'episode 7');
    try {
      await expect(renderEpisode({ project, episode: 7, mode: 'rough', tools })).rejects.toMatchObject({ code: 'BUSY', message: expect.stringMatching(/^episode 7 is busy: render \(pid \d+\)/) });
      expect((await readdir(dir)).sort()).toEqual(['.mirage.lock', '.work-live', 'episode.json', 'final.mp4.partial-live.mp4']);
    } finally {
      await lock.release();
    }
  }, 60_000);

  it('stops with NO_EPISODE before rendering when a final cut has a voice-over but no voice-over transcript', async () => {
    await saveEpisode(project, ep([{ id: 'v', beat: 'problem', clip: 'c001', src: { in: 0, out: 1 } }], { number: 2, voiceover: { recording: 'vo.m4a', lines: [] } }));
    await expect(renderEpisode({ project, episode: 2, mode: 'final', tools })).rejects.toMatchObject({ code: 'NO_EPISODE', message: expect.stringContaining('voiceover.transcript.json') });
    expect((await readdir(join(project, 'episodes', '2'))).filter((f) => f.startsWith('.work-') || f.includes('.partial-'))).toEqual([]);
  }, 60_000);
});

describe('loadEpisode errors', () => {
  it('names episode.json, the item and the field when an item is invalid', async () => {
    const project = await mkdtemp(join(tmpdir(), 'we-bad-ep-'));
    await mkdir(join(project, 'episodes', '1'), { recursive: true });
    const items = [0, 1, 2, 3].map((i) => ({ id: `i${i + 1}`, beat: 'problem', clip: 'c001', src: { in: i === 3 ? 2 : 0, out: 1 } }));
    await writeFile(join(project, 'episodes', '1', 'episode.json'), JSON.stringify({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items }));
    await expect(loadEpisode(project, 1)).rejects.toMatchObject({
      message: 'episodes/1/episode.json: items[3].src: item i4: src.out must be greater than src.in',
      hint: 'Fix that field and run the command again.',
    });
  });

  it('refuses an episode.json whose number is not its folder, so saving never overwrites another episode', async () => {
    const project = await mkdtemp(join(tmpdir(), 'we-copied-ep-'));
    await saveEpisode(project, ep([{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 1 } }]));
    await mkdir(join(project, 'episodes', '3'), { recursive: true });
    await writeFile(join(project, 'episodes', '3', 'episode.json'), await readFile(join(project, 'episodes', '1', 'episode.json'), 'utf8'));
    await expect(loadEpisode(project, 3)).rejects.toMatchObject({ code: 'NO_EPISODE', message: 'episodes/3/episode.json says it is episode 1', hint: 'Set "number" to 3 in episodes/3/episode.json.' });
    await expect(saveEpisode(project, ep([{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 1 } }]), 3)).rejects.toMatchObject({ code: 'NO_EPISODE' });
  });
});
