import { access, cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdlSchema, type Edl } from '@wordedits/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { realMediaTools, type MediaTools } from './media-tools.js';
import { edlHash, renderEdl } from './render.js';

const edl = EdlSchema.parse({
  version: 1,
  output: { width: 640, height: 360, fps: 30 },
  scenes: [
    { id: 's1', src: { in: 0.5, out: 2.5 }, cuts: [[1.0, 1.4]] },
    { id: 's2', src: { in: 3.0, out: 5.5 }, zoom: { scale: 1.2 } },
  ],
});

let tools: MediaTools;
beforeAll(async () => {
  tools = await realMediaTools();
});

describe('edlHash', () => {
  it('is stable and 8 hex chars', () => {
    expect(edlHash(edl)).toMatch(/^[0-9a-f]{8}$/);
    expect(edlHash(edl)).toBe(edlHash(JSON.parse(JSON.stringify(edl))));
    expect(edlHash({ ...edl, endScreen: { seconds: 3 } })).not.toBe(edlHash(edl));
  });

  it('hashes equal for a raw EDL with endScreen omitted vs the same EDL with the default spelled out', () => {
    // Both raw objects parse (via EdlSchema.parse) to the identical Edl, since { seconds: 12 }
    // is exactly SceneSchema's default for an omitted endScreen. edlHash must hash them equal
    // too: it must build its key allowlist from the *parsed* (defaulted) value, not from the
    // raw argument, or keys that only exist after defaulting get dropped from the raw-omitted
    // variant's canonical JSON and the two hashes diverge.
    const rawWithoutEndScreen = {
      version: 1,
      output: { width: 640, height: 360, fps: 30 },
      scenes: [{ id: 's1', src: { in: 0, out: 1 } }],
    };
    const rawWithEndScreenSpelledOut = { ...rawWithoutEndScreen, endScreen: { seconds: 12 } };
    expect(EdlSchema.parse(rawWithoutEndScreen)).toEqual(EdlSchema.parse(rawWithEndScreenSpelledOut));
    expect(edlHash(rawWithoutEndScreen as unknown as Edl)).toBe(edlHash(rawWithEndScreenSpelledOut as unknown as Edl));
  });
});

describe('renderEdl', () => {
  it('renders a two-scene EDL to an MP4 of the expected length (final)', async () => {
    const dir = await mkdtemp(join(tmpdir(), "we render 'quoted' -"));
    const input = join(dir, "my take 'one'.mp4");
    await cp('fixtures/tone-6s.mp4', input);
    const seen: number[] = [];
    const r = await renderEdl({ edl, input, outputDir: dir, mode: 'final', tools, onProgress: (f) => seen.push(f) });
    expect(r.expectedDurationSec).toBeCloseTo(4.1, 5);
    expect(Math.abs(r.probe.durationSec - 4.1)).toBeLessThanOrEqual(0.1);
    expect(r.probe.width).toBe(640);
    expect(r.probe.height).toBe(360);
    expect(r.probe.fps).toBe(30);
    expect(r.probe.hasAudio).toBe(true);
    expect(r.outputPath).toBe(join(dir, `final-${edlHash(edl)}.mp4`));
    expect(Math.max(...seen)).toBe(1);
    const loud = await tools.measureLoudness(r.outputPath);
    expect(loud.integratedLufs).toBeGreaterThanOrEqual(-15);
    expect(loud.integratedLufs).toBeLessThanOrEqual(-13);
    expect(loud.truePeakDb).toBeLessThanOrEqual(-0.5);
  });

  it('renders a 540p preview quickly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-prev-'));
    const r = await renderEdl({ edl, input: 'fixtures/tone-6s.mp4', outputDir: dir, mode: 'preview', tools });
    expect(r.probe.height).toBe(540);
    expect(r.outputPath.endsWith(`preview-${edlHash(edl)}.mp4`)).toBe(true);
  });

  it('keeps the rendered duration within 0.1 s of the EDL across 15 non-frame-aligned cuts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-cuts-'));
    const cuts: [number, number][] = [
      [0.37, 0.61], [0.93, 1.02], [1.21, 1.43], [1.57, 1.66], [1.88, 2.11],
      [2.29, 2.37], [2.52, 2.77], [2.95, 3.03], [3.19, 3.41], [3.58, 3.67],
      [3.86, 4.09], [4.23, 4.31], [4.49, 4.71], [4.89, 4.97], [5.23, 5.46],
    ];
    const cutEdl = EdlSchema.parse({
      version: 1,
      output: { width: 640, height: 360, fps: 30 },
      scenes: [{ id: 'c', src: { in: 0.2, out: 5.8 }, cuts }],
    });
    const r = await renderEdl({ edl: cutEdl, input: 'fixtures/tone-6s.mp4', outputDir: dir, mode: 'preview', tools });
    expect(Math.abs(r.probe.durationSec - r.expectedDurationSec)).toBeLessThanOrEqual(0.1);
  });

  it('keeps a fractional source frame rate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-2997-'));
    const r = await renderEdl({ edl, input: 'fixtures/tone-6s-2997.mp4', outputDir: dir, mode: 'preview', tools });
    expect(r.probe.fps).toBeCloseTo(29.97, 2);
  });

  it('refuses a source with no audio track with code NO_AUDIO', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-noaudio-'));
    await expect(renderEdl({ edl, input: 'fixtures/noaudio-6s.mp4', outputDir: dir, mode: 'preview', tools })).rejects.toMatchObject({
      name: 'RenderError',
      code: 'NO_AUDIO',
      hint: expect.stringContaining('audio'),
    });
  });

  it('surfaces EDL errors with code EDL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-edl-'));
    const bad = { ...edl, scenes: [{ ...edl.scenes[0], cuts: [[0.5, 2.5]] as [number, number][] }] };
    await expect(renderEdl({ edl: bad, input: 'fixtures/tone-6s.mp4', outputDir: dir, mode: 'preview', tools })).rejects.toMatchObject({
      name: 'RenderError',
      code: 'EDL',
    });
  });

  it('removes the partial output file when the rendered duration mismatches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-mismatch-'));
    const validSourceProbe = {
      durationSec: 6,
      width: 1280,
      height: 720,
      fps: 30,
      hasVideo: true,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
    };
    const badOutputProbe = { ...validSourceProbe, durationSec: 1 }; // far from edlDuration(edl) = 4.1s
    let probeCalls = 0;
    const stubTools: MediaTools = {
      probe: async (_file: string) => {
        // First probe call is the source; the second is the rendered output.
        probeCalls += 1;
        return probeCalls === 1 ? validSourceProbe : badOutputProbe;
      },
      runFfmpeg: async (args) => {
        const outputPath = args.at(-1) as string;
        await writeFile(outputPath, 'not a real render, just a placeholder');
      },
      pickEncoder: async () => ({ name: 'libx264', extraArgs: [] }),
      makeProxy: async () => {},
      measureLoudness: async () => ({ integratedLufs: -14, truePeakDb: -3 }),
    };

    const expectedOutputPath = join(dir, `preview-${edlHash(edl)}.mp4`);
    await expect(renderEdl({ edl, input: 'fixtures/tone-6s.mp4', outputDir: dir, mode: 'preview', tools: stubTools })).rejects.toMatchObject({
      name: 'RenderError',
      code: 'DURATION_MISMATCH',
    });
    await expect(access(expectedOutputPath)).rejects.toThrow();
    expect((await readdir(dir)).filter((f) => f.includes('.partial-'))).toEqual([]);
  });

  it('keeps a previous good render when a re-render fails, and rethrows the original error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-atomic-'));
    const outputPath = join(dir, `preview-${edlHash(edl)}.mp4`);
    await writeFile(outputPath, 'previous good render');
    const sentinel = new Error('ffmpeg blew up');
    let writtenTo = '';
    const stubTools = probeStub([4.1], async (args) => {
      writtenTo = args.at(-1) as string;
      await writeFile(writtenTo, 'half-written render');
      throw sentinel;
    });
    const err = await renderEdl({ edl, input: 'fixtures/tone-6s.mp4', outputDir: dir, mode: 'preview', tools: stubTools }).catch((e: unknown) => e);
    expect(err).toBe(sentinel);
    expect(writtenTo).not.toBe(outputPath);
    expect(writtenTo.startsWith(`${outputPath}.partial-`)).toBe(true);
    expect((await readdir(dir)).filter((f) => f.includes('.partial-'))).toEqual([]);
    expect(await readFile(outputPath, 'utf8')).toBe('previous good render');
  });

  it('keeps a previous good render when the re-render has the wrong duration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-atomic-dur-'));
    const outputPath = join(dir, `preview-${edlHash(edl)}.mp4`);
    await writeFile(outputPath, 'previous good render');
    await expect(renderEdl({ edl, input: 'fixtures/tone-6s.mp4', outputDir: dir, mode: 'preview', tools: probeStub([1]) })).rejects.toMatchObject({
      code: 'DURATION_MISMATCH',
    });
    expect((await readdir(dir)).filter((f) => f.includes('.partial-'))).toEqual([]);
    expect(await readFile(outputPath, 'utf8')).toBe('previous good render');
  });

  it('moves a verified render into place and leaves no partial file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-atomic-ok-'));
    const r = await renderEdl({ edl, input: 'fixtures/tone-6s.mp4', outputDir: dir, mode: 'preview', tools: probeStub([4.1]) });
    expect(r.outputPath).toBe(join(dir, `preview-${edlHash(edl)}.mp4`));
    expect(await readdir(dir)).toEqual([`preview-${edlHash(edl)}.mp4`]);
    expect(await readFile(r.outputPath, 'utf8')).toBe('placeholder render');
  });

  it('rejects a render 0.15 s off the EDL (spec tolerance is 0.1 s)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-tol-'));
    const stubTools = probeStub([4.1 + 0.15]);
    await expect(renderEdl({ edl, input: 'fixtures/tone-6s.mp4', outputDir: dir, mode: 'preview', tools: stubTools })).rejects.toMatchObject({
      name: 'RenderError',
      code: 'DURATION_MISMATCH',
    });
  });

  it('accepts a render 0.09 s off the EDL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-tol-ok-'));
    const r = await renderEdl({ edl, input: 'fixtures/tone-6s.mp4', outputDir: dir, mode: 'preview', tools: probeStub([4.1 + 0.09]) });
    expect(r.expectedDurationSec).toBeCloseTo(4.1, 9);
  });
});

/** Stub tools: the first probe is a valid 6 s source; later probes return the given output durations. */
function probeStub(outputDurations: number[], runFfmpeg?: MediaTools['runFfmpeg']): MediaTools {
  const source = { durationSec: 6, width: 1280, height: 720, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac' };
  let calls = 0;
  return {
    probe: async () => (calls++ === 0 ? source : { ...source, durationSec: outputDurations[Math.min(calls - 2, outputDurations.length - 1)] }),
    runFfmpeg:
      runFfmpeg ??
      (async (args) => {
        await writeFile(args.at(-1) as string, 'placeholder render');
      }),
    pickEncoder: async () => ({ name: 'libx264', extraArgs: [] }),
    makeProxy: async () => {},
    measureLoudness: async () => ({ integratedLufs: -14, truePeakDb: -3 }),
  };
}
