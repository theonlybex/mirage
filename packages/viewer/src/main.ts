// SPDX-License-Identifier: AGPL-3.0-or-later
// The Mirage viewer as the plugin's monitor: `main.mjs --project <dir> --ui <dir> --data <dir>`. Everything it prints to stdout
// is a line for Claude, so nothing else is printed there; trouble goes to stderr. Outside a Mirage project it prints nothing and
// waits for one. It ends when stdin ends or on SIGTERM.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realMediaTools } from '@wordedits/core';
import { startWhenProject } from './monitor.js';
import { startViewer } from './server/server.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const project = resolve(arg('project') ?? process.env.MIRAGE_PROJECT ?? process.cwd());
const uiDir = resolve(arg('ui') ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist-ui'));
const pluginData = resolve(arg('data') ?? process.env.CLAUDE_PLUGIN_DATA ?? join(project, '.mirage'));
// The speech helper the viewer checks for is the one the transcriber runs.
process.env.WORDEDITS_TRANSCRIBER ??= join(pluginData, 'bin', 'wordedits-transcribe');

const monitor = startWhenProject({
  project,
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
  void monitor.stop().finally(() => process.exit(0));
};
process.on('SIGTERM', end);
process.on('SIGINT', end);
process.stdin.on('end', end);
process.stdin.on('close', end);
process.stdin.resume();
