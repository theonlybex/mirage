// SPDX-License-Identifier: AGPL-3.0-or-later
import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import {
  episodeDir, listVersions, noteStatuses, readControl, readNotes, readProgress, readSteps,
  type NoteStatus,
} from '@wordedits/core';
import type { Control, Note, Progress, StepLine } from '@wordedits/shared';
import { mediaPath } from './media.js';
import { buildTimelineView } from './timeline-view.js';
import type { EventType, NoteStatusView, NoteView, TimelineView, VersionView, VideoEvents } from '../view-types.js';

export type { EventType, NoteView, VersionView, VideoEvents };

// The page's copy of a note's status must take what core gives (a compile-time check).
type Holds<T extends true> = T;
export type NoteStatusFits = Holds<NoteStatus extends NoteStatusView ? true : false>;

export const STEP_LIMIT = 200;
export const DEBOUNCE_MS = 100;
export const KEEP_ALIVE_MS = 20_000;
const RETRY_MS = 500;

/** The notes of video `n`, each with what Claude did with it (status, and its reason) once it did something. */
export async function noteViews(project: string, n: number): Promise<NoteView[]> {
  const [notes, statuses] = await Promise.all([readNotes(project, n), noteStatuses(project, n)]);
  return notes.map((x) => ({ ...x, ...statuses[x.id], stillUrl: noteStillUrl(project, n, x) }));
}

/** Where a note's still is, as a media path. The page never builds file paths itself. */
export const noteStillUrl = (project: string, n: number, note: Pick<Note, 'still'>): string => mediaPath(join(episodeDir(project, n), note.still));

/** The versions of video `n`, each with a `videoUrl` when it has a render. */
export async function versionViews(project: string, n: number): Promise<VersionView[]> {
  return (await listVersions(project, n)).map((v) => ({
    ...v,
    ...(v.render ? { videoUrl: mediaPath(join(episodeDir(project, n), 'versions', v.id, v.render.file)) } : {}),
  }));
}

const readText = (path: string): Promise<string | null> => readFile(path, 'utf8').catch(() => null);

/** The session folders of video `n`, sorted by name; none when there are no sessions yet. */
async function sessionDirs(project: string, n: number): Promise<string[]> {
  const root = join(episodeDir(project, n), 'sessions');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name)).sort();
}

const atOf = (s: StepLine) => Date.parse(s.at) || 0;

/** Same bytes but for the clock: a video with no control.json reads as "all off, updated now", which is not a change. */
const dedupeKey = (type: EventType, data: unknown): string => {
  if (type === 'control') {
    const c = data as Control;
    if (!c.paused && !c.pauseNow && !c.stop && c.correction === null) return JSON.stringify({ ...c, updatedAt: '' });
  }
  return JSON.stringify(data);
};

/** Reads the state of videos for the page and keeps the timeline of each video's last good episode. */
export class EventHub {
  private views = new Map<number, { key: string; view: TimelineView }>();

  constructor(private project: string) {}

  /** The timeline of video `n`. Rebuilt only when episode.json or catalog.json changed; while the episode is broken, the last good one stays. */
  async timeline(n: number): Promise<TimelineView> {
    const episode = await readText(join(episodeDir(this.project, n), 'episode.json'));
    const catalogFile = join(resolve(this.project), 'catalog.json');
    const info = await stat(catalogFile).catch(() => null);
    const key = `${episode}\0${info ? `${info.mtimeMs}:${info.size}` : ''}`;
    const last = this.views.get(n);
    if (last?.key === key) return last.view;
    const catalog = info ? await readText(catalogFile) : null;
    const view = buildTimelineView(this.project, { episode, catalog }, last?.view ?? null);
    this.views.set(n, { key, view });
    return view;
  }

  /** Everything the page shows of video `n`. A part that can't be read now is left out (the page keeps what it had). */
  async collect(n: number): Promise<Partial<VideoEvents>> {
    const { project } = this;
    const out: Partial<VideoEvents> = {};
    const part = async <K extends EventType>(k: K, f: () => Promise<VideoEvents[K]>) => {
      try {
        out[k] = await f();
      } catch {
        // Half-written or in use: the next change tries again.
      }
    };
    const dirs = await sessionDirs(project, n);
    await Promise.all([
      part('timeline', () => this.timeline(n)),
      part('steps', async () => {
        const all = (await Promise.all(dirs.map((d) => readSteps(d)))).flat();
        // Array.prototype.sort is stable: lines with the same time keep the order they were written in.
        return all.sort((a, b) => atOf(a) - atOf(b)).slice(-STEP_LIMIT);
      }),
      part('progress', async () => {
        const all = (await Promise.all(dirs.map((d) => readProgress(d)))).filter((p): p is Progress => p !== null);
        return all.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))[0] ?? null;
      }),
      part('versions', () => versionViews(project, n)),
      part('notes', () => noteViews(project, n)),
      part('control', () => readControl(project, n)),
      part('report', async () => {
        let best: { path: string; mtime: number } | null = null;
        for (const d of dirs) {
          const path = join(d, 'report.md');
          const info = await stat(path).catch(() => null);
          if (info?.isFile() && (!best || info.mtimeMs > best.mtime)) best = { path, mtime: info.mtimeMs };
        }
        return best ? await readFile(best.path, 'utf8') : null;
      }),
    ]);
    return out;
  }

  /**
   * Answers an `/api/events` request: every kind of event once, then each again whenever it changes. Changes come from
   * watching episodes/<n>/ (all of it: steps, progress, control, notes, versions, reports) and catalog.json. Returns a function that ends the stream.
   */
  stream(req: IncomingMessage, res: ServerResponse, n: number, o: { debounceMs?: number; keepAliveMs?: number } = {}): () => void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    const sent = new Map<EventType, string>();
    let closed = false;
    let running = false;
    let again = false;
    let timer: NodeJS.Timeout | undefined;

    const refresh = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          const state = await this.collect(n);
          for (const type of Object.keys(state) as EventType[]) {
            if (closed) return;
            const data = state[type];
            const key = dedupeKey(type, data);
            if (sent.get(type) === key) continue;
            sent.set(type, key);
            res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
          }
        } while (again && !closed);
      } finally {
        running = false;
      }
    };
    const changed = () => {
      if (closed || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, o.debounceMs ?? DEBOUNCE_MS);
    };

    const watchers: FSWatcher[] = [];
    let retry: NodeJS.Timeout | undefined;
    // episodes/<n>/ may not exist yet (or may be replaced): attach when it does, and again if the watcher dies.
    const attachEpisode = (first = false) => {
      retry = undefined;
      if (closed) return;
      let w: FSWatcher;
      try {
        w = watch(episodeDir(this.project, n), { recursive: true }, changed);
      } catch {
        retry = setTimeout(() => attachEpisode(), RETRY_MS);
        return;
      }
      watchers.push(w);
      w.on('error', () => {
        w.close();
        watchers.splice(watchers.indexOf(w), 1);
        if (!closed && !retry) retry = setTimeout(() => attachEpisode(), RETRY_MS);
      });
      if (!first) changed(); // whatever was written before the watcher was there
    };
    attachEpisode(true);
    // catalog.json is replaced by rename, so a watcher on the file itself would lose it: watch its folder.
    try {
      const w = watch(resolve(this.project), { recursive: false }, (_event, name) => {
        if (name === null || String(name) === 'catalog.json') changed();
      });
      w.on('error', () => w.close());
      watchers.push(w);
    } catch {
      // The project folder is gone: there is nothing to show.
    }

    const keepAlive = setInterval(() => {
      if (!closed) res.write(': keep-alive\n\n');
    }, o.keepAliveMs ?? KEEP_ALIVE_MS);

    const end = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      if (timer) clearTimeout(timer);
      if (retry) clearTimeout(retry);
      for (const w of watchers) w.close();
      res.end();
    };
    res.on('close', end);
    req.on('aborted', end);
    void refresh();
    return end;
  }
}
