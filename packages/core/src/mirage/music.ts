import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { isCard, MusicLibrarySchema, type Catalog, type ClipItem, type Episode, type MusicCue, type MusicLibrary, type MusicTrack } from '@wordedits/shared';
import type { MediaTools } from '../media-tools.js';
import { readJsonFile, writeJsonFile } from './json-file.js';
import { errorReason, MirageError } from './errors.js';
import { acquireLock, clearLeftovers } from './lock.js';
import { decodeMono, detectTempo } from './tempo.js';
import { itemFrames, shiftAfter } from './timeline.js';

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.aif', '.aiff', '.flac', '.ogg']);
const MIN_CONFIDENCE = 0.1;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export async function loadLibrary(dir: string): Promise<MusicLibrary> {
  try {
    return await readJsonFile(join(resolve(dir), 'library.json'), MusicLibrarySchema, 'music/library.json');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, tracks: [] };
    throw e;
  }
}

/** The same file name, whichever Unicode form (NFC/NFD) each side uses: macOS and other tools disagree on accents. */
export const sameFileName = (a: string, b: string) => a.normalize('NFC') === b.normalize('NFC');

export function findTrack(lib: MusicLibrary, file: string): MusicTrack | undefined {
  return lib.tracks.find((t) => sameFileName(t.file, file));
}

/** The library track a cue plays; NO_MUSIC_TRACK when library.json does not list it. */
export function cueTrack(c: MusicCue, i: number, lib: MusicLibrary): MusicTrack {
  const t = findTrack(lib, c.track);
  if (!t) throw new MirageError('NO_MUSIC_TRACK', `music cue ${i + 1}: ${c.track} is not in music/library.json`, 'Run: pnpm mirage music <project>, or fix the track name.');
  return t;
}

/** Stops with NO_MUSIC_TRACK when a cue's track is not in library.json or its file is gone from `musicDir`. */
export function checkCueFiles(cues: MusicCue[], lib: MusicLibrary, musicDir: string): void {
  cues.forEach((c, i) => {
    if (!existsSync(join(musicDir, cueTrack(c, i, lib).file))) {
      throw new MirageError('NO_MUSIC_TRACK', `music cue ${i + 1}: ${c.track} is missing from music/`, `Put ${c.track} back in ${musicDir}, or remove the cue.`);
    }
  });
}

export interface LibraryReport {
  library: MusicLibrary;
  /** Tracks whose file is in the folder and was read. */
  tracks: MusicTrack[];
  /** Tracks that were skipped or are missing (printed with ⚠). */
  warnings: string[];
}

/** The `music` command: adds the folder's new tracks to library.json and detects their tempo and duration. */
export async function analyzeLibrary(dir: string, tools: MediaTools): Promise<LibraryReport> {
  const root = resolve(dir);
  const lock = await acquireLock(root, 'music', 'the music folder');
  try {
    await clearLeftovers(root, lock, (f) => /^\.tmp-.*\.f32$/.test(f));
    return await analyzeLocked(root, tools);
  } finally {
    await lock.release();
  }
}

async function analyzeLocked(root: string, tools: MediaTools): Promise<LibraryReport> {
  const lib = await loadLibrary(root);
  const files = (await readdir(root)).filter((f) => !f.startsWith('.') && AUDIO_EXTENSIONS.has(extname(f).toLowerCase())).sort();
  const added = new Set<MusicTrack>();
  for (const file of files) {
    if (findTrack(lib, file)) continue;
    const track: MusicTrack = { file, mood: 'upbeat', licence: '', bpm: null, beatOffset: null, durationSec: null };
    lib.tracks.push(track);
    added.add(track);
  }
  const report: LibraryReport = { library: lib, tracks: [], warnings: [] };
  const unreadable = new Set<MusicTrack>();
  const skip = (track: MusicTrack, reason: string) => {
    report.warnings.push(`skipped ${track.file}: ${reason}`);
    unreadable.add(track);
  };
  for (const track of lib.tracks) {
    const onDisk = files.find((f) => sameFileName(f, track.file)) ?? (existsSync(join(root, track.file)) ? track.file : undefined);
    if (!onDisk) {
      report.warnings.push(`${track.file} is in library.json but not in the music folder — put it back, or remove its entry`);
      continue;
    }
    if (track.bpm !== null && track.beatOffset !== null && track.durationSec !== null) {
      report.tracks.push(track);
      continue;
    }
    const path = join(root, onDisk);
    let p;
    try {
      p = await tools.probe(path);
    } catch (e) {
      skip(track, errorReason(e));
      continue;
    }
    if (!p.hasAudio) {
      skip(track, 'no audio stream');
      continue;
    }
    if (!(p.durationSec > 0)) {
      skip(track, "its duration can't be read (a damaged or streamed file) — re-export it");
      continue;
    }
    if (track.bpm === null || track.beatOffset === null) {
      let samples: Float32Array;
      try {
        samples = await decodeMono(path, join(root, `.tmp-${randomUUID()}.f32`), tools, { sampleRate: 11025, maxSec: 90 });
      } catch (e) {
        skip(track, errorReason(e));
        continue;
      }
      const tempo = detectTempo(samples, 11025);
      // A weak or silent pulse is not a tempo: leave the grid unset so snapToBeats never snaps to an invented one.
      if (tempo.confidence >= MIN_CONFIDENCE) {
        track.bpm ??= tempo.bpm;
        track.beatOffset ??= tempo.beatOffset;
      }
    }
    track.durationSec ??= p.durationSec;
    report.tracks.push(track);
  }
  // A new file that could not be read is not added (it is retried next time); a listed one keeps its mood and licence.
  lib.tracks = lib.tracks.filter((t) => !(added.has(t) && unreadable.has(t)));
  await writeJsonFile(join(root, 'library.json'), MusicLibrarySchema, lib, 'music/library.json');
  return report;
}

/**
 * `item` (starting at output time `t`, lasting `oldDur`) ending on a beat of `cue`, or null to leave it alone. Its hold
 * is kept: the source part ends so that the item with its hold ends on the beat. The source runs on (or stops earlier)
 * within the clip's video; when the clip runs out, the item is slowed — except an item that keeps its live audio, which
 * only plays at its own speed: it takes the nearest beat its footage reaches instead.
 */
function snapItem(item: ClipItem, t: number, oldDur: number, cue: MusicCue, beat: number, fps: number, catalog: Catalog): ClipItem | null {
  const probe = catalog.clips.find((c) => c.id === item.clip)?.probe;
  const avail = (probe ? (probe.videoDurationSec ?? probe.durationSec) : item.src.out) - item.src.in;
  if (!(avail > 0)) return null;
  const keepsAudio = item.audio === 'keep';
  const holdFrames = Math.round(item.hold * fps);
  const startFrame = Math.round(t * fps);
  // Grid times are cue.start + k * beat (the offset step in snapToBeats puts a beat at the cue start).
  const kMin = Math.floor((t - cue.start) / beat + 1e-6) + 1;
  const kNear = Math.max(kMin, Math.round((t + oldDur - cue.start) / beat));
  // Beat ends nearest first (earlier before later at the same distance), a few beats either way.
  const ks = [kNear];
  for (let d = 1; d <= 8; d++) ks.push(kNear - d, kNear + d);
  for (const k of ks.filter((k) => k >= kMin)) {
    const srcFrames = Math.round((cue.start + k * beat) * fps) - startFrame - holdFrames;
    if (srcFrames < 1) continue;
    const target = srcFrames / fps;
    let srcLen = target * item.speed;
    let speed = item.speed;
    if (srcLen > avail - 1e-5) {
      // Kept audio plays only at its own speed: try a beat its footage reaches.
      if (keepsAudio) continue;
      srcLen = avail;
      speed = srcLen / target;
    }
    // Slowing it down below the schema's minimum speed: leave the item alone.
    if (speed < 0.25) return null;
    return { ...item, speed: r6(speed), src: { in: item.src.in, out: r6(item.src.in + srcLen) } };
  }
  return null;
}

/**
 * Starts each cue on a beat of its track, then ends every onBeat item on a beat of the cue playing under
 * it (extending the source, or slowing it when the clip runs out; see snapItem); cards are left alone. Item ends are snapped to the cue's
 * beat grid, not given a rounded duration, so frame rounding never accumulates into drift.
 * Everything after a changed item shifts with it. An episode with a fitted voice-over is returned unchanged.
 */
export function snapToBeats(ep: Episode, catalog: Catalog, lib: MusicLibrary): Episode {
  // The voice-over is fitted to these exact items (holds, splits): snapping now would pull them out of step.
  if (ep.voiceover) return ep;
  const track = (file: string) => findTrack(lib, file);
  let cur: Episode = {
    ...ep,
    music: ep.music.map((c) => {
      const t = track(c.track);
      if (!t?.bpm || t.beatOffset === null) return c;
      const beat = 60 / t.bpm;
      const k = Math.max(0, Math.ceil((c.offset - t.beatOffset) / beat - 1e-4));
      return { ...c, offset: r6(t.beatOffset + k * beat) };
    }),
  };
  if (cur.music.every((c, i) => c.offset === ep.music[i].offset) && !ep.items.some((it) => !isCard(it) && it.onBeat)) return ep;

  const fps = ep.output.fps;
  let t = 0;
  for (let i = 0; i < cur.items.length; i++) {
    const item = cur.items[i];
    const oldDur = itemFrames(item, fps).frames / fps;
    if (!isCard(item) && item.onBeat) {
      const cue = cur.music.find((c) => t >= c.start - 1e-6 && t < c.end);
      const tr = cue ? track(cue.track) : undefined;
      if (cue && tr?.bpm && tr.beatOffset !== null) {
        const next = snapItem(item, t, oldDur, cue, 60 / tr.bpm, fps, catalog);
        if (next) {
          const newDur = itemFrames(next, fps).frames / fps;
          const items = [...cur.items];
          items[i] = next;
          cur = { ...shiftAfter(cur, t + oldDur, newDur - oldDur), items };
          t += newDur;
          continue;
        }
      }
    }
    t += oldDur;
  }
  return cur;
}
