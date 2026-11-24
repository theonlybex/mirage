// SPDX-License-Identifier: MIT
// Starts one of Mirage's programs (the hooks, the engine, the viewer): `node start.mjs <program.mjs> [arguments…]`.
// Claude Code runs it with the `node` on its PATH, the same command on macOS, Linux and Windows (on Windows a command must be a
// real .exe, so a shell script can't be the launcher there). When that Node is 22 or later, the program runs in this same
// process, so its parent is still the Claude Code process. When it is older, this looks for a newer Node and runs the program
// with it, telling it the Claude Code process in MIRAGE_CLAUDE_PID. Looked at in order: PATH; the fixed locations
// (/opt/homebrew/bin/node and /usr/local/bin/node; on Windows the Node installer's folder); the newest nvm Node (on Windows
// nvm-windows); Volta; ~/.local/node.
// With no usable Node, the hook at the start of a session (last argument "session-start") tells Claude to ask about installing
// Node instead: in a Mirage project every time, elsewhere once (a node-notice-shown file in the data folder).
// Written for old Node versions too (no import.meta.dirname, nothing newer than Node 14): it has to run to say Node is too old.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIN_MAJOR = 22;
export const TOO_OLD = 'Mirage needs Node.js 22 or later. Run /mirage:setup.';
export const NOTICE =
  "Mirage, the video-editing plugin, needs Node.js 22 or later, and this computer doesn't have it (or has an older one), so none of Mirage works yet. At the start of your first reply, before anything else, ask the person whether to install Node now, and say it runs Mirage itself: its engine and the viewer they watch their videos in. Use the mirage:setup skill (step 1) to install it. After Node is installed they need to start a new Claude Code session.";

/** The major version in `v22.4.1`, or null for anything that isn't a version. */
export function majorOf(version) {
  const m = /^v?(\d+)\.\d+\.\d+/.exec(String(version).trim());
  return m ? Number(m[1]) : null;
}

/** Versions as numbers, newest first: `v22.10.0` before `v22.9.0`. */
function newestFirst(a, b) {
  const pa = a.version.split('.').map(Number);
  const pb = b.version.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  return 0;
}

/** Node binaries in nvm's folder `<dir>/v<version><rest>`, newest version first. */
function versionDirs(path, dir, rest) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^v\d+\.\d+\.\d+$/.test(n))
    .map((n) => ({ version: n.slice(1), path: path.join(dir, n, ...rest) }))
    .sort(newestFirst)
    .map((x) => x.path);
}

/** Every place a Node could be, in the order they are tried. `env.MIRAGE_NODE_FIXED` replaces the fixed locations (the tests use it). */
export function candidates({ env, platform, home }) {
  const win = platform === 'win32';
  const path = win ? win32 : posix;
  const { join } = path;
  const exe = win ? 'node.exe' : 'node';
  const list = [];
  for (const d of (env.PATH || env.Path || '').split(path.delimiter)) if (d) list.push(join(d, exe));
  if (env.MIRAGE_NODE_FIXED !== undefined) {
    for (const p of env.MIRAGE_NODE_FIXED.split(path.delimiter)) if (p) list.push(p);
  } else if (win) {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) if (base) list.push(join(base, 'nodejs', exe));
  } else {
    list.push('/opt/homebrew/bin/node', '/usr/local/bin/node');
  }
  if (win) {
    if (env.NVM_SYMLINK) list.push(join(env.NVM_SYMLINK, exe));
    if (env.NVM_HOME) list.push(...versionDirs(path, env.NVM_HOME, [exe]));
    if (env.LOCALAPPDATA) list.push(join(env.LOCALAPPDATA, 'Volta', 'bin', exe));
  }
  if (home) {
    if (!win) list.push(...versionDirs(path, join(home, '.nvm', 'versions', 'node'), ['bin', 'node']));
    list.push(join(home, '.volta', 'bin', exe));
    list.push(win ? join(home, '.local', 'node', exe) : join(home, '.local', 'node', 'bin', 'node'));
  }
  return list;
}

/** The version a Node binary reports, or '' when it can't be run. */
export function probe(path) {
  const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : '';
}

/** The first Node of version 22 or later among the candidates, other than `skip` (the one running this), or null. */
export function findNode(o) {
  const seen = new Set();
  const exists = o.exists || existsSync;
  const versionOf = o.probe || probe;
  for (const p of candidates(o)) {
    const key = o.platform === 'win32' ? p.toLowerCase() : p;
    if (seen.has(key) || (o.skip && key === (o.platform === 'win32' ? o.skip.toLowerCase() : o.skip))) continue;
    seen.add(key);
    if (!exists(p)) continue;
    const major = majorOf(versionOf(p));
    if (major !== null && major >= MIN_MAJOR) return p;
  }
  return null;
}

/**
 * The SessionStart JSON asking about installing Node, or '' for none: always in a Mirage project (mirage.json in
 * CLAUDE_PROJECT_DIR, else the current folder), elsewhere once, remembered by a file in the data folder, and never without one.
 */
export function noNodeNotice({ env, cwd }) {
  let show = existsSync(join(env.CLAUDE_PROJECT_DIR || cwd, 'mirage.json'));
  const data = env.CLAUDE_PLUGIN_DATA;
  if (!show && data && !existsSync(join(data, 'node-notice-shown'))) {
    show = true;
    try {
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, 'node-notice-shown'), '');
    } catch {
      // can't remember it: it shows again next time
    }
  }
  return show ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: NOTICE } }) + '\n' : '';
}

/** Runs `program` with another Node, passing stdio and signals through, and ends with its exit code. */
function runWith(node, program, args, env) {
  const child = spawn(node, [program, ...args], { stdio: 'inherit', windowsHide: true, env: { ...env, MIRAGE_CLAUDE_PID: env.MIRAGE_CLAUDE_PID || String(process.ppid) } });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', (e) => {
    process.stderr.write(`Mirage could not start ${node}: ${e.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code));
}

/**
 * What start.mjs does with its arguments. `version` is this Node's (process.version); the other options are for the tests.
 * Returns once the program is running here, or once a decision is printed; a program handed to another Node keeps this one
 * alive until it ends.
 */
export async function start(argv, o = {}) {
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const out = o.stdout || ((s) => process.stdout.write(s));
  const err = o.stderr || ((s) => process.stderr.write(s));
  const [program, ...args] = argv;
  if (!program) {
    err('usage: node start.mjs <program.mjs> [arguments…]\n');
    return 2;
  }
  const major = majorOf(o.version || process.version);
  if (major !== null && major >= MIN_MAJOR) {
    // The program reads its own arguments from process.argv[2…], as if it had been started directly.
    process.argv.splice(1, process.argv.length - 1, program, ...args);
    await import(pathToFileURL(program).href);
    return null;
  }
  const home = env.HOME || env.USERPROFILE || '';
  const node = findNode({ env, platform, home, skip: o.execPath || process.execPath, probe: o.probe, exists: o.exists });
  if (node) {
    (o.runWith || runWith)(node, program, args, env);
    return null;
  }
  if (args[args.length - 1] === 'session-start') {
    out(noNodeNotice({ env, cwd: o.cwd || process.cwd() }));
    return 0;
  }
  err(TOO_OLD + '\n');
  return 1;
}

/** Whether `a` and `b` name the same file, through symlinks (Windows paths compare without case, and with either slash). */
function samePath(a, b) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const [x, y] = [real(a), real(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

if (process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1])) {
  const code = await start(process.argv.slice(2));
  if (code !== null) process.exitCode = code;
}
