// SPDX-License-Identifier: MIT
// The hook script Claude Code runs: `hook.mjs <session-start|pre|post|stop>` with the event's JSON on stdin. It always exits
// 0; any failure prints nothing and adds a line to ${CLAUDE_PLUGIN_DATA}/hook-errors.log. Outside a Mirage project it only
// reads stdin and looks for mirage.json (findProject), so it stays fast in every other session of the person; at session
// start it also checks, with sync node:fs only, whether Mirage's tools are installed (setup-notice.ts).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findProject } from './project-root.js';
import { missingTools, setupNotice } from './setup-notice.js';

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

/** The plugin's version from ${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json, or 'unknown'. */
function pluginVersion(): string {
  try {
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (!root) return 'unknown';
    const version = (JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' && version !== '' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The notice asking whether Mirage may install what is missing, or null. Without a data folder nothing can be remembered,
 * so outside a project there is none (it would repeat every session); inside one it still shows.
 */
function sessionNotice(inProject: boolean): string | null {
  if (!pluginData && !inProject) return null;
  return setupNotice({
    dataDir: pluginData,
    version: pluginVersion(),
    inProject,
    now: new Date(),
    missing: missingTools({ env: process.env, platform: process.platform, home: homedir(), dataDir: pluginData }),
  });
}

async function main(): Promise<void> {
  if (!(EVENTS as readonly string[]).includes(event)) return;
  const input = JSON.parse(await readStdin()) as { cwd?: unknown; source?: unknown };
  if (typeof input?.cwd !== 'string') return;
  const inProject = findProject(projectDir, input.cwd) !== null;
  // Not again after /compact: Claude may be in the middle of an edit, and the person was already asked at the start.
  const notice = event === 'session-start' && input.source !== 'compact' ? sessionNotice(inProject) : null;
  if (!inProject) {
    if (notice) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: notice } }));
    return;
  }
  const { runHook } = await import('./hook.js');
  const r = await runHook(event as Event, input as Parameters<typeof runHook>[1], {
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pluginData,
    ppid: process.ppid,
    projectDir,
    pluginRoot: process.env.CLAUDE_PLUGIN_ROOT || undefined,
    setupNotice: notice,
  });
  if (r.stdout) process.stdout.write(r.stdout);
}

try {
  await main();
} catch (e) {
  logError(e);
}
process.exitCode = 0;
