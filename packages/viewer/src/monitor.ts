// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Viewer } from './server/server.js';

/**
 * The monitor runs in every Claude session, project or not. Inside a Mirage project (mirage.json exists) it starts the viewer
 * now; anywhere else it says nothing and looks again every `intervalMs` (2 s), starting once a project appears (`init`/new_project).
 * `started` settles when the viewer is up (never, if `stop()` comes first); `stop()` closes the viewer.
 */
export function startWhenProject(o: { project: string; intervalMs?: number; start: () => Promise<Viewer> }): { started: Promise<Viewer>; stop(): Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<Viewer> | null = null;
  let resolveStarted!: (v: Viewer) => void;
  let rejectStarted!: (e: unknown) => void;
  const started = new Promise<Viewer>((ok, fail) => {
    resolveStarted = ok;
    rejectStarted = fail;
  });
  started.catch(() => {}); // the caller may only care about stop()

  const check = () => {
    if (stopped || running || !existsSync(join(o.project, 'mirage.json'))) return;
    if (timer) clearInterval(timer);
    running = o.start();
    running.then(resolveStarted, rejectStarted);
  };
  timer = setInterval(check, o.intervalMs ?? 2000);
  check();

  return {
    started,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      const viewer = await running?.catch(() => null);
      await viewer?.close();
    },
  };
}
