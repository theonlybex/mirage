import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdlSchema } from '@wordedits/shared';
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
});

describe('renderEdl', () => {
  it('renders a two-scene EDL to an MP4 of the expected length (final)', async () => {
    const dir = await mkdtemp(join(tmpdir(), "we render 'quoted' -"));
    const input = join(dir, "my take 'one'.mp4");
    await cp('fixtures/tone-6s.mp4', input);
    const seen: number[] = [];
    const r = await renderEdl({ edl, input, outputDir: dir, mode: 'final', tools, onProgress: (f) => seen.push(f) });
    expect(r.expectedDurationSec).toBeCloseTo(4.1, 5);
    expect(r.probe.durationSec).toBeGreaterThan(4.1 - 0.25);
    expect(r.probe.durationSec).toBeLessThan(4.1 + 0.25);
    expect(r.probe.width).toBe(640);
    expect(r.probe.height).toBe(360);
    expect(r.probe.fps).toBe(30);
    expect(r.probe.hasAudio).toBe(true);
    expect(r.outputPath).toBe(join(dir, `final-${edlHash(edl)}.mp4`));
    expect(Math.max(...seen)).toBe(1);
    const loud = await tools.measureLoudness(r.outputPath);
    expect(loud.integratedLufs).toBeGreaterThan(-16.5);
    expect(loud.integratedLufs).toBeLessThan(-11.5);
    expect(loud.truePeakDb).toBeLessThanOrEqual(-0.5);
  });

  it('renders a 540p preview quickly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-prev-'));
    const r = await renderEdl({ edl, input: 'fixtures/tone-6s.mp4', outputDir: dir, mode: 'preview', tools });
    expect(r.probe.height).toBe(540);
    expect(r.outputPath.endsWith(`preview-${edlHash(edl)}.mp4`)).toBe(true);
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
});
