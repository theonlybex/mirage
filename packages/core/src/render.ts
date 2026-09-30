import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { EdlSchema, type Edl, type ProbeInfo } from '@wordedits/shared';
import { compileEdl, EdlError, edlDuration } from './edl-compiler.js';
import type { MediaTools } from './media-tools.js';

export class RenderError extends Error {
  override name = 'RenderError';
  constructor(
    public code: 'NO_AUDIO' | 'NO_VIDEO' | 'DURATION_MISMATCH' | 'EDL',
    message: string,
    public hint: string,
    public override cause?: unknown,
  ) {
    super(message);
  }
}

export function edlHash(edl: Edl): string {
  const parsed = EdlSchema.parse(edl);
  const canonical = JSON.stringify(parsed, Object.keys(flatten(parsed)).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

// Collects every key so JSON.stringify's replacer array sorts keys at all depths.
function flatten(v: unknown, acc: Record<string, true> = {}): Record<string, true> {
  if (Array.isArray(v)) v.forEach((x) => flatten(x, acc));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      acc[k] = true;
      flatten(x, acc);
    }
  }
  return acc;
}

export interface RenderOptions {
  edl: Edl;
  input: string;
  outputDir: string;
  mode: 'preview' | 'final';
  tools: MediaTools;
  onProgress?: (fraction: number) => void;
}

export interface RenderResult {
  outputPath: string;
  expectedDurationSec: number;
  probe: ProbeInfo;
}

const DURATION_TOLERANCE_SEC = 0.25;

export async function renderEdl(opts: RenderOptions): Promise<RenderResult> {
  const { tools } = opts;
  const src = await tools.probe(opts.input);
  if (!src.hasVideo) throw new RenderError('NO_VIDEO', 'The source file has no video stream', 'Choose a video file.');
  if (!src.hasAudio) {
    throw new RenderError('NO_AUDIO', 'The source file has no audio track', 'WordEdits needs your voice to cut the video. Re-export the recording with audio.');
  }

  let expected: number;
  try {
    expected = edlDuration(opts.edl);
    const encoder = opts.mode === 'final' ? await tools.pickEncoder() : { name: 'libx264' as const, extraArgs: [] };
    await mkdir(opts.outputDir, { recursive: true });
    const outputPath = join(opts.outputDir, `${opts.mode}-${edlHash(opts.edl)}.mp4`);
    const args = compileEdl(opts.edl, { input: opts.input, output: outputPath, encoder, mode: opts.mode, sourceFps: src.fps });
    try {
      await tools.runFfmpeg(args, {
        expectedDurationSec: expected,
        timeoutMs: Math.max(60_000, expected * 20 * 1000),
        onProgress: opts.onProgress,
      });
    } catch (e) {
      await rm(outputPath, { force: true });
      throw e;
    }
    const probe = await tools.probe(outputPath);
    if (Math.abs(probe.durationSec - expected) > DURATION_TOLERANCE_SEC) {
      await rm(outputPath, { force: true });
      throw new RenderError('DURATION_MISMATCH', `Rendered ${probe.durationSec}s but expected ${expected}s`, 'The source may be shorter than the EDL assumes. Re-import the file.');
    }
    return { outputPath, expectedDurationSec: expected, probe };
  } catch (e) {
    if (e instanceof EdlError) throw new RenderError('EDL', e.message, e.hint, e);
    throw e;
  }
}
