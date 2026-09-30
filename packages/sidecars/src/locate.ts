import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { SidecarError } from './errors.js';

export type Tool = 'ffmpeg' | 'ffprobe';

const cache = new Map<Tool, string>();
export function _resetLocateCache(): void {
  cache.clear();
}

const exe = (tool: Tool) => (process.platform === 'win32' ? `${tool}.exe` : tool);

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

/**
 * Resolution order: WORDEDITS_FFMPEG_DIR (if set, it must contain the binary),
 * then PATH, then the ffmpeg-static / ffprobe-static packages.
 */
export async function locate(tool: Tool): Promise<string> {
  const cached = cache.get(tool);
  if (cached) return cached;

  const override = process.env.WORDEDITS_FFMPEG_DIR;
  if (override) {
    const p = join(override, exe(tool));
    if (await exists(p)) return remember(tool, p);
    throw new SidecarError(
      tool, 'NOT_FOUND',
      `${tool} not found in WORDEDITS_FFMPEG_DIR (${override})`,
      `Put ${exe(tool)} in that folder or unset WORDEDITS_FFMPEG_DIR.`,
    );
  }

  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const p = join(dir, exe(tool));
    if (await exists(p)) return remember(tool, p);
  }

  const bundled = await fromStaticPackage(tool);
  if (bundled && (await exists(bundled))) return remember(tool, bundled);

  throw new SidecarError(
    tool, 'NOT_FOUND',
    `${tool} was not found`,
    `Install FFmpeg (macOS: brew install ffmpeg; Windows: winget install ffmpeg) or set WORDEDITS_FFMPEG_DIR to a folder containing ${exe(tool)}.`,
  );
}

function remember(tool: Tool, p: string): string {
  cache.set(tool, p);
  return p;
}
