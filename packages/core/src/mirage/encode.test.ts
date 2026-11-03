import { describe, expect, it } from 'vitest';
import type { Encoder } from '../media-tools.js';
import { bitrateFor, encodeArgs, ffNum } from './encode.js';

describe('bitrateFor', () => {
  it('follows the YouTube table', () => {
    expect(bitrateFor(1920, 1080, 30)).toBe('8M');
    expect(bitrateFor(1920, 1080, 60)).toBe('12M');
    expect(bitrateFor(3840, 2160, 30)).toBe('40M');
    expect(bitrateFor(1280, 720, 30)).toBe('5M');
  });
});

describe('ffNum', () => {
  it('keeps microsecond precision', () => {
    expect(ffNum(2 / 30)).toBe('0.066667');
    expect(ffNum(1)).toBe('1');
  });
});

describe('encodeArgs', () => {
  const encoder: Encoder = { name: 'libx264', extraArgs: ['-preset', 'medium'] };

  it('uses a fast x264 preset for previews', () => {
    const args = encodeArgs({ mode: 'preview', encoder, width: 1920, height: 1080, fps: 30 });
    expect(args.slice(0, 6)).toEqual(['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28']);
    expect(args).toContain('128k');
  });

  it('uses the chosen encoder, the bitrate table and a two-second GOP for finals', () => {
    const args = encodeArgs({ mode: 'final', encoder, width: 1920, height: 1080, fps: 30 });
    expect(args.slice(0, 8)).toEqual(['-c:v', 'libx264', '-preset', 'medium', '-b:v', '8M', '-g', '60']);
    expect(args).toContain('384k');
    expect(args.at(-1)).toBe('+faststart');
  });
});
