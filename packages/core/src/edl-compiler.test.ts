import { EdlSchema } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { bitrateFor, buildFilterGraph, compileEdl, edlDuration, edlSegments, resolveFps, sceneSegments } from './edl-compiler.js';

const oneOffScenes = EdlSchema.parse({
  version: 1,
  output: { width: 1920, height: 1080, fps: 30 },
  scenes: [
    { id: 'A', src: { in: 3.0, out: 5.5 } },
    { id: 'B', src: { in: 0.5, out: 2.5 } },
  ],
});

const twoScenes = EdlSchema.parse({
  version: 1,
  output: { width: 1920, height: 1080, fps: 30 },
  scenes: [
    { id: 's1', src: { in: 0.5, out: 2.5 }, cuts: [[1.0, 1.4]] },
    { id: 's2', src: { in: 3.0, out: 5.5 }, zoom: { scale: 1.2, anchor: { x: 0.5, y: 0.4 } } },
  ],
});
const enc = { name: 'libx264' as const, extraArgs: ['-preset', 'medium'] };

describe('sceneSegments', () => {
  it('splits a scene around its cuts', () => {
    expect(sceneSegments(twoScenes.scenes[0])).toEqual([
      { start: 0.5, end: 1.0 },
      { start: 1.4, end: 2.5 },
    ]);
  });

  it('returns the whole scene when there are no cuts', () => {
    expect(sceneSegments(twoScenes.scenes[1])).toEqual([{ start: 3.0, end: 5.5 }]);
  });

  it('merges overlapping cuts and ignores zero-length leftovers', () => {
    const s = { ...twoScenes.scenes[0], cuts: [[0.5, 1.0], [0.9, 1.5]] as [number, number][] };
    expect(sceneSegments(s)).toEqual([{ start: 1.5, end: 2.5 }]);
  });

  it('throws EMPTY_SCENE when cuts remove everything', () => {
    const s = { ...twoScenes.scenes[0], cuts: [[0.5, 2.5]] as [number, number][] };
    expect(() => sceneSegments(s)).toThrow(expect.objectContaining({ code: 'EMPTY_SCENE', sceneId: 's1' }));
  });
});

describe('edlDuration', () => {
  it('sums kept segments as whole output frames', () => {
    // 0.5-1.0 = 15 frames, 1.4-2.5 = 33 frames, 3.0-5.5 = 75 frames -> 123/30
    expect(edlDuration(twoScenes, 30)).toBeCloseTo(123 / 30, 9);
  });

  it('snaps non-frame-aligned cuts so the total is a whole number of frames', () => {
    const edl = EdlSchema.parse({ ...twoScenes, scenes: [{ id: 'x', src: { in: 0.51, out: 1.0 } }] });
    expect(edlDuration(edl, 30)).toBeCloseTo(15 / 30, 9);
  });
});

describe('resolveFps', () => {
  it('prefers the source fps and falls back to output.fps', () => {
    expect(resolveFps(twoScenes, 29.97)).toBe(29.97);
    expect(resolveFps(twoScenes, 0)).toBe(30);
  });
});

describe('edlSegments', () => {
  it('snaps segment bounds to the output frame grid and reports whole frame counts', () => {
    const edl = EdlSchema.parse({ ...twoScenes, scenes: [{ id: 'x', src: { in: 0.51, out: 1.0 } }] });
    const [seg] = edlSegments(edl, 30);
    expect(seg.start).toBe(15 / 30);
    expect(seg.start).toBeCloseTo(0.5, 9);
    expect(seg.end).toBe(1);
    expect(seg.frames).toBe(15);
    expect(seg.sceneId).toBe('x');
  });

  it('drops a leftover shorter than half a frame', () => {
    // [2.4996, 2.5] is a 0.4 ms sliver left after the cut
    const edl = EdlSchema.parse({ ...twoScenes, scenes: [{ id: 'x', src: { in: 0.5, out: 2.5 }, cuts: [[1.0, 2.4996]] }] });
    expect(edlSegments(edl, 30)).toEqual([expect.objectContaining({ start: 0.5, end: 1, frames: 15 })]);
  });

  it('throws EMPTY_SCENE when a scene keeps only sub-frame slivers', () => {
    const edl = EdlSchema.parse({ ...twoScenes, scenes: [{ id: 'x', src: { in: 2, out: 3 }, cuts: [[2, 2.9996]] }] });
    expect(() => edlSegments(edl, 30)).toThrow(expect.objectContaining({ name: 'EdlError', code: 'EMPTY_SCENE', sceneId: 'x' }));
  });
});

describe('bitrateFor', () => {
  it('follows the YouTube table', () => {
    expect(bitrateFor(1920, 1080, 30)).toBe('8M');
    expect(bitrateFor(1920, 1080, 60)).toBe('12M');
    expect(bitrateFor(3840, 2160, 30)).toBe('40M');
    expect(bitrateFor(1280, 720, 30)).toBe('5M');
  });
});

describe('buildFilterGraph', () => {
  it('trims, zooms, scales and concatenates every segment', () => {
    const g = buildFilterGraph(twoScenes, { mode: 'final', sourceFps: 30 });
    expect(g).toContain('[0:v]setpts=PTS-STARTPTS');
    expect(g).toContain('[1:v]setpts=PTS-STARTPTS');
    expect(g).toContain('crop=trunc(iw/1.2/2)*2:trunc(ih/1.2/2)*2:(iw-iw/1.2)*0.5:(ih-ih/1.2)*0.4');
    expect(g).toContain('scale=1920:1080:flags=bicubic,setsar=1,fps=30');
    expect(g).toContain(
      '[0:v]setpts=PTS-STARTPTS,scale=1920:1080:flags=bicubic,setsar=1,fps=30,tpad=stop=1:stop_mode=clone,trim=end_frame=15,setpts=PTS-STARTPTS[v0]',
    );
    expect(g).toContain('[0:a]asetpts=PTS-STARTPTS,apad,atrim=end=0.5,asetpts=PTS-STARTPTS[a0]');
    expect(g).toContain('trim=end_frame=33,setpts=PTS-STARTPTS[v1]');
    expect(g).toContain('[1:a]asetpts=PTS-STARTPTS,apad,atrim=end=1.1,asetpts=PTS-STARTPTS[a1]');
    expect(g).toContain('trim=end_frame=75,setpts=PTS-STARTPTS[v2]');
    expect(g).toContain('concat=n=3:v=1:a=1[vcat][acat]');
    expect(g).toContain('[acat]highpass=f=90,loudnorm=I=-14:TP=-1:LRA=11,asetpts=N/SR/TB[aout]');
  });

  it('writes frame-derived times to the microsecond so audio never outlasts its video', () => {
    // 2 frames at 30 fps = 0.0666... s; millisecond rounding (0.067) would add 0.33 ms per segment.
    const edl = EdlSchema.parse({ ...twoScenes, scenes: [{ id: 'x', src: { in: 1, out: 1 + 2 / 30 } }] });
    const g = buildFilterGraph(edl, { mode: 'preview', sourceFps: 30 });
    expect(g).toContain('trim=end_frame=2,');
    expect(g).toContain('atrim=end=0.066667,');
  });

  it('uses the source fps and preview size in preview mode', () => {
    const g = buildFilterGraph(twoScenes, { mode: 'preview', sourceFps: 29.97 });
    expect(g).toContain('scale=960:540:flags=bicubic,setsar=1,fps=29.97');
  });
});

describe('compileEdl', () => {
  it('produces the full argument list for a final render', () => {
    const args = compileEdl(twoScenes, { input: 'in.mp4', output: 'out.mp4', encoder: enc, mode: 'final', sourceFps: 30 });
    expect(args).toMatchSnapshot();
    expect(args).toContain('-filter_complex');
    expect(args.slice(-1)[0]).toBe('out.mp4');
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-b:v', '8M', '-c:a', 'aac', '-b:a', '384k', '-ar', '48000', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709']));
  });

  it('seeks each segment as its own input, in scene order', () => {
    const args = compileEdl(twoScenes, { input: 'in.mp4', output: 'out.mp4', encoder: enc, mode: 'final', sourceFps: 30 });
    // segment 0: scene s1's first kept range (0.5-1.0 = 15 frames), plus one frame of slack
    expect(args.join('|')).toContain(['-ss', '0.5', '-t', '0.533333', '-i', 'in.mp4'].join('|'));
    // segment 2 (3rd input overall): scene s2's only kept range (3.0-5.5 = 75 frames), plus one frame of slack
    expect(args.join('|')).toContain(['-ss', '3', '-t', '2.533333', '-i', 'in.mp4'].join('|'));
  });

  it('emits inputs in scene order even when scenes are out of source order', () => {
    const args = compileEdl(oneOffScenes, { input: 'in.mp4', output: 'out.mp4', encoder: enc, mode: 'final', sourceFps: 30 });
    const aIdx = args.indexOf('-ss');
    expect(args.slice(aIdx, aIdx + 6)).toEqual(['-ss', '3', '-t', '2.533333', '-i', 'in.mp4']);
    const bIdx = args.indexOf('-ss', aIdx + 1);
    expect(args.slice(bIdx, bIdx + 6)).toEqual(['-ss', '0.5', '-t', '2.033333', '-i', 'in.mp4']);
  });

  it('never emits -t 0 for a sub-millisecond leftover and does not add it as an input', () => {
    const edl = EdlSchema.parse({ ...twoScenes, scenes: [{ id: 'x', src: { in: 0.5, out: 2.5 }, cuts: [[1.0, 2.4996]] }] });
    const args = compileEdl(edl, { input: 'in.mp4', output: 'out.mp4', encoder: enc, mode: 'preview', sourceFps: 30 });
    expect(args.filter((a) => a === '-i')).toHaveLength(1);
    const tValues = args.flatMap((a, i) => (a === '-t' ? [args[i + 1]] : []));
    expect(tValues).toEqual(['0.533333']);
    expect(args.join('|')).not.toContain('-t|0|');
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('concat=n=1:v=1:a=1');
  });

  it('falls back to output.fps for bitrate and GOP when sourceFps is 0', () => {
    const edl60fps = EdlSchema.parse({ ...twoScenes, output: { ...twoScenes.output, fps: 60 } });
    const args = compileEdl(edl60fps, { input: 'in.mp4', output: 'out.mp4', encoder: enc, mode: 'final', sourceFps: 0 });
    expect(args).toEqual(expect.arrayContaining(['-b:v', '12M']));
  });

  it('uses crf ultrafast libx264 for previews regardless of the picked encoder', () => {
    const args = compileEdl(twoScenes, { input: 'in.mp4', output: 'p.mp4', encoder: { name: 'h264_videotoolbox', extraArgs: [] }, mode: 'preview', sourceFps: 30 });
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28']));
    expect(args).not.toContain('h264_videotoolbox');
  });
});
