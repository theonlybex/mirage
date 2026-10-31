import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EpisodeSchema, TranscriptSchema, type Catalog, type Episode, type MusicCue, type MusicLibrary, type Transcript, type VoiceLine } from '@wordedits/shared';
import { encodeArgs, ffNum } from '../edl-compiler.js';
import type { Encoder, MediaTools } from '../media-tools.js';
import { readJsonFile, writeJsonFile } from '../project-store.js';
import { MirageError } from './errors.js';
import { loadCatalog } from './ingest.js';
import { loadLibrary } from './music.js';
import { buildAss, groupCaptions, keptSegments, speechWords, toSrt } from './overlays.js';
import { decodeMono } from './tempo.js';
import { layoutTimeline, type LaidItem } from './timeline.js';

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

export function itemChunkArgs(laid: LaidItem[], o: { width: number; height: number; fps: number }, sources: Map<string, ClipSource>, output: string): string[] {
  const inputs: string[] = [];
  const chains: string[] = [];
  const labels: string[] = [];
  laid.forEach((l, k) => {
    const { item } = l;
    const src = sources.get(item.clip)!;
    // One extra output frame of source so fps never comes up short.
    inputs.push('-threads', '1', '-ss', ffNum(item.src.in), '-t', ffNum(((l.srcFrames + 1) / o.fps) * item.speed), '-i', src.path);
    const zoom = item.zoom > 1 + 1e-6 ? `crop=trunc(iw/${ffNum(item.zoom)}/2)*2:trunc(ih/${ffNum(item.zoom)}/2)*2,` : '';
    chains.push(
      `[${k}:v]setpts=(PTS-STARTPTS)/${ffNum(item.speed)},${zoom}` +
        `scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease,pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,` +
        `fps=${ffNum(o.fps)},tpad=stop=-1:stop_mode=clone,trim=end_frame=${l.frames},setpts=PTS-STARTPTS[v${k}]`,
    );
    const dur = ffNum(l.frames / o.fps);
    if (item.audio === 'keep' && item.speed === 1 && src.hasAudio) {
      chains.push(`[${k}:a]asetpts=PTS-STARTPTS,aresample=48000,${FLTP_STEREO},apad,atrim=end=${dur},asetpts=PTS-STARTPTS[a${k}]`);
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

export function musicTrackArgs(cues: MusicCue[], lib: MusicLibrary, musicDir: string, durationSec: number, loudnessLufs: number, output: string): string[] {
  const inputs: string[] = [];
  const chains: string[] = [];
  cues.forEach((c, i) => {
    if (!lib.tracks.some((t) => t.file === c.track)) {
      throw new MirageError('NO_MUSIC_TRACK', `music cue ${i + 1}: ${c.track} is not in music/library.json`, 'Run: pnpm mirage music <project>, or fix the track name.');
    }
    inputs.push('-stream_loop', '-1', '-ss', ffNum(c.offset), '-i', join(musicDir, c.track));
    const dur = c.end - c.start;
    const fades = [
      c.fadeIn > 0 ? `afade=t=in:d=${ffNum(Math.min(c.fadeIn, dur / 2))}` : '',
      c.fadeOut > 0 ? `afade=t=out:st=${ffNum(Math.max(0, dur - c.fadeOut))}:d=${ffNum(Math.min(c.fadeOut, dur))}` : '',
    ].filter(Boolean);
    chains.push(
      [
        `[${i}:a]atrim=duration=${ffNum(dur)}`,
        'asetpts=PTS-STARTPTS',
        `aresample=48000,${FLTP_STEREO}`,
        `loudnorm=I=${ffNum(loudnessLufs + c.gainDb)}:TP=-2:LRA=11`,
        `aresample=48000,${FLTP_STEREO}`,
        ...fades,
        `adelay=delays=${Math.round(c.start * 1000)}:all=1[m${i}]`,
      ].join(','),
    );
  });
  chains.push(`${cues.map((_, i) => `[m${i}]`).join('')}amix=inputs=${cues.length}:duration=longest:normalize=0,apad,atrim=end=${ffNum(durationSec)}[out]`);
  return [...inputs, '-filter_complex', chains.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', output];
}

export function buildVoiceTrack(o: { recording: Float32Array; sampleRate: number; lines: VoiceLine[]; durationSec: number }): Float32Array {
  const sr = o.sampleRate;
  const out = new Float32Array(Math.round(o.durationSec * sr));
  const fade = Math.max(1, Math.round(0.008 * sr));
  for (const line of o.lines) {
    for (const seg of keptSegments(line)) {
      const from = Math.round(seg.in * sr);
      const to = Math.min(o.recording.length, Math.round(seg.out * sr));
      const at = Math.round((line.at + seg.offset) * sr);
      const n = to - from;
      for (let i = 0; i < n && at + i < out.length; i++) {
        const gain = Math.max(0, Math.min(1, i / fade, (n - 1 - i) / fade));
        out[at + i] += o.recording[from + i] * (fade <= 1 ? 1 : gain);
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
    `[speechraw]highpass=f=90,loudnorm=I=${ffNum(o.loudnessLufs)}:TP=-1:LRA=11,aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,asetpts=N/SR/TB${o.musicWav ? '[speech]' : '[aout]'}`,
  );
  if (o.musicWav) {
    chains.push(
      '[speech]asplit=2[smix][skey]',
      `[${musicIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=end=${D}[mus]`,
      '[mus][skey]sidechaincompress=threshold=0.03:ratio=8:attack=150:release=900[duck]',
      '[smix][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.891:level=false[aout]',
    );
  }
  return [...inputs, '-filter_complex', chains.join(';'), '-map', '[vout]', '-map', '[aout]', ...encodeArgs(o), '-t', D, o.output];
}

export const episodeDir = (project: string, n: number) => join(resolve(project), 'episodes', String(n));

export async function loadEpisode(project: string, n: number): Promise<Episode> {
  try {
    return await readJsonFile(join(episodeDir(project, n), 'episode.json'), EpisodeSchema);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MirageError('NO_EPISODE', `episodes/${n}/episode.json does not exist`, 'Ask Claude to write the episode timeline first.');
    }
    throw e;
  }
}

export async function saveEpisode(project: string, ep: Episode): Promise<void> {
  const dir = episodeDir(project, ep.number);
  await mkdir(dir, { recursive: true });
  await writeJsonFile(join(dir, 'episode.json'), EpisodeSchema, ep);
}

export type EpisodeMode = 'rough' | 'guide' | 'final';

export async function renderEpisode(o: { project: string; episode: number; mode: EpisodeMode; tools: MediaTools; musicDir?: string; onProgress?: (f: number) => void }): Promise<{ outputPath: string; srtPath: string | null; durationSec: number }> {
  const project = resolve(o.project);
  const ep = await loadEpisode(project, o.episode);
  const catalog = await loadCatalog(project);
  if (catalog.clips.length === 0) throw new MirageError('NO_CATALOG', 'The project has no catalogued clips', 'Run: pnpm mirage ingest <project> <clips folder>');
  const sources = sourcesFor(ep, catalog);
  const laid = layoutTimeline(ep);
  const D = laid[laid.length - 1].end;
  const fps = ep.output.fps;
  const final = o.mode === 'final';
  const [W, H] = final ? [ep.output.width, ep.output.height] : [960, 540];
  const dir = episodeDir(project, o.episode);
  const musicDir = resolve(o.musicDir ?? join(project, 'music'));
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
        timeoutMs: Math.max(120_000, dur * 30 * 1000),
        onProgress: (f) => report((0.6 * (done + f * dur)) / D),
      });
      done += dur;
    }
    await writeFile(join(work, 'chunks.txt'), chunks.map((_, i) => `file 'chunk-${pad3(i)}.mov'`).join('\n') + '\n');

    let musicWav: string | undefined;
    if (ep.music.length) {
      await o.tools.runFfmpeg(musicTrackArgs(ep.music, await loadLibrary(musicDir), musicDir, D, ep.loudnessLufs, join(work, 'music.wav')), {
        expectedDurationSec: D,
        timeoutMs: Math.max(120_000, D * 10 * 1000),
      });
      musicWav = 'music.wav';
    }
    report(0.7);

    let voiceRaw: string | undefined;
    let voTranscript: Transcript | null = null;
    if (final && ep.voiceover) {
      const pcm = await decodeMono(resolve(project, ep.voiceover.recording), join(work, 'rec.f32'), o.tools, { sampleRate: 48000 });
      const track = buildVoiceTrack({ recording: pcm, sampleRate: 48000, lines: ep.voiceover.lines, durationSec: D });
      await writeFile(join(work, 'vo.f32'), Buffer.from(track.buffer, track.byteOffset, track.byteLength));
      voiceRaw = 'vo.f32';
      voTranscript = await readJsonFile(join(dir, 'voiceover.transcript.json'), TranscriptSchema);
    }

    const cues = o.mode === 'guide' ? [] : groupCaptions(speechWords(ep, catalog, voTranscript), { durationSec: D });
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
