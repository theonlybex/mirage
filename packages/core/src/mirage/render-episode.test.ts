import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type Catalog, type MusicLibrary } from '@wordedits/shared';
import { run, SidecarError, wordsFromWhisperJson } from '@wordedits/sidecars';
import { beforeAll, describe, expect, it } from 'vitest';
import { realMediaTools, type MediaTools } from '../media-tools.js';
import { ingestClips, loadCatalog, sha256File } from './ingest.js';
import { bundledFontsDir, CAPTION_FONT_FILE } from './fonts.js';
import { acquireLock, LOCK_FILE } from './lock.js';
import { analyzeLibrary, loadLibrary } from './music.js';
import { buildAss, groupCaptions, speechWords, toSrt } from './overlays.js';
import { buildVoiceTrack, chunkItems, chunkSize, type ClipSource, commandLength, episodeChunks, MAX_COMMAND, chunkTimeoutMs, episodeFinalArgs, filterValue, itemChunkArgs, loadEpisode, musicTrackArgs, previewSize, renderEpisode, saveEpisode, sourcesFor } from './render-episode.js';
import { layoutTimeline, timelineDuration } from './timeline.js';
import { fitVoiceover, holdAt } from './voiceover.js';

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
/** libass's "Loading font file" line for `file` in `dir`: it joins them with '/', whatever the platform's separator. */
const loadedFont = (dir: string, file: string) => {
  const re = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`Loading font file '${re(dir)}[\\\\/]${re(file)}'`);
};
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
    expect(graph).toContain('[0:v]setpts=(PTS-0.008333/TB)/1,fps=30:start_time=0:round=up,trim=end_frame=61,crop=trunc(iw/1.2/2)*2:trunc(ih/1.2/2)*2,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,tpad=stop=-1:stop_mode=clone,trim=end_frame=60,setpts=PTS-STARTPTS[v0]');
    // Frames are dropped to the output rate before any scaling, so a 20x item scales 1 frame in 20.
    expect(graph).toContain('[1:v]setpts=(PTS-0.008333/TB)/20,fps=30:start_time=0:round=up,trim=end_frame=91,scale=960:540:');
  });
  it('keeps live audio only at real-time speed; sped-up items get silence', () => {
    expect(graph).toContain('[0:a:0]aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end=2,apad,atrim=end=2,asetpts=PTS-STARTPTS[a0]');
    expect(graph).toContain('anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end=3,aformat=sample_fmts=fltp:channel_layouts=stereo[a1]');
    expect(graph).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[vcat][acat]');
    expect(args.at(-1)).toBe('/w/chunk-000.mov');
  });
  it('fills the frame by cropping around the focus point, and punches in around it too', () => {
    const f = ep([{ id: 'f', beat: 'montage', clip: 'c001', src: { in: 0, out: 2 }, frame: 'fill', focus: { x: 0.25, y: 0.5 }, zoom: 1.5 }]);
    const g = itemChunkArgs(layoutTimeline(f), { width: 1080, height: 1920, fps: 30 }, sourcesFor(f, cat), '/w/c.mov');
    expect(g[g.indexOf('-filter_complex') + 1]).toContain(
      'trim=end_frame=61,crop=trunc(iw/1.5/2)*2:trunc(ih/1.5/2)*2:(iw-ow)*0.25:(ih-oh)*0.5,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(iw-ow)*0.25:(ih-oh)*0.5,setsar=1,tpad=',
    );
  });
  it('puts the whole picture over a blurred, darkened copy of itself that fills the frame', () => {
    const b = ep([{ id: 'b', beat: 'montage', clip: 'c001', src: { in: 0, out: 2 }, frame: 'blur' }]);
    const g = itemChunkArgs(layoutTimeline(b), { width: 1080, height: 1920, fps: 30 }, sourcesFor(b, cat), '/w/c.mov');
    expect(g[g.indexOf('-filter_complex') + 1]).toContain(
      'trim=end_frame=61,split[fg0][bg0];[bg0]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,gblur=sigma=12,eq=brightness=-0.08,scale=1080:1920[bb0];' +
        '[fg0]scale=1080:1920:force_original_aspect_ratio=decrease[ff0];[bb0][ff0]overlay=(W-w)/2:(H-h)/2,setsar=1,tpad=',
    );
  });
  it('cuts live audio at the end of the source before padding silence under a hold', () => {
    const h = ep([{ id: 'h', beat: 'problem', clip: 'c001', src: { in: 1, out: 3 }, audio: 'keep', hold: 0.5 }]);
    const g = itemChunkArgs(layoutTimeline(h), { width: 960, height: 540, fps: 30 }, sourcesFor(h, cat), '/w/c.mov');
    expect(g[g.indexOf('-filter_complex') + 1]).toContain('aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end=2,apad,atrim=end=2.5,asetpts=PTS-STARTPTS[a0]');
  });
});

describe('itemChunkArgs with a move', () => {
  const graphOf = (items: object[], o: { width: number; height: number }) => {
    const e = ep(items, { output: { ...o, fps: 30 } });
    const a = itemChunkArgs(layoutTimeline(e), { ...o, fps: 30 }, sourcesFor(e, cat), '/w/c.mov');
    return a[a.indexOf('-filter_complex') + 1];
  };
  const inOut = (d: number) => `st(0,clip((in-1)/${d},0,1));st(0,if(lt(ld(0),0.5),2*ld(0)^2,1-2*(1-ld(0))^2))`;
  /** perspective sending the move's window at each frame to the picture's corners (w, h: the window's size at zoom 1). */
  const persp = (e: string, zoom: string, x: string, y: string, w = 'W', h = 'H') => {
    const left = `${e};st(1,${w}/(${zoom}));(W-ld(1))*(${x})`;
    const top = `${e};st(1,${h}/(${zoom}));(H-ld(1))*(${y})`;
    return `perspective=x0='${left}':y0='${top}':x1='${left}+ld(1)':y1='${top}':x2='${left}':y2='${top}+ld(1)':x3='${left}+ld(1)':y3='${top}+ld(1)':interpolation=cubic:eval=frame`;
  };

  it('holds first (so held frames keep moving), then moves the source picture, then frames it', () => {
    const g = graphOf([{ id: 'm', beat: 'montage', clip: 'c001', src: { in: 0, out: 2 }, hold: 0.5, move: { zoom: 1.2 } }], { width: 1920, height: 1080 });
    expect(g).toContain(
      '[0:v]setpts=(PTS-0.008333/TB)/1,fps=30:start_time=0:round=up,trim=end_frame=61,tpad=stop=-1:stop_mode=clone,trim=end_frame=75,' +
        `${persp(inOut(74), '1*(1.2/1)^ld(0)', '0.5', '0.5')},` +
        'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,setpts=PTS-STARTPTS[v0]',
    );
  });
  it('leaves the other items of the chunk exactly as they were', () => {
    const g = graphOf(
      [
        { id: 'm', beat: 'montage', clip: 'c001', src: { in: 0, out: 2 }, move: { zoom: 1.2 } },
        { id: 'a', beat: 'cold-open', clip: 'c001', src: { in: 1, out: 3 }, audio: 'keep', zoom: 1.2 },
      ],
      { width: 960, height: 540 },
    );
    expect(g).toContain('[1:v]setpts=(PTS-0.008333/TB)/1,fps=30:start_time=0:round=up,trim=end_frame=61,crop=trunc(iw/1.2/2)*2:trunc(ih/1.2/2)*2,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,tpad=stop=-1:stop_mode=clone,trim=end_frame=60,setpts=PTS-STARTPTS[v1]');
  });
  it('moves from the item zoom and focus to the move ones, starting where the move starts', () => {
    const g = graphOf([{ id: 'm', beat: 'montage', clip: 'c001', src: { in: 0, out: 2 }, zoom: 1.5, focus: { x: 0.2, y: 0.5 }, move: { zoom: 1, focus: { x: 0.8 }, ease: 'linear', start: 0.5 } }], { width: 1920, height: 1080 });
    expect(g).toContain(`trim=end_frame=60,${persp('st(0,clip((in-16)/44,0,1))', '1.5*(1/1.5)^ld(0)', '0.2+(0.8-0.2)*ld(0)', '0.5')},scale=1920:1080:`);
  });
  it('moves the picture before blur splits it, so the blurred background follows the move', () => {
    const g = graphOf([{ id: 'b', beat: 'montage', clip: 'c001', src: { in: 0, out: 2 }, frame: 'blur', move: { zoom: 1.2 } }], { width: 1080, height: 1920 });
    expect(g).toContain(`:interpolation=cubic:eval=frame,split[fg0][bg0];[bg0]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,gblur=sigma=12,`);
    expect(g).toContain('[bb0][ff0]overlay=(W-w)/2:(H-h)/2,setsar=1,setpts=PTS-STARTPTS[v0]');
  });
  it("fill: the moving window is cut to the output's shape, so focus pans it, and the picture is only scaled after", () => {
    const g = graphOf([{ id: 'f', beat: 'montage', clip: 'c001', src: { in: 0, out: 2 }, frame: 'fill', focus: { x: 0.25, y: 0.5 }, move: { zoom: 1.2, focus: { x: 0.75 } } }], { width: 1080, height: 1920 });
    expect(g).toContain(`trim=end_frame=60,${persp(inOut(59), '1*(1.2/1)^ld(0)', '0.25+(0.75-0.25)*ld(0)', '0.5', 'min(W,H*1080/1920)', 'min(H,W*1920/1080)')},scale=1080:1920,setsar=1,setpts=PTS-STARTPTS[v0]`);
  });
  it('scales a picture larger than the output needs at the closest zoom down before moving it', () => {
    const fit = graphOf([{ id: 'm', beat: 'montage', clip: 'c001', src: { in: 0, out: 2 }, move: { zoom: 1.2 } }], { width: 960, height: 540 });
    expect(fit).toContain("trim=end_frame=60,scale=w='trunc(iw*min(960/iw,540/ih)*1.2/2)*2':h=-2,perspective=");
    const fill = graphOf([{ id: 'm', beat: 'montage', clip: 'c001', src: { in: 0, out: 2 }, zoom: 1.4, frame: 'fill', move: { zoom: 1.1 } }], { width: 360, height: 640 });
    expect(fill).toContain("trim=end_frame=60,scale=w='trunc(iw*max(360/iw,640/ih)*1.4/2)*2':h=-2,perspective=");
  });
});

describe('previewSize', () => {
  it('keeps the output shape, with its longer side 960 and both sides even', () => {
    expect(previewSize(1920, 1080)).toEqual([960, 540]);
    expect(previewSize(1080, 1920)).toEqual([540, 960]);
    expect(previewSize(1080, 1080)).toEqual([960, 960]);
    expect(previewSize(1080, 1350)).toEqual([768, 960]);
    expect(previewSize(640, 360)).toEqual([640, 360]);
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

describe('episodeChunks', () => {
  const o = { width: 1080, height: 1920, fps: 30 };
  const items = (n: number, move: boolean) =>
    Array.from({ length: n }, (_, i) => ({ id: `i${i}`, beat: 'montage', clip: 'c002', src: { in: i, out: i + 2 }, audio: 'keep', frame: 'fill', focus: { x: 0.3, y: 0.5 }, ...(move ? { move: { zoom: 1.25, focus: { x: 0.6 }, start: 0.5 } } : {}) }));
  const chunks = (n: number, move: boolean) => {
    const e = ep(items(n, move), { output: o });
    const sources = sourcesFor(e, cat);
    return { sources, chunks: episodeChunks(layoutTimeline(e), o, sources, '/w/.work-0123/chunk-000.mov') };
  };
  it('counts a command as Windows writes it: each argument quoted, with a space before it', () => {
    expect(commandLength(['-i', 'a b.mp4'])).toBe(2 + 3 + 7 + 3);
    expect(MAX_COMMAND).toBe(24_000);
  });
  it('cuts a chunk early when its FFmpeg command would pass 24,000 characters', () => {
    const { sources, chunks: c } = chunks(30, true);
    expect(c.length).toBeGreaterThan(1);
    expect(c.flat()).toHaveLength(30);
    for (const chunk of c) {
      const args = itemChunkArgs(chunk, o, sources, '/w/.work-0123/chunk-000.mov');
      expect(commandLength(args)).toBeLessThanOrEqual(24_000);
      // Each chunk is as full as the limit allows: one more item would pass it.
      if (chunk !== c.at(-1)) expect(commandLength(itemChunkArgs([...chunk, c[c.indexOf(chunk) + 1][0]], o, sources, '/w/c.mov'))).toBeGreaterThan(24_000);
    }
  });
  it('keeps the item counts for an episode without moves', () => {
    expect(chunks(65, false).chunks.map((x) => x.length)).toEqual([30, 30, 5]);
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
  it('does not loudnorm a silent speech bus; measures an episode under 3 s over 3.1 s (loudnorm returns NaN on short silence)', () => {
    const graph = (o: object) => { const a = episodeFinalArgs({ chunkList: 'c.txt', output: '/o.mp4', encoder: enc, mode: 'preview', width: 960, height: 540, fps: 30, durationSec: 5, loudnessLufs: -14, assFile: 'o.ass', ...o }); return a[a.indexOf('-filter_complex') + 1]; };
    expect(graph({ liveAudio: false })).toContain('[speechraw]highpass=f=90,aresample=48000');
    expect(graph({ liveAudio: false })).not.toContain('loudnorm');
    expect(graph({ liveAudio: false, voiceRaw: 'vo.f32' })).toContain('loudnorm=I=-14');
    expect(graph({ durationSec: 2.5 })).toContain('[speechraw]highpass=f=90,apad=whole_dur=3.1,loudnorm=I=-14:TP=-1:LRA=11,');
    expect(graph({ durationSec: 2.5 })).toMatch(/asetpts=N\/SR\/TB,atrim=end=2\.5\[aout\]/);
    expect(graph({ durationSec: 2.5, liveAudio: false })).not.toContain('loudnorm');
    expect(graph({})).toContain('[speechraw]highpass=f=90,loudnorm=I=-14');
    expect(graph({})).not.toContain('apad=whole_dur');
  });
  it('clamps the speech loudnorm target', () => {
    const lo = episodeFinalArgs({ chunkList: 'c.txt', output: '/o.mp4', encoder: enc, mode: 'preview', width: 960, height: 540, fps: 30, durationSec: 5, loudnessLufs: -90, assFile: 'o.ass' });
    expect(lo[lo.indexOf('-filter_complex') + 1]).toContain('loudnorm=I=-70:TP=-1');
    const hi = episodeFinalArgs({ chunkList: 'c.txt', output: '/o.mp4', encoder: enc, mode: 'preview', width: 960, height: 540, fps: 30, durationSec: 5, loudnessLufs: 0, assFile: 'o.ass' });
    expect(hi[hi.indexOf('-filter_complex') + 1]).toContain('loudnorm=I=-5:TP=-1');
  });
  it('escapes the fonts folder for the filter graph, and adds none without one', () => {
    const graph = (fontsDir?: string) => { const a = episodeFinalArgs({ chunkList: 'c.txt', output: '/o.mp4', encoder: enc, mode: 'preview', width: 960, height: 540, fps: 30, durationSec: 5, loudnessLufs: -14, assFile: 'overlays.ass', fontsDir }); const g = a[a.indexOf('-filter_complex') + 1]; return g.slice(0, g.indexOf('[vout]') + 6); };
    expect(graph()).toBe('[0:v]ass=overlays.ass[vout]');
    expect(graph('/a b/fonts')).toBe('[0:v]ass=overlays.ass:fontsdir=/a b/fonts[vout]');
    // Option level (\ ' :), then graph level (\ ' [ ] , ;).
    expect(graph("C:\\Mirage's [x], y;")).toBe("[0:v]ass=overlays.ass:fontsdir=C\\\\:\\\\\\\\Mirage\\\\\\'s \\[x\\]\\, y\\;[vout]");
  });

  it('hands libass a fonts folder whose path has spaces, quotes, colons and brackets (real ffmpeg)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'we-fontsdir-'));
    const fonts = join(root, process.platform === 'win32' ? "my fonts 'q' [x], y;" : "my fonts 'q' : \\ [x], y;");
    await mkdir(fonts);
    await copyFile(join(bundledFontsDir(), CAPTION_FONT_FILE), join(fonts, CAPTION_FONT_FILE));
    await writeFile(join(root, 'o.ass'), buildAss({ width: 320, height: 180, captions: [], overlays: [], prompts: [], captionLines: { style: 'pop', lines: [{ start: 0, end: 1, parts: [{ text: 'HI', pop: true }] }] } }));
    const a = episodeFinalArgs({ chunkList: 'c.txt', output: '/o.mp4', encoder: enc, mode: 'preview', width: 320, height: 180, fps: 30, durationSec: 1, loudnessLufs: -14, assFile: 'o.ass', fontsDir: fonts });
    const g = a[a.indexOf('-filter_complex') + 1];
    const chain = g.slice(0, g.indexOf('[vout]') + 6);
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-v', 'verbose', '-f', 'lavfi', '-i', 'color=gray:s=320x180:d=0.5', '-filter_complex', chain, '-map', '[vout]', '-frames:v', '1', '-f', 'null', '-'], { cwd: root });
    expect(stderr).toMatch(loadedFont(fonts, CAPTION_FONT_FILE));
    expect(stderr).toMatch(/fontselect: \(Montserrat ExtraBold, \d+, \d+\) -> Montserrat-ExtraBold\b/);
  }, 60_000);
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

  it('renders an episode of 15 moving items, in chunks short enough for Windows, at the right length', async () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ id: `z${i}`, beat: 'montage', clip: 'c003', src: { in: i, out: i + 0.5 }, frame: 'fill', move: { zoom: 1.2 + (i % 3) * 0.1, focus: { x: (i % 5) / 4 } } }));
    const e = ep(items, { number: 4, output: { width: 1080, height: 1920, fps: 30 } });
    await saveEpisode(project, e);
    const { calls, tools: t } = counting();
    const r = await renderEpisode({ project, episode: 4, mode: 'rough', tools: t });
    const chunkCalls = calls.filter((a) => a.at(-1)!.endsWith('.mov'));
    console.log(`15 moving items: chunk commands of ${chunkCalls.map((a) => commandLength(a)).join(', ')} characters`);
    expect(chunkCalls.length).toBeGreaterThan(1);
    for (const a of chunkCalls) expect(commandLength(a)).toBeLessThanOrEqual(24_000);
    const p = await tools.probe(r.outputPath);
    expect(Math.abs(p.durationSec - timelineDuration(e))).toBeLessThanOrEqual(0.1);
    expect(Math.abs((p.videoDurationSec ?? p.durationSec) - 7.5)).toBeLessThanOrEqual(0.1);
  }, 300_000);

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

  it('brings the speech of an episode under 3 s to the loudness target, and renders one whose kept sound is silent', async () => {
    const gen = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    const dir = await mkdtemp(join(tmpdir(), 'we-hush-'));
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '3', join(dir, 'hush.mp4')]);
    const [hush] = (await ingestClips({ project, clipsDir: dir, tools })).added;
    const lufsOf = async (file: string) => {
      const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128', '-f', 'null', '-']);
      return Number(/I:\s+(-?[\d.]+)\s+LUFS/.exec(stderr.split('Summary:').at(-1)!)![1]);
    };
    // c001's live sound is a steady tone at about -21 LUFS.
    await saveEpisode(project, ep([{ id: 'k', beat: 'problem', clip: 'c001', src: { in: 0, out: 2 }, audio: 'keep' }], { number: 12 }));
    const r = await renderEpisode({ project, episode: 12, mode: 'rough', tools });
    const lufs = await lufsOf(r.outputPath);
    expect(lufs).toBeGreaterThan(-16);
    expect(lufs).toBeLessThan(-12);
    expect(Math.abs((await tools.probe(r.outputPath)).durationSec - 2)).toBeLessThanOrEqual(0.1);

    await saveEpisode(project, ep([{ id: 'h', beat: 'problem', clip: hush.id, src: { in: 0, out: 2 }, audio: 'keep' }], { number: 12 }));
    const silent = await renderEpisode({ project, episode: 12, mode: 'rough', tools });
    expect(Math.abs((await tools.probe(silent.outputPath)).durationSec - 2)).toBeLessThanOrEqual(0.1);
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

  it('refuses before creating any work folder when FFmpeg was built without libass', async () => {
    await saveEpisode(project, ep(one, { number: 13 }));
    const a = counting();
    const noCaptions = { ...a.tools, ffmpegCaptions: async () => ({ ok: false as const, path: '/opt/homebrew/bin/ffmpeg', hint: "Install Homebrew's complete build: brew install ffmpeg-full (Mirage finds it by itself)." }) };
    for (const mode of ['rough', 'final', 'guide'] as const) {
      await expect(renderEpisode({ project, episode: 13, mode, tools: noCaptions })).rejects.toMatchObject({
        name: 'MirageError',
        message: "FFmpeg can't draw captions or text: /opt/homebrew/bin/ffmpeg was built without libass.",
        hint: "Install Homebrew's complete build: brew install ffmpeg-full (Mirage finds it by itself).",
      });
    }
    expect(a.calls).toEqual([]);
    expect((await readdir(join(project, 'episodes', '13'))).filter((f) => f.startsWith('.work-'))).toEqual([]);
    // With captions available the same episode renders.
    const ok = { ...a.tools, ffmpegCaptions: async () => ({ ok: true as const, path: 'ffmpeg' }) };
    await expect(renderEpisode({ project, episode: 13, mode: 'rough', tools: ok })).resolves.toBeDefined();
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

  it('burns pop captions into a vertical video in the bundled font; final.srt keeps phrase cues; no captions setting changes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we speech '));
    await copyFile('fixtures/speech-retake.mp4', join(dir, 'speech-retake.mp4'));
    const words = wordsFromWhisperJson(readFileSync('fixtures/whisper/speech-retake.json', 'latin1'));
    const [clip] = (await ingestClips({ project, clipsDir: dir, tools: { ...tools, transcribe: async () => ({ words, segments: [], speech: [] }) } })).added;
    const items = [{ id: 's', beat: 'problem', clip: clip.id, src: { in: 0, out: 6 }, audio: 'keep' }];
    const output = { width: 1080, height: 1920, fps: 30 };
    const e = ep(items, { number: 15, output, captions: { style: 'pop', position: 'middle', highlight: ['say', 'zebra'] } });
    await saveEpisode(project, e);
    // The last pass (the one with the ass filter) runs at -v verbose, so libass says which font file it picked.
    const logs: string[] = [];
    const graphs: string[] = [];
    const verbose: MediaTools = {
      ...tools,
      runFfmpeg: async (args, opts) => {
        const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
        if (!graph.includes(']ass=')) return tools.runFfmpeg(args, opts);
        graphs.push(graph);
        logs.push((await run('ffmpeg', ['-hide_banner', '-v', 'verbose', '-nostats', '-y', ...args], { cwd: opts?.cwd, timeoutMs: opts?.timeoutMs })).stderr);
      },
    };
    const r = await renderEpisode({ project, episode: 15, mode: 'final', tools: verbose });
    const p = await tools.probe(r.outputPath);
    expect([p.width, p.height]).toEqual([1080, 1920]);
    expect(logs[0]).toMatch(loadedFont(bundledFontsDir(), CAPTION_FONT_FILE));
    expect(logs[0]).toMatch(/fontselect: \(Montserrat ExtraBold, \d+, \d+\) -> Montserrat-ExtraBold\b/);
    expect(graphs[0].startsWith(`[0:v]ass=overlays.ass:fontsdir=${filterValue(bundledFontsDir())}[vout];`)).toBe(true);
    // Only font files in the folder libass reads: it opens no licence or readme as a font.
    expect(logs[0]).not.toContain('Error opening memory font');
    const zebra = 'captions.highlight "zebra" is never said in this video — check the spelling or remove it';
    expect(r.warnings).toEqual([zebra]);
    const said = speechWords(e, await loadCatalog(project), null);
    expect(said.map((x) => x.w)).toContain('say');
    expect(await readFile(r.srtPath!, 'utf8')).toBe(toSrt(groupCaptions(said, { durationSec: 6 })));

    // The rough cut shows them too, at its own size. It has no narration, so it never says a highlight word is not said.
    const rough = await renderEpisode({ project, episode: 15, mode: 'rough', tools: verbose });
    expect(rough.warnings).toEqual([]);
    expect(logs[1]).toMatch(/fontselect: .*Montserrat-ExtraBold/);

    // A highlight with another style: the rough cut (and the render) say it does nothing. Karaoke uses the font too.
    await saveEpisode(project, ep(items, { number: 15, output, captions: { style: 'karaoke', highlight: ['say'] } }));
    const style = 'captions.highlight only works with the "pop" style — it does nothing with "karaoke"';
    expect((await renderEpisode({ project, episode: 15, mode: 'rough', tools: verbose })).warnings).toEqual([style]);
    expect(logs[2]).toMatch(/fontselect: \(Montserrat ExtraBold, \d+, \d+\) -> Montserrat-ExtraBold\b/);

    // Without captions: today's ass= argument, no fontsdir, no warnings.
    await saveEpisode(project, ep(items, { number: 15, output }));
    const plain = await renderEpisode({ project, episode: 15, mode: 'rough', tools: verbose });
    expect(graphs[3].split(';')[0]).toBe('[0:v]ass=overlays.ass[vout]');
    expect(plain.warnings).toEqual([]);
  }, 180_000);

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

  it('a cancelled render leaves no work files, keeps the previous output and releases the lock', async () => {
    const dir = join(project, 'episodes', '13');
    const items = Array.from({ length: 31 }, (_, i) => ({ id: `m${i}`, beat: 'montage', clip: 'c001', src: { in: 0, out: 0.3 } }));
    await saveEpisode(project, ep(items, { number: 13 }));
    await writeFile(join(dir, 'rough.mp4'), 'old');
    const ac = new AbortController();
    let calls = 0;
    const stub = {
      ...tools,
      runFfmpeg: async (_args: string[], o?: { signal?: AbortSignal }) => {
        if (++calls === 1) return;
        setTimeout(() => ac.abort(), 20);
        await new Promise<void>((_, reject) => o!.signal!.addEventListener('abort', () => reject(new SidecarError('ffmpeg', 'CANCELLED', 'ffmpeg was stopped', 'Stopped on request.'))));
      },
    } as MediaTools;
    await expect(renderEpisode({ project, episode: 13, mode: 'rough', tools: stub, signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED', name: 'MirageError' });
    expect(calls).toBe(2);
    expect((await readdir(dir)).sort()).toEqual(['episode.json', 'rough.mp4']);
    expect(await readFile(join(dir, 'rough.mp4'), 'utf8')).toBe('old');
  }, 60_000);

  it('stops between chunks when the signal aborted while a chunk was rendering', async () => {
    const dir = join(project, 'episodes', '14');
    const items = Array.from({ length: 31 }, (_, i) => ({ id: `m${i}`, beat: 'montage', clip: 'c001', src: { in: 0, out: 0.3 } }));
    await saveEpisode(project, ep(items, { number: 14 }));
    const ac = new AbortController();
    let calls = 0;
    // A tool that finishes its chunk even though the signal aborted meanwhile: the render must not start the next one.
    const stub = { ...tools, runFfmpeg: async () => { calls++; ac.abort(); } } as MediaTools;
    await expect(renderEpisode({ project, episode: 14, mode: 'rough', tools: stub, signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(calls).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(['episode.json']);
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

describe('itemChunkArgs with a move (real ffmpeg)', () => {
  let dir: string;
  const sources = new Map<string, ClipSource>();
  const ff = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'we-move-'));
    const make = async (id: string, w: number, h: number, sec: number, lavfi: string, extra: string[] = []) => {
      await ff(['-f', 'lavfi', '-i', lavfi, '-c:v', 'libx264', '-preset', 'veryfast', ...extra, join(dir, `${id}.mp4`)]);
      sources.set(id, { path: join(dir, `${id}.mp4`), hasAudio: false, durationSec: sec, width: w, height: h });
    };
    const box = (x: number, y: number, s: number) => `drawbox=x=${x}:y=${y}:w=${s}:h=${s}:color=white:t=fill`;
    // Black with one small white square right of and above the centre, which a push-in moves out to the top right.
    await make('sq', 1920, 1080, 6, `color=black:s=1920x1080:r=30:d=6,${box(1400, 300, 40)}`, ['-pix_fmt', 'yuv420p']);
    // Grey to its edges: any black there is the move's doing.
    await make('grey', 1920, 1080, 3, `color=gray:s=1920x1080:r=30:d=3,${box(1400, 300, 40)}`, ['-pix_fmt', 'yuv420p']);
    await make('odd', 1081, 607, 2, `color=gray:s=1081x607:r=30:d=2,format=yuv444p,${box(700, 150, 30)}`, ['-pix_fmt', 'yuv444p']);
    await make('long', 640, 360, 40, `color=black:s=640x360:r=30:d=40,${box(480, 60, 20)}`, ['-pix_fmt', 'yuv420p']);
    await make('ts', 1920, 1080, 6, 'testsrc2=size=1920x1080:rate=30:duration=6', ['-pix_fmt', 'yuv420p']);
    // Fine detail everywhere, to see how sharp a zoomed picture stays.
    await make('mb', 1920, 1080, 1, 'mandelbrot=size=1920x1080:rate=30,trim=duration=1', ['-pix_fmt', 'yuv420p', '-crf', '12']);
  }, 300_000);

  /** Renders one item as a chunk; gives its frames as grey pictures and how long FFmpeg took. */
  const render = async (item: object, o: { width: number; height: number }, frames = true) => {
    const e = ep([{ id: 'm', beat: 'montage', ...item }], { output: { ...o, fps: 30 } });
    const out = join(dir, `${randomUUID()}.mov`);
    const t = performance.now();
    await ff(itemChunkArgs(layoutTimeline(e), { ...o, fps: 30 }, sources, out));
    const seconds = (performance.now() - t) / 1000;
    if (!frames) return { seconds, frames: [] as Buffer[] };
    const raw = join(dir, `${randomUUID()}.gray`);
    await ff(['-i', out, '-f', 'rawvideo', '-pix_fmt', 'gray', raw]);
    const buf = await readFile(raw);
    const size = o.width * o.height;
    return { seconds, frames: Array.from({ length: buf.length / size }, (_, i) => buf.subarray(i * size, (i + 1) * size)) };
  };
  /** The centre of the white in a frame (the background is 0; 4 is above the encoder's noise there). */
  const centroid = (f: Buffer, width: number) => {
    let s = 0, sx = 0, sy = 0;
    for (let i = 0; i < f.length; i++) {
      const v = f[i] - 4;
      if (v > 0) { s += v; sx += v * (i % width); sy += v * Math.floor(i / width); }
    }
    return { x: sx / s, y: sy / s };
  };
  /** The darkest pixel on the frame's four edges. */
  const edgeMin = (f: Buffer, width: number, height: number) => {
    let m = 255;
    for (let x = 0; x < width; x++) m = Math.min(m, f[x], f[(height - 1) * width + x]);
    for (let y = 0; y < height; y++) m = Math.min(m, f[y * width], f[y * width + width - 1]);
    return m;
  };
  /** Steps of a point moving right and up (x grows, y shrinks): the largest second difference, and the most backward step. */
  const steadiness = (c: { x: number; y: number }[]) => {
    let second = 0;
    let back = 0;
    for (let i = 1; i < c.length; i++) {
      back = Math.min(back, c[i].x - c[i - 1].x, c[i - 1].y - c[i].y);
      if (i + 1 < c.length) second = Math.max(second, Math.abs(c[i + 1].x - 2 * c[i].x + c[i - 1].x), Math.abs(c[i + 1].y - 2 * c[i].y + c[i - 1].y));
    }
    return { second, back };
  };
  // A still picture's centroid wobbles by about 0.002 px through the encoder; a step back smaller than this is that.
  const NOISE = 0.005;

  it('moves a point by a steady amount each frame on a slow push-in (1 → 1.1 over 6 s)', async () => {
    const { frames } = await render({ clip: 'sq', src: { in: 0, out: 6 }, move: { zoom: 1.1 } }, { width: 1920, height: 1080 });
    expect(frames).toHaveLength(180);
    const c = frames.map((f) => centroid(f, 1920));
    const { second, back } = steadiness(c);
    console.log(`push-in 1 → 1.1 over 6 s: largest second difference ${second.toFixed(3)} px, most backward step ${back.toFixed(4)} px`);
    expect(second).toBeLessThan(0.25);
    expect(back).toBeGreaterThan(-NOISE);
    // From the square's own place (1419.5, 319.5) to 1.1× as far from the centre.
    expect(c[0].x).toBeCloseTo(1419.5, 0);
    expect(c[0].y).toBeCloseTo(319.5, 0);
    expect(Math.abs(c[179].x - (960 + 459.5 * 1.1))).toBeLessThan(0.3);
    expect(Math.abs(c[179].y - (540 - 220.5 * 1.1))).toBeLessThan(0.3);
  }, 120_000);

  it('renders a move in at most 3× the time of the same item at a fixed zoom', async () => {
    const time = async (item: object) => Math.min(...[await render(item, { width: 1920, height: 1080 }, false), await render(item, { width: 1920, height: 1080 }, false)].map((r) => r.seconds));
    const fixed = await time({ clip: 'ts', src: { in: 0, out: 6 }, zoom: 1.1 });
    const moving = await time({ clip: 'ts', src: { in: 0, out: 6 }, move: { zoom: 1.1 } });
    console.log(`1920×1080 6 s: fixed zoom ${fixed.toFixed(2)} s, move ${moving.toFixed(2)} s (${(moving / fixed).toFixed(2)}×)`);
    expect(moving / fixed).toBeLessThanOrEqual(3);
  }, 180_000);

  it('ends a push-in to 1.3 as sharp as a fixed zoom of 1.3', async () => {
    /** The mean absolute difference between neighbouring pixels, across and down: higher is sharper. */
    const gradient = (f: Buffer, width: number, height: number) => {
      let s = 0;
      for (let y = 0; y + 1 < height; y++) for (let x = 0; x + 1 < width; x++) { const i = y * width + x; s += Math.abs(f[i + 1] - f[i]) + Math.abs(f[i + width] - f[i]); }
      return s / ((width - 1) * (height - 1));
    };
    const o = { width: 1920, height: 1080 };
    const fixed = (await render({ clip: 'mb', src: { in: 0, out: 1 }, zoom: 1.3 }, o)).frames;
    const moving = (await render({ clip: 'mb', src: { in: 0, out: 1 }, move: { zoom: 1.3 } }, o)).frames;
    expect(moving).toHaveLength(30);
    const [g0, g1] = [gradient(fixed[29], 1920, 1080), gradient(moving[29], 1920, 1080)];
    console.log(`last frame at 1.3×: fixed zoom ${g0.toFixed(3)}, move ${g1.toFixed(3)} (${((g1 / g0 - 1) * 100).toFixed(1)}%)`);
    expect(Math.abs(g1 / g0 - 1)).toBeLessThanOrEqual(0.05);
  }, 120_000);

  it('moves smoothly on a sped-up item (20×)', async () => {
    const { frames } = await render({ clip: 'long', src: { in: 0, out: 40 }, speed: 20, move: { zoom: 1.2 } }, { width: 640, height: 360 });
    expect(frames).toHaveLength(60);
    const c = frames.map((f) => centroid(f, 640));
    expect(steadiness(c).back).toBeGreaterThan(-NOISE);
    expect(Math.abs(c[59].x - (320 + 169.5 * 1.2))).toBeLessThan(0.3);
  }, 120_000);

  it('keeps moving through a held second', async () => {
    const { frames } = await render({ clip: 'sq', src: { in: 0, out: 2 }, hold: 1, move: { zoom: 1.1 } }, { width: 1920, height: 1080 });
    expect(frames).toHaveLength(90);
    const c = frames.map((f) => centroid(f, 1920));
    const held = c.slice(60);
    expect(steadiness(held).back).toBeGreaterThan(-NOISE);
    expect(held[29].x - held[0].x).toBeGreaterThan(5);
    expect(steadiness(c).second).toBeLessThan(0.25);
  }, 120_000);

  it('leaves no black at the edges of a vertical blur or fill output', async () => {
    for (const frame of ['blur', 'fill']) {
      const { frames } = await render({ clip: 'grey', src: { in: 0, out: 2 }, frame, focus: { x: 0.2, y: 0.5 }, move: { zoom: 1.3, focus: { x: 0.9, y: 0.1 } } }, { width: 1080, height: 1920 });
      expect(frames).toHaveLength(60);
      expect(Math.min(...frames.map((f) => edgeMin(f, 1080, 1920)))).toBeGreaterThan(40);
    }
  }, 180_000);

  it('pushes in from the full picture and pulls out to it without a black line at the edge', async () => {
    for (const item of [{ move: { zoom: 1.3 } }, { zoom: 1.3, move: { zoom: 1 } }, { zoom: 1.3, focus: { x: 1, y: 1 }, move: { zoom: 1, focus: { x: 0, y: 0 } } }]) {
      const { frames } = await render({ clip: 'grey', src: { in: 0, out: 1 }, ...item }, { width: 960, height: 540 });
      expect(frames).toHaveLength(30);
      expect(Math.min(...frames.map((f) => edgeMin(f, 960, 540)))).toBeGreaterThan(40);
    }
  }, 180_000);

  it('moves a picture of odd size (1081 × 607)', async () => {
    for (const frame of ['fit', 'fill']) {
      const { frames } = await render({ clip: 'odd', src: { in: 0, out: 2 }, frame, focus: { x: 0.7, y: 0.3 }, move: { zoom: 1.37, focus: { x: 0.1 } } }, { width: 1080, height: 1920 });
      expect(frames).toHaveLength(60);
    }
  }, 120_000);

  it('plays a move on across a voice-over split: no jump back at the seam, moving through the frozen frames', async () => {
    const o = { width: 1920, height: 1080, fps: 30 };
    // 2 s pushing in, split at 1 s and frozen for 0.5 s: 30 frames, 15 frozen, 30.
    const e = holdAt(ep([{ id: 'm', beat: 'montage', clip: 'sq', src: { in: 0, out: 2 }, move: { zoom: 1.1 } }], { output: o }), { version: 1, clips: [] }, 1, 0.5);
    expect(e.items.map((i) => i.id)).toEqual(['m', 'm-b']);
    const out = join(dir, `${randomUUID()}.mov`);
    await ff(itemChunkArgs(layoutTimeline(e), o, sources, out));
    const raw = join(dir, `${randomUUID()}.gray`);
    await ff(['-i', out, '-f', 'rawvideo', '-pix_fmt', 'gray', raw]);
    const buf = await readFile(raw);
    const frames = Array.from({ length: buf.length / (1920 * 1080) }, (_, i) => buf.subarray(i * 1920 * 1080, (i + 1) * 1920 * 1080));
    expect(frames).toHaveLength(75);
    const c = frames.map((f) => centroid(f, 1920));
    const { second, back } = steadiness(c);
    const seam = [c[44].x - c[43].x, c[45].x - c[44].x, c[46].x - c[45].x];
    console.log(`split push-in: steps at the seam ${seam.map((d) => d.toFixed(3)).join(', ')} px, largest second difference ${second.toFixed(3)} px`);
    // The square keeps moving out on every frame, the frozen ones too, and never jumps back to where it started.
    expect(back).toBeGreaterThan(-NOISE);
    expect(second).toBeLessThan(0.25);
    expect(c[44].x - c[30].x).toBeGreaterThan(5);
    expect(Math.abs(c[0].x - 1419.5)).toBeLessThan(0.3);
    expect(Math.abs(c[74].x - (960 + 459.5 * 1.1))).toBeLessThan(0.3);
  }, 120_000);

  it('punches in over 3 frames: start, between, end', async () => {
    const { frames } = await render({ clip: 'sq', src: { in: 0, out: 1 }, move: { zoom: 1.5, start: 0.5, end: 0.6 } }, { width: 1920, height: 1080 });
    expect(frames).toHaveLength(30);
    const c = frames.map((f) => centroid(f, 1920));
    for (const p of c.slice(0, 16)) expect(Math.abs(p.x - 1419.5)).toBeLessThan(0.3);
    for (const p of c.slice(17)) expect(Math.abs(p.x - (960 + 459.5 * 1.5))).toBeLessThan(0.3);
    expect(c[16].x).toBeGreaterThan(1425);
    expect(c[16].x).toBeLessThan(1640);
  }, 120_000);
});
