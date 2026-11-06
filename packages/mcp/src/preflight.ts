// SPDX-License-Identifier: MIT
import { execFile, spawn } from 'node:child_process';
import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readVideo } from '@wordedits/core';
import { locate, whisperSetup } from '@wordedits/sidecars';

/** What the overnight check asks of the machine. Tests pass stubs; the server passes realPreflightDeps(). */
export interface PreflightDeps {
  onBattery(): Promise<boolean>;
  freeBytes(path: string): Promise<number>;
  footageBytes(project: string, n: number): Promise<number>;
  which(cmd: string): Promise<boolean>;
  /** What speech recognition is missing (whisper-cli, its model, or both, with how to get them); null when both are found. */
  transcriber(): Promise<string | null>;
}

const GB = 1024 ** 3;

/** Whether tonight's videos can be edited unattended: plugged in, with room for the renders, and with the tools installed. */
export async function preflight(o: { project: string; videos: number[]; deps: PreflightDeps }): Promise<{ ok: boolean; problems: string[] }> {
  const { deps } = o;
  const problems: string[] = [];
  if (await deps.onBattery()) problems.push('Plug in your Mac. Overnight editing needs the power adapter.');
  const footage = (await Promise.all(o.videos.map((n) => deps.footageBytes(o.project, n)))).reduce((a, b) => a + b, 0);
  const needed = Math.max(10 * GB, 2 * footage);
  if ((await deps.freeBytes(o.project)) < needed) problems.push(`Free up space: Mirage needs about ${Math.ceil(needed / GB)} GB on this disk for tonight's videos.`);
  for (const tool of ['ffmpeg', 'ffprobe']) {
    if (!(await deps.which(tool))) problems.push(`${tool} isn't installed. Run /mirage:setup.`);
  }
  const speech = await deps.transcriber();
  if (speech) problems.push(`Speech recognition isn't set up: ${speech} Run /mirage:setup.`);
  return { ok: problems.length === 0, problems };
}

const execFileAsync = promisify(execFile);

/** Total size of the files under `dir` (0 when it is not there). */
async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, e.name);
    if (e.isDirectory()) total += await folderBytes(path);
    else if (e.isFile()) total += (await stat(path).catch(() => null))?.size ?? 0;
  }
  return total;
}

/** The checks against the real machine. */
export function realPreflightDeps(): PreflightDeps {
  return {
    onBattery: async () => {
      try {
        return (await execFileAsync('pmset', ['-g', 'batt'])).stdout.includes('Battery Power');
      } catch {
        return false; // no pmset (not a Mac): nothing says it runs on battery
      }
    },
    freeBytes: async (path) => {
      const s = await statfs(path);
      return s.bavail * s.bsize;
    },
    footageBytes: async (project, n) => {
      const video = await readVideo(project, n).catch(() => null);
      return (await Promise.all((video?.footage ?? []).map(folderBytes))).reduce((a, b) => a + b, 0);
    },
    which: (cmd) => locate(cmd as 'ffmpeg' | 'ffprobe').then(() => true, () => false),
    transcriber: async () => {
      const s = await whisperSetup();
      return s.ok ? null : s.problem;
    },
  };
}

/**
 * Keeps the Mac from sleeping for as long as this process lives (`caffeinate -i -w <pid>` ends when the pid does). Detached and
 * unref'd so it never holds the server up. Returns caffeinate's pid, or null when it could not be started (not a Mac).
 */
export function startCaffeinate(): number | null {
  const child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); // no caffeinate on this machine: the overnight run is just not kept awake
  child.unref();
  return child.pid ?? null;
}
