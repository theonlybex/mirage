import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EpisodeSchema, TranscriptSchema, type Catalog, type Episode, type MusicCue, type MusicLibrary, type TimelineItem, type Transcript, type VoiceLine } from '@wordedits/shared';
import { encodeArgs, ffNum } from './encode.js';
import type { Encoder, MediaTools } from '../media-tools.js';
import { readJsonFile, writeJsonFile } from './json-file.js';
import { asCancelled } from './cancel.js';
import { captionWarnings, karaokeLines, popLines, type CaptionLine } from './captions.js';
import { MirageError } from './errors.js';
import { bundledFontsDir } from './fonts.js';
import { loadCatalog, sha256File } from './ingest.js';
import { acquireLock, clearLeftovers, type Lock } from './lock.js';
import { moveExprs } from './move.js';
import { checkCueFiles, cueTrack, loadLibrary } from './music.js';
import { buildAss, groupCaptions, keptSegments, speechWords, toSrt } from './overlays.js';
import { decodeMono } from './tempo.js';
import { layoutTimeline, type LaidItem } from './timeline.js';
import { cutChanged, cutChangedError, fittedRecordingSha, lineChangeWarnings } from './voiceover.js';

export const CHUNK_ITEMS = 30;
/** Items per chunk when a source is larger than 1080p: every input of a chunk opens a decoder, and 4K ones are big. */
export const CHUNK_ITEMS_LARGE = 12;
const pad3 = (i: number) => String(i).padStart(3, '0');

export interface ClipSource {
  path: string;
  hasAudio: boolean;
  durationSec: number;
  /** The audio stream with the clip's sound (default the first). */
  audioStream?: number;
  /** When the video stream starts, if after the clip does (its sound comes first). */
  videoStartSec?: number;
  /** Picture size as displayed (0 when unknown). */
  width?: number;
  height?: number;
}

export function sourcesFor(ep: Episode, catalog: Catalog): Map<string, ClipSource> {
  const map = new Map<string, ClipSource>();
  for (const item of ep.items) {
    const clip = catalog.clips.find((c) => c.id === item.clip);
    if (!clip) throw new MirageError('BAD_ITEM', `item ${item.id}: clip ${item.clip} is not in the catalog`, 'Run ingest, or fix the clip id in episode.json.');
    if (item.src.out > clip.probe.durationSec + 0.05) {
      throw new MirageError('BAD_ITEM', `item ${item.id}: src.out ${item.src.out}s is past the end of ${item.clip} (${clip.probe.durationSec}s)`, 'Shorten the item.');
    }
    // Audio can run on after the picture stops (or a cut-short file's header promise more): past the video there is
    // no frame to show.
    const videoEnd = clip.probe.videoDurationSec ?? clip.probe.durationSec;
    if (item.src.out > videoEnd + 0.1) {
      throw new MirageError('BAD_ITEM', `item ${item.id}: ${item.clip} has video only until ${videoEnd.toFixed(1)} s (src.out is ${item.src.out} s)`, `End the item by ${videoEnd.toFixed(1)} s; the rest of ${item.clip} is sound only.`);
    }
    if (!existsSync(clip.path)) {
      throw new MirageError('BAD_ITEM', `item ${item.id}: clip file ${clip.path} is missing`, 'Reconnect the drive or re-ingest the folder it moved to');
    }
    map.set(clip.id, { path: clip.path, hasAudio: clip.probe.hasAudio, durationSec: clip.probe.durationSec, audioStream: clip.probe.audioStream, videoStartSec: clip.probe.videoStartSec, width: clip.probe.width, height: clip.probe.height });
  }
  return map;
}

export function chunkItems(laid: LaidItem[], size = CHUNK_ITEMS): LaidItem[][] {
  const out: LaidItem[][] = [];
  for (let i = 0; i < laid.length; i += size) out.push(laid.slice(i, i + size));
  return out;
}

/** Chunk size for these sources: smaller when any is larger than 1080p. */
export function chunkSize(sources: Map<string, ClipSource>): number {
  return [...sources.values()].some((s) => (s.width ?? 0) * (s.height ?? 0) > 1920 * 1080) ? CHUNK_ITEMS_LARGE : CHUNK_ITEMS;
}

/**
 * The longest FFmpeg command a chunk may run, in characters, on every platform: Windows refuses a command line over
 * 32,767, and this leaves room for FFmpeg's path and the options runFfmpeg adds. An item with a move adds about 1,200.
 */
export const MAX_COMMAND = 24_000;

/** A command's length as Windows writes it: each argument quoted, with a space before it. */
export const commandLength = (args: string[]) => args.reduce((n, a) => n + a.length + 3, 0);

/**
 * The episode's chunks: chunkSize's count of items each, cut early when a chunk's command (itemChunkArgs to `output`)
 * would pass MAX_COMMAND. An item alone is always a chunk.
 */
export function episodeChunks(laid: LaidItem[], o: { width: number; height: number; fps: number }, sources: Map<string, ClipSource>, output: string): LaidItem[][] {
  const out: LaidItem[][] = [];
  for (const group of chunkItems(laid, chunkSize(sources))) {
    let chunk: LaidItem[] = [];
    for (const l of group) {
      if (chunk.length && commandLength(itemChunkArgs([...chunk, l], o, sources, output)) > MAX_COMMAND) {
        out.push(chunk);
        chunk = [];
      }
      chunk.push(l);
    }
    out.push(chunk);
  }
  return out;
}

const FLTP_STEREO = 'aformat=sample_fmts=fltp:channel_layouts=stereo';
/** Shorter than this, loudnorm turns digital silence into NaN (and the AAC encoder then fails). */
const LOUDNORM_MIN_SEC = 3.1;
/** loudnorm rejects targets outside [-70, -5] LUFS. */
const lufs = (n: number) => ffNum(Math.min(-5, Math.max(-70, n)));

/** Seconds a source frame may be stamped after the time it is picked for (a quarter of a frame at `fps`). */
export const frameTolerance = (fps: number) => ffNum(1 / (4 * fps));

/** A crop's offset that keeps `focus` in view; nothing for the centre (crop's own default). */
function cropAt(focus: TimelineItem['focus']): string {
  return Math.abs(focus.x - 0.5) < 1e-6 && Math.abs(focus.y - 0.5) < 1e-6 ? '' : `:(iw-ow)*${ffNum(focus.x)}:(ih-oh)*${ffNum(focus.y)}`;
}

/**
 * Filters that bring a picture of any shape to the output size: fit letterboxes it, fill crops it around the focus,
 * blur puts it over a copy of itself filled, blurred and darkened (blurred at an eighth of the area, so it stays cheap).
 */
function framed(frame: TimelineItem['frame'], at: string, o: { width: number; height: number }, k: number): string {
  const { width: W, height: H } = o;
  if (frame === 'fill') return `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}${at}`;
  if (frame === 'blur') {
    const w = Math.max(2, Math.round(W / 8) * 2);
    const h = Math.max(2, Math.round(H / 8) * 2);
    return (
      `split[fg${k}][bg${k}];[bg${k}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}${at},gblur=sigma=12,eq=brightness=-0.08,scale=${W}:${H}[bb${k}];` +
      `[fg${k}]scale=${W}:${H}:force_original_aspect_ratio=decrease[ff${k}];[bb${k}][ff${k}]overlay=(W-w)/2:(H-h)/2`
    );
  }
  return `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

/**
 * An animated zoom (the item's `move`): perspective sends each frame's crop window, at the zoom and focus moveFrames
 * gives that frame, to the picture's corners. It samples between pixels, so a slow push-in moves a steady fraction of a
 * pixel each frame (crop and zoompan place the window on whole pixels, which shimmers). It samples bicubic: the window
 * is enlarged by the zoom, and bilinear leaves a push-in that ends at 1.3× about 17% softer than a fixed 1.3× (bicubic
 * about 1%). For fill the window is cut to the output's shape inside the move, placed by the focus as fill's crop
 * is, so the focus can pan it and the picture after it is only scaled to size.
 */
function moveFilters(l: LaidItem, k: number, o: { width: number; height: number; fps: number }, src: ClipSource): string {
  const { item } = l;
  const { width: W, height: H } = o;
  const fill = item.frame === 'fill';
  // perspective works on every pixel of the picture each frame: a picture larger than framing needs at the move's
  // closest zoom (fit and blur fit it inside the output, fill covers it) is scaled down to that first.
  const zMax = Math.max(item.zoom, item.move!.zoom);
  const fit = fill ? 'max' : 'min';
  const larger = !!src.width && !!src.height && Math[fit](W / src.width, H / src.height) * zMax < 1;
  const pre = larger ? `scale=w='trunc(iw*${fit}(${W}/iw,${H}/ih)*${ffNum(zMax)}/2)*2':h=-2,` : '';
  // The window: the picture over the zoom (for fill, cut to the output's shape), its corner at (W−w)·x, (H−h)·y.
  // perspective counts frames from 1.
  const { e, zoom, x, y } = moveExprs(item, l.frames, o.fps, 'in', 1, l.clock);
  const [w, h] = fill ? [`min(W,H*${W}/${H})`, `min(H,W*${H}/${W})`] : ['W', 'H'];
  const left = `${e};st(1,${w}/(${zoom}));(W-ld(1))*(${x})`;
  const top = `${e};st(1,${h}/(${zoom}));(H-ld(1))*(${y})`;
  return (
    `${pre}perspective=x0='${left}':y0='${top}':x1='${left}+ld(1)':y1='${top}':x2='${left}':y2='${top}+ld(1)':x3='${left}+ld(1)':y3='${top}+ld(1)'` +
    `:interpolation=cubic:eval=frame,${fill ? `scale=${W}:${H}` : framed(item.frame, cropAt(item.focus), o, k)}`
  );
}

export function itemChunkArgs(laid: LaidItem[], o: { width: number; height: number; fps: number }, sources: Map<string, ClipSource>, output: string): string[] {
  const inputs: string[] = [];
  const chains: string[] = [];
  const labels: string[] = [];
  laid.forEach((l, k) => {
    const { item } = l;
    const src = sources.get(item.clip)!;
    // Real-time items decode on one thread each (a chunk opens up to 30 inputs); sped-up items read far more source
    // than they output, so they get four (all threads cost a 4K decoder over 1 GB; four keep most of the speed).
    inputs.push('-threads', item.speed <= 1 ? '1' : '4');
    // Seek to the keyframe before src.in and keep the source clock (time 0 = src.in) instead of starting at the first
    // frame after the seek point: VFR screen recordings write no frames while the screen is still, and a video stream
    // can start after the container does.
    // Before a late-starting video stream there is no keyframe to seek to: the demuxer would move the audio up to the
    // video's first frame too, losing the sound before it. Read from the start instead, on the same clock.
    if (item.src.in < (src.videoStartSec ?? 0)) inputs.push(...(item.src.in > 0 ? ['-itsoffset', ffNum(-item.src.in)] : []), '-i', src.path);
    else inputs.push('-noaccurate_seek', '-ss', ffNum(item.src.in), '-i', src.path);
    const at = cropAt(item.focus);
    const zoom = item.zoom > 1 + 1e-6 ? `crop=trunc(iw/${ffNum(item.zoom)}/2)*2:trunc(ih/${ffNum(item.zoom)}/2)*2${at},` : '';
    // fps (right after setpts, so it drops frames before any crop or scale touches them) shows at each output frame
    // the latest source frame at or before its time: it holds a frame across a gap, and the first frame until a late
    // video stream starts. A frame up to a quarter of an output frame late still counts as on time: MKV and WebM store
    // times in milliseconds (30 fps frame 2 at 0.067 s, after its true 0.0667 s), and on-grid times would otherwise
    // show every third frame twice and skip the next. The first trim keeps one frame past src.out for a hold and ends
    // decoding there. The hold clones the last frame after framing it, except under a move: held frames keep moving, so
    // the hold comes first and the move and framing work on every frame.
    const head = `[${k}:v]setpts=(PTS-${frameTolerance(o.fps)}/TB)/${ffNum(item.speed)},fps=${ffNum(o.fps)}:start_time=0:round=up,trim=end_frame=${l.srcFrames + 1},`;
    const hold = `tpad=stop=-1:stop_mode=clone,trim=end_frame=${l.frames},`;
    chains.push(
      item.move
        ? `${head}${hold}${moveFilters(l, k, o, src)},setsar=1,setpts=PTS-STARTPTS[v${k}]`
        : `${head}${zoom}${framed(item.frame, at, o, k)},setsar=1,${hold}setpts=PTS-STARTPTS[v${k}]`,
    );
    const dur = ffNum(l.frames / o.fps);
    if (item.audio === 'keep' && item.speed === 1 && src.hasAudio) {
      // aresample on the source clock drops what the seek read before src.in and pads silence before audio that
      // starts late (or across a gap), so sound stays with its picture. Cut at src.out before padding under a hold.
      chains.push(`[${k}:a:${src.audioStream ?? 0}]aresample=48000:async=1:first_pts=0,${FLTP_STEREO},atrim=end=${ffNum(l.srcFrames / o.fps)},apad,atrim=end=${dur},asetpts=PTS-STARTPTS[a${k}]`);
    } else {
      chains.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end=${dur},${FLTP_STEREO}[a${k}]`);
    }
    labels.push(`[v${k}][a${k}]`);
  });
  chains.push(`${labels.join('')}concat=n=${laid.length}:v=1:a=1[vcat][acat]`);
  return [
    ...inputs,
    '-filter_complex', chains.join(';'),
    '-map', '[vcat]', '-map', '[acat]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-g', String(Math.round(o.fps)),
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    output,
  ];
}

/** The rough cut's size: the output's shape with its longer side at most 960, both sides even (1920×1080 → 960×540, 1080×1920 → 540×960). */
export function previewSize(width: number, height: number): [number, number] {
  const scale = Math.min(1, 960 / Math.max(width, height));
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return [even(width), even(height)];
}

/** Time allowed for one chunk: decoding grows with the source seconds read, encoding with the output seconds written. */
export function chunkTimeoutMs(chunk: LaidItem[], fps: number): number {
  const srcSec = chunk.reduce((s, l) => s + (l.item.src.out - l.item.src.in), 0);
  const outSec = chunk.reduce((s, l) => s + l.frames / fps, 0);
  return Math.round(Math.max(120, srcSec * 3 + outSec * 30) * 1000);
}

export function musicTrackArgs(cues: MusicCue[], lib: MusicLibrary, musicDir: string, durationSec: number, loudnessLufs: number, output: string): string[] {
  const inputs: string[] = [];
  const chains: string[] = [];
  cues.forEach((c, i) => {
    inputs.push('-stream_loop', '-1', '-ss', ffNum(c.offset), '-i', join(musicDir, cueTrack(c, i, lib).file));
    const dur = c.end - c.start;
    // loudnorm turns under 3 s of digital silence into NaN: a short cue is measured over 3 s of its (looping) track.
    const measured = Math.max(dur, LOUDNORM_MIN_SEC);
    const fades = [
      c.fadeIn > 0 ? `afade=t=in:d=${ffNum(Math.min(c.fadeIn, dur / 2))}` : '',
      c.fadeOut > 0 ? `afade=t=out:st=${ffNum(Math.max(0, dur - c.fadeOut))}:d=${ffNum(Math.min(c.fadeOut, dur))}` : '',
    ].filter(Boolean);
    chains.push(
      [
        // With -stream_loop and -ss, loop seams overlap timestamps by the offset; renumbering by sample count
        // keeps atrim and afade (both timestamp-based) on the cue's real length.
        `[${i}:a]asetpts=N/SR/TB,atrim=duration=${ffNum(measured)}`,
        'asetpts=PTS-STARTPTS',
        `aresample=48000,${FLTP_STEREO}`,
        `loudnorm=I=${lufs(loudnessLufs + c.gainDb)}:TP=-2:LRA=11`,
        `aresample=48000,${FLTP_STEREO}`,
        ...(measured > dur ? [`atrim=duration=${ffNum(dur)}`] : []),
        ...fades,
        `adelay=delays=${Math.round(c.start * 1000)}:all=1[m${i}]`,
      ].join(','),
    );
  });
  chains.push(`${cues.map((_, i) => `[m${i}]`).join('')}amix=inputs=${cues.length}:duration=longest:normalize=0,apad,atrim=end=${ffNum(durationSec)}[out]`);
  return [...inputs, '-filter_complex', chains.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', output];
}

/** Lays the fitted lines out on the timeline. `recording` is one decoded recording, or one per path (lines without their own `recording` use `defaultRecording`). */
export function buildVoiceTrack(o: { recording: Float32Array | Map<string, Float32Array>; defaultRecording?: string; sampleRate: number; lines: VoiceLine[]; durationSec: number }): Float32Array {
  const sr = o.sampleRate;
  const out = new Float32Array(Math.round(o.durationSec * sr));
  const fade = Math.max(1, Math.round(0.008 * sr));
  for (const line of o.lines) {
    const rec = o.recording instanceof Map ? o.recording.get(line.recording ?? o.defaultRecording ?? '') : o.recording;
    if (!rec) throw new MirageError('BAD_ITEM', `line ${line.slot}: its recording ${line.recording ?? o.defaultRecording} was not loaded`, 'Run vo again for that recording.');
    for (const seg of keptSegments(line)) {
      const from = Math.round(seg.in * sr);
      const to = Math.min(rec.length, Math.round(seg.out * sr));
      const at = Math.round((line.at + seg.offset) * sr);
      const n = to - from;
      for (let i = 0; i < n && at + i < out.length; i++) {
        const gain = Math.max(0, Math.min(1, i / fade, (n - 1 - i) / fade));
        out[at + i] += rec[from + i] * (fade <= 1 ? 1 : gain);
      }
    }
  }
  return out;
}

export interface FinalEpisodeOptions {
  chunkList: string;
  output: string;
  encoder: Encoder;
  mode: 'preview' | 'final';
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  loudnessLufs: number;
  assFile: string;
  /** A folder of fonts for libass to load (all of them, into memory): only ever the plugin's own. */
  fontsDir?: string;
  musicWav?: string;
  voiceRaw?: string;
  /** Some item keeps its live sound (default true). */
  liveAudio?: boolean;
}

/**
 * A filter option's value as it must be written in a filter graph: escaped for the option list (\ ' :), then for the
 * graph (\ ' [ ] , ;). Spaces inside need nothing.
 */
export const filterValue = (v: string) => v.replace(/[\\':]/g, '\\$&').replace(/[\\'[\],;]/g, '\\$&');

export function episodeFinalArgs(o: FinalEpisodeOptions): string[] {
  const inputs = ['-f', 'concat', '-safe', '0', '-i', o.chunkList];
  let next = 1;
  const musicIdx = o.musicWav ? next++ : -1;
  if (o.musicWav) inputs.push('-i', o.musicWav);
  const voiceIdx = o.voiceRaw ? next++ : -1;
  if (o.voiceRaw) inputs.push('-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', o.voiceRaw);
  const D = ffNum(o.durationSec);

  const chains = [`[0:v]ass=${filterValue(o.assFile)}${o.fontsDir ? `:fontsdir=${filterValue(o.fontsDir)}` : ''}[vout]`];
  if (o.voiceRaw) {
    chains.push(`[0:a]${FLTP_STEREO}[live]`, `[${voiceIdx}:a]${FLTP_STEREO},apad,atrim=end=${D}[vo]`, '[live][vo]amix=inputs=2:duration=first:normalize=0[speechraw]');
  } else {
    chains.push('[0:a]anull[speechraw]');
  }
  // A speech bus with no live sound and no voice-over is silence, which needs no normalising. loudnorm turns digital
  // silence shorter than 3 s into NaN, so an episode that short is measured over 3.1 s (silence after its end), then
  // cut back to length.
  const normalise = o.liveAudio !== false || o.voiceRaw !== undefined;
  const short = normalise && o.durationSec < LOUDNORM_MIN_SEC;
  chains.push(
    `[speechraw]highpass=f=90,${normalise ? `${short ? `apad=whole_dur=${LOUDNORM_MIN_SEC},` : ''}loudnorm=I=${lufs(o.loudnessLufs)}:TP=-1:LRA=11,` : ''}` +
      `aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,asetpts=N/SR/TB${short ? `,atrim=end=${D}` : ''}${o.musicWav ? '[speech]' : '[aout]'}`,
  );
  if (o.musicWav) {
    chains.push(
      '[speech]asplit=2[smix][skey]',
      `[${musicIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=end=${D}[mus]`,
      // Measured: a -14 LUFS speech key ducks -19 LUFS music by about 16 dB (steady tone) to 17 dB (continuous speech);
      // music on its own is below the threshold and passes untouched.
      '[mus][skey]sidechaincompress=threshold=0.025:ratio=12:attack=150:release=900[duck]',
      '[smix][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.891:level=false[aout]',
    );
  }
  return [...inputs, '-filter_complex', chains.join(';'), '-map', '[vout]', '-map', '[aout]', ...encodeArgs(o), '-t', D, o.output];
}

export const episodeDir = (project: string, n: number) => join(resolve(project), 'episodes', String(n));

const noEpisode = (n: number) => new MirageError('NO_EPISODE', `episodes/${n}/episode.json does not exist`, 'Ask Claude to write the episode timeline first.');
const wrongNumber = (n: number, found: number) =>
  new MirageError('NO_EPISODE', `episodes/${n}/episode.json says it is episode ${found}`, `Set "number" to ${n} in episodes/${n}/episode.json.`);

/** Loads episodes/<n>/episode.json. Refuses a file whose `number` is not `n` (a copied episode), so no save lands in another episode's folder. */
export async function loadEpisode(project: string, n: number): Promise<Episode> {
  let ep: Episode;
  try {
    ep = await readJsonFile(join(episodeDir(project, n), 'episode.json'), EpisodeSchema, `episodes/${n}/episode.json`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw noEpisode(n);
    }
    throw e;
  }
  if (ep.number !== n) throw wrongNumber(n, ep.number);
  return ep;
}

/** Writes episodes/<n>/episode.json; `n` (the folder it was loaded from) defaults to the episode's number and must match it. */
export async function saveEpisode(project: string, ep: Episode, n: number = ep.number): Promise<void> {
  if (ep.number !== n) throw wrongNumber(n, ep.number);
  const dir = episodeDir(project, n);
  await mkdir(dir, { recursive: true });
  // Unchanged content is not rewritten, so checking an unchanged episode writes nothing.
  await writeJsonFile(join(dir, 'episode.json'), EpisodeSchema, ep, `episodes/${n}/episode.json`, { onlyIfChanged: true });
}

export type EpisodeMode = 'rough' | 'guide' | 'final';

/** Every recording the voice-over's lines use (the voice-over's own recording when it has no lines yet). */
export function voiceRecordings(ep: Episode): string[] {
  const vo = ep.voiceover;
  if (!vo) return [];
  return vo.lines.length ? [...new Set(vo.lines.map((l) => l.recording ?? vo.recording))] : [vo.recording];
}

/** The transcript of each recording the voice-over uses, keyed by recording path. */
export async function loadVoiceoverTranscripts(project: string, ep: Episode): Promise<Map<string, Transcript>> {
  const n = ep.number;
  const dir = episodeDir(project, n);
  const out = new Map<string, Transcript>();
  for (const rec of voiceRecordings(ep)) {
    const file = ep.voiceover!.transcripts[rec] ?? 'voiceover.transcript.json';
    try {
      out.set(rec, await readJsonFile(join(dir, file), TranscriptSchema, `episodes/${n}/${file}`));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new MirageError('NO_EPISODE', `episodes/${n}/${file} is missing`, `Run: pnpm mirage vo <project> ${n} ${rec}`);
      }
      throw e;
    }
  }
  return out;
}

/**
 * Takes episode `n`'s lock for `command` (render modes and vo work in its folder), then clears what killed commands left
 * there: work folders, partial outputs, extracted voice-over WAVs and old temp files of atomic writes.
 */
export async function lockEpisode(project: string, n: number, command: string): Promise<Lock> {
  const dir = episodeDir(project, n);
  if (!existsSync(dir)) throw noEpisode(n);
  const lock = await acquireLock(dir, command, `episode ${n}`);
  await clearLeftovers(dir, lock, (f) => f.startsWith('.work-') || f.includes('.partial-') || /^\.vo-.*\.wav$/.test(f));
  return lock;
}

const COMMAND: Record<EpisodeMode, string> = { rough: 'cut', guide: 'guide', final: 'render' };

type RenderOptions = {
  project: string;
  episode: number;
  mode: EpisodeMode;
  tools: MediaTools;
  musicDir?: string;
  onProgress?: (f: number) => void;
  /** Aborting stops the render: the work folder and partial file are removed, and it throws CANCELLED. */
  signal?: AbortSignal;
  /** Runs once the lock is held, before rendering (cut's check, which may save episode.json). */
  beforeRender?: () => Promise<unknown>;
};

export type RenderResult = {
  outputPath: string;
  srtPath: string | null;
  durationSec: number;
  /** Things the user should hear about (printed with ⚠): lines edited since the voice-over was fitted, captions settings that do nothing. */
  warnings: string[];
};

/** Renders episode `episode` in `mode`, holding the episode's lock so a second render of it refuses instead of deleting this one's work. */
export async function renderEpisode(o: RenderOptions): Promise<RenderResult> {
  const lock = await lockEpisode(resolve(o.project), o.episode, COMMAND[o.mode]);
  try {
    o.signal?.throwIfAborted();
    await o.beforeRender?.();
    return await renderLocked(o);
  } catch (e) {
    throw asCancelled(e, o.signal);
  } finally {
    await lock.release();
  }
}

async function renderLocked(o: RenderOptions): Promise<RenderResult> {
  const project = resolve(o.project);
  const ep = await loadEpisode(project, o.episode);
  const catalog = await loadCatalog(project);
  if (catalog.clips.length === 0) throw new MirageError('NO_CATALOG', 'The project has no catalogued clips', 'Run: pnpm mirage ingest <project> <clips folder>');
  const sources = sourcesFor(ep, catalog);
  // A voice-over fitted to another cut would play out of step with the picture.
  if (o.mode === 'final' && cutChanged(ep)) throw cutChangedError();
  const laid = layoutTimeline(ep);
  const D = laid[laid.length - 1].end;
  const fps = ep.output.fps;
  const final = o.mode === 'final';
  const [W, H] = final ? [ep.output.width, ep.output.height] : previewSize(ep.output.width, ep.output.height);
  const dir = episodeDir(project, o.episode);
  // Everything below is checked before any rendering, so a missing file fails fast.
  const musicDir = resolve(o.musicDir ?? join(project, 'music'));
  const lib = ep.music.length ? await loadLibrary(musicDir) : null;
  if (lib) checkCueFiles(ep.music, lib, musicDir);
  const voTranscripts = final && ep.voiceover ? await loadVoiceoverTranscripts(project, ep) : null;
  const recordings = final ? voiceRecordings(ep) : [];
  for (const rec of recordings) {
    const abs = resolve(project, rec);
    if (!existsSync(abs)) throw new MirageError('BAD_ITEM', `voice-over recording ${abs} is missing`, 'Reconnect the drive or put the recording back, then render again.');
    // A recording saved over since the fit would play other words at the lines' times.
    const was = fittedRecordingSha(ep.voiceover!, rec);
    if (was && !(await sha256File(abs)).startsWith(was)) {
      throw new MirageError('BAD_ITEM', `voice-over recording ${abs} changed since vo fitted it`, `Put back the recording you fitted, or run vo again with the new one: pnpm mirage vo <project> ${o.episode} <recording> (then --add for lines from other recordings).`);
    }
  }
  // Pop and karaoke captions are drawn in the bundled font: a broken install stops here, not with libass's fallback font.
  const style = o.mode === 'guide' ? 'off' : (ep.captions?.style ?? 'phrase');
  const fontsDir = style === 'pop' || style === 'karaoke' ? bundledFontsDir() : undefined;
  // Every render's last pass draws overlays.ass with FFmpeg's ass filter: an FFmpeg without libass fails there, after all the work.
  const captions = await o.tools.ffmpegCaptions?.();
  if (captions && !captions.ok) {
    throw new MirageError('NO_CAPTIONS', `FFmpeg can't draw captions or text: ${captions.path} was built without libass.`, captions.hint);
  }
  const outputPath = join(dir, `${o.mode}.mp4`);
  const id = randomUUID();
  const work = join(dir, `.work-${id}`);
  const partial = `${outputPath}.partial-${id}.mp4`;
  await mkdir(work, { recursive: true });
  const report = (f: number) => o.onProgress?.(Math.min(1, Math.max(0, f)));

  try {
    const chunks = episodeChunks(laid, { width: W, height: H, fps }, sources, join(work, `chunk-${pad3(0)}.mov`));
    let done = 0;
    for (const [i, chunk] of chunks.entries()) {
      o.signal?.throwIfAborted();
      const dur = chunk.reduce((s, l) => s + l.frames / fps, 0);
      await o.tools.runFfmpeg(itemChunkArgs(chunk, { width: W, height: H, fps }, sources, join(work, `chunk-${pad3(i)}.mov`)), {
        expectedDurationSec: dur,
        timeoutMs: chunkTimeoutMs(chunk, fps),
        signal: o.signal,
        onProgress: (f) => report((0.6 * (done + f * dur)) / D),
      });
      done += dur;
    }
    o.signal?.throwIfAborted();
    await writeFile(join(work, 'chunks.txt'), chunks.map((_, i) => `file 'chunk-${pad3(i)}.mov'`).join('\n') + '\n');

    let musicWav: string | undefined;
    if (ep.music.length) {
      o.signal?.throwIfAborted();
      await o.tools.runFfmpeg(musicTrackArgs(ep.music, lib!, musicDir, D, ep.loudnessLufs, join(work, 'music.wav')), {
        expectedDurationSec: D,
        timeoutMs: Math.max(120_000, D * 10 * 1000),
        signal: o.signal,
      });
      musicWav = 'music.wav';
    }
    report(0.7);
    o.signal?.throwIfAborted();

    let voiceRaw: string | undefined;
    if (final && ep.voiceover) {
      const pcm = new Map<string, Float32Array>();
      for (const [i, rec] of recordings.entries()) pcm.set(rec, await decodeMono(resolve(project, rec), join(work, `rec-${i}.f32`), o.tools, { sampleRate: 48000, clipTime: true, signal: o.signal }));
      const track = buildVoiceTrack({ recording: pcm, defaultRecording: ep.voiceover.recording, sampleRate: 48000, lines: ep.voiceover.lines, durationSec: D });
      await writeFile(join(work, 'vo.f32'), Buffer.from(track.buffer, track.byteOffset, track.byteLength));
      voiceRaw = 'vo.f32';
    }

    // final.srt is always phrase cues; what is burned in depends on the captions style (the guide cut burns in none).
    const words = o.mode === 'guide' ? [] : speechWords(ep, catalog, voTranscripts);
    const cues = groupCaptions(words, { durationSec: D });
    let captionLines: { style: 'pop' | 'karaoke'; lines: CaptionLine[] } | undefined;
    if (style === 'pop') captionLines = { style, lines: popLines(words, { durationSec: D, highlight: ep.captions!.highlight }) };
    if (style === 'karaoke') captionLines = { style, lines: karaokeLines(words, { durationSec: D }) };
    await writeFile(
      join(work, 'overlays.ass'),
      buildAss({
        width: W, height: H, captions: style === 'phrase' ? cues : [], captionLines, position: ep.captions?.position, highlightColor: ep.captions?.color,
        overlays: ep.overlays, prompts: o.mode === 'guide' ? ep.slots : [],
      }),
    );

    o.signal?.throwIfAborted();
    const encoder = final ? await o.tools.pickEncoder() : { name: 'libx264' as const, extraArgs: [] };
    await o.tools.runFfmpeg(
      episodeFinalArgs({
        chunkList: 'chunks.txt', output: partial, encoder, mode: final ? 'final' : 'preview', width: W, height: H, fps, durationSec: D,
        // fontsdir only for the plugin's own fonts folder: libass loads every font in it into memory (about 1 GB for
        // /System/Library/Fonts), and it finds system fonts and fallbacks itself; buildAss names a font for the scripts
        // whose fallback it can't open.
        loudnessLufs: ep.loudnessLufs, assFile: 'overlays.ass', fontsDir, musicWav, voiceRaw,
        liveAudio: laid.some((l) => l.item.audio === 'keep' && l.item.speed === 1 && sources.get(l.item.clip)!.hasAudio),
      }),
      { cwd: work, expectedDurationSec: D, timeoutMs: Math.max(120_000, D * 20 * 1000), signal: o.signal, onProgress: (f) => report(0.7 + 0.3 * f) },
    );
    const probe = await o.tools.probe(partial);
    const tolerance = Math.max(0.1, 1 / fps);
    if (Math.abs(probe.durationSec - D) > tolerance) {
      throw new MirageError('DURATION_MISMATCH', `Rendered ${probe.durationSec}s but the timeline is ${D}s`, 'A clip may be shorter than the catalog says; re-run ingest.');
    }
    // The audio alone can make the length right while the picture stops early.
    const videoSec = probe.videoDurationSec ?? probe.durationSec;
    if (!probe.hasVideo || Math.abs(videoSec - D) > tolerance) {
      throw new MirageError('DURATION_MISMATCH', `Rendered ${probe.hasVideo ? videoSec : 0}s of picture but the timeline is ${D}s`, 'A clip may have less video than the catalog says; re-run ingest.');
    }
    // The last point to stop at: the output is replaced only when the render finished and was not cancelled.
    o.signal?.throwIfAborted();
    await rename(partial, outputPath);
    let srtPath: string | null = null;
    if (final) {
      srtPath = join(dir, 'final.srt');
      await writeFile(srtPath, toSrt(cues));
    }
    report(1);
    // The voice-over says what was fitted, and its captions say the same: a line edited since then is only flagged.
    // A highlight word "never said" is known only with the narration's words (final): a rough cut says only that a
    // highlight does nothing with a style other than pop.
    const captionNotes = final || (o.mode === 'rough' && ep.captions?.style !== 'pop') ? captionWarnings(words, ep.captions) : [];
    const warnings = [...(final ? lineChangeWarnings(ep, 'render') : []), ...captionNotes];
    return { outputPath, srtPath, durationSec: D, warnings };
  } catch (e) {
    await rm(partial, { force: true }).catch(() => {});
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
