import type { Edl, Scene } from '@wordedits/shared';
import type { Encoder } from './media-tools.js';

export class EdlError extends Error {
  override name = 'EdlError';
  constructor(
    public code: 'EMPTY_SCENE' | 'NO_SCENES',
    message: string,
    public hint: string,
    public sceneId?: string,
  ) {
    super(message);
  }
}

export interface Segment {
  start: number;
  end: number;
}

const EPS = 1e-6;

/** Kept ranges of a scene after removing its cuts. Cuts may overlap; results are sorted. */
export function sceneSegments(scene: Scene): Segment[] {
  const cuts = [...scene.cuts].sort((a, b) => a[0] - b[0]);
  const out: Segment[] = [];
  let cursor = scene.src.in;
  for (const [a, b] of cuts) {
    if (a - cursor > EPS) out.push({ start: cursor, end: a });
    cursor = Math.max(cursor, b);
  }
  if (scene.src.out - cursor > EPS) out.push({ start: cursor, end: scene.src.out });
  if (out.length === 0) {
    throw new EdlError('EMPTY_SCENE', `scene ${scene.id}: cuts remove the whole scene`, 'Remove a cut or delete the scene.', scene.id);
  }
  return out;
}

/** Output frame rate: the source's when known, otherwise the EDL's. */
export function resolveFps(edl: Edl, sourceFps: number): number {
  return sourceFps > 0 ? sourceFps : edl.output.fps;
}

export interface EdlSegment {
  sceneId: string;
  start: number;
  end: number;
  /** Whole output frames this segment contributes (end - start = frames / fps). */
  frames: number;
  scene: Scene;
}

/**
 * Flattened kept segments across all scenes, in scene order, snapped to the output
 * frame grid. Segments shorter than half a frame are dropped; a scene left with none
 * throws EMPTY_SCENE.
 */
export function edlSegments(edl: Edl, fps: number): EdlSegment[] {
  return edl.scenes.flatMap((scene) => {
    const kept = sceneSegments(scene).flatMap((seg) => {
      const start = Math.round(seg.start * fps) / fps;
      const end = Math.round(seg.end * fps) / fps;
      const frames = Math.round((end - start) * fps);
      return frames < 1 ? [] : [{ sceneId: scene.id, scene, start, end, frames }];
    });
    if (kept.length === 0) {
      throw new EdlError(
        'EMPTY_SCENE',
        `scene ${scene.id}: cuts leave less than one frame`,
        'Remove a cut or delete the scene.',
        scene.id,
      );
    }
    return kept;
  });
}

/** Rendered length in seconds: the sum of whole frames kept, at the output frame rate. */
export function edlDuration(edl: Edl, fps: number): number {
  return edlSegments(edl, fps).reduce((sum, s) => sum + s.frames / fps, 0);
}

export function bitrateFor(width: number, height: number, fps: number): string {
  const longSide = Math.max(width, height);
  if (longSide >= 3840) return '40M';
  if (longSide >= 1920) return fps > 40 ? '12M' : '8M';
  return '5M';
}

// Microsecond precision: frame-derived times like 2/30 must not round to whole
// milliseconds, or the audio of each segment drifts from its video by up to 0.5 ms.
export const ffNum = (n: number) => String(Math.round(n * 1e6) / 1e6);

export interface GraphOptions {
  mode: 'preview' | 'final';
  sourceFps: number;
}

export function buildFilterGraph(edl: Edl, opts: GraphOptions): string {
  if (edl.scenes.length === 0) throw new EdlError('NO_SCENES', 'EDL has no scenes', 'Add at least one scene.');
  const [W, H] = opts.mode === 'preview' ? [960, 540] : [edl.output.width, edl.output.height];
  const fps = resolveFps(edl, opts.sourceFps);

  const segments = edlSegments(edl, fps);
  const chains: string[] = [];
  const labels: string[] = [];
  segments.forEach((seg, k) => {
    const S = seg.scene.zoom.scale;
    const { x: ax, y: ay } = seg.scene.zoom.anchor;
    const crop =
      S > 1 + EPS
        ? `crop=trunc(iw/${ffNum(S)}/2)*2:trunc(ih/${ffNum(S)}/2)*2:(iw-iw/${ffNum(S)})*${ffNum(ax)}:(ih-ih/${ffNum(S)})*${ffNum(ay)},`
        : '';
    // Both streams are cut to exactly seg.frames frames so concat never pads one to
    // match the other (which would add up to a frame of drift per segment). tpad
    // clones the last frame in case the source runs out a frame early.
    chains.push(
      `[${k}:v]setpts=PTS-STARTPTS,${crop}scale=${W}:${H}:flags=bicubic,setsar=1,fps=${ffNum(fps)},` +
        `tpad=stop=1:stop_mode=clone,trim=end_frame=${ffNum(seg.frames)},setpts=PTS-STARTPTS[v${k}]`,
    );
    chains.push(`[${k}:a]asetpts=PTS-STARTPTS,apad,atrim=end=${ffNum(seg.frames / fps)},asetpts=PTS-STARTPTS[a${k}]`);
    labels.push(`[v${k}][a${k}]`);
  });
  chains.push(`${labels.join('')}concat=n=${segments.length}:v=1:a=1[vcat][acat]`);
  chains.push(`[acat]highpass=f=90,loudnorm=I=${ffNum(edl.audio.loudnessLufs)}:TP=-1:LRA=11,asetpts=N/SR/TB[aout]`);
  return chains.join(';');
}

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

export interface CompileOptions extends GraphOptions {
  input: string;
  output: string;
  encoder: Encoder;
}

export function compileEdl(edl: Edl, opts: CompileOptions): string[] {
  const graph = buildFilterGraph(edl, opts);
  const fps = resolveFps(edl, opts.sourceFps);
  // One extra frame of input so the fps filter never comes up a frame short.
  const inputs = edlSegments(edl, fps).flatMap((seg) => ['-ss', ffNum(seg.start), '-t', ffNum((seg.frames + 1) / fps), '-i', opts.input]);
  return [
    ...inputs,
    '-filter_complex', graph,
    '-map', '[vcat]', '-map', '[aout]',
    ...encodeArgs({ mode: opts.mode, encoder: opts.encoder, width: edl.output.width, height: edl.output.height, fps }),
    opts.output,
  ];
}
