import { EdlSchema } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { bitrateFor, buildFilterGraph, compileEdl, edlDuration, sceneSegments } from './edl-compiler.js';

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
  it('sums kept segments', () => {
    expect(edlDuration(twoScenes)).toBeCloseTo(1.6 + 2.5, 5);
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
    expect(g).toContain('[0:v]trim=start=0.5:end=1,setpts=PTS-STARTPTS');
    expect(g).toContain('[0:v]trim=start=1.4:end=2.5,setpts=PTS-STARTPTS');
    expect(g).toContain('crop=trunc(iw/1.2/2)*2:trunc(ih/1.2/2)*2:(iw-iw/1.2)*0.5:(ih-ih/1.2)*0.4');
    expect(g).toContain('scale=1920:1080:flags=bicubic,setsar=1,fps=30');
    expect(g).toContain('concat=n=3:v=1:a=1[vcat][acat]');
    expect(g).toContain('[acat]highpass=f=90,loudnorm=I=-14:TP=-1:LRA=11[aout]');
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

  it('uses crf ultrafast libx264 for previews regardless of the picked encoder', () => {
    const args = compileEdl(twoScenes, { input: 'in.mp4', output: 'p.mp4', encoder: { name: 'h264_videotoolbox', extraArgs: [] }, mode: 'preview', sourceFps: 30 });
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28']));
    expect(args).not.toContain('h264_videotoolbox');
  });
});
