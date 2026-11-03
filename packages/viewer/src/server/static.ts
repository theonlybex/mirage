// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

/** What a static request gets: bytes and a type, or just a status. */
export type StaticResult = { status: number; type?: string; body?: Buffer | string };

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/** `url` with `k=<key>` in its query, before any #fragment. */
export function withKey(url: string, key: string): string {
  const hash = url.indexOf('#');
  const [path, frag] = hash < 0 ? [url, ''] : [url.slice(0, hash), url.slice(hash)];
  return `${path}${path.includes('?') ? '&' : '?'}k=${key}${frag}`;
}

/**
 * Subresources are fetched by the browser without our header, so each link to a file we serve carries the key:
 * the page's `src`/`href` pointing into assets/.
 */
export const keyHtml = (html: string, key: string): string =>
  html.replace(/(\b(?:src|href)\s*=\s*)(["'])((?:\.\/|\/)?assets\/[^"'?#]*)\2/g, (_m, attr: string, q: string, url: string) => `${attr}${q}${withKey(url, key)}${q}`);

/** … and every `url(…)` in a stylesheet (fonts, images) that is not a data: or absolute URL. */
export const keyCss = (css: string, key: string): string =>
  css.replace(/url\(\s*(["']?)([^"')]+?)\1\s*\)/g, (m, q: string, url: string) =>
    /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url) ? m : `url(${q}${withKey(url, key)}${q})`,
  );

/** `index.html` from `uiDir`, with the key in its asset links. */
export async function servePage(uiDir: string, key: string): Promise<StaticResult> {
  const html = await readFile(join(uiDir, 'index.html'), 'utf8').catch(() => null);
  return html === null ? { status: 404 } : { status: 200, type: TYPES['.html'], body: keyHtml(html, key) };
}

/** A file of `uiDir/assets/`. Nothing outside that folder: not by "..", not by a symlink. */
export async function serveAsset(uiDir: string, name: string, key: string): Promise<StaticResult> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return { status: 400 };
  }
  if (!decoded || decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some((p) => p === '..' || p === '')) return { status: 404 };
  const root = resolve(uiDir, 'assets');
  const abs = resolve(root, decoded);
  if (!abs.startsWith(root + sep)) return { status: 404 };
  try {
    const realRoot = await realpath(root);
    const real = await realpath(abs);
    if (!real.startsWith(realRoot + sep) || !(await stat(real)).isFile()) return { status: 404 };
    const type = TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream';
    const bytes = await readFile(real);
    return { status: 200, type, body: extname(real).toLowerCase() === '.css' ? keyCss(bytes.toString('utf8'), key) : bytes };
  } catch {
    return { status: 404 };
  }
}
