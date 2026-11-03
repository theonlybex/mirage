// SPDX-License-Identifier: AGPL-3.0-or-later
// The hook script Claude Code runs: `hook.mjs <session-start|pre|post|stop>` with the event's JSON on stdin. It always exits
// 0; any failure prints nothing and adds a line to ${CLAUDE_PLUGIN_DATA}/hook-errors.log. Outside a Mirage project it only
// reads stdin and checks for mirage.json, so it stays fast in every other session of the person.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const EVENTS = ['session-start', 'pre', 'post', 'stop'] as const;
type Event = (typeof EVENTS)[number];

const event = process.argv[2] ?? '';
const pluginData = process.env.CLAUDE_PLUGIN_DATA ?? '';
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? '';

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

/** `swiftc -parse-as-library -O <src> -o <out>`, detached: into a temp name, then renamed, so a half-made helper is never used. */
function swiftc(src: string, out: string): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolveOk) => {
    const script = 'tmp="$2.tmp.$$" && swiftc -parse-as-library -O "$1" -o "$tmp" && mv -f "$tmp" "$2"; s=$?; rm -f "$tmp"; exit $s';
    const child = spawn('/bin/sh', ['-c', script, 'sh', src, out], { detached: true, stdio: 'ignore' });
    child.on('error', () => resolveOk(false));
    child.on('exit', (code) => resolveOk(code === 0));
    child.unref();
  });
}

async function main(): Promise<void> {
  if (!(EVENTS as readonly string[]).includes(event)) return;
  const input = JSON.parse(await readStdin()) as { cwd?: unknown };
  if (typeof input?.cwd !== 'string') return;
  if (event !== 'session-start' && !existsSync(join(input.cwd, 'mirage.json'))) return;
  const { runHook } = await import('./hook.js');
  const r = await runHook(event as Event, input as Parameters<typeof runHook>[1], {
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pluginData,
    pluginRoot,
    swiftc,
  });
  if (r.stdout) process.stdout.write(r.stdout);
}

try {
  await main();
} catch (e) {
  logError(e);
}
process.exitCode = 0;
