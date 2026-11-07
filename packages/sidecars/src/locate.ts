import { access, constants, stat } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { writeSetupState } from '@wordedits/shared/setup-state';
import { SidecarError } from './errors.js';
import { runPath } from './run.js';

export type Tool = 'ffmpeg' | 'ffprobe';

/** Homebrew's complete FFmpeg is keg-only: it is never linked onto PATH, so Mirage looks in its folder itself. */
const KEG_DIRS = ['/opt/homebrew/opt/ffmpeg-full/bin', '/usr/local/opt/ffmpeg-full/bin', '/home/linuxbrew/.linuxbrew/opt/ffmpeg-full/bin'];
/** How long `ffmpeg -filters` may take before the FFmpeg counts as unable to draw captions. */
const CAPTIONS_TIMEOUT_MS = 10_000;

let kegDirs = KEG_DIRS;
let captionsTimeoutMs = CAPTIONS_TIMEOUT_MS;
let useStatic = true;
/** What ffmpeg -filters said, per FFmpeg file (path and mtime): each file is asked once per process. */
const captionChecks = new Map<string, Promise<boolean>>();

export function _resetLocateCache(): void {
  captionChecks.clear();
}

/** For tests: where the keg folders are, how long the check may take, and whether the ffmpeg-static package counts. */
export function _setCaptionsCheck(o: { kegDirs?: string[]; timeoutMs?: number; noStatic?: boolean }): void {
  kegDirs = o.kegDirs ?? KEG_DIRS;
  captionsTimeoutMs = o.timeoutMs ?? CAPTIONS_TIMEOUT_MS;
  useStatic = !o.noStatic;
}

const exe = (tool: Tool) => (process.platform === 'win32' ? `${tool}.exe` : tool);

/** What to tell the user when a tool is missing or cannot be started. */
export function installHint(tool: Tool): string {
  return `Install FFmpeg (macOS: brew install ffmpeg; Windows: winget install ffmpeg) or set WORDEDITS_FFMPEG_DIR to a folder containing ${exe(tool)}.`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function fromStaticPackage(tool: Tool): Promise<string | null> {
  try {
    if (tool === 'ffmpeg') {
      const mod = await import('ffmpeg-static');
      return mod.default;
    }
    const mod = await import('ffprobe-static');
    return mod.path;
  } catch {
    return null;
  }
}

async function overrideMissing(tool: Tool, override: string): Promise<never> {
  throw new SidecarError(
    tool, 'NOT_FOUND',
    `${tool} not found in WORDEDITS_FFMPEG_DIR (${override})`,
    `Put ${exe(tool)} in that folder or unset WORDEDITS_FFMPEG_DIR.`,
  );
}

/** Every FFmpeg to consider, best place first. WORDEDITS_FFMPEG_DIR, when set, is the only place looked. */
async function ffmpegCandidates(): Promise<string[]> {
  const override = process.env.WORDEDITS_FFMPEG_DIR;
  if (override) {
    const p = join(override, exe('ffmpeg'));
    return (await exists(p)) ? [p] : overrideMissing('ffmpeg', override);
  }
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...(process.platform === 'win32' ? [] : kegDirs)];
  const found: string[] = [];
  for (const dir of dirs) {
    const p = join(dir, exe('ffmpeg'));
    if (!found.includes(p) && (await exists(p))) found.push(p);
  }
  if (found.length === 0 && useStatic) {
    const bundled = await fromStaticPackage('ffmpeg');
    if (bundled && (await exists(bundled))) found.push(bundled);
  }
  return found;
}

/** Whether `ffmpeg -filters` lists the `ass` filter (which needs libass). A run that fails or hangs counts as no. */
async function listsAssFilter(path: string): Promise<boolean> {
  try {
    const { stdout } = await runPath('ffmpeg', path, ['-hide_banner', '-filters'], { timeoutMs: captionsTimeoutMs });
    return /^\s*\S+\s+ass\s/m.test(stdout);
  } catch {
    return false;
  }
}

interface Resolved {
  path: string;
  captions: boolean;
  /** Whether this call had to run an FFmpeg (rather than reuse what it already knew). */
  asked: boolean;
}

/**
 * The FFmpeg to use: the first that can draw captions, else the first found (reported as unable to). Looked up afresh on every
 * call, so an FFmpeg installed while the engine runs is found; only what an FFmpeg file can do is remembered (by path and mtime).
 */
async function resolveFfmpeg(): Promise<Resolved> {
  const candidates = await ffmpegCandidates();
  if (candidates.length === 0) {
    throw new SidecarError('ffmpeg', 'NOT_FOUND', 'ffmpeg was not found', installHint('ffmpeg'));
  }
  let asked = false;
  let first: Resolved | undefined;
  for (const path of candidates) {
    const mtimeMs = (await stat(path)).mtimeMs;
    const key = `${path}\0${mtimeMs}`;
    let check = captionChecks.get(key);
    if (!check) {
      asked = true;
      check = listsAssFilter(path);
      captionChecks.set(key, check);
    }
    const captions = await check;
    if (captions) return remembered({ path, captions, asked }, mtimeMs);
    first ??= { path, captions, asked: false };
  }
  const chosen = first!;
  return remembered({ ...chosen, asked }, (await stat(chosen.path)).mtimeMs);
}

/** Writes what the check found to setup.json (the SessionStart hook reads it; it never starts a process) when an FFmpeg was asked. */
function remembered(r: Resolved, mtimeMs: number): Resolved {
  const dataDir = process.env.MIRAGE_PLUGIN_DATA;
  if (r.asked && dataDir) writeSetupState(dataDir, { ffmpeg: { path: r.path, mtimeMs, captions: r.captions } });
  return r;
}

/** What to tell the person whose FFmpeg was built without libass. */
export function captionsHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return "Install Homebrew's complete build: brew install ffmpeg-full (Mirage finds it by itself).";
  if (platform === 'win32') return 'Install the full build: winget install --id Gyan.FFmpeg -e.';
  return "Install an FFmpeg built with libass (your distribution's ffmpeg package usually is), or set WORDEDITS_FFMPEG_DIR to one.";
}

export type CaptionsCheck = { ok: true; path: string } | { ok: false; path: string; hint: string };

/** Whether the FFmpeg Mirage uses can draw captions (render's last pass draws them with the `ass` filter). Throws NOT_FOUND without an FFmpeg. */
export async function ffmpegCaptions(): Promise<CaptionsCheck> {
  const { path, captions } = await resolveFfmpeg();
  return captions ? { ok: true, path } : { ok: false, path, hint: captionsHint() };
}

/**
 * Resolution order for ffmpeg: WORDEDITS_FFMPEG_DIR (if set, it is the only place looked and must contain the binary), else PATH,
 * then Homebrew's keg-only ffmpeg-full; the first that can draw captions wins, and if none can the first found is used. Then the
 * ffmpeg-static package when nothing else is there. ffprobe comes from the chosen ffmpeg's folder when it has one there, otherwise
 * from the same places in turn (override, PATH, ffprobe-static).
 */
export async function locate(tool: Tool): Promise<string> {
  if (tool === 'ffmpeg') return (await resolveFfmpeg()).path;

  const sibling = await resolveFfmpeg().then((r) => join(dirname(r.path), exe('ffprobe')), () => null);
  if (sibling && (await exists(sibling))) return sibling;

  const override = process.env.WORDEDITS_FFMPEG_DIR;
  if (override) {
    const p = join(override, exe(tool));
    return (await exists(p)) ? p : overrideMissing(tool, override);
  }

  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const p = join(dir, exe(tool));
    if (await exists(p)) return p;
  }

  const bundled = useStatic ? await fromStaticPackage(tool) : null;
  if (bundled && (await exists(bundled))) return bundled;

  throw new SidecarError(
    tool, 'NOT_FOUND',
    `${tool} was not found`,
    installHint(tool),
  );
}
