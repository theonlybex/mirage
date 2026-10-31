import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { MusicLibrarySchema, type Catalog, type Episode, type MusicLibrary } from '@wordedits/shared';
import type { MediaTools } from '../media-tools.js';
import { readJsonFile, writeJsonFile } from '../project-store.js';
import { MirageError } from './errors.js';
import { decodeMono, detectTempo } from './tempo.js';
import { itemFrames, shiftAfter } from './timeline.js';

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.aif', '.aiff', '.flac', '.ogg']);
const MIN_CONFIDENCE = 0.1;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export async function loadLibrary(dir: string): Promise<MusicLibrary> {
  try {
    return await readJsonFile(join(resolve(dir), 'library.json'), MusicLibrarySchema);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, tracks: [] };
    throw e;
  }
}

export async function analyzeLibrary(dir: string, tools: MediaTools): Promise<MusicLibrary> {
  const root = resolve(dir);
  const lib = await loadLibrary(root);
  const files = (await readdir(root)).filter((f) => !f.startsWith('.') && AUDIO_EXTENSIONS.has(extname(f).toLowerCase())).sort();
  for (const file of files) {
    if (!lib.tracks.some((t) => t.file === file)) lib.tracks.push({ file, mood: 'upbeat', licence: '', bpm: null, beatOffset: null, durationSec: null });
  }
  for (const track of lib.tracks) {
    if (track.bpm !== null && track.beatOffset !== null && track.durationSec !== null) continue;
    const path = join(root, track.file);
    const p = await tools.probe(path).catch(() => null);
    if (!p?.hasAudio) throw new MirageError('NO_MUSIC_TRACK', `${track.file} is missing or has no audio`, 'Remove it from music/library.json or add the file.');
    if (track.bpm === null || track.beatOffset === null) {
      const tempo = detectTempo(await decodeMono(path, join(root, `.tmp-${randomUUID()}.f32`), tools, { sampleRate: 11025, maxSec: 90 }), 11025);
      // A weak or silent pulse is not a tempo: leave the grid unset so snapToBeats never snaps to an invented one.
      if (tempo.confidence >= MIN_CONFIDENCE) {
        track.bpm ??= tempo.bpm;
        track.beatOffset ??= tempo.beatOffset;
      }
    }
    track.durationSec ??= p.durationSec;
  }
  await writeJsonFile(join(root, 'library.json'), MusicLibrarySchema, lib);
  return lib;
}

/**
 * Starts each cue on a beat of its track, then ends every onBeat item on a beat of the cue playing under
 * it (extending the source, or slowing it when the clip runs out). Item ends are snapped to the cue's
 * beat grid, not given a rounded duration, so frame rounding never accumulates into drift.
 * Everything after a changed item shifts with it.
 */
export function snapToBeats(ep: Episode, catalog: Catalog, lib: MusicLibrary): Episode {
  const track = (file: string) => lib.tracks.find((t) => t.file === file);
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
  if (cur.music.every((c, i) => c.offset === ep.music[i].offset) && !ep.items.some((it) => it.onBeat)) return ep;

  const fps = ep.output.fps;
  let t = 0;
  for (let i = 0; i < cur.items.length; i++) {
    const item = cur.items[i];
    const oldDur = itemFrames(item, fps).frames / fps;
    if (item.onBeat) {
      const cue = cur.music.find((c) => t >= c.start - 1e-6 && t < c.end);
      const tr = cue ? track(cue.track) : undefined;
      if (cue && tr?.bpm && tr.beatOffset !== null) {
        const beat = 60 / tr.bpm;
        // Grid times are cue.start + k * beat (the offset step above puts a beat at the cue start).
        const kEnd = Math.max(Math.floor((t - cue.start) / beat + 1e-6) + 1, Math.round((t + oldDur - cue.start) / beat));
        const startFrame = Math.round(t * fps);
        const frames = Math.max(1, Math.round((cue.start + kEnd * beat) * fps) - startFrame);
        const target = frames / fps;
        const clipDur = catalog.clips.find((c) => c.id === item.clip)?.probe.durationSec ?? item.src.out;
        const avail = clipDur - item.src.in;
        let srcLen = target * item.speed;
        let speed = item.speed;
        if (avail > 0 && srcLen > avail - 1e-5) {
          srcLen = avail;
          speed = srcLen / target;
        }
        // No footage left, or slowing it down would go below the schema's minimum speed: leave the item alone.
        if (avail > 0 && speed >= 0.25) {
          const next = { ...item, speed: r6(speed), hold: 0, src: { in: item.src.in, out: r6(item.src.in + srcLen) } };
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
