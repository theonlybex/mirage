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

export function edlDuration(edl: Edl): number {
  return edl.scenes.flatMap(sceneSegments).reduce((sum, s) => sum + (s.end - s.start), 0);
}

export function bitrateFor(width: number, height: number, fps: number): string {
  const longSide = Math.max(width, height);
  if (longSide >= 3840) return '40M';
  if (longSide >= 1920) return fps > 40 ? '12M' : '8M';
  return '5M';
}

const num = (n: number) => String(Math.round(n * 1000) / 1000);

export interface GraphOptions {
  mode: 'preview' | 'final';
  sourceFps: number;
}

export function buildFilterGraph(edl: Edl, opts: GraphOptions): string {
  if (edl.scenes.length === 0) throw new EdlError('NO_SCENES', 'EDL has no scenes', 'Add at least one scene.');
  const [W, H] = opts.mode === 'preview' ? [960, 540] : [edl.output.width, edl.output.height];
  const fps = num(opts.sourceFps > 0 ? opts.sourceFps : edl.output.fps);

  const chains: string[] = [];
  const labels: string[] = [];
  let k = 0;
  for (const scene of edl.scenes) {
    const S = scene.zoom.scale;
    const { x: ax, y: ay } = scene.zoom.anchor;
    const crop =
      S > 1 + EPS
        ? `crop=trunc(iw/${num(S)}/2)*2:trunc(ih/${num(S)}/2)*2:(iw-iw/${num(S)})*${num(ax)}:(ih-ih/${num(S)})*${num(ay)},`
        : '';
    for (const seg of sceneSegments(scene)) {
      chains.push(
        `[0:v]trim=start=${num(seg.start)}:end=${num(seg.end)},setpts=PTS-STARTPTS,${crop}scale=${W}:${H}:flags=bicubic,setsar=1,fps=${fps}[v${k}]`,
      );
      chains.push(`[0:a]atrim=start=${num(seg.start)}:end=${num(seg.end)},asetpts=PTS-STARTPTS[a${k}]`);
      labels.push(`[v${k}][a${k}]`);
      k++;
    }
  }
  chains.push(`${labels.join('')}concat=n=${k}:v=1:a=1[vcat][acat]`);
  chains.push(`[acat]highpass=f=90,loudnorm=I=${num(edl.audio.loudnessLufs)}:TP=-1:LRA=11[aout]`);
  return chains.join(';');
}

export interface CompileOptions extends GraphOptions {
  input: string;
  output: string;
  encoder: Encoder;
}

export function compileEdl(edl: Edl, opts: CompileOptions): string[] {
  const graph = buildFilterGraph(edl, opts);
  const video =
    opts.mode === 'preview'
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28']
      : ['-c:v', opts.encoder.name, ...opts.encoder.extraArgs, '-b:v', bitrateFor(edl.output.width, edl.output.height, opts.sourceFps), '-g', String(Math.round((opts.sourceFps || edl.output.fps) * 2))];
  const audio = opts.mode === 'preview' ? ['-c:a', 'aac', '-b:a', '128k'] : ['-c:a', 'aac', '-b:a', '384k'];
  return [
    '-i', opts.input,
    '-filter_complex', graph,
    '-map', '[vcat]', '-map', '[aout]',
    ...video,
    '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    ...audio, '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    opts.output,
  ];
}
