import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MirageError } from './errors.js';

/**
 * A path the user typed, made absolute: a leading `~/` is their home folder (a quoted "~/x" reaches us unexpanded) and a
 * relative path is relative to where they typed the command (`pnpm` runs scripts from the repo root and passes that as INIT_CWD).
 */
export function resolveUserPath(p: string, base: string = process.env.INIT_CWD ?? process.cwd(), home: string = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return resolve(base, p);
}

/** The `init` command: creates the project folder with mirage.json. Refuses a folder that already is a project. */
export async function initProject(project: string, title: string): Promise<void> {
  const file = join(project, 'mirage.json');
  if (existsSync(file)) throw new MirageError('BAD_INPUT', `${project} is already a Mirage project`, 'Nothing was changed; edit mirage.json to change its title.');
  await mkdir(join(project, 'episodes'), { recursive: true });
  await mkdir(join(project, 'music'), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, title, createdAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
}

/** Every command but `init` works on an existing project: a mistyped path must not become a new one. */
export function requireProject(project: string): void {
  if (!existsSync(join(project, 'mirage.json'))) {
    throw new MirageError('NO_PROJECT', `no Mirage project at ${project}`, `Check the path, or create one with: pnpm mirage init ${project} --title "<title>"`);
  }
}
