// SPDX-License-Identifier: MIT
// The hook script Claude Code runs: `hook.mjs <session-start|pre|post|stop>` with the event's JSON on stdin. It always exits
// 0; any failure prints nothing and adds a line to ${CLAUDE_PLUGIN_DATA}/hook-errors.log. Outside a Mirage project it only
// reads stdin and looks for mirage.json (findProject), so it stays fast in every other session of the person.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { findProject } from './project-root.js';

const EVENTS = ['session-start', 'pre', 'post', 'stop'] as const;
type Event = (typeof EVENTS)[number];

const event = process.argv[2] ?? '';
const pluginData = process.env.CLAUDE_PLUGIN_DATA ?? '';
const projectDir = process.env.CLAUDE_PROJECT_DIR || undefined;

/** The same line format as hook.ts's logHookError, without loading hook.ts. */
function logError(e: unknown): void {
  if (!pluginData) return;
  try {
    mkdirSync(pluginData, { recursive: true });
    const msg = (e instanceof Error ? (e.stack ?? e.message) : String(e)).replace(/\s*\n\s*/g, ' | ');
    appendFileSync(join(pluginData, 'hook-errors.log'), `${new Date().toISOString()} ${event} ${msg}\n`);
  } catch {
    // nowhere left to report it
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  if (!(EVENTS as readonly string[]).includes(event)) return;
  const input = JSON.parse(await readStdin()) as { cwd?: unknown };
  if (typeof input?.cwd !== 'string') return;
  if (findProject(projectDir, input.cwd) === null) return;
  const { runHook } = await import('./hook.js');
  const r = await runHook(event as Event, input as Parameters<typeof runHook>[1], {
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pluginData,
    ppid: process.ppid,
    projectDir,
  });
  if (r.stdout) process.stdout.write(r.stdout);
}

try {
  await main();
} catch (e) {
  logError(e);
}
process.exitCode = 0;
