// SPDX-License-Identifier: MIT
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

/** The URL path of a file the viewer may serve; the page appends `?k=<key>`. */
export const mediaPath = (abs: string): string => `/media/${encodeURIComponent(abs)}`;

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webm': 'audio/webm',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
};

const inside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

const plain = (status: number, text: string, headers: Record<string, string> = {}) =>
  new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });

/** The byte range a `Range` header asks for: 'whole' when there is none (or it can't be read, which the spec says to ignore), 'none' when it starts past the end. */
function parseRange(header: string | null, size: number): { start: number; end: number } | 'whole' | 'none' {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (m[1] === '' && m[2] === '')) return 'whole';
  if (m[1] === '') {
    const n = Number(m[2]);
    return n === 0 || size === 0 ? 'none' : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (m[2] !== '' && Number(m[2]) < start) return 'whole';
  return start >= size ? 'none' : { start, end };
}

/**
 * Serves `/media/<encoded absolute path>`: only files inside one of `roots`, judged after the path is resolved and its symlinks
 * are followed (403 otherwise; 404 for a missing file or a folder). Honours a single `Range: bytes=a-b` (206).
 */
export async function handleMedia(req: Request, roots: string[]): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'Method Not Allowed', { allow: 'GET, HEAD' });
  const pathname = new URL(req.url).pathname;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice('/media/'.length));
  } catch {
    return plain(400, 'Bad path');
  }
  if (!pathname.startsWith('/media/') || decoded.includes('\0') || !isAbsolute(decoded)) return plain(400, 'Bad path');

  const real = (await Promise.all(roots.map((r) => realpath(r).catch(() => null)))).filter((r): r is string => r !== null);
  const abs = resolve(decoded);
  // First the path as written (so "..", other folders and missing files outside the roots are all just 403), then where it really is.
  if (![...roots.map((r) => resolve(r)), ...real].some((r) => inside(abs, r))) return plain(403, 'Forbidden');
  let file: string;
  try {
    file = await realpath(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'EACCES' || code === 'EPERM' ? plain(403, 'Forbidden') : plain(404, 'Not found');
  }
  if (!real.some((r) => inside(file, r))) return plain(403, 'Forbidden');
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return plain(404, 'Not found');

  const size = info.size;
  const headers: Record<string, string> = {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  };
  const range = parseRange(req.headers.get('range'), size);
  if (range === 'none') return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
  const [status, start, end] = range === 'whole' ? ([200, 0, size - 1] as const) : ([206, range.start, range.end] as const);
  const length = size === 0 ? 0 : end - start + 1;
  headers['content-length'] = String(length);
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  if (req.method === 'HEAD' || length === 0) return new Response(null, { status, headers });
  const stream = createReadStream(file, { start, end });
  return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers });
}
