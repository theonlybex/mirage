// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The arguments for the stand-in viewer next to this bundle (plugin/dist): the monitor's command with `--fallback`. Null when
 * there is no built viewer beside it (running from source) or MIRAGE_FALLBACK_VIEWER is 0.
 */
export function fallbackViewerArgs(o: { here: string; project: string; env: NodeJS.ProcessEnv; exists?: (path: string) => boolean }): string[] | null {
  if (o.env.MIRAGE_FALLBACK_VIEWER === '0') return null;
  const exists = o.exists ?? existsSync;
  const script = join(o.here, 'viewer.mjs');
  const ui = join(o.here, 'viewer-ui');
  if (!exists(script) || !exists(ui)) return null;
  const data = o.env.MIRAGE_PLUGIN_DATA;
  return [script, '--project', o.project, '--ui', ui, ...(data ? ['--data', data] : []), '--fallback'];
}

/**
 * Claude Code's desktop app runs no plugin monitors, so the viewer would never start there: the engine, which always starts,
 * starts a stand-in. It waits for a Mirage project, steps aside for the monitor's viewer where there is one, and ends with the
 * engine (its stdin is a pipe from here). Its lines for Claude go nowhere; the status tool still gives its address.
 */
export function startFallbackViewer(project: string): void {
  const args = fallbackViewerArgs({ here: dirname(fileURLToPath(import.meta.url)), project, env: process.env });
  if (!args) return;
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'ignore', 'inherit'], windowsHide: true });
  child.on('error', (e) => console.error(`mirage engine: the viewer didn't start: ${e.message}`));
  // The engine must still end when Claude Code lets go of it: neither the child nor its pipe keeps it running.
  child.unref();
  (child.stdin as Socket | null)?.unref();
}
