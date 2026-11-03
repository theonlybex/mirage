// SPDX-License-Identifier: AGPL-3.0-or-later
// Plays Claude Code's part for the end-to-end tests, without a model: it runs the plugin's hook script for every event (JSON
// on stdin, as hooks/hooks.json says), talks to the engine over MCP stdio (as .mcp.json says), writes files itself for
// Write, and starts the viewer the way monitors/monitors.json does, reading its stdout lines. Everything runs from plugin/,
// the built plugin, on a temp project.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PLUGIN_ROOT = join(ROOT, 'plugin');
const NODE = join(PLUGIN_ROOT, 'scripts', 'node');
const HOOK = join(PLUGIN_ROOT, 'dist', 'hook.mjs');
const ENGINE = join(PLUGIN_ROOT, 'dist', 'engine.mjs');
/** The speech helper `pnpm build:native` makes. */
const BUILT_TRANSCRIBER = join(ROOT, 'packages', 'sidecars', 'bin', 'darwin', 'wordedits-transcribe');
/** What Claude Code calls the plugin's engine tools. */
export const ENGINE_PREFIX = 'mcp__plugin_mirage_engine__';
export const CLIPS_FOLDER = 'my clips ✨';

const hooksJson = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')) as {
  hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]>;
};
const monitorsJson = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'monitors', 'monitors.json'), 'utf8')) as { name: string; command: string }[];
const mcpJson = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.mcp.json'), 'utf8')) as {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
};

/** The hook event name Claude Code sends → the argument hooks.json gives hook.mjs for it. */
const HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'] as const;
type HookEventName = (typeof HOOK_EVENTS)[number];

export type HookAnswer = { stdout: string; json: Record<string, unknown> | null };
export type PreAnswer = { decision: 'allow' | 'deny' | null; reason: string | null };
export type ToolAnswer = { denied: string | null; text: string; isError: boolean };

/** `${VAR}` in a manifest string, filled from `vars` (as Claude Code expands them). */
const expand = (s: string, vars: Record<string, string>) => s.replace(/\$\{([A-Z_]+)\}/g, (_m, k: string) => vars[k] ?? '');

/** The folder holding ffmpeg and ffprobe (ffmpeg-static and ffprobe-static, linked side by side): ffmpeg is not on PATH here. */
async function ffmpegDir(root: string): Promise<string> {
  const require = createRequire(join(ROOT, 'packages', 'sidecars', 'package.json'));
  const ffmpeg = require('ffmpeg-static') as string;
  const ffprobe = (require('ffprobe-static') as { path: string }).path;
  const dir = join(root, 'ffmpeg');
  await mkdir(dir, { recursive: true });
  await symlink(ffmpeg, join(dir, 'ffmpeg'));
  await symlink(ffprobe, join(dir, 'ffprobe'));
  return dir;
}

/** Runs a command to the end, failing on a non-zero exit. */
function run(cmd: string, args: string[], o: { cwd?: string } = {}): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd: o.cwd, stdio: 'inherit' });
    p.on('error', fail);
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(' ')} exited with ${code}`))));
  });
}

export class Driver {
  readonly sessionId = randomUUID();
  /** Every line the viewer printed to stdout, in order: what Claude Code would hear from the monitor. */
  readonly viewerLines: string[] = [];
  private client: Client | null = null;
  private viewer: ChildProcessWithoutNullStreams | null = null;
  private viewerStderr = '';
  private lineWaiters: (() => void)[] = [];
  private toolIds = 0;

  private constructor(
    readonly root: string,
    /** The project folder, as Claude Code's CLAUDE_PROJECT_DIR (and the session's cwd). */
    readonly project: string,
    /** The footage folder: `<root>/my clips ✨`, outside the project. */
    readonly clips: string,
    /** CLAUDE_PLUGIN_DATA. */
    readonly pluginData: string,
    /** The environment Claude Code runs the plugin's commands with. */
    readonly env: Record<string, string>,
  ) {}

  /** A temp project and footage folder with tone-6s.mp4 and silent-6s.mp4 (plus `extraClips`), and Claude Code's environment. */
  static async create(o: { extraClips?: (clipsDir: string, env: Record<string, string>) => Promise<void> } = {}): Promise<Driver> {
    for (const f of [NODE, HOOK, ENGINE, join(PLUGIN_ROOT, 'dist', 'viewer.mjs')]) {
      if (!existsSync(f)) throw new Error(`${f} is missing: run pnpm build:plugin first.`);
    }
    if (process.platform === 'darwin' && !existsSync(BUILT_TRANSCRIBER)) await run('pnpm', ['build:native'], { cwd: ROOT });
    const root = await mkdtemp(join(tmpdir(), 'mirage-e2e-'));
    const project = join(root, 'project');
    const clips = join(root, CLIPS_FOLDER);
    const pluginData = join(root, 'plugin data');
    await mkdir(project, { recursive: true });
    await mkdir(clips, { recursive: true });
    for (const f of ['tone-6s.mp4', 'silent-6s.mp4']) await copyFile(join(ROOT, 'fixtures', f), join(clips, f));
    // The speech helper where the SessionStart hook would compile it (a fresh copy is newer than its source, so the hook
    // doesn't start swiftc), and where .mcp.json points WORDEDITS_TRANSCRIBER.
    if (existsSync(BUILT_TRANSCRIBER)) {
      await mkdir(join(pluginData, 'bin'), { recursive: true });
      await copyFile(BUILT_TRANSCRIBER, join(pluginData, 'bin', 'wordedits-transcribe'));
    }
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PLUGIN_DATA: pluginData,
      CLAUDE_PROJECT_DIR: project,
      WORDEDITS_FFMPEG_DIR: await ffmpegDir(root),
    };
    // Nothing of the test runner's own settings may reach the plugin's processes.
    for (const k of ['MIRAGE_PROJECT', 'WORDEDITS_TRANSCRIBER', 'NODE_OPTIONS']) delete env[k];
    await o.extraClips?.(clips, env);
    return new Driver(root, project, clips, pluginData, env);
  }

  // ---- the engine (MCP over stdio, as .mcp.json starts it) ----

  /** Starts the engine as Claude Code would at session start. */
  async startEngine(): Promise<void> {
    const server = mcpJson.mcpServers.engine!;
    const vars = this.env;
    const transport = new StdioClientTransport({
      command: expand(server.command, vars),
      args: server.args.map((a) => expand(a, vars)),
      env: { ...this.env, ...Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, expand(v, vars)])) },
      cwd: this.project,
      stderr: 'pipe',
    });
    this.client = new Client({ name: 'mirage-e2e-driver', version: '0.0.1' });
    await this.client.connect(transport);
    const { tools } = await this.client.listTools();
    if (!tools.some((t) => t.name === 'cut')) throw new Error(`the engine has no cut tool: ${tools.map((t) => t.name).join(', ')}`);
  }

  /** Calls engine tool `name` straight over MCP (no hooks). */
  async callEngine(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    if (!this.client) throw new Error('the engine is not started');
    const r = (await this.client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    return { text: (r.content ?? []).map((c) => c.text ?? '').join('\n'), isError: r.isError === true };
  }

  // ---- hooks (hook.mjs <event>, JSON on stdin, as hooks.json says) ----

  /** Runs the hook command hooks.json has for `eventName`, with `fields` added to the common input. */
  async hook(eventName: HookEventName, fields: Record<string, unknown> = {}): Promise<HookAnswer> {
    const entry = hooksJson.hooks[eventName]?.[0]?.hooks[0];
    if (!entry) throw new Error(`hooks.json has no ${eventName} hook`);
    const input = {
      session_id: this.sessionId,
      transcript_path: join(this.root, 'transcript.jsonl'),
      cwd: this.project,
      permission_mode: 'default',
      hook_event_name: eventName,
      ...fields,
    };
    const stdout = await new Promise<string>((ok, fail) => {
      const p = spawn(expand(entry.command, this.env), entry.args.map((a) => expand(a, this.env)), { cwd: this.project, env: this.env });
      let out = '';
      let err = '';
      p.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      p.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
      p.on('error', fail);
      p.on('exit', (code) => (code === 0 ? ok(out) : fail(new Error(`${eventName} hook exited with ${code}: ${err}`))));
      p.stdin.end(JSON.stringify(input));
    });
    return { stdout, json: stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : null };
  }

  sessionStart(): Promise<HookAnswer> {
    return this.hook('SessionStart', { source: 'startup' });
  }

  /** The Stop hook, when Claude finishes its turn. */
  stop(): Promise<HookAnswer> {
    return this.hook('Stop', { stop_hook_active: false });
  }

  /** PreToolUse for a tool call: its permission decision and reason. */
  async pre(tool: string, toolInput: Record<string, unknown>, toolUseId: string): Promise<PreAnswer> {
    const { json } = await this.hook('PreToolUse', { tool_name: tool, tool_input: toolInput, tool_use_id: toolUseId });
    const out = (json?.hookSpecificOutput ?? null) as { permissionDecision?: 'allow' | 'deny'; permissionDecisionReason?: string } | null;
    return { decision: out?.permissionDecision ?? null, reason: out?.permissionDecisionReason ?? null };
  }

  /** PostToolUse (or PostToolUseFailure for a failed call) with the tool's response. */
  async post(tool: string, toolInput: Record<string, unknown>, toolUseId: string, response: { text: string; isError: boolean }): Promise<void> {
    const common = { tool_name: tool, tool_input: toolInput, tool_use_id: toolUseId };
    if (response.isError) await this.hook('PostToolUseFailure', { ...common, error: response.text });
    else await this.hook('PostToolUse', { ...common, tool_response: [{ type: 'text', text: response.text }] });
  }

  private nextId = () => `toolu_e2e_${++this.toolIds}`;

  /**
   * One engine tool call the way Claude Code makes it: PreToolUse (a deny ends it there: the tool doesn't run), the call over
   * MCP, then PostToolUse or PostToolUseFailure.
   */
  async tool(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    const tool = `${ENGINE_PREFIX}${name}`;
    const id = this.nextId();
    const pre = await this.pre(tool, args, id);
    if (pre.decision === 'deny') return { denied: pre.reason ?? '', text: '', isError: true };
    const r = await this.callEngine(name, args);
    await this.post(tool, args, id, r);
    return { denied: null, ...r };
  }

  /** A Write of `relPath` in the project: PreToolUse, the file written (unless denied), PostToolUse. */
  async write(relPath: string, content: string): Promise<ToolAnswer> {
    const toolInput = { file_path: join(this.project, relPath), content };
    const id = this.nextId();
    const pre = await this.pre('Write', toolInput, id);
    if (pre.decision === 'deny') return { denied: pre.reason ?? '', text: '', isError: true };
    await mkdir(dirname(toolInput.file_path), { recursive: true });
    await writeFile(toolInput.file_path, content);
    const text = `File created successfully at: ${toolInput.file_path}`;
    await this.hook('PostToolUse', { tool_name: 'Write', tool_input: toolInput, tool_use_id: id, tool_response: { type: 'create', filePath: toolInput.file_path, content } });
    return { denied: null, text, isError: false };
  }

  // ---- the viewer (as monitors.json starts it) ----

  /** Starts the viewer monitor: its command through a shell, with Claude Code's environment. */
  startViewer(): void {
    const monitor = monitorsJson.find((m) => m.name === 'viewer');
    if (!monitor) throw new Error('monitors.json has no viewer');
    const p = spawn('/bin/sh', ['-c', monitor.command], { cwd: this.project, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.viewer = p;
    createInterface({ input: p.stdout }).on('line', (line) => {
      this.viewerLines.push(line);
      for (const w of this.lineWaiters.splice(0)) w();
    });
    p.stderr.on('data', (c: Buffer) => (this.viewerStderr += c.toString('utf8')));
    p.on('exit', () => {
      for (const w of this.lineWaiters.splice(0)) w();
    });
  }

  /** The first viewer line matching `test`, waiting up to `timeoutMs` for it. */
  async waitForLine(test: (line: string) => boolean, timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.viewerLines.find(test);
      if (found !== undefined) return found;
      const left = deadline - Date.now();
      // Out of time, or no viewer running to say it.
      if (left <= 0 || !this.viewer || this.viewer.exitCode !== null) {
        throw new Error(`no such viewer line after ${timeoutMs} ms. Lines: ${JSON.stringify(this.viewerLines)}; stderr: ${this.viewerStderr}`);
      }
      await new Promise<void>((ok) => {
        const t = setTimeout(ok, Math.min(left, 500));
        this.lineWaiters.push(() => (clearTimeout(t), ok()));
      });
    }
  }

  /** The viewer's address, from the first line it says. */
  async viewerUrl(): Promise<string> {
    const line = await this.waitForLine((l) => l.startsWith('Mirage viewer: http://127.0.0.1:'));
    const m = /^Mirage viewer: (http:\/\/127\.0\.0\.1:\d+\/\?k=[A-Za-z0-9_-]+)\s/.exec(line);
    if (!m) throw new Error(`no address in the viewer's first line: ${line}`);
    return m[1]!;
  }

  // ---- the end ----

  /** Ends the viewer and the engine; removes the temp folders unless `keep` (a failed test keeps them to look at). */
  async close(keep = false): Promise<void> {
    const viewer = this.viewer;
    if (viewer && viewer.exitCode === null) {
      const gone = new Promise<void>((ok) => viewer.once('exit', () => ok()));
      viewer.kill('SIGTERM');
      await Promise.race([gone, new Promise((ok) => setTimeout(ok, 5000))]);
      if (viewer.exitCode === null) viewer.kill('SIGKILL');
    }
    await this.client?.close().catch(() => {});
    if (!keep) await rm(this.root, { recursive: true, force: true });
  }
}
