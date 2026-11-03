// SPDX-License-Identifier: AGPL-3.0-or-later
// The Claude Code hooks of the Mirage plugin. Outside a Mirage project (no mirage.json in cwd) every event returns at once
// with nothing to print; the engine (@wordedits/core) is imported only inside one.
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { SessionState, StepLine, VersionMeta } from '@wordedits/shared';
import { engineTool, fileDecision, isChanging, isStage, stepLabel, videoOf } from './policy.js';

type Core = typeof import('@wordedits/core');

export type HookEvent = 'session-start' | 'pre' | 'post' | 'stop';

export interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  tool_response?: unknown;
  permission_mode?: string;
}

export interface HookDeps {
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** ${CLAUDE_PLUGIN_DATA}: the compiled speech helper and hook-errors.log live here. */
  pluginData: string;
  /** ${CLAUDE_PLUGIN_ROOT}: native/transcribe.swift is here. */
  pluginRoot: string;
  /** Compiles the speech helper; the hook starts it and never waits for it. */
  swiftc(src: string, out: string): Promise<boolean>;
}

export const STOP_REASON = 'The person stopped the edit. Stop now and say in one line what was finished.';
const correctionReason = (text: string) =>
  `The person paused the edit and said: “${text}”. Act on this before you carry on. The step you were about to run didn't run.`;
const BEFORE_LABEL = 'Before this edit';
const PAUSE_POLL_MS = 250;
/** Under the PreToolUse hook's 86 400 s timeout, so the hook answers before Claude Code gives up on it. */
const MAX_HOLD_MS = (23 * 60 + 50) * 60_000;
const MODES: Record<string, 'rough' | 'guide' | 'final'> = { cut: 'rough', guide: 'guide', render: 'final' };

type Result = { stdout: string; exitCode: 0 };
const result = (stdout = ''): Result => ({ stdout, exitCode: 0 });
const preDecision = (permissionDecision: 'allow' | 'deny', reason?: string) =>
  result(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, ...(reason === undefined ? {} : { permissionDecisionReason: reason }) } }));

/** Adds one line to ${CLAUDE_PLUGIN_DATA}/hook-errors.log. Never throws: a hook must not fail because its log can't be written. */
export function logHookError(pluginData: string, event: string, e: unknown): void {
  if (!pluginData) return;
  try {
    mkdirSync(pluginData, { recursive: true });
    const msg = (e instanceof Error ? (e.stack ?? e.message) : String(e)).replace(/\s*\n\s*/g, ' | ');
    appendFileSync(join(pluginData, 'hook-errors.log'), `${new Date().toISOString()} ${event} ${msg}\n`);
  } catch {
    // nowhere left to report it
  }
}

/** Runs one Claude Code hook event. Always exit code 0; stdout is the JSON decision, or empty for none. */
export async function runHook(event: HookEvent, input: HookInput, deps: HookDeps): Promise<Result> {
  if (input === null || typeof input !== 'object' || typeof input.cwd !== 'string' || input.cwd === '') return result();
  const project = resolve(input.cwd);
  const inProject = existsSync(join(project, 'mirage.json'));
  if (event === 'session-start') startSpeechHelper(deps, event);
  if (!inProject) return result();
  const core: Core = await import('@wordedits/core');
  const h = new Handler(core, project, input, deps, event);
  switch (event) {
    case 'session-start': return h.sessionStart();
    case 'pre': return h.pre();
    case 'post': return h.post();
    case 'stop': return h.stop();
    default: return result();
  }
}

/** Compiles the speech helper when it is missing or older than its source: started detached, never waited for. */
function startSpeechHelper(deps: HookDeps, event: string): void {
  if (!deps.pluginRoot || !deps.pluginData) return;
  const src = join(deps.pluginRoot, 'native', 'transcribe.swift');
  const out = join(deps.pluginData, 'bin', 'wordedits-transcribe');
  try {
    const srcTime = statSync(src).mtimeMs;
    let stale = true;
    try {
      stale = statSync(out).mtimeMs < srcTime;
    } catch {
      // not compiled yet
    }
    if (!stale) return;
    mkdirSync(dirname(out), { recursive: true });
    void deps.swiftc(src, out).catch((e: unknown) => logHookError(deps.pluginData, event, e));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') logHookError(deps.pluginData, event, e);
  }
}

/** The text of a tool_response: a string, MCP content blocks (bare or under `content`), or a `text`/`result`/`error` field. */
function responseText(r: unknown): string {
  if (typeof r === 'string') return r;
  const blocks = Array.isArray(r) ? r : Array.isArray((r as { content?: unknown } | null)?.content) ? (r as { content: unknown[] }).content : null;
  if (blocks) return blocks.map((b) => (typeof (b as { text?: unknown } | null)?.text === 'string' ? (b as { text: string }).text : '')).join('\n');
  if (r !== null && typeof r === 'object') {
    for (const k of ['text', 'result', 'error'] as const) {
      const v = (r as Record<string, unknown>)[k];
      if (typeof v === 'string') return v;
    }
  }
  return '';
}

/** A failed tool: PostToolUseFailure, a response with `isError: true`, or an error string (one that starts with ✖ or Error). */
function failure(input: HookInput): { detail: string } | null {
  const r = input.tool_response;
  const raw = input as unknown as { error?: unknown };
  const isFailure =
    input.hook_event_name === 'PostToolUseFailure' ||
    (r !== null && typeof r === 'object' && !Array.isArray(r) && (r as { isError?: unknown }).isError === true) ||
    (typeof r === 'string' && /^\s*(✖|Error\b)/.test(r));
  if (!isFailure) return null;
  const text = responseText(r) || (typeof raw.error === 'string' ? raw.error : '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const detail = lines.find((l) => l.startsWith('✖')) ?? lines[0] ?? '';
  return { detail: detail.slice(0, 500) };
}

const videoNumbers = (project: string): number[] => {
  try {
    return readdirSync(join(project, 'episodes')).filter((f) => /^[1-9]\d*$/.test(f)).map(Number).sort((a, b) => a - b);
  } catch {
    return [];
  }
};

class Handler {
  private readonly tool: string;
  private readonly sid: string;

  constructor(
    private readonly core: Core,
    private readonly project: string,
    private readonly input: HookInput,
    private readonly deps: HookDeps,
    private readonly event: string,
  ) {
    this.tool = typeof input.tool_name === 'string' ? input.tool_name : '';
    this.sid = typeof input.session_id === 'string' ? input.session_id : '';
  }

  /** Runs a side effect that must not cost the decision: a failure is logged and the hook carries on. */
  private async soft<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      logHookError(this.deps.pluginData, this.event, e);
      return null;
    }
  }

  private async session(): Promise<SessionState> {
    return (await this.soft(() => this.core.readSessionState(this.project, this.sid))) ?? { video: null, overnight: null, awakePid: null };
  }

  private videoExists = (n: number) => existsSync(this.core.episodeDir(this.project, n));

  /** Appends a step line for video `n`; nothing for a video that isn't there (a step needs a video's folder). */
  private async step(n: number | null, line: StepLine): Promise<void> {
    if (n === null || !this.videoExists(n)) return;
    await this.soft(() => this.core.appendStep(this.core.sessionDir(this.project, n, this.sid), line));
  }

  private stepLine(label: string, status: 'running' | 'done' | 'failed' | 'denied', detail?: string): StepLine {
    return { at: this.deps.now().toISOString(), id: this.input.tool_use_id ?? '', tool: this.tool, label, status, ...(detail ? { detail } : {}) };
  }

  /** The footage folders of every video of the project. */
  private async footage(): Promise<string[]> {
    const all: string[] = [];
    for (const n of videoNumbers(this.project)) {
      const v = await this.soft(() => this.core.readVideo(this.project, n));
      if (v) all.push(...v.footage);
    }
    return all;
  }

  /** This session's versions of video `n`. */
  private async myVersions(n: number): Promise<VersionMeta[]> {
    return ((await this.soft(() => this.core.listVersions(this.project, n))) ?? []).filter((v) => v.sessionId === this.sid);
  }

  async sessionStart(): Promise<Result> {
    await this.core.writeSessionState(this.project, this.sid, {});
    const p = await this.core.readProject(this.project);
    const k = videoNumbers(this.project).length;
    const line = `This folder is a Mirage project (“${p?.title ?? ''}”, ${k} ${k === 1 ? 'video' : 'videos'}). Use the mirage:edit skill to make or change a video.`;
    return result(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: line } }));
  }

  async pre(): Promise<Result> {
    const { core, project, tool } = this;
    const toolInput = this.input.tool_input;
    const { label } = stepLabel(tool, toolInput);
    const file = fileDecision(tool, toolInput, project, await this.footage());
    const n = videoOf(tool, toolInput, project, await this.session());
    const deny = async (reason: string) => {
      await this.step(n, this.stepLine(label, 'denied'));
      return preDecision('deny', reason);
    };

    // 1. The file guard.
    if (file !== null && file !== 'allow') return deny(file.deny);

    if (n !== null) {
      // 2. Stop.
      let control = await core.readControl(project, n);
      if (control.stop) return deny(STOP_REASON);
      // 3. The pause gate: hold the step while paused.
      const deadline = this.deps.now().getTime() + MAX_HOLD_MS;
      while (control.paused && this.deps.now().getTime() < deadline) {
        await this.deps.sleep(PAUSE_POLL_MS);
        control = await core.readControl(project, n);
      }
      // Held for the whole hook timeout: the person is gone, so the edit stops (the Stop hook leaves the pause on).
      if (control.paused || control.stop) return deny(STOP_REASON);
      // Taken even when this hook didn't wait: the person may have paused and resumed during a long step.
      const correction = await core.takeCorrection(project, n);
      if (correction !== null) return deny(correctionReason(correction));

      // 4. A `before` version at this session's first changing step on the video.
      if (isChanging(tool, toolInput, project) && this.videoExists(n)) {
        const mine = await this.myVersions(n);
        if (!mine.some((v) => v.kind === 'before')) {
          await this.soft(() => core.snapshotVersion(project, n, { kind: 'before', label: BEFORE_LABEL, sessionId: this.sid }));
        }
      }
      // 5. The running step.
      await this.step(n, this.stepLine(label, 'running'));
    }

    // 6. Auto-approve Mirage's own steps.
    if (engineTool(tool) !== null || file === 'allow') return preDecision('allow');
    return result();
  }

  async post(): Promise<Result> {
    const { core, project, tool } = this;
    const toolInput = this.input.tool_input;
    const { label, doneLabel } = stepLabel(tool, toolInput);
    const failed = failure(this.input);
    let n = videoOf(tool, toolInput, project, await this.session());

    const engine = engineTool(tool);
    if (engine === 'new_video' && !failed) {
      const made = /\bvideo (\d+) created\b/.exec(responseText(this.input.tool_response));
      if (made) {
        n = Number(made[1]);
        const video = n;
        await this.soft(() => core.writeSessionState(project, this.sid, { video }));
      }
    }
    if (n === null) return result();
    const video = n;

    await this.step(video, failed ? this.stepLine(label, 'failed', failed.detail) : this.stepLine(doneLabel, 'done'));
    if (failed || !this.videoExists(video)) return result();
    if (isStage(tool)) {
      await this.soft(() => core.snapshotVersion(project, video, { kind: 'checkpoint', label: doneLabel, sessionId: this.sid }));
    }
    const mode = engine === null ? undefined : MODES[engine];
    if (mode) {
      await this.soft(() => core.snapshotVersion(project, video, { kind: 'delivery', label: core.DELIVERY_LABEL[mode], render: mode, sessionId: this.sid }));
    }
    return result();
  }

  async stop(): Promise<Result> {
    const { core, project, sid } = this;
    const session = await this.session();
    const numbers = videoNumbers(project);
    // The videos this session worked on: its video, and those it has a session folder in.
    const touched = new Set<number>(numbers.filter((n) => {
      try {
        return existsSync(core.sessionDir(project, n, sid));
      } catch {
        return false;
      }
    }));
    if (session.video !== null && this.videoExists(session.video)) touched.add(session.video);
    for (const n of touched) await this.step(n, { at: this.deps.now().toISOString(), type: 'turn-end' });

    for (const n of numbers) {
      const control = await core.readControl(project, n);
      if (!control.stop) continue;
      // Go back to the last finished stage (or to before this session's edit); restoreVersion keeps what is there as a backup.
      const back = (await this.myVersions(n)).filter((v) => v.kind === 'checkpoint' || v.kind === 'before').at(-1);
      if (back) await this.soft(() => core.restoreVersion(project, n, back.id));
      if (back || touched.has(n)) await this.soft(() => core.writeControl(project, n, { stop: null, paused: false, pauseNow: false }));
    }

    if (session.overnight) {
      for (const n of session.overnight.videos) await this.soft(() => this.writeReport(n, session.overnight!.startedAt));
    }
    return result();
  }

  /** The morning report of video `n` in this session's folder. */
  private async writeReport(n: number, startedAt: string): Promise<void> {
    const { core, project, sid } = this;
    if (!this.videoExists(n)) return;
    const dir = core.sessionDir(project, n, sid);
    const steps = await core.readSteps(dir);
    const since = Date.parse(startedAt);
    const delivered = (await this.myVersions(n)).filter((v) => v.kind === 'delivery' && !(Date.parse(v.createdAt) < since)).at(-1) ?? null;
    const last = [...steps].reverse().find((s): s is Extract<StepLine, { label: string }> => 'label' in s);
    const md = core.buildReport({
      videoTitle: (await core.readVideo(project, n))?.title ?? `Video ${n}`,
      steps,
      log: await core.readLog(dir),
      delivered,
      ...(last ? { stoppedAt: last.label } : {}),
    });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'report.md'), md);
  }
}
