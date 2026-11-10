import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { SidecarError } from './errors.js';
import { runPath, type RunOptions, type RunResult } from './run.js';

/** yt-dlp (https://github.com/yt-dlp/yt-dlp): reads a channel's public video list, captions and info. Mirage never downloads a video with it. */
export const YTDLP = 'yt-dlp';

const exe = () => (process.platform === 'win32' ? `${YTDLP}.exe` : YTDLP);

export function ytDlpInstallHint(): string {
  return `Install yt-dlp (macOS: brew install yt-dlp; Windows: winget install yt-dlp) or set WORDEDITS_YTDLP_DIR to a folder containing ${exe()}.`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where installers put yt-dlp outside PATH: the desktop app may not inherit the shell's PATH (Homebrew's is set in ~/.zprofile). */
function knownDirs(): string[] {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return [join(local, 'Microsoft', 'WinGet', 'Links'), join(local, 'Programs', 'yt-dlp')];
  }
  return ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', join(homedir(), '.local', 'bin')];
}

/**
 * Resolution order: WORDEDITS_YTDLP_DIR (if set, it must contain yt-dlp), then PATH, then the folders installers use.
 * Not cached: an install made while the engine runs is found.
 */
export async function locateYtDlp(): Promise<string> {
  const override = process.env.WORDEDITS_YTDLP_DIR;
  if (override) {
    const p = join(override, exe());
    if (await exists(p)) return p;
    throw new SidecarError(YTDLP, 'NOT_FOUND', `${YTDLP} not found in WORDEDITS_YTDLP_DIR (${override})`, `Put ${exe()} in that folder or unset WORDEDITS_YTDLP_DIR.`);
  }
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...knownDirs()];
  for (const dir of dirs) {
    const p = join(dir, exe());
    if (await exists(p)) return p;
  }
  throw new SidecarError(YTDLP, 'NOT_FOUND', `${YTDLP} was not found`, ytDlpInstallHint());
}

/** Runs yt-dlp with these arguments (no shell). */
export async function runYtDlp(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return runPath(YTDLP, await locateYtDlp(), args, { notFoundHint: ytDlpInstallHint(), ...opts });
}
