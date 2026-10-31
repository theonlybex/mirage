import { describe, expect, it } from 'vitest';
import { EdlSchema } from './edl.js';

const base = {
  version: 1,
  output: { width: 1920, height: 1080, fps: 30 },
  scenes: [{ id: 's1', src: { in: 0.5, out: 2.5 }, cuts: [[1.0, 1.4]] }],
};

describe('EdlSchema', () => {
  it('parses a minimal EDL and fills defaults', () => {
    const edl = EdlSchema.parse(base);
    expect(edl.scenes[0].zoom).toEqual({ scale: 1, anchor: { x: 0.5, y: 0.4 } });
    expect(edl.scenes[0].captions).toBe(true);
    expect(edl.audio.loudnessLufs).toBe(-14);
    expect(edl.endScreen.seconds).toBe(12);
  });

  it('rejects src.out <= src.in and names the scene', () => {
    const r = EdlSchema.safeParse({ ...base, scenes: [{ id: 'bad', src: { in: 2, out: 2 } }] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('scene bad');
  });

  it('rejects a cut outside the scene range', () => {
    const r = EdlSchema.safeParse({
      ...base,
      scenes: [{ id: 's1', src: { in: 1, out: 2 }, cuts: [[0.5, 1.5]] }],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('outside');
  });

  it('rejects an empty scene list', () => {
    expect(EdlSchema.safeParse({ ...base, scenes: [] }).success).toBe(false);
  });

  it('rejects zoom scale above 2', () => {
    const r = EdlSchema.safeParse({
      ...base,
      scenes: [{ id: 's1', src: { in: 0, out: 1 }, zoom: { scale: 2.5 } }],
    });
    expect(r.success).toBe(false);
  });
});
