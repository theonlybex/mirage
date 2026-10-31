import { join, resolve } from 'node:path';
import type { Episode } from '@wordedits/shared';
import { loadCatalog } from './ingest.js';
import { loadLibrary, snapToBeats } from './music.js';
import { loadEpisode, saveEpisode, sourcesFor } from './render-episode.js';
import { cutChanged, cutChangedError } from './voiceover.js';

/**
 * The `check` command: validates the timeline against the catalog (clips exist, ranges fit), snaps montages to the beat
 * (not once a voice-over is fitted), saves it, and collects what the user should know: `warnings` (⚠) and `notes`.
 */
export async function checkEpisode(project: string, n: number): Promise<{ episode: Episode; warnings: string[]; notes: string[] }> {
  const root = resolve(project);
  const catalog = await loadCatalog(root);
  let ep = await loadEpisode(root, n);
  sourcesFor(ep, catalog);
  const warnings: string[] = [];
  const notes: string[] = [];
  const lib = await loadLibrary(join(root, 'music'));
  if (lib.tracks.length && ep.voiceover) {
    if (ep.items.some((i) => i.onBeat) || ep.music.length) notes.push('Montages were not snapped to the beat: the voice-over is fitted to this cut.');
  } else if (lib.tracks.length) {
    ep = snapToBeats(ep, catalog, lib);
  }
  await saveEpisode(root, ep);

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
  return { episode: ep, warnings, notes };
}
