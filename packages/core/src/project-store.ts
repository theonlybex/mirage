import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EdlSchema, ProjectSchema, type Edl, type Project } from '@wordedits/shared';
import type { ZodType } from 'zod';

export interface ProjectHandle {
  dir: string;
  project: Project;
}

export function slugify(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'untitled';
}

export async function readJsonFile<T>(path: string, schema: ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export async function writeJsonFile<T>(path: string, schema: ZodType<T>, value: T): Promise<void> {
  const parsed = schema.parse(value);
  const tmpPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  await rename(tmpPath, path);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function createProject(rootDir: string, title: string): Promise<ProjectHandle> {
  const base = slugify(title);
  let dir = join(rootDir, base);
  for (let n = 2; await exists(dir); n++) dir = join(rootDir, `${base}-${n}`);

  await mkdir(join(dir, 'source'), { recursive: true });
  await mkdir(join(dir, 'renders'), { recursive: true });
  await mkdir(join(dir, 'history'), { recursive: true });

  const project: Project = {
    id: randomUUID(),
    title,
    createdAt: new Date().toISOString(),
    stage: 'start',
    format: 'talking-head',
    source: null,
  };
  await writeJsonFile(join(dir, 'project.json'), ProjectSchema, project);
  return { dir, project };
}

export async function openProject(dir: string): Promise<ProjectHandle> {
  const project = await readJsonFile(join(dir, 'project.json'), ProjectSchema);
  return { dir, project };
}

export async function saveProject(handle: ProjectHandle): Promise<void> {
  await writeJsonFile(join(handle.dir, 'project.json'), ProjectSchema, handle.project);
}

export async function saveEdl(handle: ProjectHandle, edl: Edl): Promise<{ snapshot: string }> {
  const parsed = EdlSchema.parse(edl);
  const histDir = join(handle.dir, 'history');
  await mkdir(histDir, { recursive: true });
  const existing = (await readdir(histDir))
    .map((f) => /^edl\.(\d{4})\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  const snapshot = join(histDir, `edl.${String(next).padStart(4, '0')}.json`);
  await writeJsonFile(snapshot, EdlSchema, parsed);
  await writeJsonFile(join(handle.dir, 'edl.json'), EdlSchema, parsed);
  return { snapshot };
}

export async function loadEdl(handle: ProjectHandle): Promise<Edl> {
  return readJsonFile(join(handle.dir, 'edl.json'), EdlSchema);
}
