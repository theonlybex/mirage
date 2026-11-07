// SPDX-License-Identifier: MIT
// What Mirage remembers about asking to set up its tools. Only node:fs/node:path (no zod), so the SessionStart hook,
// which runs in every Claude Code session, can read it without loading the rest of this package.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The file in the plugin's data folder. */
export const SETUP_FILE = 'setup.json';

/** How many days "not now" holds off asking again. */
export const LATER_DAYS = 7;

export interface SetupState {
  /** The plugin version the person was last asked about, wherever the notice shows. */
  askedVersion?: string;
  /** An ISO date: no asking before then, because the person said "not now". */
  laterUntil?: string;
  /** The FFmpeg the engine last checked: where it is, when the file was last changed, and whether it can draw captions (has libass). */
  ffmpeg?: FfmpegRecord;
}

export interface FfmpegRecord {
  path: string;
  mtimeMs: number;
  captions: boolean;
}

/** The state in `<dataDir>/setup.json`; `{}` when the file is missing or broken, and fields of the wrong type are dropped. */
export function readSetupState(dataDir: string): SetupState {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, SETUP_FILE), 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const { askedVersion, laterUntil, ffmpeg } = raw as Record<string, unknown>;
    const state: SetupState = {};
    if (typeof askedVersion === 'string') state.askedVersion = askedVersion;
    if (typeof laterUntil === 'string') state.laterUntil = laterUntil;
    if (typeof ffmpeg === 'object' && ffmpeg !== null && !Array.isArray(ffmpeg)) {
      const { path, mtimeMs, captions } = ffmpeg as Record<string, unknown>;
      if (typeof path === 'string' && typeof mtimeMs === 'number' && Number.isFinite(mtimeMs) && typeof captions === 'boolean') state.ffmpeg = { path, mtimeMs, captions };
    }
    return state;
  } catch {
    return {};
  }
}

/** Merges `patch` into `<dataDir>/setup.json`, creating `dataDir`. Never throws: not remembering only means asking again. */
export function writeSetupState(dataDir: string, patch: SetupState): void {
  try {
    const next: SetupState = { ...readSetupState(dataDir) };
    if (patch.askedVersion !== undefined) next.askedVersion = patch.askedVersion;
    if (patch.laterUntil !== undefined) next.laterUntil = patch.laterUntil;
    if (patch.ffmpeg !== undefined) next.ffmpeg = patch.ffmpeg;
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, SETUP_FILE), `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // Not remembered; the person may be asked once more.
  }
}
