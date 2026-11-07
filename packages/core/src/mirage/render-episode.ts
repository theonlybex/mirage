import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EpisodeSchema, isCard, TranscriptSchema, type Catalog, type ClipItem, type Episode, type MusicCue, type MusicLibrary, type SfxCue, type Transcript, type VoiceLine } from '@wordedits/shared';
import { encodeArgs, ffNum } from './encode.js';
import type { Encoder, MediaTools } from '../media-tools.js';
import { readJsonFile, writeJsonFile } from './json-file.js';
import { asCancelled } from './cancel.js';
import { captionWarnings, karaokeLines, popLines, subtitleWarnings, type CaptionLine } from './captions.js';
import { MirageError } from './errors.js';
import { measureSfxLevel, resolveSfx, sfxSource, sfxVolumeDb, type SfxLevel } from './sfx.js';
import { bundledFontsDir } from './fonts.js';
import { cardImagesFor, type CardImage } from './cards.js';
import { loadCatalog, sha256File } from './ingest.js';
import { acquireLock, clearLeftovers, type Lock } from './lock.js';
import { moveExprs } from './move.js';
import { checkCueFiles, cueTrack, loadLibrary } from './music.js';
import { buildAss, groupCaptions, keptSegments, speechWords, toSrt } from './overlays.js';
import { decodeMono } from './tempo.js';
import { fadesFor, singleFade, spills, type Fade, type ItemFades, type Spill } from './spill.js';
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

/** The catalogued clip behind each clip item, checked (cards have no footage). */
export function sourcesFor(ep: Episode, catalog: Catalog): Map<string, ClipSource> {
  const map = new Map<string, ClipSource>();
  for (const item of ep.items) {
    if (isCard(item)) continue;
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

/**
 * Chunk size for these sources and card pictures: smaller when any is larger than 1080p. A picture counts like a clip:
 * FFmpeg 7 and newer decode each input's frame ahead, about 96 MB for a 24-megapixel photo.
 */
export function chunkSize(sources: Map<string, ClipSource>, cardImages?: Map<string, CardImage>): number {
  const large = (s: { width?: number; height?: number }) => (s.width ?? 0) * (s.height ?? 0) > 1920 * 1080;
  return [...sources.values()].some(large) || [...(cardImages?.values() ?? [])].some(large) ? CHUNK_ITEMS_LARGE : CHUNK_ITEMS;
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
export function episodeChunks(laid: LaidItem[], o: ChunkShape, sources: Map<string, ClipSource>, output: string): LaidItem[][] {
  const out: LaidItem[][] = [];
  for (const group of chunkItems(laid, chunkSize(sources, o.cardImages))) {
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
function cropAt(focus: ClipItem['focus']): string {
  return Math.abs(focus.x - 0.5) < 1e-6 && Math.abs(focus.y - 0.5) < 1e-6 ? '' : `:(iw-ow)*${ffNum(focus.x)}:(ih-oh)*${ffNum(focus.y)}`;
}

/**
 * Filters that bring a picture of any shape to the output size: fit letterboxes it, fill crops it around the focus,
 * blur puts it over a copy of itself filled, blurred and darkened (blurred at an eighth of the area, so it stays cheap).
 */
function framed(frame: ClipItem['frame'], at: string, o: { width: number; height: number }, k: number): string {
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
function moveFilters(l: LaidItem, item: ClipItem, k: number, o: { width: number; height: number; fps: number }, src: ClipSource): string {
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

/**
 * The filters that turn a picture of each EXIF orientation (1–8) upright: 2 is mirrored, 3 upside down, 4 mirrored
 * upside down, 5 mirrored on its diagonal, 6 needs a quarter turn clockwise, 7 mirrored on the other diagonal, 8 a
 * quarter turn anticlockwise.
 */
const UPRIGHT = ['', '', 'hflip,', 'hflip,vflip,', 'vflip,', 'transpose=0,', 'transpose=1,', 'transpose=3,', 'transpose=2,'];

/**
 * An image card's picture as an input: read once by the demuxer for what it is (so neither its name nor a % or * in its
 * path matters), with FFmpeg's own rotation off (some versions turn a JPEG by its EXIF and some don't; cardPicture turns
 * it from the orientation Mirage read itself).
 */
export function cardPictureInput(pic: CardImage, fps: number): string[] {
  return ['-noautorotate', '-f', `${pic.format}_pipe`, '-framerate', ffNum(fps), '-i', pic.path];
}

/**
 * The filters that make an image card's picture (cardPictureInput) a frame of `o`'s size: turned upright, laid on black,
 * scaled to cover the frame and cropped (centred, or around `focus`), at the clips' limited range. `k` names the labels
 * of a chain with more than one picture.
 */
export function cardPicture(pic: CardImage, o: { width: number; height: number }, k = 0, focus: ClipItem['focus'] = { x: 0.5, y: 0.5 }): string {
  // A PNG's colour times its alpha is the picture over black: clear parts black, not whatever colour they hold.
  const flat = pic.format === 'png' ? 'format=rgba,premultiply=inplace=1,' : '';
  // A JPEG decodes full range on the BT.601 matrix (yuvj420p): left so, the chunk would be encoded full range, the
  // clips beside it converted to match, and as the first chunk the whole episode would come out full range
  // (-pix_fmt yuv420p doesn't bring it back on FFmpeg 7 and newer). Brought to the clips' limited range and BT.709.
  const range = pic.format === 'jpeg' ? ',scale=out_range=tv:out_color_matrix=bt709,format=yuv420p' : '';
  // FFmpeg 7.1 and newer still pass the JPEG's rotation on to the chunk with -noautorotate; as the first frame of
  // the first chunk, the concat demuxer would carry it into the final pass, which would turn the whole episode.
  return `sidedata=mode=delete:type=DISPLAYMATRIX,${UPRIGHT[pic.orientation ?? 1] ?? ''}${flat}${framed('fill', cropAt(focus), o, k)}${range},setsar=1`;
}

/**
 * A chunk's output size and frame rate, the pictures of its image cards (cardImagesFor), and the fades J- and L-cuts ask
 * of shots' own sound (fadesFor), by item id.
 */
export interface ChunkShape {
  width: number;
  height: number;
  fps: number;
  cardImages?: Map<string, CardImage>;
  fades?: Map<string, ItemFades>;
}

/**
 * Reads `src` from `sec` on its own clock (0 = `sec`): seeks to the keyframe before it, or, before a late-starting video
 * stream (no keyframe to seek to: the demuxer would move the audio up to the video's first frame too, losing the sound
 * before it), reads from the start on the same clock.
 */
export function readFrom(src: ClipSource, sec: number): string[] {
  if (sec < (src.videoStartSec ?? 0)) return [...(sec > 0 ? ['-itsoffset', ffNum(-sec)] : []), '-i', src.path];
  return ['-noaccurate_seek', '-ss', ffNum(sec), '-i', src.path];
}

/**
 * A clip's sound from its input's clock 0 (readFrom) for `sec` seconds, as 48 kHz stereo float: aresample on the source
 * clock drops what the seek read before 0 and pads silence before audio that starts late (or across a gap), so the sound
 * stays with its picture.
 */
const ownSound = (k: number, src: ClipSource, sec: number) => `[${k}:a:${src.audioStream ?? 0}]aresample=48000:async=1:first_pts=0,${FLTP_STEREO},atrim=end=${ffNum(sec)}`;

/**
 * An equal-power fade (Fade) on a sound whose timestamps start at 0. One that starts before the sound does is the later
 * part of a longer fade: the sound's timestamps are moved on to where it begins in the fade (afade goes by them), then back.
 */
function fadeFilter(f: Fade): string {
  const d = `d=${ffNum(f.sec)}:curve=qsin`;
  if (f.st < 0) return `asetpts=PTS-STARTPTS+${ffNum(-f.st)}/TB,afade=t=${f.t}${f.t === 'out' ? ':st=0' : ''}:${d},asetpts=PTS-STARTPTS`;
  return f.t === 'in' && f.st === 0 ? `afade=t=in:${d}` : `afade=t=${f.t}:st=${ffNum(f.st)}:${d}`;
}

/** An item's own sound's fades (fadesFor), in then out, each after a comma; nothing without them. */
const crossfades = (f: ItemFades | undefined) => [f?.fadeIn, f?.fadeOut].map((x) => (x ? `,${fadeFilter(x)}` : '')).join('');

export function itemChunkArgs(laid: LaidItem[], o: ChunkShape, sources: Map<string, ClipSource>, output: string): string[] {
  const inputs: string[] = [];
  const chains: string[] = [];
  const labels: string[] = [];
  laid.forEach((l, k) => {
    const { item } = l;
    const dur = ffNum(l.frames / o.fps);
    const silence = `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end=${dur},${FLTP_STEREO}[a${k}]`;
    if (isCard(item)) {
      if (item.card.style === 'image') {
        // A picture card is its picture, read once (by the demuxer for what it is, so neither its name nor a % or * in
        // its path matters), turned upright, laid on black, scaled to cover the frame, cropped centred, then held for the
        // card's length (equivalent to -loop 1, which decodes a 24-megapixel picture again for every frame). Its text
        // comes in the final pass. FFmpeg's own rotation is off: some versions turn a JPEG by its EXIF and some don't,
        // so Mirage turns it from the orientation it read itself.
        const pic = o.cardImages?.get(item.id);
        if (!pic) throw new MirageError('BAD_ITEM', `item ${item.id}: card image ${item.card.image} was not checked before rendering`, 'Run check, then render again.');
        inputs.push(...cardPictureInput(pic, o.fps));
        chains.push(`[${k}:v]${cardPicture(pic, o, k)},tpad=stop=-1:stop_mode=clone,trim=end_frame=${l.frames},setpts=PTS-STARTPTS[v${k}]`, silence);
      } else {
        // A text card is black for its length, at the chunk's size (its text comes in the final pass); all cards are silent.
        inputs.push('-f', 'lavfi', '-i', `color=c=black:s=${o.width}x${o.height}:r=${ffNum(o.fps)}:d=${ffNum((l.frames + 1) / o.fps)}`);
        chains.push(`[${k}:v]trim=end_frame=${l.frames},setsar=1,setpts=PTS-STARTPTS[v${k}]`, silence);
      }
      labels.push(`[v${k}][a${k}]`);
      return;
    }
    const src = sources.get(item.clip)!;
    // Real-time items decode on one thread each (a chunk opens up to 30 inputs); sped-up items read far more source
    // than they output, so they get four (all threads cost a 4K decoder over 1 GB; four keep most of the speed).
    inputs.push('-threads', item.speed <= 1 ? '1' : '4');
    // Seek to the keyframe before src.in and keep the source clock (time 0 = src.in) instead of starting at the first
    // frame after the seek point: VFR screen recordings write no frames while the screen is still, and a video stream
    // can start after the container does.
    // Before a late-starting video stream it reads from the start instead, on the same clock (readFrom).
    inputs.push(...readFrom(src, item.src.in));
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
        ? `${head}${hold}${moveFilters(l, item, k, o, src)},setsar=1,setpts=PTS-STARTPTS[v${k}]`
        : `${head}${zoom}${framed(item.frame, at, o, k)},setsar=1,${hold}setpts=PTS-STARTPTS[v${k}]`,
    );
    if (item.audio === 'keep' && item.speed === 1 && src.hasAudio) {
      // Cut at src.out before padding silence under a hold. Where a neighbour's lead or tail plays over this shot, its
      // sound fades out under the lead or in under the tail.
      chains.push(`${ownSound(k, src, l.srcFrames / o.fps)},apad,atrim=end=${dur},asetpts=PTS-STARTPTS${crossfades(o.fades?.get(item.id))}[a${k}]`);
    } else {
      chains.push(silence);
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
  const srcSec = chunk.reduce((s, l) => s + (isCard(l.item) ? 0 : l.item.src.out - l.item.src.in), 0);
  const outSec = chunk.reduce((s, l) => s + l.frames / fps, 0);
  return Math.round(Math.max(120, srcSec * 3 + outSec * 30) * 1000);
}

/** Seconds a dip takes to fade the music out (ending at its start) and back in (starting at its end). */
const DIP_FADE_SEC = 0.08;

/**
 * A cue's dips as a gain on every sample, on the cue's own clock (0 = the cue's start): for each dip, 1 → 0 over the 80 ms
 * before its start, 0 until its end, back to 1 over the 80 ms after; dips multiply. A dip outside the cue does nothing
 * and adds nothing. Nothing at all for a cue without dips.
 */
function dipFilters(c: MusicCue, dur: number): string[] {
  const terms = (c.dips ?? [])
    .map((d) => ({ s: d.start - c.start, e: d.end - c.start }))
    .filter((d) => d.e > 0 && d.s < dur)
    .map((d) => `(clip((${ffNum(d.s)}-t)/${DIP_FADE_SEC},0,1)+clip((t-${ffNum(d.e)})/${DIP_FADE_SEC},0,1))`);
  if (!terms.length) return [];
  const gain = terms.join('*');
  // Sample-exact time for aeval's t: the number of samples so far.
  return ['asetpts=N/SR/TB', `aeval='val(0)*${gain}|val(1)*${gain}':c=same`];
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
        ...dipFilters(c, dur),
        `adelay=delays=${Math.round(c.start * 1000)}:all=1[m${i}]`,
      ].join(','),
    );
  });
  chains.push(`${cues.map((_, i) => `[m${i}]`).join('')}amix=inputs=${cues.length}:duration=longest:normalize=0,apad,atrim=end=${ffNum(durationSec)}[out]`);
  return [...inputs, '-filter_complex', chains.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', output];
}

/** A sound effect ready to place: its file, the output time `at` its peak (`peakSec` into the file) lands on, and its gain. */
export interface PlacedSfx {
  file: string;
  at: number;
  peakSec: number;
  durationSec: number;
  volumeDb: number;
}

/**
 * The sound effects track (48 kHz stereo float WAV, `durationSec` long): each sound starts at `at − peakSec`, so its peak
 * lands on `at`; one that would start before 0 loses its beginning instead (the episode never gets longer), and whatever
 * runs past the end is cut. Each is set to its `volumeDb` (no loudnorm, which turns short silence into NaN). Overlapping
 * sounds add; float samples keep a sum over full scale for the final pass's limiter. Every sound must start before `durationSec`.
 */
export function sfxTrackArgs(sounds: PlacedSfx[], durationSec: number, output: string): string[] {
  const SR = 48000;
  const inputs: string[] = [];
  const chains: string[] = [];
  sounds.forEach((x, i) => {
    const start = x.at - x.peakSec;
    const skip = Math.max(0, -start);
    const delay = Math.max(0, start);
    // Reading stops where the episode ends: a long file isn't decoded to its end.
    inputs.push('-t', ffNum(skip + durationSec - delay), '-i', x.file);
    chains.push(
      [
        `[${i}:a]aresample=${SR},${FLTP_STEREO}`,
        // Sample-exact: the cut and the delay count samples, not timestamps.
        'asetpts=N/SR/TB',
        ...(skip > 0 ? [`atrim=start_sample=${Math.round(skip * SR)}`, 'asetpts=PTS-STARTPTS'] : []),
        `volume=${ffNum(x.volumeDb)}dB`,
        `adelay=delays=${Math.round(delay * SR)}S:all=1[s${i}]`,
      ].join(','),
    );
  });
  chains.push(`${sounds.map((_, i) => `[s${i}]`).join('')}amix=inputs=${sounds.length}:duration=longest:normalize=0,apad,atrim=end=${ffNum(durationSec)}[out]`);
  return [...inputs, '-filter_complex', chains.join(';'), '-map', '[out]', '-c:a', 'pcm_f32le', '-ar', String(SR), '-ac', '2', output];
}

/** A spill and its fade (fadesFor; without one, singleFade: a lead fades in over its length, a tail out). */
export type FadedSpill = Spill & { fade?: Fade };

/**
 * The spill track of J- and L-cuts (48 kHz stereo float WAV, `durationSec` long): each spill is its clip's sound from
 * `srcIn` to `srcOut`, read as the shot reads it, faded with an equal-power curve (the shot's sound under it fades the
 * other way) and placed sample-exact at `at`. `under`, an earlier part of the track, is mixed in as it is.
 */
export function spillTrackArgs(list: FadedSpill[], sources: Map<string, ClipSource>, durationSec: number, output: string, under?: string): string[] {
  const SR = 48000;
  const inputs: string[] = [];
  const chains: string[] = [];
  list.forEach((s, i) => {
    const src = sources.get(s.clip)!;
    inputs.push(...readFrom(src, s.srcIn));
    const sec = ffNum(s.sec);
    const fade = fadeFilter(s.fade ?? singleFade(s));
    chains.push(`${ownSound(i, src, s.sec)},apad,atrim=end=${sec},asetpts=PTS-STARTPTS,${fade},adelay=delays=${Math.round(s.at * SR)}S:all=1[s${i}]`);
  });
  if (under) inputs.push('-i', under);
  const mix = [...list.map((_, i) => `[s${i}]`), ...(under ? [`[${list.length}:a]`] : [])];
  chains.push(`${mix.join('')}amix=inputs=${mix.length}:duration=longest:normalize=0,apad,atrim=end=${ffNum(durationSec)}[out]`);
  return [...inputs, '-filter_complex', chains.join(';'), '-map', '[out]', '-c:a', 'pcm_f32le', '-ar', String(SR), '-ac', '2', output];
}

/**
 * The commands that make the spill track `dir`/spill.wav: one, or as many as keep each under MAX_COMMAND (every spill
 * opens an input), each writing a part that the next mixes in.
 */
export function spillTrackCommands(list: FadedSpill[], sources: Map<string, ClipSource>, durationSec: number, dir: string): string[][] {
  const out = join(dir, 'spill.wav');
  const part = (n: number) => join(dir, `spill-${n}.wav`);
  const groups: FadedSpill[][] = [];
  let group: FadedSpill[] = [];
  for (const s of list) {
    const under = groups.length ? part(groups.length - 1) : undefined;
    // Measured with a part's name, the longer of the two it may write.
    if (group.length && commandLength(spillTrackArgs([...group, s], sources, durationSec, part(groups.length), under)) > MAX_COMMAND) {
      groups.push(group);
      group = [];
    }
    group.push(s);
  }
  groups.push(group);
  return groups.map((g, n) => spillTrackArgs(g, sources, durationSec, n === groups.length - 1 ? out : part(n), n ? part(n - 1) : undefined));
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

/**
 * The sound effects that play (one whose start, `at` minus its peak, is at or after the end never does), each resolved to its file and peak, measured once
 * per distinct file and set so its loudest 400 ms sits at `loudnessLufs + gainDb` (sfxVolumeDb). Files are made or read
 * in `work`.
 */
async function placeSfx(project: string, cues: SfxCue[], durationSec: number, loudnessLufs: number, tools: MediaTools, work: string, signal?: AbortSignal): Promise<PlacedSfx[]> {
  const sounds = new Map<string, { file: string; peakSec: number; durationSec: number }>();
  const levels = new Map<string, SfxLevel>();
  const placed: PlacedSfx[] = [];
  for (const [k, c] of cues.entries()) {
    if (!sounds.has(c.sound)) sounds.set(c.sound, await resolveSfx(project, c.sound, tools, { label: `sfx ${k + 1}`, tmpDir: work, signal }));
    const s = sounds.get(c.sound)!;
    // A sound starts at `at − peak`: when that is at the end or later, none of it plays.
    if (c.at - s.peakSec >= durationSec - 1e-6) continue;
    // An empty file has nothing to play.
    if (!(s.durationSec > 0)) continue;
    if (!levels.has(s.file)) levels.set(s.file, await measureSfxLevel(s.file, tools, { metaFile: join(work, `level-${levels.size}.txt`), signal }));
    placed.push({ ...s, at: c.at, volumeDb: sfxVolumeDb(levels.get(s.file)!, loudnessLufs + c.gainDb) });
  }
  return placed;
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
  /** The sound effects track (sfxTrackArgs): added after the music is ducked, before the limiter, never ducked itself. */
  sfxWav?: string;
  /** Some item keeps its live sound (default true). */
  liveAudio?: boolean;
  /** The spill track of J- and L-cuts (spillTrackArgs): the shots' own sound, mixed into the speech bus before it is normalised. */
  spillWav?: string;
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
  const sfxIdx = o.sfxWav ? next++ : -1;
  if (o.sfxWav) inputs.push('-i', o.sfxWav);
  const spillIdx = o.spillWav ? next++ : -1;
  if (o.spillWav) inputs.push('-i', o.spillWav);
  const D = ffNum(o.durationSec);

  const chains = [`[0:v]ass=${filterValue(o.assFile)}${o.fontsDir ? `:fontsdir=${filterValue(o.fontsDir)}` : ''}[vout]`];
  if (o.voiceRaw || o.spillWav) {
    // The live sound, the voice-over and the shots' sound carried over a cut make one speech bus.
    chains.push(`[0:a]${FLTP_STEREO}[live]`);
    if (o.voiceRaw) chains.push(`[${voiceIdx}:a]${FLTP_STEREO},apad,atrim=end=${D}[vo]`);
    if (o.spillWav) chains.push(`[${spillIdx}:a]${FLTP_STEREO},apad,atrim=end=${D}[spill]`);
    const parts = ['[live]', ...(o.voiceRaw ? ['[vo]'] : []), ...(o.spillWav ? ['[spill]'] : [])];
    chains.push(`${parts.join('')}amix=inputs=${parts.length}:duration=first:normalize=0[speechraw]`);
  } else {
    chains.push('[0:a]anull[speechraw]');
  }
  // A speech bus with no live sound and no voice-over is silence, which needs no normalising. loudnorm turns digital
  // silence shorter than 3 s into NaN, so an episode that short is measured over 3.1 s (silence after its end), then
  // cut back to length.
  const normalise = o.liveAudio !== false || o.voiceRaw !== undefined || o.spillWav !== undefined;
  const short = normalise && o.durationSec < LOUDNORM_MIN_SEC;
  chains.push(
    `[speechraw]highpass=f=90,${normalise ? `${short ? `apad=whole_dur=${LOUDNORM_MIN_SEC},` : ''}loudnorm=I=${lufs(o.loudnessLufs)}:TP=-1:LRA=11,` : ''}` +
      `aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,asetpts=N/SR/TB${short ? `,atrim=end=${D}` : ''}${o.musicWav || o.sfxWav ? '[speech]' : '[aout]'}`,
  );
  // Sound effects join the mix after the ducking (they never duck) and go through the limiter with everything else.
  const sfx = o.sfxWav ? '[sfx]' : '';
  if (o.sfxWav) chains.push(`[${sfxIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=end=${D}[sfx]`);
  const limited = (n: number) => `amix=inputs=${n}:duration=first:normalize=0,alimiter=limit=0.891:level=false[aout]`;
  if (o.musicWav) {
    chains.push(
      '[speech]asplit=2[smix][skey]',
      `[${musicIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=end=${D}[mus]`,
      // Measured: a -14 LUFS speech key ducks -19 LUFS music by about 16 dB (steady tone) to 17 dB (continuous speech);
      // music on its own is below the threshold and passes untouched.
      '[mus][skey]sidechaincompress=threshold=0.025:ratio=12:attack=150:release=900[duck]',
      `[smix][duck]${sfx}${limited(o.sfxWav ? 3 : 2)}`,
    );
  } else if (o.sfxWav) {
    chains.push(`[speech][sfx]${limited(2)}`);
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
  // An episode of only cards needs no clips.
  if (catalog.clips.length === 0 && !ep.items.every(isCard)) throw new MirageError('NO_CATALOG', 'The project has no catalogued clips', 'Run: pnpm mirage ingest <project> <clips folder>');
  const sources = sourcesFor(ep, catalog);
  // A card's picture missing or unreadable stops here, as check does, before any work.
  const cardImages = cardImagesFor(project, ep);
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
  // The guide cut has no sound effects: the person records narration against it.
  const sfxCues = o.mode === 'guide' ? [] : (ep.sfx ?? []);
  sfxCues.forEach((c, k) => sfxSource(project, c.sound, `sfx ${k + 1}`));
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
  // Pop and karaoke captions, cards, name labels, chosen subtitles and time tags are drawn in the bundled fonts: a broken
  // install stops here, not with libass's fallback font.
  const style = o.mode === 'guide' ? 'off' : (ep.captions?.style ?? 'phrase');
  const cards = laid.flatMap((l) => (isCard(l.item) ? [{ start: l.start, end: l.end, card: l.item.card }] : []));
  const labels = ep.overlays.some((ov) => ov.kind === 'name' || ov.kind === 'subtitle' || ov.kind === 'timecard');
  const fontsDir = style === 'pop' || style === 'karaoke' || cards.length || labels ? bundledFontsDir() : undefined;
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
    // Before the chunks: a sound file FFmpeg can't read stops the render here.
    const sfx = await placeSfx(project, sfxCues, D, ep.loudnessLufs, o.tools, work, o.signal);
    // J- and L-cuts: the shots' own sound played over the cut, and the fades they ask of the shots' sound under them.
    const spilled = spills(ep, sources, laid).spills;
    const crossfaded = spilled.length ? fadesFor(laid, spilled) : undefined;
    const shape: ChunkShape = { width: W, height: H, fps, cardImages, ...(crossfaded ? { fades: crossfaded.items } : {}) };
    const chunks = episodeChunks(laid, shape, sources, join(work, `chunk-${pad3(0)}.mov`));
    let done = 0;
    for (const [i, chunk] of chunks.entries()) {
      o.signal?.throwIfAborted();
      const dur = chunk.reduce((s, l) => s + l.frames / fps, 0);
      await o.tools.runFfmpeg(itemChunkArgs(chunk, shape, sources, join(work, `chunk-${pad3(i)}.mov`)), {
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
    let sfxWav: string | undefined;
    if (sfx.length) {
      o.signal?.throwIfAborted();
      await o.tools.runFfmpeg(sfxTrackArgs(sfx, D, join(work, 'sfx.wav')), { expectedDurationSec: D, timeoutMs: Math.max(120_000, D * 10 * 1000), signal: o.signal });
      sfxWav = 'sfx.wav';
    }
    let spillWav: string | undefined;
    if (spilled.length) {
      for (const args of spillTrackCommands(spilled.map((s, i) => ({ ...s, fade: crossfaded!.spills[i] })), sources, D, work)) {
        o.signal?.throwIfAborted();
        await o.tools.runFfmpeg(args, { expectedDurationSec: D, timeoutMs: Math.max(120_000, D * 10 * 1000), signal: o.signal });
      }
      spillWav = 'spill.wav';
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
        overlays: ep.overlays, prompts: o.mode === 'guide' ? ep.slots : [], cards,
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
        loudnessLufs: ep.loudnessLufs, assFile: 'overlays.ass', fontsDir, musicWav, voiceRaw, sfxWav, spillWav,
        liveAudio: laid.some((l) => !isCard(l.item) && l.item.audio === 'keep' && l.item.speed === 1 && sources.get(l.item.clip)!.hasAudio),
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
    // Likewise a chosen subtitle the narration doesn't say: only the final render knows the voice-over's words.
    const warnings = [...(final ? lineChangeWarnings(ep, 'render') : []), ...captionNotes, ...(final ? subtitleWarnings(words, ep.overlays) : [])];
    return { outputPath, srtPath, durationSec: D, warnings };
  } catch (e) {
    await rm(partial, { force: true }).catch(() => {});
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
