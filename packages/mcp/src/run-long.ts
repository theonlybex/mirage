// SPDX-License-Identifier: AGPL-3.0-or-later
import { clearProgress, readControl, writeProgress } from '@wordedits/core';

const POLL_MS = 250;

/**
 * Runs a long engine command so the person can stop it and Claude's session can show how far it got.
 *
 * - `signal` aborts when the MCP request is cancelled (`requestSignal`), or when the video's control.json asks to
 *   pause now or stop with an `updatedAt` after the command started (a stop from before it started is old news).
 * - progress.json of the session folder `dir` is written at most every 250 ms and removed when the command ends.
 *
 * With `video` null (a command that belongs to no video yet) there is no control file to watch.
 */
export async function runLong<T>(o: {
  project: string;
  video: number | null;
  /** The session folder (episodes/<n>/sessions/<id>/) that holds progress.json; null for none. */
  dir: string | null;
  command: string;
  requestSignal?: AbortSignal;
  work: (h: { signal: AbortSignal; progress: (fraction: number) => void }) => Promise<T>;
}): Promise<T> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const ac = new AbortController();
  const abort = () => ac.abort();
  if (o.requestSignal?.aborted) abort();
  else o.requestSignal?.addEventListener('abort', abort, { once: true });

  let polling = false;
  const poll =
    o.video === null
      ? null
      : setInterval(() => {
          if (polling) return;
          polling = true;
          readControl(o.project, o.video!)
            .then((c) => {
              if ((c.pauseNow || c.stop) && Date.parse(c.updatedAt) > started) abort();
            })
            .catch(() => {}) // an unreadable control file never stops a command
            .finally(() => (polling = false));
        }, POLL_MS);

  let finished = false;
  let lastWrite = 0;
  let writes: Promise<unknown> = Promise.resolve();
  const write = (fraction: number) => {
    lastWrite = Date.now();
    writes = writes.then(() =>
      finished || !o.dir ? undefined : writeProgress(o.dir, { command: o.command, fraction, startedAt, updatedAt: new Date().toISOString() }).catch(() => {}), // progress is only a display
    );
  };
  write(0);

  try {
    return await o.work({
      signal: ac.signal,
      progress: (f) => {
        if (Date.now() - lastWrite >= POLL_MS) write(Math.min(1, Math.max(0, f)));
      },
    });
  } finally {
    finished = true;
    if (poll) clearInterval(poll);
    o.requestSignal?.removeEventListener('abort', abort);
    await writes;
    if (o.dir) await clearProgress(o.dir).catch(() => {});
  }
}
