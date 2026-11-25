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

/**
 * adelay by `delays` (its own syntax: milliseconds, or samples with an S), with the result renumbered by sample count.
 * FFmpeg 9's adelay stamps the silence it adds with no timestamp when its input was read from a seek point, and amix and
 * atrim then misplace or drop the sound; every delayed sound here starts at 0, so counting samples gives the true clock.
 * Every amix is followed by the same renumbering, for the same reason: FFmpeg 9's amix sometimes stamps what it mixes
 * with no timestamp, and an apad,atrim after it then never ends (the file grows without limit).
 */
export const delayed = (delays: string) => `adelay=delays=${delays}:all=1,asetpts=N/SR/TB`;

/**
 * Tags the final picture BT.709 (encodeArgs' flags say the same): FFmpeg 9 takes the colour primaries and transfer from
 * the frames and ignores -color_primaries and -color_trc given only as output options, so the file would say "unknown".
 */
export const BT709_TAGS = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709';

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
