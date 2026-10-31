import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { CatalogSchema, type Catalog, type Clip, type ClipKind, type ProbeInfo, type Transcript } from '@wordedits/shared';
import type { MediaTools } from '../media-tools.js';
import { readJsonFile, writeJsonFile } from '../project-store.js';
import { acquireLock, clearLeftovers } from './lock.js';

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm']);
const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084']);

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
async function transcribeClip(o: { tools: MediaTools; path: string; name: string; wav: string; durationSec: number; locale?: string; result: IngestResult; onStep?: (m: string) => void }): Promise<Transcript | null> {
  try {
    await o.tools.extractWav(o.path, o.wav, { timeoutMs: Math.max(10 * 60_000, o.durationSec * 500) });
    return await o.tools.transcribe(o.wav, { locale: o.locale, timeoutMs: Math.max(30 * 60_000, o.durationSec * 2000) });
  } catch (e) {
    o.onStep?.(`${o.name}: transcription failed, kept as silent footage`);
    o.result.warnings.push(`${o.name}: transcription failed (${e instanceof Error ? e.message : String(e)}); its speech is invisible to slots and captions — run ingest again to retry`);
    return null;
  } finally {
    await rm(o.wav, { force: true }).catch(() => {});
  }
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
  const dir = resolve(o.clipsDir);
  const catalog = await loadCatalog(project);
  const known = new Map(catalog.clips.map((c) => [c.sha256, c]));
  const files = (await readdir(dir)).filter((f) => !f.startsWith('.') && VIDEO_EXTENSIONS.has(extname(f).toLowerCase())).sort();
  const result: IngestResult = { added: [], skipped: [], warnings: [] };

  for (const name of files) {
    const path = join(dir, name);
    const id = nextClipId(catalog);
    const framesDir = join(project, 'frames', id);
    let sha256 = '';
    try {
      sha256 = await sha256File(path);
      const prev = known.get(sha256);
      if (prev) {
        let changed = false;
        if (prev.path !== path && !existsSync(prev.path)) {
          prev.path = path;
          changed = true;
          o.onStep?.(`${name}: moved, path updated`);
        }
        if (prev.path === path && prev.probe.hasAudio && prev.transcript === null) {
          // A transcription that failed last time: try again, keeping everything else about the clip.
          const transcript = await transcribeClip({ tools: o.tools, path, name, wav: join(project, `.tmp-${prev.id}.wav`), durationSec: prev.probe.durationSec, locale: o.locale, result, onStep: o.onStep });
          if (transcript) {
            prev.transcript = transcript;
            changed = true;
            o.onStep?.(`${name}: transcribed`);
          }
        }
        if (changed) await saveCatalog(project, catalog);
        else result.skipped.push({ file: name, reason: 'already in the catalog' });
        continue;
      }
      const probe = await o.tools.probe(path);
      if (!probe.hasVideo) {
        result.skipped.push({ file: name, reason: 'no video stream' });
        continue;
      }
      o.onStep?.(`${name} → ${id}`);
      if (probe.colorTransfer && HDR_TRANSFERS.has(probe.colorTransfer)) {
        result.warnings.push(`${name} is HDR (${probe.colorTransfer}); colours will look washed out — export it as SDR (e.g. Photos → Export → "Most Compatible")`);
      }

      await rm(framesDir, { recursive: true, force: true });
      await mkdir(framesDir, { recursive: true });
      const interval = frameInterval(probe.durationSec);
      await o.tools.runFfmpeg(['-i', path, '-vf', `fps=1/${interval},scale=640:-2`, '-q:v', '5', join(framesDir, 'f%04d.jpg')], {
        expectedDurationSec: probe.durationSec,
        timeoutMs: Math.max(120_000, probe.durationSec * 5000),
      });
      const frames = (await readdir(framesDir))
        .filter((f) => f.endsWith('.jpg'))
        .sort()
        .map((f, i) => ({ t: i * interval, file: `frames/${id}/${f}` }));

      // null = no audio, or transcription failed (retried on the next ingest); no words = transcribed, nothing said.
      const transcript = probe.hasAudio
        ? await transcribeClip({ tools: o.tools, path, name, wav: join(project, `.tmp-${id}.wav`), durationSec: probe.durationSec, locale: o.locale, result, onStep: o.onStep })
        : null;

      const clip: Clip = { id, path, sha256, probe, kind: guessKind(probe, transcript), transcript, frames, notes: '', moments: [] };
      catalog.clips.push(clip);
      known.set(sha256, clip);
      result.added.push(clip);
      await saveCatalog(project, catalog);
    } catch (e) {
      // a failed catalog save must not leave a half-registered clip behind
      if (catalog.clips.at(-1)?.id === id) {
        catalog.clips.pop();
        result.added.pop();
        if (sha256) known.delete(sha256);
      }
      await rm(framesDir, { recursive: true, force: true }).catch(() => {});
      result.skipped.push({ file: name, reason: `failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return result;
}
