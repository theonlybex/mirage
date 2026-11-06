// SPDX-License-Identifier: MIT
import type { Encoder } from '../media-tools.js';

export function bitrateFor(width: number, height: number, fps: number): string {
  const longSide = Math.max(width, height);
  if (longSide >= 3840) return '40M';
  if (longSide >= 1920) return fps > 40 ? '12M' : '8M';
  return '5M';
}

// Microsecond precision: frame-derived times like 2/30 must not round to whole
// milliseconds, or the audio of each segment drifts from its video by up to 0.5 ms.
export const ffNum = (n: number) => String(Math.round(n * 1e6) / 1e6);

export function encodeArgs(o: { mode: 'preview' | 'final'; encoder: Encoder; width: number; height: number; fps: number }): string[] {
  const video =
    o.mode === 'preview'
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28']
      : ['-c:v', o.encoder.name, ...o.encoder.extraArgs, '-b:v', bitrateFor(o.width, o.height, o.fps), '-g', String(Math.round(o.fps * 2))];
  const audio = o.mode === 'preview' ? ['-c:a', 'aac', '-b:a', '128k'] : ['-c:a', 'aac', '-b:a', '384k'];
  return [
    ...video,
    '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    ...audio, '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
  ];
}
