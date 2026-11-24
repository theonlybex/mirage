// SPDX-License-Identifier: MIT
import { execFile, spawn } from 'node:child_process';
import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readVideo } from '@wordedits/core';
import { ffmpegCaptions, locate, ttsSetup, whisperSetup, type CaptionsCheck, type TtsState } from '@wordedits/sidecars';

/** What the overnight check asks of the machine. Tests pass stubs; the server passes realPreflightDeps(). */
export interface PreflightDeps {
  onBattery(): Promise<boolean>;
  freeBytes(path: string): Promise<number>;
  footageBytes(project: string, n: number): Promise<number>;
  which(cmd: string): Promise<boolean>;
  /** Whether the FFmpeg in use can draw captions; null when there is no FFmpeg to ask. */
  captions(): Promise<CaptionsCheck | null>;
  /** What speech recognition is missing (whisper-cli, its model, or both, with how to get them); null when both are found. */
  transcriber(): Promise<string | null>;
  /** Whether Kokoro, the AI narration voice, is ready, will be fetched by speak, or can't be installed. */
  tts(): Promise<TtsState>;
}

const GB = 1024 ** 3;

/** What to call the machine in what the person reads: "Mac" on macOS, else "computer". */
export const machineName = (platform: NodeJS.Platform = process.platform): string => (platform === 'darwin' ? 'Mac' : 'computer');

/** Whether tonight's videos can be edited unattended: plugged in, with room for the renders, and with the tools installed. */
export async function preflight(o: { project: string; videos: number[]; deps: PreflightDeps; platform?: NodeJS.Platform }): Promise<{ ok: boolean; problems: string[]; notes: string[] }> {
  const { deps } = o;
  const problems: string[] = [];
  if (await deps.onBattery()) problems.push(`Plug in your ${machineName(o.platform)}. Overnight editing needs the power adapter.`);
  const footage = (await Promise.all(o.videos.map((n) => deps.footageBytes(o.project, n)))).reduce((a, b) => a + b, 0);
  const needed = Math.max(10 * GB, 2 * footage);
  if ((await deps.freeBytes(o.project)) < needed) problems.push(`Free up space: Mirage needs about ${Math.ceil(needed / GB)} GB on this disk for tonight's videos.`);
  for (const tool of ['ffmpeg', 'ffprobe']) {
    if (!(await deps.which(tool))) problems.push(`${tool} isn't installed. Run /mirage:setup.`);
  }
  const captions = await deps.captions();
  if (captions && !captions.ok) problems.push(captionsProblem(captions));
  const speech = await deps.transcriber();
  if (speech) problems.push(`Speech recognition isn't set up: ${speech} Run /mirage:setup.`);
  // Narration is only needed by videos without a voice of their own, and speak fetches Kokoro itself: only a Kokoro that
  // can't be installed is a problem.
  const notes: string[] = [];
  const tts = await deps.tts();
  if (tts.state === 'missing') problems.push(`AI narration isn't available: ${tts.text}`);
  if (tts.state === 'fetch') notes.push(`AI narration (Kokoro) is ${tts.text}.`);
  return { ok: problems.length === 0, problems, notes };
}

/** The sentence for an FFmpeg built without libass: it can't draw captions or text on the video. */
export function captionsProblem(c: { path: string; hint: string }): string {
  return `FFmpeg can't draw captions or text: ${c.path} was built without libass. ${c.hint}`;
}

const execFileAsync = promisify(execFile);

/** Total size of the files under `dir` (0 when it is not there). */
async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, e.name);
    if (e.isDirectory()) total += await folderBytes(path);
    else if (e.isFile()) total += (await stat(path).catch(() => null))?.size ?? 0;
  }
  return total;
}

/** The checks against the real machine. */
export function realPreflightDeps(): PreflightDeps {
  return {
    onBattery: async () => {
      try {
        if (process.platform === 'win32') {
          const { stdout } = await execFileAsync('powershell.exe', powershellArgs(WIN_BATTERY), { windowsHide: true, timeout: 30_000 });
          return onBatteryFromWin32(stdout);
        }
        return (await execFileAsync('pmset', ['-g', 'batt'])).stdout.includes('Battery Power');
      } catch {
        return false; // no pmset or PowerShell to ask: nothing says it runs on battery
      }
    },
    freeBytes: async (path) => {
      const s = await statfs(path);
      return s.bavail * s.bsize;
    },
    footageBytes: async (project, n) => {
      const video = await readVideo(project, n).catch(() => null);
      return (await Promise.all((video?.footage ?? []).map(folderBytes))).reduce((a, b) => a + b, 0);
    },
    which: (cmd) => locate(cmd as 'ffmpeg' | 'ffprobe').then(() => true, () => false),
    captions: () => ffmpegCaptions().catch(() => null),
    transcriber: async () => {
      const s = await whisperSetup();
      return s.ok ? null : s.problem;
    },
    tts: async () => ttsSetup(),
  };
}

/** PowerShell arguments that run `script` with no profile, no prompts and no window (-EncodedCommand: no quoting to get wrong). */
export function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/** Each battery's BatteryStatus, one per line; a desktop has none. */
const WIN_BATTERY = '(Get-CimInstance -ClassName Win32_Battery).BatteryStatus';

/** Whether a Windows PC runs on battery: a BatteryStatus of 1 means discharging (2 is on mains power). */
export function onBatteryFromWin32(stdout: string): boolean {
  return stdout.split(/\r?\n/).some((l) => l.trim() === '1');
}

/**
 * The PowerShell that keeps Windows from sleeping while process `pid` lives: SetThreadExecutionState with ES_CONTINUOUS |
 * ES_SYSTEM_REQUIRED (0x80000001), held by this thread until Wait-Process returns; Windows drops it when PowerShell ends.
 */
export function windowsAwakeScript(pid: number): string {
  return [
    "$k = Add-Type -Name Awake -Namespace Mirage -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'",
    '[void]$k::SetThreadExecutionState([uint32]2147483649)',
    `Wait-Process -Id ${Math.trunc(pid)} -ErrorAction SilentlyContinue`,
  ].join('\n');
}

/** The program and arguments that keep this machine awake while `pid` lives, or null where Mirage has none (Linux). */
export function keepAwakeCommand(pid: number, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } | null {
  if (platform === 'darwin') return { file: 'caffeinate', args: ['-i', '-w', String(pid)] };
  if (platform === 'win32') return { file: 'powershell.exe', args: powershellArgs(windowsAwakeScript(pid)) };
  return null;
}

/**
 * Keeps the machine from sleeping for as long as this process lives: `caffeinate -i -w <pid>` on a Mac, a PowerShell holding
 * SetThreadExecutionState on Windows; both end when the pid does. Detached and unref'd so it never holds the server up.
 * Returns its pid, or null when nothing could be started.
 */
export function startCaffeinate(): number | null {
  const cmd = keepAwakeCommand(process.pid);
  if (!cmd) return null;
  const child = spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {}); // not on this machine: the overnight run is just not kept awake
  child.unref();
  return child.pid ?? null;
}
