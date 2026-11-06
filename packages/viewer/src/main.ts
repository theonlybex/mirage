// SPDX-License-Identifier: MIT
// The Mirage viewer as the plugin's monitor: `main.mjs --project <dir> --ui <dir> --data <dir> [--fallback]`. Everything it prints to stdout
// is a line for Claude, so nothing else is printed there; trouble goes to stderr. Outside a Mirage project it prints nothing and
// waits for one. It ends on SIGTERM/SIGHUP/SIGINT, when stdin (if it is a pipe) ends, when its parent goes away, or when
// stdout can no longer be written.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realMediaTools } from '@wordedits/core';
import { otherViewer } from './fallback.js';
import { watchLifecycle } from './lifecycle.js';
import { startWhenProject } from './monitor.js';
import { startViewer } from './server/server.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const project = resolve(arg('project') ?? process.env.MIRAGE_PROJECT ?? process.cwd());
const uiDir = resolve(arg('ui') ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist-ui'));
const pluginData = resolve(arg('data') ?? process.env.CLAUDE_PLUGIN_DATA ?? join(project, '.mirage'));

// --fallback: the engine started this one, for where Claude Code runs no plugin monitors (the desktop app). It waits while
// another viewer serves the project and ends when one starts later, so the monitor's viewer, whose lines reach Claude, wins.
const fallback = process.argv.includes('--fallback');

const monitor = startWhenProject({
  project,
  ready: fallback ? () => !otherViewer(project, process.pid) : undefined,
  start: async () => startViewer({ project, uiDir, pluginData, say: (line) => void process.stdout.write(`${line}\n`), tools: await realMediaTools() }),
});
monitor.started.catch((e: unknown) => {
  console.error(`mirage viewer: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

let ending = false;
const end = (): void => {
  if (ending) return;
  ending = true;
  dispose();
  void monitor.stop().finally(() => process.exit(0));
};
const dispose = watchLifecycle({ stop: end, stdin: process.stdin });
if (fallback) setInterval(() => otherViewer(project, process.pid) && end(), 2000).unref();
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(signal, end);
// A reader that went away (EPIPE) must end the viewer cleanly, not crash it.
process.stdout.on('error', end);
