import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFps, probe } from './ffprobe.js';
import { run } from './run.js';

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
    expect(info.colorTransfer).toBeNull();
  });

  it('reads the colour transfer, so HDR (HLG/PQ) clips can be flagged', async () => {
    const out = join(await mkdtemp(join(tmpdir(), 'we-hdr-')), 'hlg.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_trc', 'arib-std-b67', out]);
    expect((await probe(out)).colorTransfer).toBe('arib-std-b67');
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
