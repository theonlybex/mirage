// SPDX-License-Identifier: MIT
// Which Mirage project a hook event belongs to. Only node:fs/node:path, so main.ts can ask before loading anything else.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** How many folders above `cwd` are looked at for a mirage.json. */
const MAX_LEVELS = 20;

/**
 * The project root of a hook event: `projectDir` (CLAUDE_PROJECT_DIR, as the engine and viewer use) when it is set and
 * holds a mirage.json; when it isn't set, the nearest folder at or above `cwd` holding one (at most 20 levels up). Null
 * when neither: not a Mirage project. With projectDir set this is one existsSync, so other sessions stay fast.
 */
export function findProject(projectDir: string | undefined, cwd: string): string | null {
  if (projectDir) return existsSync(join(projectDir, 'mirage.json')) ? resolve(projectDir) : null;
  let dir = resolve(cwd);
  for (let i = 0; i <= MAX_LEVELS; i++) {
    if (existsSync(join(dir, 'mirage.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}
