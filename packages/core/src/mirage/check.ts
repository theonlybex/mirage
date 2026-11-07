import { join, resolve } from 'node:path';
import { BUILD_STORY_BEATS, isCard, type Catalog, type ClipItem, type Episode, type Move, type MusicLibrary, type Video } from '@wordedits/shared';
import type { MediaTools } from '../media-tools.js';
import { checkCardImages } from './cards.js';
import { describeError } from './errors.js';
import { loadFormats, type Format } from './formats.js';
import { loadCatalog } from './ingest.js';
import { checkCueFiles, findTrack, loadLibrary, snapToBeats } from './music.js';
import { splitShots } from './move.js';
import { keptSegments, OVERLAY_STYLE, speechWords, spilledWords, styleGeometry, undrawable, type StyleGeometry } from './overlays.js';
import { loadEpisode, saveEpisode, sourcesFor } from './render-episode.js';
import { fileUnreadable, sfxSource, unreadableSfx } from './sfx.js';
import { slotsStale, SPEECH_PAD_SEC } from './slots.js';
import { hasSpill, keepsOwnSound, spills } from './spill.js';
import { dropCollapsed, formatTime, layoutTimeline, timelineDuration } from './timeline.js';
import { readVideo } from './video.js';
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

/**
 * What the leads and tails (leadIn, tailOut) do that the user should hear about, from the final layout: one that does
 * nothing (the item doesn't keep its own sound), one that plays shorter than written and why, and a fitted voice-over
 * line over words one of them carries (each word padded as slots pad speech, so a line in a slot never warns). Nothing
 * at all for an episode without them.
 */
function spillWarnings(ep: Episode, catalog: Catalog): string[] {
  if (!ep.items.some(hasSpill)) return [];
  const out: string[] = [];
  const { shortened } = spills(ep, catalog);
  for (const item of ep.items) {
    if (!hasSpill(item)) continue;
    if (!keepsOwnSound(item, catalog)) {
      out.push(`item ${item.id} has leadIn/tailOut but doesn't keep its own sound (audio "keep" at speed 1) — it does nothing`);
      continue;
    }
    for (const x of shortened) if (x.item === item.id) out.push(`item ${x.item}'s ${x.field} of ${s2(x.asked)} s is shortened to ${s2(x.got)} s — ${x.reason}`);
  }
  const carried = spilledWords(ep, catalog);
  for (const line of ep.voiceover?.lines ?? []) {
    const segs = keptSegments(line);
    const last = segs[segs.length - 1];
    if (!last) continue;
    const end = line.at + last.offset + last.out - last.in;
    for (const { spill, words } of carried) {
      const under = words.filter((w) => Math.min(end, w.end + SPEECH_PAD_SEC) - Math.max(line.at, w.start - SPEECH_PAD_SEC) > 1e-6);
      if (!under.length) continue;
      const from = Math.min(...under.map((w) => w.start));
      const to = Math.max(...under.map((w) => w.end));
      out.push(`voice-over line ${line.slot} plays over item ${spill.item}'s carried-over sound (${s2(from)}–${s2(to)} s) — shorten the leadIn/tailOut or move the line`);
    }
  }
  return out;
}

/** More sound effects than this in any minute gets a warning. */
const MAX_SFX_PER_MINUTE = 6;
const SFX_WINDOW_SEC = 60;

/** A short opening on more silence than this gets a warning. */
const MAX_OPENING_SILENCE_SEC = 0.5;
/** What the Shorts and Reels buttons cover of a vertical frame (Instagram's cover more than YouTube's: these are both). */
const COVERED = { top: 0.1, bottom: 0.2, right: 0.15 };

/** The covered areas a style's text box reaches into, e.g. ['top 10%', 'right 15%']: its edge by its anchor and margins. */
function coveredBy(s: StyleGeometry, width: number, height: number): string[] {
  const row = Math.ceil(s.align / 3); // 1 bottom, 2 middle, 3 top
  const col = (s.align - 1) % 3; // 0 left, 1 centre, 2 right
  const out: string[] = [];
  if (row === 3 && s.marginV - s.outline < height * COVERED.top) out.push(`top ${COVERED.top * 100}%`);
  if (row === 1 && height - s.marginV + s.outline > height * (1 - COVERED.bottom)) out.push(`bottom ${COVERED.bottom * 100}%`);
  if (col === 2 && width - s.margin + s.outline > width * (1 - COVERED.right)) out.push(`right ${COVERED.right * 100}%`);
  return out;
}

/**
 * What the video's format asks that the cut doesn't do. A video without a format (a build story) is only told about a
 * beat outside the build story's own list; `formatted` is false for it.
 */
function formatWarnings(ep: Episode, catalog: Catalog, video: Video | null, format: Format, formatted: boolean): string[] {
  const out: string[] = [];
  const known: readonly string[] = formatted ? format.beats : BUILD_STORY_BEATS;
  for (const item of ep.items) {
    if (!known.includes(item.beat)) out.push(`item ${item.id}'s beat "${item.beat}" isn't one of the ${format.name} format's beats (${format.beats.join(', ')})`);
  }
  if (!formatted) return out;
  const { width: w, height: h } = ep.output;
  if (format.output && (w !== format.output.width || h !== format.output.height)) {
    out.push(`the video is ${w}×${h}, not the ${format.name} format's ${format.output.width}×${format.output.height}`);
  }
  // Only what the format file itself writes: the vlog writes a style and no position. No captions in episode.json are
  // phrase captions at the bottom.
  const stated = format.statedCaptions;
  if (stated) {
    const own = { style: ep.captions?.style ?? 'phrase', position: ep.captions?.position ?? 'bottom' };
    const keys = (['style', 'position'] as const).filter((k) => stated[k] !== undefined);
    if (keys.some((k) => own[k] !== stated[k])) {
      out.push(`captions are ${keys.map((k) => own[k]).join('/')}, not the ${format.name} format's ${keys.map((k) => stated[k]).join('/')}`);
    }
  }
  const D = timelineDuration(ep);
  if (format.warnPastSec !== undefined) {
    // A video's own target scales the limit: a vlog aiming at 15 min instead of 4:20 is warned past 400 s × 900 / 260.
    const own = video?.targetSec !== undefined && format.targetSec !== undefined;
    const limit = own ? (format.warnPastSec * video!.targetSec!) / format.targetSec! : format.warnPastSec;
    const whose = own ? `this video's ${formatTime(limit)} limit` : `the ${format.name} format's ${formatTime(limit)}`;
    const cut = format.short ? 'cut whole moments' : 'cut whole bits rather than thinning laughs';
    if (D > limit + 1e-6) out.push(`the video is ${formatTime(D)}, longer than ${whose} — ${cut}`);
  }
  if (format.short) {
    const laid = layoutTimeline(ep);
    const first = laid[0];
    const opening = first?.item;
    // The opening silence of the first item's own live sound; a card or a muted item has none to measure.
    if (opening && !isCard(opening) && opening.audio === 'keep' && opening.speed === 1) {
      const clip = catalog.clips.find((c) => c.id === opening.clip);
      if (clip?.probe.hasAudio && clip.transcript) {
        const word = speechWords(ep, catalog, null).find((w) => w.start >= first.start - 1e-6 && w.start < first.end);
        const silence = (word?.start ?? first.end) - first.start;
        if (silence > MAX_OPENING_SILENCE_SEC + 1e-6) out.push(`a short opens on its hook: item ${opening.id} starts with ${s1(silence)} s of silence`);
      }
    }
    if (first && (first.item.beat === 'title' || first.item.beat === 'cold-open')) out.push(`a short opens on its hook, not a ${first.item.beat}: item ${first.item.id}`);
    for (const item of ep.items) if (item.beat === 'outro') out.push(`a short has no outro: item ${item.id}`);
    // A short made from a big video is the format's kind (a teaser pointing to it); one with no big video behind it stands alone.
    const kind = video?.from !== undefined ? format.short.kind : 'standalone';
    if (kind === 'standalone') {
      const last = [...ep.music].sort((a, b) => b.end - a.end)[0];
      if (last && last.end >= D - 0.5 / ep.output.fps && last.fadeOut > 0) out.push('a standalone short loops: the last music cue fades out at the end — set its fadeOut to 0');
    } else if (!ep.items.some((i) => i.beat === 'pointer')) {
      out.push('a teaser short ends pointing to the full video: add a pointer beat at the end');
    }
    const { width, height } = ep.output;
    if (height > width) {
      // An overlay's place is fixed by its style on a vertical frame, so it can't be moved: left out, or a callout instead.
      const covered = (what: string, s: StyleGeometry, todo: string) => {
        const areas = coveredBy(s, width, height);
        if (areas.length) out.push(`${what} falls where the Shorts and Reels buttons cover it (${areas.join(', ')}) — ${todo}`);
      };
      const position = ep.captions?.position ?? 'bottom';
      const g = styleGeometry(width, height, position);
      for (const o of ep.overlays) covered(`overlay ${o.kind} ("${o.text}")`, g[OVERLAY_STYLE[o.kind]], 'leave it out, or use a callout');
      const style = ep.captions?.style ?? 'phrase';
      if (style !== 'chosen' && style !== 'off') covered(`captions at the ${position}`, g[style === 'pop' ? 'Pop' : style === 'karaoke' ? 'Karaoke' : 'Caption'], 'set captions position middle');
    }
  }
  return out;
}

/**
 * The video's format, and what is wrong with the formats: every format file that can't be used, an unknown format id
 * (the video is then checked as a build story), a missing build story when the video needs it. Never throws.
 */
async function videoFormat(root: string, n: number, dir?: string): Promise<{ video: Video | null; format: Format | null; formatted: boolean; problems: string[] }> {
  const { formats, problems } = loadFormats(dir);
  let video: Video | null = null;
  try {
    video = await readVideo(root, n);
  } catch (e) {
    const { message, hint } = describeError(e);
    problems.push(`✖ ${message}${hint ? `\n  ${hint}` : ''}`);
  }
  const named = video?.format === undefined ? undefined : formats.find((f) => f.id === video!.format);
  if (named) return { video, format: named, formatted: true, problems };
  if (video?.format !== undefined) problems.push(`✖ video.json: unknown format "${video.format}"\n  The formats are: ${formats.map((f) => f.id).join(', ') || 'none'}.`);
  const story = formats.find((f) => f.id === 'build-story') ?? null;
  // A broken build-story.md, or no formats folder, is already among the loader's problems.
  if (!story && !problems.some((p) => p.startsWith('✖ plugin/formats/build-story.md:') || p.startsWith('✖ plugin/formats:'))) {
    problems.push('✖ plugin/formats/build-story.md: the file is missing');
  }
  return { video, format: story, formatted: false, problems };
}

/**
 * The `check` command: validates the timeline against the catalog (clips exist, ranges fit), the music library (cue
 * tracks listed and present) and the sound effects (each a built-in or a file in sfx/; with `tools`, a file FFmpeg can
 * read), snaps montages to the beat (not once a voice-over is fitted), saves it if that changed anything, and collects
 * what the user should know: `warnings` (⚠), `notes`, and `problems` (✖ lines that don't stop the check: a format file
 * that can't be used, a format id that isn't one). It also warns about what the video's format asks (`formatsDir`: the
 * folder of format files, default the plugin's own).
 */
export async function checkEpisode(
  project: string,
  n: number,
  tools?: MediaTools,
  opts: { formatsDir?: string } = {},
): Promise<{ episode: Episode; warnings: string[]; notes: string[]; problems: string[] }> {
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
  warnings.push(...spillWarnings(ep, catalog));
  const { video, format, formatted, problems } = await videoFormat(root, n, opts.formatsDir);
  if (format) warnings.push(...formatWarnings(ep, catalog, video, format, formatted));
  return { episode: ep, warnings, notes, problems };
}
