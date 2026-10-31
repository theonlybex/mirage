import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EdlSchema, ProjectSchema, type Edl, type Project } from '@wordedits/shared';
import { ZodError, type ZodType } from 'zod';

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

/** A project file that is not valid JSON or does not match its schema. `file` is the name shown to the user. */
export class JsonFileError extends Error {
  override name = 'JsonFileError';
  constructor(
    public file: string,
    message: string,
    public hint = 'Fix that field and run the command again.',
  ) {
    super(`${file}: ${message}`);
  }
}

function issuePath(path: PropertyKey[]): string {
  return path.reduce<string>((s, k) => (typeof k === 'number' ? `${s}[${k}]` : s ? `${s}.${String(k)}` : String(k)), '');
}

/** A schema error as one readable line, `items[2].src: message`: an unknown key first (it usually explains the other issues, e.g. a misspelled required key), else the first issue. */
export function describeZodError(e: ZodError): string {
  const issue = firstIssue(e);
  const at = issuePath(issue.path);
  return `${at ? `${at}: ` : ''}${issue.message}`;
}

const firstIssue = (e: ZodError) => e.issues.find((i) => i.code === 'unrecognized_keys') ?? e.issues[0];

const UNKNOWN_KEY_HINT = 'Remove or rename that key (a misspelled key would be ignored).';

function schemaError(display: string, e: ZodError, hint?: string): JsonFileError {
  return new JsonFileError(display, describeZodError(e), firstIssue(e).code === 'unrecognized_keys' ? UNKNOWN_KEY_HINT : hint);
}

/** Reads and validates a JSON file. `display` names the file in errors (defaults to `path`); ENOENT is rethrown as is. */
export async function readJsonFile<T>(path: string, schema: ZodType<T>, display: string = path): Promise<T> {
  const text = await readFile(path, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new JsonFileError(display, `not valid JSON (${(e as Error).message})`);
  }
  try {
    return schema.parse(raw);
  } catch (e) {
    if (!(e instanceof ZodError)) throw e;
    throw schemaError(display, e);
  }
}

/**
 * Validates and writes a JSON file atomically. A value that fails its schema writes nothing and throws a JsonFileError
 * naming `display`. With `onlyIfChanged`, a file that already holds exactly this content is left untouched.
 */
export async function writeJsonFile<T>(path: string, schema: ZodType<T>, value: T, display: string = path, o: { onlyIfChanged?: boolean } = {}): Promise<void> {
  let parsed: T;
  try {
    parsed = schema.parse(value);
  } catch (e) {
    if (!(e instanceof ZodError)) throw e;
    throw schemaError(display, e, 'Nothing was written. Fix that field and run the command again.');
  }
  const text = JSON.stringify(parsed, null, 2) + '\n';
  if (o.onlyIfChanged && (await readFile(path, 'utf8').catch(() => null)) === text) return;
  const tmpPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, text, 'utf8');
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
