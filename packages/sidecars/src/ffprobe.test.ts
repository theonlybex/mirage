import { mkdtemp, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
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

describe('probe of awkward files', () => {
  let dir: string;
  const gen = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const VIDEO = (d: number, size = '320x180') => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${d}`];
  const TONE = (d: number) => ['-f', 'lavfi', '-i', `sine=frequency=300:sample_rate=48000:duration=${d}`];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'we-probe-'));
  });

  it('reports the video duration apart from a longer audio track', async () => {
    const f = join(dir, 'short-video.mp4');
    await gen([...VIDEO(3), ...TONE(6), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]);
    const info = await probe(f);
    expect(info.durationSec).toBeCloseTo(6, 1);
    expect(info.videoDurationSec).toBeCloseTo(3, 1);
    expect(info.truncated).toBeFalsy();
  });

  it('treats cover art as no video', async () => {
    const jpg = join(dir, 'cover.jpg');
    await gen(['-f', 'lavfi', '-i', 'color=green:s=64x64', '-frames:v', '1', jpg]);
    const f = join(dir, 'song.mp4');
    await gen([...TONE(3), '-i', jpg, '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic', f]);
    const info = await probe(f);
    expect(info.hasVideo).toBe(false);
    expect(info.hasAudio).toBe(true);
    expect([info.width, info.height, info.videoCodec]).toEqual([0, 0, null]);
  });

  it('applies display rotation, so a portrait phone clip reads as portrait', async () => {
    const f = join(dir, 'rot.mp4');
    await gen([...VIDEO(1, '320x180'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'flat.mp4')]);
    await gen(['-i', join(dir, 'flat.mp4'), '-c', 'copy', '-metadata:s:v:0', 'rotate=90', f]);
    expect(await probe(f)).toMatchObject({ width: 180, height: 320 });
  });

  it('measures content from the start time, not from zero', async () => {
    const f = join(dir, 'late-start.mkv');
    await gen([...VIDEO(6), ...TONE(6), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-output_ts_offset', '5', f]);
    const info = await probe(f);
    expect(info.durationSec).toBeCloseTo(6, 1);
    expect(info.videoDurationSec).toBeCloseTo(6, 1);
  });

  it('reports when a video stream starts after its sound', async () => {
    await gen([...VIDEO(3), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'v3.mp4')]);
    const f = join(dir, 'video-late.mp4');
    await gen(['-itsoffset', '1.5', '-i', join(dir, 'v3.mp4'), ...TONE(5), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', f]);
    expect((await probe(f)).videoStartSec).toBeCloseTo(1.5, 1);
    expect((await probe(join(dir, 'v3.mp4'))).videoStartSec).toBeUndefined();
  });

  it('reads the duration of a streamed recording whose container has none', async () => {
    const f = join(dir, 'streamed.webm');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...VIDEO(4), ...TONE(4), '-c:v', 'libvpx', '-deadline', 'realtime', '-c:a', 'libopus', '-f', 'webm', '-live', '1', f]);
    const info = await probe(f);
    expect(info.durationSec).toBeCloseTo(4, 0);
    expect(info.videoDurationSec).toBeCloseTo(4, 0);
  });

  it('falls back to the header when the packet scan fails, and says so', async () => {
    const f = join(dir, 'scan.mp4');
    await gen([...VIDEO(3), ...TONE(6), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]);
    const info = await probe(f, { scanTimeoutMs: 1 });
    expect(info.scanFailed).toBe(true);
    // The streams' header durations.
    expect(info.durationSec).toBeCloseTo(6, 1);
    expect(info.videoDurationSec).toBeCloseTo(3, 1);
    expect(info.hasVideo).toBe(true);
    expect((await probe(f)).scanFailed).toBeUndefined();
  });

  it('flags a file cut short (its header promises more than its data holds) and reports what is there', async () => {
    const f = join(dir, 'cut.mp4');
    await gen([...VIDEO(6), ...TONE(6), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', f]);
    await truncate(f, Math.round((await stat(f)).size * 0.5));
    const info = await probe(f);
    expect(info.truncated).toBe(true);
    expect(info.durationSec).toBeLessThan(4.5);
    expect(info.videoDurationSec).toBeLessThan(4.5);
  });
});
