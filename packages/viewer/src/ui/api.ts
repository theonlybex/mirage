// SPDX-License-Identifier: AGPL-3.0-or-later
// Talking to the viewer server: the session key, JSON calls, media addresses and the live events of one video.
import { useEffect, useState } from 'react';
import type { EventType, VideoEvents } from '../view-types.js';

let key: string | null = null;

/** The session key from the address the page was opened with (`/?k=…`), read once. */
export function sessionKey(): string {
  key ??= new URLSearchParams(window.location.search).get('k') ?? '';
  return key;
}

/** `path` (a server path such as `/media/…`) with the key in its query, for <img>, <video> and EventSource. */
export function withKey(path: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}k=${encodeURIComponent(sessionKey())}`;
}

/** A failed call, with the server's own words when it sent some. */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { ...init.headers, 'x-mirage-key': sessionKey() } });
  } catch {
    throw new ApiError(0, 'Mirage isn’t answering. Is Claude Code still open?');
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON (a plain "Forbidden"): the status says enough.
  }
  if (!res.ok) {
    const said = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : null;
    throw new ApiError(res.status, said ?? (res.status === 403 ? 'This page’s link has expired. Open the newest link from Claude Code.' : `Something went wrong (${res.status}).`));
  }
  return body as T;
}

export const get = <T>(path: string): Promise<T> => call<T>(path, { method: 'GET' });

export const post = <T>(path: string, body: unknown): Promise<T> =>
  call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * What the page knows of a video: each part null until the server first sends it (progress and report can also be null
 * from the server). `loaded` is true once every part has come at least once; `connected` while the stream is up;
 * `gaveUp` when the browser stopped retrying (the server refused the stream: a stale key).
 */
export type LiveVideo = { [K in EventType]: VideoEvents[K] | null } & { connected: boolean; loaded: boolean; gaveUp: boolean };

const EVENT_TYPES: EventType[] = ['timeline', 'steps', 'progress', 'versions', 'notes', 'control', 'report'];

const empty = (): LiveVideo => ({ timeline: null, steps: null, progress: null, versions: null, notes: null, control: null, report: null, connected: false, loaded: false, gaveUp: false });

/**
 * The live state of video `video`, from the server's event stream. The browser reconnects by itself when the stream
 * drops; `connected` says whether it is up. A part that arrives garbled is ignored and the last good one stays.
 */
export function useEvents(video: number): LiveVideo {
  const [state, setState] = useState<LiveVideo>(empty);
  useEffect(() => {
    setState(empty());
    const source = new EventSource(withKey(`/api/events?video=${video}`));
    const seen = new Set<EventType>();
    const listeners = EVENT_TYPES.map((type) => {
      const on = (e: MessageEvent<string>) => {
        let data: unknown;
        try {
          data = JSON.parse(e.data);
        } catch {
          return;
        }
        seen.add(type);
        const loaded = seen.size === EVENT_TYPES.length;
        setState((s) => ({ ...s, [type]: data, connected: true, loaded }));
      };
      source.addEventListener(type, on as EventListener);
      return [type, on] as const;
    });
    source.onopen = () => setState((s) => ({ ...s, connected: true, gaveUp: false }));
    source.onerror = () => setState((s) => ({ ...s, connected: false, gaveUp: source.readyState === EventSource.CLOSED }));
    return () => {
      for (const [type, on] of listeners) source.removeEventListener(type, on as EventListener);
      source.close();
    };
  }, [video]);
  return state;
}

/** A clock for things that age (time left, a step that went quiet): re-renders every `everyMs`. */
export function useNow(everyMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
