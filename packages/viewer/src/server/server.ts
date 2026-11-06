// SPDX-License-Identifier: MIT
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, resolve } from 'node:path';
import { readVideo, writeJsonFile, type MediaTools } from '@wordedits/core';
import { ViewerInfoSchema } from '@wordedits/shared';
import { whisperSetup } from '@wordedits/sidecars';
import { errorResult, handleApi, videoNumbers, type ApiResult } from './api.js';
import { EventHub } from './events.js';
import { handleMedia } from './media.js';
import { serveAsset, servePage, type StaticResult } from './static.js';

export type ViewerOptions = {
  project: string;
  /** The built page (index.html and assets/). */
  uiDir: string;
  /** The plugin's data folder. */
  pluginData: string;
  /** Whether speech recognition (whisper.cpp and its model) is installed, checked before a voice note is taken. Default: whisperSetup(). */
  speechReady?: () => Promise<boolean>;
  /** First and last port to try on 127.0.0.1. */
  ports?: [number, number];
  key?: string;
  /** Prints one line to stdout, which is how Claude hears the viewer. */
  say: (line: string) => void;
  tools: MediaTools;
};
export type Viewer = { url: string; port: number; key: string; close(): Promise<void> };

const DEFAULT_PORTS: [number, number] = [4410, 4430];

/** Same answer in the same time whatever the guess: both sides are hashed to equal length, then compared. */
function sameKey(given: string | null | undefined, key: string): boolean {
  if (!given) return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(given), digest(key));
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  // The key is in the address: it must not leave in a Referer, and the page must not be framed.
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

function listen(server: Server, port: number): Promise<number> {
  return new Promise((ok, fail) => {
    const onError = (e: Error) => fail(e);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      ok((server.address() as AddressInfo).port);
    });
  });
}

/** Starts the viewer for `o.project`: listens, writes .mirage/viewer.json and says its address first. */
export async function startViewer(o: ViewerOptions): Promise<Viewer> {
  const project = resolve(o.project);
  const key = o.key ?? randomBytes(32).toString('base64url');
  // One line each, whatever is passed in: a newline would be a second notification.
  const say = (line: string) => o.say(line.replace(/[\r\n]+/g, ' '));
  const speechReady = o.speechReady ?? (async () => (await whisperSetup()).ok);
  const hub = new EventHub(project);
  const ends = new Set<() => void>();
  let port = 0;

  const send = (res: ServerResponse, status: number, type: string, body: Buffer | string | null, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-store', ...extra });
    res.end(body);
  };
  const sendJson = (res: ServerResponse, r: ApiResult, extra: Record<string, string> = {}) =>
    send(res, r.status, 'application/json; charset=utf-8', JSON.stringify(r.body), extra);
  const sendStatic = (res: ServerResponse, r: StaticResult) =>
    r.status === 200 ? send(res, 200, r.type ?? 'application/octet-stream', r.body ?? '') : send(res, r.status, 'text/plain; charset=utf-8', r.status === 400 ? 'Bad request' : 'Not found');

  /** The folders media may come from: the project and every video's footage (read per request: videos are made while it runs). */
  const mediaRoots = async (): Promise<string[]> => {
    const footage = await Promise.all((await videoNumbers(project)).map(async (n) => (await readVideo(project, n).catch(() => null))?.footage ?? []));
    return [project, ...footage.flat()];
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Who may ask: the Host header names this server (not a rebound DNS name) …
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    if (!req.url?.startsWith('/')) return send(res, 400, 'text/plain; charset=utf-8', 'Bad request');
    const url = new URL(`http://127.0.0.1:${port}${req.url}`);
    // … and the request carries the session key.
    const header = req.headers['x-mirage-key'];
    if (!sameKey(url.searchParams.get('k'), key) && !sameKey(Array.isArray(header) ? header[0] : header, key)) {
      return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    }
    const { pathname } = url;
    const method = req.method ?? 'GET';

    if (pathname === '/api/events') {
      if (method !== 'GET') return sendJson(res, { status: 405, body: { error: 'Use GET.' } });
      const video = url.searchParams.get('video');
      if (video === null || !/^[1-9]\d*$/.test(video)) return sendJson(res, { status: 400, body: { error: 'Say which video: ?video=<number>.' } });
      const end = hub.stream(req, res, Number(video));
      ends.add(end);
      res.on('close', () => ends.delete(end));
      return;
    }
    if (pathname.startsWith('/media/')) {
      const r = await handleMedia(new Request(url, { method, headers: req.headers.range ? { range: req.headers.range } : {} }), await mediaRoots());
      const headers: Record<string, string> = { ...SECURITY_HEADERS };
      r.headers.forEach((v, k) => (headers[k] = v));
      res.writeHead(r.status, headers);
      if (!r.body) return void res.end();
      // pipeline passes on back-pressure and stops reading the file when the player goes away.
      return pipeline(Readable.fromWeb(r.body as import('node:stream/web').ReadableStream), res).catch(() => {});
    }
    if (pathname.startsWith('/api/')) {
      return sendJson(res, await handleApi({ project, speechReady, tools: o.tools, say }, req, url));
    }
    if (method !== 'GET' && method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', { allow: 'GET, HEAD' });
    if (pathname === '/') return sendStatic(res, await servePage(o.uiDir, key));
    if (pathname.startsWith('/assets/')) return sendStatic(res, await serveAsset(o.uiDir, pathname.slice('/assets/'.length), key));
    return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.destroy();
      try {
        const result = errorResult(e instanceof Error ? e : new Error(String(e)));
        if (result.status !== 413) return sendJson(res, result);
        // Too large: stop taking the body (it is dropped, not kept), answer, and close the connection after the answer.
        sendJson(res, result, { connection: 'close' });
        req.resume();
        res.once('finish', () => void setTimeout(() => req.destroy(), 2000).unref());
      } catch {
        res.destroy();
      }
    });
  });
  server.on('clientError', (_e, socket) => socket.destroy());

  const [first, last] = o.ports ?? DEFAULT_PORTS;
  let bound = false;
  for (let p = first; p <= last && !bound; p++) {
    try {
      port = await listen(server, p);
      bound = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  if (!bound) throw new Error(`No free port for the Mirage viewer between ${first} and ${last}.`);

  const url = `http://127.0.0.1:${port}/?k=${key}`;
  const info = join(project, '.mirage', 'viewer.json');
  await mkdir(join(project, '.mirage'), { recursive: true });
  await writeJsonFile(info, ViewerInfoSchema, { url, pid: process.pid }, '.mirage/viewer.json');
  say(`Mirage viewer: ${url}  (open it for the person: in the Claude desktop app use the browser pane; otherwise run: open "${url}")`);

  let closing: Promise<void> | null = null;
  return {
    url,
    port,
    key,
    close: () =>
      (closing ??= (async () => {
        for (const end of [...ends]) end();
        server.closeAllConnections();
        await new Promise<void>((ok) => server.close(() => ok()));
        // Only our own file: a viewer started later in this project has written its own.
        const mine = await readFile(info, 'utf8').then((t) => ViewerInfoSchema.safeParse(JSON.parse(t)), () => null).catch(() => null);
        if (mine?.success && mine.data.url === url) await rm(info, { force: true });
      })()),
  };
}
