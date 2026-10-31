import { join, resolve } from 'node:path';
import type { Episode, MusicLibrary } from '@wordedits/shared';
import { loadCatalog } from './ingest.js';
import { checkCueFiles, findTrack, loadLibrary, snapToBeats } from './music.js';
import { undrawable } from './overlays.js';
import { loadEpisode, saveEpisode, sourcesFor } from './render-episode.js';
import { dropCollapsed, layoutTimeline, timelineDuration } from './timeline.js';
import { cutChanged, cutChangedError } from './voiceover.js';

/** The music cue gain every cue got before 9af3199; cues saved by a check back then carry it explicitly. */
const OLD_DEFAULT_GAIN_DB = -18;
const s1 = (n: number) => n.toFixed(1);
const s2 = (n: number) => n.toFixed(2);

/** Timeline problems that don't stop a cut but that the user should hear about. */
function timelineWarnings(ep: Episode, lib: MusicLibrary | null, snapped: boolean): string[] {
  const out: string[] = [];
  const D = timelineDuration(ep);
  ep.overlays.forEach((o, i) => {
    if (o.start >= D - 1e-6) out.push(`overlay ${i + 1} ("${o.text}") starts at ${s2(o.start)} s, after the episode ends (${s2(D)} s) — it will never show`);
    if (undrawable(o.text)) out.push(`overlay ${i + 1} ("${o.text}") has emoji, which can't be drawn — they are left out`);
  });
  ep.music.forEach((c, i) => {
    if (c.start >= D - 1e-6) out.push(`music cue ${i + 1} (${c.track}) starts at ${s2(c.start)} s, after the episode ends (${s2(D)} s) — it will never play`);
  });
  if (snapped) {
    // Same rule as snapToBeats: the cue playing at the item's start decides its beat.
    for (const l of layoutTimeline(ep)) {
      if (!l.item.onBeat) continue;
      const cue = ep.music.find((c) => l.start >= c.start - 1e-6 && l.start < c.end);
      const track = cue && lib ? findTrack(lib, cue.track) : undefined;
      if (!cue) out.push(`item ${l.item.id} is onBeat but no music plays under it — left unsnapped`);
      else if (!track?.bpm || track.beatOffset === null) out.push(`item ${l.item.id} is onBeat but ${cue.track} has no clear beat — left unsnapped`);
      else {
        const beat = 60 / track.bpm;
        const k = Math.round((l.end - cue.start) / beat);
        if (Math.abs(cue.start + k * beat - l.end) <= 0.5 / ep.output.fps + 1e-6) continue;
        out.push(
          l.item.audio === 'keep'
            ? `item ${l.item.id} keeps its live audio, which plays only at normal speed, and ${l.item.clip} has no footage left to reach a beat — left unsnapped`
            : `item ${l.item.id} could not reach a beat: ${l.item.clip} has too little footage left — left unsnapped`,
        );
      }
    }
  }
  ep.music.forEach((c, i) => {
    const len = lib ? findTrack(lib, c.track)?.durationSec : null;
    if (len && c.offset + (c.end - c.start) > len + 0.05) {
      out.push(`music cue ${i + 1} plays ${s1(c.end - c.start)} s of ${c.track} from ${s1(c.offset)} s, but the track is ${s1(len)} s long — it will loop`);
    }
  });
  ep.music.forEach((c, i) => {
    if (c.gainDb === OLD_DEFAULT_GAIN_DB) out.push(`music cue ${i + 1} has gainDb ${OLD_DEFAULT_GAIN_DB}, the old default (now -5) — delete gainDb to use the new one`);
  });
  return out;
}

/**
 * The `check` command: validates the timeline against the catalog (clips exist, ranges fit) and the music library (cue
 * tracks listed and present), snaps montages to the beat (not once a voice-over is fitted), saves it if that changed
 * anything, and collects what the user should know: `warnings` (⚠) and `notes`.
 */
export async function checkEpisode(project: string, n: number): Promise<{ episode: Episode; warnings: string[]; notes: string[] }> {
  const root = resolve(project);
  const catalog = await loadCatalog(root);
  let ep = await loadEpisode(root, n);
  sourcesFor(ep, catalog);
  const warnings: string[] = [];
  const notes: string[] = [];
  // library.json only matters to an episode with music: a broken one must not block a cut without any.
  const musicDir = join(root, 'music');
  const lib = ep.music.length ? await loadLibrary(musicDir) : null;
  if (lib) checkCueFiles(ep.music, lib, musicDir);
  if (ep.voiceover) {
    if (ep.items.some((i) => i.onBeat) || ep.music.length) notes.push('Montages were not snapped to the beat: the voice-over is fitted to this cut.');
  } else if (lib) {
    const snapped = dropCollapsed(snapToBeats(ep, catalog, lib));
    ep = snapped.episode;
    for (const d of snapped.dropped) warnings.push(`${d} was inside time that beat snapping removed, so it was dropped — place it again on the times above`);
  }
  await saveEpisode(root, ep, n);

  if (cutChanged(ep)) {
    const e = cutChangedError();
    warnings.push(`${e.message}. ${e.hint}`);
  }
  for (const item of ep.items) {
    if (item.audio !== 'keep' || item.speed !== 1) continue;
    const clip = catalog.clips.find((c) => c.id === item.clip);
    if (clip?.probe.hasAudio && clip.transcript === null) {
      warnings.push(`item ${item.id} keeps audio from ${clip.id}, which has no transcript — narration slots and captions won't see its speech`);
    }
  }
  warnings.push(...timelineWarnings(ep, lib, !ep.voiceover));
  return { episode: ep, warnings, notes };
}
