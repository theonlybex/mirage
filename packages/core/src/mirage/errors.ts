import { accessSync, constants, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { ZodError } from 'zod';
import { describeZodError } from './json-file.js';

export class MirageError extends Error {
  override name = 'MirageError';
  constructor(
    public code: 'BAD_ITEM' | 'BAD_INPUT' | 'BUSY' | 'NO_PROJECT' | 'NO_CATALOG' | 'NO_EPISODE' | 'NO_MUSIC_TRACK' | 'NOTHING_MATCHED' | 'DURATION_MISMATCH',
    message: string,
    public hint: string,
  ) {
    super(message);
  }
}

/** True when `path` exists but this process may not read it. */
function unreadableFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT' && existsSync(path);
  }
}

/**
 * Any error as the one-line message and hint the CLI prints: errors that carry a hint (MirageError, JsonFileError,
 * SidecarError) as they are, a stray schema error and file-system errors in plain words.
 */
export function describeError(e: unknown): { message: string; hint?: string } {
  if (e instanceof ZodError) return { message: describeZodError(e), hint: 'This is a bug in Mirage; the file was not changed.' };
  const err = e as NodeJS.ErrnoException & { hint?: string };
  if (typeof err?.message !== 'string') return { message: String(e) };
  const path = err.path;
  if (path && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS')) {
    const why = err.code === 'EROFS' ? 'the disk is read-only' : 'permission denied';
    if (err.syscall === 'scandir' || err.syscall === 'opendir') return { message: `can't read ${path}: ${why}`, hint: 'Check the folder\'s permissions (Finder → Get Info → Sharing & Permissions).' };
    // errno doesn't say whether a file was opened to read or to write: an existing file we may not read is the problem.
    if ((err.syscall === 'open' || err.syscall === 'read') && unreadableFile(path)) return { message: `can't read ${path}: ${why}`, hint: 'Make that file readable (Finder → Get Info → Sharing & Permissions).' };
    // Creating, replacing or removing a file needs write access to the folder it is in (mkdir: the folder it creates).
    return { message: `can't write in ${dirname(path)}: ${why}`, hint: 'Make that folder writable (Finder → Get Info → Sharing & Permissions), or move the project to a folder you can write to.' };
  }
  if (path && err.code === 'ENOENT') return { message: `${path} does not exist`, hint: err.hint };
  if (path && err.code === 'ENOSPC') return { message: `the disk is full (writing ${path})`, hint: 'Free some space and run the command again.' };
  return { message: err.message, hint: err.hint };
}

/** An error's message plus the tool's own reason (a SidecarError's hint: ffmpeg's last stderr line), for ⚠ skip lines. */
export function errorReason(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const hint = (e as { hint?: unknown }).hint;
  return typeof hint === 'string' && hint && !e.message.includes(hint) ? `${e.message} — ${hint}` : e.message;
}
