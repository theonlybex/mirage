import { join, resolve } from 'node:path';
import { isCard, type ClipItem, type Episode, type Move, type MusicLibrary } from '@wordedits/shared';
import type { MediaTools } from '../media-tools.js';
import { checkCardImages } from './cards.js';
import { loadCatalog } from './ingest.js';
import { checkCueFiles, findTrack, loadLibrary, snapToBeats } from './music.js';
import { splitShots } from './move.js';
import { undrawable } from './overlays.js';
import { loadEpisode, saveEpisode, sourcesFor } from './render-episode.js';
import { fileUnreadable, sfxSource, unreadableSfx } from './sfx.js';
import { slotsStale } from './slots.js';
import { dropCollapsed, layoutTimeline, timelineDuration } from './timeline.js';
import { cutChanged, cutChangedError, hasWords, lineChangeWarnings } from './voiceover.js';

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
    if (o.sub && undrawable(o.sub)) out.push(`overlay ${i + 1} ("${o.sub}") has emoji, which can't be drawn — they are left out`);
    // A subtitle sits where automatic captions do, on another layer, so libass doesn't move either out of the way.
    const auto = (ep.captions?.style ?? 'phrase') !== 'chosen' && ep.captions?.style !== 'off';
    if (o.kind === 'subtitle' && auto) out.push(`subtitle overlay ${i + 1} ("${o.text}") shows over the automatic captions — use captions style chosen, or remove it`);
  });
  // A move's times are seconds of the shot's output length, held frames included. It never plays when it starts on the
  // frame after the shot's last (moveFrames' timing).
  const fps = ep.output.fps;
  const moveWarning = (id: string, m: Move, frames: number) => {
    const len = frames / fps;
    if (m.start !== undefined && Math.round(m.start * fps) >= frames) out.push(`item ${id}'s move starts at ${s2(m.start)} s, after the shot ends (${s2(len)} s) — it never plays`);
    else if (m.end !== undefined && m.end > len + 0.5 / fps) out.push(`item ${id}'s move ends at ${s2(m.end)} s, after the shot ends (${s2(len)} s) — it stops at the end of the shot`);
  };
  const laid = layoutTimeline(ep);
  // The parts of a shot voice-over fitting split play its move on one clock: checked once, as the shot was before the
  // fit froze frames inside it (its source frames and its end hold), so fitting never causes a warning.
  const shotAt = new Map(splitShots(ep.items).map((s) => [s.to, s]));
  for (const l of laid) {
    const m = isCard(l.item) ? undefined : l.item.move;
    if (m && !l.clock) moveWarning(l.item.id, m, l.frames);
    const shot = shotAt.get(l.index);
    if (!shot) continue;
    const parts = laid.slice(shot.from, shot.to + 1);
    if (!parts.some((p) => p.clock)) continue;
    const frames = parts.reduce((s, p) => s + p.srcFrames, 0) + l.holdFrames;
    const { splitFrom } = l.item as ClipItem;
    moveWarning(splitFrom!.item, splitFrom!.move, frames);
  }
  ep.music.forEach((c, i) => {
    if (c.start >= D - 1e-6) out.push(`music cue ${i + 1} (${c.track}) starts at ${s2(c.start)} s, after the episode ends (${s2(D)} s) — it will never play`);
  });
  if (snapped) {
    // Same rule as snapToBeats: the cue playing at the item's start decides its beat.
    for (const l of layoutTimeline(ep)) {
      if (isCard(l.item) || !l.item.onBeat) continue;
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
  const sfx = ep.sfx ?? [];
  sfx.forEach((x, k) => {
    if (x.at > D + 1e-6) out.push(`sfx ${k + 1} (${x.sound}) is at ${s2(x.at)} s, after the episode ends (${s2(D)} s) — it will never play`);
  });
  // The busiest minute (from one sound effect's time to just under a minute after it); a shorter video is one window.
  const times = sfx.map((x) => x.at).filter((t) => t <= D + 1e-6).sort((a, b) => a - b);
  let busiest = { n: 0, from: 0 };
  times.forEach((t, i) => {
    const n = times.filter((u, j) => j >= i && u < t + SFX_WINDOW_SEC).length;
    if (n > busiest.n) busiest = { n, from: t };
  });
  if (busiest.n > MAX_SFX_PER_MINUTE) {
    out.push(`${busiest.n} sound effects within one minute (from ${s1(busiest.from)} s) — sound effects on almost every cut cheapen the video; keep the ones that land a joke or a reveal`);
  }
  ep.music.forEach((c, i) => {
    for (const d of c.dips ?? []) {
      if (d.end <= c.start || d.start >= c.end) out.push(`music cue ${i + 1} has a dip at ${s2(d.start)}–${s2(d.end)} s outside the cue (${s2(c.start)}–${s2(c.end)} s) — it does nothing`);
    }
  });
  return out;
}

/** More sound effects than this in any minute gets a warning. */
const MAX_SFX_PER_MINUTE = 6;
const SFX_WINDOW_SEC = 60;

/**
 * The `check` command: validates the timeline against the catalog (clips exist, ranges fit), the music library (cue
 * tracks listed and present) and the sound effects (each a built-in or a file in sfx/; with `tools`, a file FFmpeg can
 * read), snaps montages to the beat (not once a voice-over is fitted), saves it if that changed anything, and collects
 * what the user should know: `warnings` (⚠) and `notes`.
 */
export async function checkEpisode(project: string, n: number, tools?: MediaTools): Promise<{ episode: Episode; warnings: string[]; notes: string[] }> {
  const root = resolve(project);
  const catalog = await loadCatalog(root);
  let ep = await loadEpisode(root, n);
  sourcesFor(ep, catalog);
  checkCardImages(root, ep);
  const warnings: string[] = [];
  const notes: string[] = [];
  // library.json only matters to an episode with music: a broken one must not block a cut without any.
  const musicDir = join(root, 'music');
  const lib = ep.music.length ? await loadLibrary(musicDir) : null;
  if (lib) checkCueFiles(ep.music, lib, musicDir);
  for (const [k, x] of (ep.sfx ?? []).entries()) {
    const src = sfxSource(root, x.sound, `sfx ${k + 1}`);
    if (!tools || 'builtin' in src) continue;
    const p = await tools.probe(src.file).catch((e: unknown) => {
      if (fileUnreadable(e)) return null;
      throw e;
    });
    if (!p?.hasAudio) throw unreadableSfx(`sfx ${k + 1}`, src.path);
  }
  if (ep.voiceover) {
    if (ep.items.some((i) => !isCard(i) && i.onBeat) || ep.music.length) notes.push('Montages were not snapped to the beat: the voice-over is fitted to this cut.');
  } else if (lib) {
    const snapped = dropCollapsed(snapToBeats(ep, catalog, lib), ep);
    ep = snapped.episode;
    for (const d of snapped.dropped) warnings.push(`${d} was inside time that beat snapping removed, so it was dropped — place it again on the times above`);
  }
  await saveEpisode(root, ep, n);

  if (cutChanged(ep)) {
    const e = cutChangedError();
    warnings.push(`${e.message}. ${e.hint}`);
  } else if (slotsStale(ep) && ep.slots.some((s) => hasWords(s.line))) {
    warnings.push(`The cut changed since slots were written — run: pnpm mirage slots <project> ${n}, and check the lines it carried over`);
  }
  warnings.push(...lineChangeWarnings(ep, 'check'));
  for (const item of ep.items) {
    if (isCard(item) || item.audio !== 'keep' || item.speed !== 1) continue;
    const clip = catalog.clips.find((c) => c.id === item.clip);
    if (clip?.probe.hasAudio && clip.transcript === null) {
      warnings.push(`item ${item.id} keeps audio from ${clip.id}, which has no transcript — narration slots and captions won't see its speech`);
    }
  }
  warnings.push(...timelineWarnings(ep, lib, !ep.voiceover));
  return { episode: ep, warnings, notes };
}
