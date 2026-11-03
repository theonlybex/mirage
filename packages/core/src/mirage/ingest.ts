import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { CatalogSchema, type Catalog, type Clip, type ClipKind, type ProbeInfo, type Transcript } from '@wordedits/shared';
import type { MediaTools } from '../media-tools.js';
import { JsonFileError, readJsonFile, writeJsonFile } from './json-file.js';
import { errorReason, MirageError } from './errors.js';
import { acquireLock, clearLeftovers } from './lock.js';
import { refineTranscript } from './word-timing.js';

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm']);
const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084']);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const s1 = (n: number) => n.toFixed(1);

export function guessKind(probe: ProbeInfo, transcript: Transcript | null): ClipKind {
  const words = transcript?.words.length ?? 0;
  const wordsPerMinute = words / Math.max(probe.durationSec / 60, 1 / 60);
  if (wordsPerMinute >= 60) return 'talking';
  if (probe.durationSec >= 15 * 60) return 'timelapse';
  if (probe.height > probe.width) return 'camera';
  return 'screen';
}

export function frameInterval(durationSec: number): number {
  return Math.min(20, Math.max(2, Math.round(durationSec / 40)));
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function loadCatalog(project: string): Promise<Catalog> {
  try {
    return await readJsonFile(join(resolve(project), 'catalog.json'), CatalogSchema, 'catalog.json');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, clips: [] };
    throw e;
  }
}

export async function saveCatalog(project: string, catalog: Catalog): Promise<void> {
  await writeJsonFile(join(resolve(project), 'catalog.json'), CatalogSchema, catalog, 'catalog.json');
}

export function nextClipId(catalog: Catalog): string {
  const max = catalog.clips.reduce((m, c) => Math.max(m, Number(c.id.slice(1))), 0);
  return `c${String(max + 1).padStart(3, '0')}`;
}

export interface IngestResult {
  added: Clip[];
  skipped: { file: string; reason: string }[];
  /** Problems the user should hear about (printed with ⚠). */
  warnings: string[];
}

/** Transcribes a clip's audio. Returns null (and warns) when transcription fails; a clip with no speech gets an empty transcript. */
async function transcribeClip(o: { tools: MediaTools; path: string; name: string; wav: string; durationSec: number; audioStream?: number; locale?: string; result: IngestResult; onStep?: (m: string) => void }): Promise<Transcript | null> {
  try {
    await o.tools.extractWav(o.path, o.wav, { timeoutMs: Math.max(10 * 60_000, o.durationSec * 500), audioStream: o.audioStream });
    const transcript = await o.tools.transcribe(o.wav, { locale: o.locale, timeoutMs: Math.max(30 * 60_000, o.durationSec * 2000) });
    // The transcriber's word times are checked against the sound, so slots and captions see when words really start and end.
    return await refineTranscript(transcript, o.wav);
  } catch (e) {
    o.onStep?.(`${o.name}: transcription failed, kept as silent footage`);
    o.result.warnings.push(`${o.name}: transcription failed (${errorReason(e)}); its speech is invisible to slots and captions — run ingest again to retry`);
    return null;
  } finally {
    await rm(o.wav, { force: true }).catch(() => {});
  }
}

/** Seconds of each audio track measured to find the clip's sound: enough to tell a silent track, without decoding hours. */
const TRACK_SAMPLE_SEC = 120;

/**
 * The audio stream with the clip's sound when it is not the first: the loudest, when the first is (near) silent and
 * another is clearly louder (a screen recording's silent system-audio track before the microphone's). Each track is
 * measured over its first two minutes, and the others only when the first is silent.
 */
async function soundStream(tools: MediaTools, path: string, streams: number): Promise<number | undefined> {
  const level = (i: number) => tools.measureLoudness(path, { audioStream: i, maxSec: TRACK_SAMPLE_SEC }).then((l) => l.integratedLufs, () => -Infinity);
  const levels = [await level(0)];
  if (levels[0] > -60) return undefined;
  for (let i = 1; i < streams; i++) levels.push(await level(i));
  const loudest = levels.indexOf(Math.max(...levels));
  return loudest > 0 && levels[loudest] > levels[0] + 20 ? loudest : undefined;
}

/**
 * Re-reads the catalog, applies `change` and saves it: ingest runs for minutes, and edits made meanwhile (Claude writing
 * notes, moments, kind) must survive its saves.
 */
async function updateCatalog(project: string, change: (catalog: Catalog) => void): Promise<Catalog> {
  const catalog = await loadCatalog(project);
  change(catalog);
  await saveCatalog(project, catalog);
  return catalog;
}

/** A catalog.json that can't be read stops the ingest: the hint says the clips catalogued so far are kept. */
function stopIngest(e: JsonFileError): JsonFileError {
  e.hint = `${e.hint} Then run ingest again: the clips catalogued so far are kept.`;
  return e;
}

async function loadCatalogOrStop(project: string): Promise<Catalog> {
  try {
    return await loadCatalog(project);
  } catch (e) {
    throw e instanceof JsonFileError ? stopIngest(e) : e;
  }
}

const NOT_A_VIDEO = `not a video Mirage reads (${[...VIDEO_EXTENSIONS].join(', ')})`;

async function clipFiles(dir: string, result: IngestResult): Promise<string[]> {
  const st = await stat(dir).catch(() => null);
  if (!st) throw new MirageError('BAD_INPUT', `${dir} does not exist`, 'Pass the folder your clips are in.');
  if (!st.isDirectory()) throw new MirageError('BAD_INPUT', `${dir} is a file, not a folder`, 'Pass the folder your clips are in.');
  const files: string[] = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith('.')) continue;
    if (VIDEO_EXTENSIONS.has(extname(e.name).toLowerCase())) files.push(e.name);
    else if (!e.isDirectory()) result.skipped.push({ file: e.name, reason: NOT_A_VIDEO });
  }
  return files;
}

export async function ingestClips(o: { project: string; clipsDir: string; tools: MediaTools; locale?: string; onStep?: (m: string) => void }): Promise<IngestResult> {
  const project = resolve(o.project);
  await mkdir(project, { recursive: true });
  const lock = await acquireLock(project, 'ingest', 'the project');
  try {
    await clearLeftovers(project, lock, (f) => /^\.tmp-c\d+\.wav$/.test(f));
    return await ingestLocked(o, project);
  } finally {
    await lock.release();
  }
}

async function ingestLocked(o: Parameters<typeof ingestClips>[0], project: string): Promise<IngestResult> {
  const result: IngestResult = { added: [], skipped: [], warnings: [] };
  const dir = resolve(o.clipsDir);
  const files = await clipFiles(dir, result);
  let catalog: Catalog;

  for (const name of files) {
    const path = join(dir, name);
    // Read before each clip's slow work: catalog.json edited into an invalid file stops the run here, not after it.
    catalog = await loadCatalogOrStop(project);
    let id = nextClipId(catalog);
    let framesDir = join(project, 'frames', id);
    try {
      const sha256 = await sha256File(path);
      const prev = catalog.clips.find((c) => c.sha256 === sha256);
      if (prev) {
        let moved = false;
        let transcript: Transcript | null = null;
        if (prev.path !== path && !existsSync(prev.path)) {
          moved = true;
          o.onStep?.(`${name}: moved, path updated`);
        }
        if ((moved || prev.path === path) && prev.probe.hasAudio && prev.transcript === null) {
          // A transcription that failed last time: try again, keeping everything else about the clip.
          transcript = await transcribeClip({ tools: o.tools, path, name, wav: join(project, `.tmp-${prev.id}.wav`), durationSec: prev.probe.durationSec, audioStream: prev.probe.audioStream, locale: o.locale, result, onStep: o.onStep });
          if (transcript) o.onStep?.(`${name}: transcribed`);
        }
        if (moved || transcript) {
          catalog = await updateCatalog(project, (cat) => {
            const clip = cat.clips.find((c) => c.id === prev.id);
            if (!clip) return;
            if (moved) clip.path = path;
            if (transcript) clip.transcript = transcript;
          });
        } else result.skipped.push({ file: name, reason: 'already in the catalog' });
        continue;
      }
      let probe = await o.tools.probe(path);
      if (!probe.hasVideo) {
        result.skipped.push({ file: name, reason: 'no video stream' });
        continue;
      }
      if (!(probe.durationSec > 0)) {
        result.skipped.push({ file: name, reason: "its duration can't be read (a damaged or streamed recording) — re-export it, e.g. QuickTime → File → Export As" });
        continue;
      }
      o.onStep?.(`${name} → ${id}`);
      if (probe.colorTransfer && HDR_TRANSFERS.has(probe.colorTransfer)) {
        result.warnings.push(`${name} is HDR (${probe.colorTransfer}); colours will look washed out — export it as SDR (e.g. Photos → Export → "Most Compatible")`);
      }

      if (probe.hasAudio && probe.audioStreams) {
        const audioStream = await soundStream(o.tools, path, probe.audioStreams);
        if (audioStream !== undefined) {
          probe = { ...probe, audioStream };
          result.warnings.push(`${name}: its first audio track is silent, so its sound is taken from track ${audioStream + 1}`);
        }
      }
      const videoSec = probe.videoDurationSec ?? probe.durationSec;
      if (probe.scanFailed) {
        result.warnings.push(`${name}: Mirage couldn't read through the whole file, so its length is what its header says (${s1(probe.durationSec)} s) — not checked for a cut-short copy; if renders of it fail, copy or export it again`);
      }
      if (probe.truncated) {
        result.warnings.push(`${name} looks cut short: its header promises more than the file holds, so only its first ${s1(probe.durationSec)} s can be used — copy or export it again if more was recorded`);
      }
      if (probe.durationSec - videoSec > Math.max(1, 0.1 * probe.durationSec)) {
        result.warnings.push(`${name}: its picture stops at ${s1(videoSec)} s but its sound runs to ${s1(probe.durationSec)} s — items can use only the first ${s1(videoSec)} s`);
      }

      await rm(framesDir, { recursive: true, force: true });
      await mkdir(framesDir, { recursive: true });
      const interval = frameInterval(videoSec);
      // A clip shorter than the interval gets one frame, from its middle.
      const first = videoSec < interval ? r3(videoSec / 2) : 0;
      // Frame i shows the latest source frame at or before first + i × interval (start_time and round=up; plain fps
      // picks the nearest frame, up to half an interval late), on the clock render seeks by (see itemChunkArgs), with
      // slack for frames stamped a few ms late (1/120 s: MKV and WebM round times to the ms).
      // Run inside the frames folder with a bare pattern: a % in the project path would be read as part of it.
      await o.tools.runFfmpeg(['-noaccurate_seek', '-ss', String(first), '-i', path, '-vf', `setpts=PTS-1/120/TB,fps=1/${interval}:start_time=0:round=up,scale=640:-2`, ...(first ? ['-frames:v', '1'] : []), '-q:v', '5', 'f%04d.jpg'], {
        cwd: framesDir,
        expectedDurationSec: probe.durationSec,
        timeoutMs: Math.max(120_000, probe.durationSec * 5000),
      });
      const frameFiles = (await readdir(framesDir)).filter((f) => f.endsWith('.jpg')).sort();

      // null = no audio, or transcription failed (retried on the next ingest); no words = transcribed, nothing said.
      const transcript = probe.hasAudio
        ? await transcribeClip({ tools: o.tools, path, name, wav: join(project, `.tmp-${id}.wav`), durationSec: probe.durationSec, audioStream: probe.audioStream, locale: o.locale, result, onStep: o.onStep })
        : null;

      let clip!: Clip;
      catalog = await updateCatalog(project, (cat) => {
        if (cat.clips.some((c) => c.id === id)) {
          // Someone else catalogued a clip meanwhile: take the next free id (its frames folder moves below).
          id = nextClipId(cat);
        }
        const frames = frameFiles.map((f, i) => ({ t: first + i * interval, file: `frames/${id}/${f}` }));
        clip = { id, path, sha256, probe, kind: guessKind(probe, transcript), transcript, frames, notes: '', moments: [] };
        cat.clips.push(clip);
      });
      const finalDir = join(project, 'frames', id);
      if (finalDir !== framesDir) {
        await rename(framesDir, finalDir);
        framesDir = finalDir;
      }
      result.added.push(clip);
    } catch (e) {
      // the catalog was not saved with this clip: its frames must not stay behind
      if (!catalog.clips.some((c) => c.id === id)) await rm(framesDir, { recursive: true, force: true }).catch(() => {});
      // A broken catalog.json would fail every remaining clip after all its work: stop instead.
      if (e instanceof JsonFileError) throw stopIngest(e);
      result.skipped.push({ file: name, reason: `failed: ${errorReason(e)}` });
    }
  }
  return result;
}
