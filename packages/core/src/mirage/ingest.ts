import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { CatalogSchema, type Catalog, type Clip, type ClipKind, type ProbeInfo, type Transcript } from '@wordedits/shared';
import type { MediaTools } from '../media-tools.js';
import { readJsonFile, writeJsonFile } from '../project-store.js';

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm']);
const MAX_TRANSCRIBE_SEC = 30 * 60;

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
    return await readJsonFile(join(resolve(project), 'catalog.json'), CatalogSchema);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, clips: [] };
    throw e;
  }
}

export async function saveCatalog(project: string, catalog: Catalog): Promise<void> {
  await writeJsonFile(join(resolve(project), 'catalog.json'), CatalogSchema, catalog);
}

export function nextClipId(catalog: Catalog): string {
  const max = catalog.clips.reduce((m, c) => Math.max(m, Number(c.id.slice(1))), 0);
  return `c${String(max + 1).padStart(3, '0')}`;
}

export interface IngestResult {
  added: Clip[];
  skipped: { file: string; reason: string }[];
}

export async function ingestClips(o: { project: string; clipsDir: string; tools: MediaTools; locale?: string; onStep?: (m: string) => void }): Promise<IngestResult> {
  const project = resolve(o.project);
  const dir = resolve(o.clipsDir);
  await mkdir(project, { recursive: true });
  const catalog = await loadCatalog(project);
  const known = new Set(catalog.clips.map((c) => c.sha256));
  const files = (await readdir(dir)).filter((f) => !f.startsWith('.') && VIDEO_EXTENSIONS.has(extname(f).toLowerCase())).sort();
  const result: IngestResult = { added: [], skipped: [] };

  for (const name of files) {
    const path = join(dir, name);
    const sha256 = await sha256File(path);
    if (known.has(sha256)) {
      result.skipped.push({ file: name, reason: 'already in the catalog' });
      continue;
    }
    const probe = await o.tools.probe(path);
    if (!probe.hasVideo) {
      result.skipped.push({ file: name, reason: 'no video stream' });
      continue;
    }
    const id = nextClipId(catalog);
    o.onStep?.(`${name} → ${id}`);

    const framesDir = join(project, 'frames', id);
    await mkdir(framesDir, { recursive: true });
    const interval = frameInterval(probe.durationSec);
    await o.tools.runFfmpeg(['-i', path, '-vf', `fps=1/${interval},scale=640:-2`, '-q:v', '5', join(framesDir, 'f%04d.jpg')], {
      expectedDurationSec: probe.durationSec,
      timeoutMs: Math.max(120_000, probe.durationSec * 5000),
    });
    const frames = (await readdir(framesDir))
      .filter((f) => f.endsWith('.jpg'))
      .sort()
      .map((f, i) => ({ t: i * interval, file: relative(project, join(framesDir, f)) }));

    let transcript: Transcript | null = null;
    if (probe.hasAudio && probe.durationSec <= MAX_TRANSCRIBE_SEC) {
      const wav = join(project, `.tmp-${id}.wav`);
      try {
        await o.tools.extractWav(path, wav);
        transcript = await o.tools.transcribe(wav, { locale: o.locale });
      } finally {
        await rm(wav, { force: true });
      }
      if (transcript.words.length === 0) transcript = null;
    }

    const clip: Clip = { id, path, sha256, probe, kind: guessKind(probe, transcript), transcript, frames, notes: '', moments: [] };
    catalog.clips.push(clip);
    known.add(sha256);
    result.added.push(clip);
    await saveCatalog(project, catalog);
  }
  return result;
}
