import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EpisodeSchema, TranscriptSchema, type Catalog, type Episode, type MusicCue, type MusicLibrary, type Transcript, type VoiceLine } from '@wordedits/shared';
import { encodeArgs, ffNum } from '../edl-compiler.js';
import type { Encoder, MediaTools } from '../media-tools.js';
import { readJsonFile, writeJsonFile } from '../project-store.js';
import { MirageError } from './errors.js';
import { loadCatalog } from './ingest.js';
import { acquireLock, clearLeftovers, type Lock } from './lock.js';
import { checkCueFiles, cueTrack, loadLibrary } from './music.js';
import { buildAss, groupCaptions, keptSegments, speechWords, toSrt } from './overlays.js';
import { decodeMono } from './tempo.js';
import { layoutTimeline, type LaidItem } from './timeline.js';
import { cutChanged, cutChangedError } from './voiceover.js';

export const CHUNK_ITEMS = 30;
const pad3 = (i: number) => String(i).padStart(3, '0');

export interface ClipSource {
  path: string;
  hasAudio: boolean;
  durationSec: number;
}

export function sourcesFor(ep: Episode, catalog: Catalog): Map<string, ClipSource> {
  const map = new Map<string, ClipSource>();
  for (const item of ep.items) {
    const clip = catalog.clips.find((c) => c.id === item.clip);
    if (!clip) throw new MirageError('BAD_ITEM', `item ${item.id}: clip ${item.clip} is not in the catalog`, 'Run ingest, or fix the clip id in episode.json.');
    if (item.src.out > clip.probe.durationSec + 0.05) {
      throw new MirageError('BAD_ITEM', `item ${item.id}: src.out ${item.src.out}s is past the end of ${item.clip} (${clip.probe.durationSec}s)`, 'Shorten the item.');
    }
    if (!existsSync(clip.path)) {
      throw new MirageError('BAD_ITEM', `item ${item.id}: clip file ${clip.path} is missing`, 'Reconnect the drive or re-ingest the folder it moved to');
    }
    map.set(clip.id, { path: clip.path, hasAudio: clip.probe.hasAudio, durationSec: clip.probe.durationSec });
  }
  return map;
}

export function chunkItems(laid: LaidItem[]): LaidItem[][] {
  const out: LaidItem[][] = [];
  for (let i = 0; i < laid.length; i += CHUNK_ITEMS) out.push(laid.slice(i, i + CHUNK_ITEMS));
  return out;
}

const FLTP_STEREO = 'aformat=sample_fmts=fltp:channel_layouts=stereo';
/** loudnorm rejects targets outside [-70, -5] LUFS. */
const lufs = (n: number) => ffNum(Math.min(-5, Math.max(-70, n)));

export function itemChunkArgs(laid: LaidItem[], o: { width: number; height: number; fps: number }, sources: Map<string, ClipSource>, output: string): string[] {
  const inputs: string[] = [];
  const chains: string[] = [];
  const labels: string[] = [];
  laid.forEach((l, k) => {
    const { item } = l;
    const src = sources.get(item.clip)!;
    // Real-time items decode on one thread each (a chunk opens up to 30 inputs); sped-up items read far more source
    // than they output, so they get every thread.
    if (item.speed <= 1) inputs.push('-threads', '1');
    // One extra output frame of source so fps never comes up short.
    inputs.push('-ss', ffNum(item.src.in), '-t', ffNum(((l.srcFrames + 1) / o.fps) * item.speed), '-i', src.path);
    const zoom = item.zoom > 1 + 1e-6 ? `crop=trunc(iw/${ffNum(item.zoom)}/2)*2:trunc(ih/${ffNum(item.zoom)}/2)*2,` : '';
    // fps right after setpts drops frames to the output rate before any crop or scale touches them.
    chains.push(
      `[${k}:v]setpts=(PTS-STARTPTS)/${ffNum(item.speed)},fps=${ffNum(o.fps)},${zoom}` +
        `scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease,pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,` +
        `tpad=stop=-1:stop_mode=clone,trim=end_frame=${l.frames},setpts=PTS-STARTPTS[v${k}]`,
    );
    const dur = ffNum(l.frames / o.fps);
    if (item.audio === 'keep' && item.speed === 1 && src.hasAudio) {
      // Cut at the end of the source first so the extra input frame never leaks into a hold.
      chains.push(`[${k}:a]asetpts=PTS-STARTPTS,aresample=48000,${FLTP_STEREO},atrim=end=${ffNum(l.srcFrames / o.fps)},apad,atrim=end=${dur},asetpts=PTS-STARTPTS[a${k}]`);
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
    const fades = [
      c.fadeIn > 0 ? `afade=t=in:d=${ffNum(Math.min(c.fadeIn, dur / 2))}` : '',
      c.fadeOut > 0 ? `afade=t=out:st=${ffNum(Math.max(0, dur - c.fadeOut))}:d=${ffNum(Math.min(c.fadeOut, dur))}` : '',
    ].filter(Boolean);
    chains.push(
      [
        // With -stream_loop and -ss, loop seams overlap timestamps by the offset; renumbering by sample count
        // keeps atrim and afade (both timestamp-based) on the cue's real length.
        `[${i}:a]asetpts=N/SR/TB,atrim=duration=${ffNum(dur)}`,
        'asetpts=PTS-STARTPTS',
        `aresample=48000,${FLTP_STEREO}`,
        `loudnorm=I=${lufs(loudnessLufs + c.gainDb)}:TP=-2:LRA=11`,
        `aresample=48000,${FLTP_STEREO}`,
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
  fontsDir?: string;
  musicWav?: string;
  voiceRaw?: string;
}

export function episodeFinalArgs(o: FinalEpisodeOptions): string[] {
  const inputs = ['-f', 'concat', '-safe', '0', '-i', o.chunkList];
  let next = 1;
  const musicIdx = o.musicWav ? next++ : -1;
  if (o.musicWav) inputs.push('-i', o.musicWav);
  const voiceIdx = o.voiceRaw ? next++ : -1;
  if (o.voiceRaw) inputs.push('-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', o.voiceRaw);
  const D = ffNum(o.durationSec);

  const chains = [`[0:v]ass=${o.assFile}${o.fontsDir ? `:fontsdir=${o.fontsDir}` : ''}[vout]`];
  if (o.voiceRaw) {
    chains.push(`[0:a]${FLTP_STEREO}[live]`, `[${voiceIdx}:a]${FLTP_STEREO},apad,atrim=end=${D}[vo]`, '[live][vo]amix=inputs=2:duration=first:normalize=0[speechraw]');
  } else {
    chains.push('[0:a]anull[speechraw]');
  }
  chains.push(
    `[speechraw]highpass=f=90,loudnorm=I=${lufs(o.loudnessLufs)}:TP=-1:LRA=11,aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,asetpts=N/SR/TB${o.musicWav ? '[speech]' : '[aout]'}`,
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

type RenderOptions = { project: string; episode: number; mode: EpisodeMode; tools: MediaTools; musicDir?: string; onProgress?: (f: number) => void };

/** Renders episode `episode` in `mode`, holding the episode's lock so a second render of it refuses instead of deleting this one's work. */
export async function renderEpisode(o: RenderOptions): Promise<{ outputPath: string; srtPath: string | null; durationSec: number }> {
  const lock = await lockEpisode(resolve(o.project), o.episode, COMMAND[o.mode]);
  try {
    return await renderLocked(o);
  } finally {
    await lock.release();
  }
}

async function renderLocked(o: RenderOptions): Promise<{ outputPath: string; srtPath: string | null; durationSec: number }> {
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
  const [W, H] = final ? [ep.output.width, ep.output.height] : [960, 540];
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
  }
  const outputPath = join(dir, `${o.mode}.mp4`);
  const id = randomUUID();
  const work = join(dir, `.work-${id}`);
  const partial = `${outputPath}.partial-${id}.mp4`;
  await mkdir(work, { recursive: true });
  const report = (f: number) => o.onProgress?.(Math.min(1, Math.max(0, f)));

  try {
    const chunks = chunkItems(laid);
    let done = 0;
    for (const [i, chunk] of chunks.entries()) {
      const dur = chunk.reduce((s, l) => s + l.frames / fps, 0);
      await o.tools.runFfmpeg(itemChunkArgs(chunk, { width: W, height: H, fps }, sources, join(work, `chunk-${pad3(i)}.mov`)), {
        expectedDurationSec: dur,
        timeoutMs: chunkTimeoutMs(chunk, fps),
        onProgress: (f) => report((0.6 * (done + f * dur)) / D),
      });
      done += dur;
    }
    await writeFile(join(work, 'chunks.txt'), chunks.map((_, i) => `file 'chunk-${pad3(i)}.mov'`).join('\n') + '\n');

    let musicWav: string | undefined;
    if (ep.music.length) {
      await o.tools.runFfmpeg(musicTrackArgs(ep.music, lib!, musicDir, D, ep.loudnessLufs, join(work, 'music.wav')), {
        expectedDurationSec: D,
        timeoutMs: Math.max(120_000, D * 10 * 1000),
      });
      musicWav = 'music.wav';
    }
    report(0.7);

    let voiceRaw: string | undefined;
    if (final && ep.voiceover) {
      const pcm = new Map<string, Float32Array>();
      for (const [i, rec] of recordings.entries()) pcm.set(rec, await decodeMono(resolve(project, rec), join(work, `rec-${i}.f32`), o.tools, { sampleRate: 48000 }));
      const track = buildVoiceTrack({ recording: pcm, defaultRecording: ep.voiceover.recording, sampleRate: 48000, lines: ep.voiceover.lines, durationSec: D });
      await writeFile(join(work, 'vo.f32'), Buffer.from(track.buffer, track.byteOffset, track.byteLength));
      voiceRaw = 'vo.f32';
    }

    const cues = o.mode === 'guide' ? [] : groupCaptions(speechWords(ep, catalog, voTranscripts), { durationSec: D });
    await writeFile(join(work, 'overlays.ass'), buildAss({ width: W, height: H, captions: cues, overlays: ep.overlays, prompts: o.mode === 'guide' ? ep.slots : [] }));

    const encoder = final ? await o.tools.pickEncoder() : { name: 'libx264' as const, extraArgs: [] };
    await o.tools.runFfmpeg(
      episodeFinalArgs({
        chunkList: 'chunks.txt', output: partial, encoder, mode: final ? 'final' : 'preview', width: W, height: H, fps, durationSec: D,
        loudnessLufs: ep.loudnessLufs, assFile: 'overlays.ass', fontsDir: process.platform === 'darwin' ? '/System/Library/Fonts' : undefined, musicWav, voiceRaw,
      }),
      { cwd: work, expectedDurationSec: D, timeoutMs: Math.max(120_000, D * 20 * 1000), onProgress: (f) => report(0.7 + 0.3 * f) },
    );
    const probe = await o.tools.probe(partial);
    if (Math.abs(probe.durationSec - D) > Math.max(0.1, 1 / fps)) {
      throw new MirageError('DURATION_MISMATCH', `Rendered ${probe.durationSec}s but the timeline is ${D}s`, 'A clip may be shorter than the catalog says; re-run ingest.');
    }
    await rename(partial, outputPath);
    let srtPath: string | null = null;
    if (final) {
      srtPath = join(dir, 'final.srt');
      await writeFile(srtPath, toSrt(cues));
    }
    report(1);
    return { outputPath, srtPath, durationSec: D };
  } catch (e) {
    await rm(partial, { force: true }).catch(() => {});
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
