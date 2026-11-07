// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { ZodError, type ZodType } from 'zod';

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

type Issue = ZodError['issues'][number];

/**
 * The issues with each failed union (a timeline item is a clip item or a card) replaced by those of the branch the
 * value was most likely meant for: the first whose keys all fit it (no unknown key at its top), else the first. Its
 * "Invalid input" says nothing; the branch's issues name the field.
 */
function flatIssues(issues: readonly Issue[]): Issue[] {
  return issues.flatMap((i) => {
    if (i.code !== 'invalid_union' || !('errors' in i) || !i.errors.length) return [i];
    const branch = i.errors.find((b) => !b.some((x) => x.code === 'unrecognized_keys' && x.path.length === 0)) ?? i.errors[0]!;
    return flatIssues(branch.map((x) => ({ ...x, path: [...i.path, ...x.path] })));
  });
}

const firstIssue = (e: ZodError) => {
  const issues = flatIssues(e.issues);
  return issues.find((i) => i.code === 'unrecognized_keys') ?? issues[0]!;
};

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
