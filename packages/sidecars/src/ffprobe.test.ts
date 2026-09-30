import { describe, expect, it } from 'vitest';
import { parseFps, probe } from './ffprobe.js';

describe('parseFps', () => {
  it('parses integer and fractional rates', () => {
    expect(parseFps('30/1')).toBe(30);
    expect(parseFps('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFps('0/0')).toBe(0);
    expect(parseFps('garbage')).toBe(0);
  });
});

describe('probe', () => {
  it('reads duration, size, fps and streams from a fixture', async () => {
    const info = await probe('fixtures/tone-6s.mp4');
    expect(info.durationSec).toBeCloseTo(6, 0);
    expect(info.width).toBe(640);
    expect(info.height).toBe(360);
    expect(info.fps).toBe(30);
    expect(info.hasVideo).toBe(true);
    expect(info.hasAudio).toBe(true);
    expect(info.videoCodec).toBe('h264');
    expect(info.audioCodec).toBe('aac');
  });

  it('reports fractional fps', async () => {
    const info = await probe('fixtures/tone-6s-2997.mp4');
    expect(info.fps).toBeCloseTo(29.97, 2);
  });

  it('reports hasAudio=false for a video-only file', async () => {
    const info = await probe('fixtures/noaudio-6s.mp4');
    expect(info.hasAudio).toBe(false);
    expect(info.audioCodec).toBeNull();
  });

  it('throws SidecarError for a missing file', async () => {
    await expect(probe('fixtures/nope.mp4')).rejects.toMatchObject({ name: 'SidecarError', tool: 'ffprobe' });
  });
});
