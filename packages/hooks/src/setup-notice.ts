// SPDX-License-Identifier: MIT
// The SessionStart notice that has Claude ask a new person whether Mirage may install its missing tools. This runs in
// every Claude Code session, so it stays fast: sync node:fs only, no process spawns, nothing from @wordedits/core.
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { readSetupState, writeSetupState } from '@wordedits/shared/setup-state';

export type MissingTool = 'ffmpeg' | 'ffprobe' | 'whisper-cli' | 'speech-model';

const DEFAULT_MODEL = 'ggml-large-v3-turbo-q5_0.bin';

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Where installers put whisper-cli outside PATH, as the engine looks (packages/sidecars/src/whisper.ts). */
function installerDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'win32') {
    const base = path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'whisper-cpp');
    return [base, path.win32.join(base, 'Release')];
  }
  return ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin'];
}

/**
 * Whether `tool` is found as the engine finds it: only in `override` when that is set, else on PATH, then `extra`.
 * (FFmpeg is not looked for in ffmpeg-static: the plugin doesn't ship it.)
 */
function found(tool: string, o: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform }, override: string | undefined, extra: string[]): boolean {
  const p = o.platform === 'win32' ? path.win32 : path.posix;
  const name = o.platform === 'win32' ? `${tool}.exe` : tool;
  const dirs = override ? [override] : [...(o.env.PATH ?? '').split(p.delimiter).filter(Boolean), ...extra];
  return dirs.some((dir) => isFile(p.join(dir, name)));
}

/** Which of the tools Mirage needs are missing, in the order the engine needs them. `env`, `platform` and `home` are arguments so tests control them. */
export function missingTools(o: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string }): MissingTool[] {
  const p = o.platform === 'win32' ? path.win32 : path.posix;
  const missing: MissingTool[] = [];
  for (const tool of ['ffmpeg', 'ffprobe'] as const) {
    if (!found(tool, o, o.env.WORDEDITS_FFMPEG_DIR, [])) missing.push(tool);
  }
  if (!found('whisper-cli', o, o.env.WORDEDITS_WHISPER_DIR, installerDirs(o.env, o.platform, o.home))) missing.push('whisper-cli');
  const model = o.env.WORDEDITS_WHISPER_MODEL || p.join(o.home, '.local', 'share', 'whisper-cpp', 'models', DEFAULT_MODEL);
  if (!isFile(model)) missing.push('speech-model');
  return missing;
}

/** The plain names of what is missing, and whether they read as several things. */
function describeMissing(missing: MissingTool[]): { list: string; several: boolean } {
  const ffmpeg = missing.includes('ffmpeg') ? 'FFmpeg' : missing.includes('ffprobe') ? 'FFmpeg (ffprobe)' : null;
  const whisper = missing.includes('whisper-cli');
  const model = missing.includes('speech-model');
  const names: string[] = [];
  if (ffmpeg) names.push(ffmpeg);
  if (whisper && model) names.push('whisper.cpp and its speech model');
  else if (whisper) names.push('whisper.cpp');
  else if (model) names.push("whisper.cpp's speech model");
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '');
  return { list, several: names.length > 1 || (whisper && model) };
}

/**
 * The notice that has Claude ask the person whether Mirage may install what is missing, or null when nothing needs
 * asking: nothing missing, "not now" still holds, or (outside a Mirage project) this version was already asked about.
 * Showing it outside a project records the version, so that is asked once per version; inside a project it is shown
 * every session. The text is fixed; nothing from the person's files goes into it.
 */
export function setupNotice(o: { dataDir: string; version: string; inProject: boolean; now: Date; missing: MissingTool[] }): string | null {
  if (o.missing.length === 0) return null;
  const state = readSetupState(o.dataDir);
  const until = state.laterUntil === undefined ? NaN : Date.parse(state.laterUntil);
  if (until > o.now.getTime()) return null;
  if (!o.inProject) {
    if (state.askedVersion === o.version) return null;
    writeSetupState(o.dataDir, { askedVersion: o.version });
  }
  const { list, several } = describeMissing(o.missing);
  const opening = o.inProject
    ? `This Mirage project can't edit videos until ${list} ${several ? 'are' : 'is'} installed.`
    : `Mirage, the video-editing plugin, was just installed or updated, and it can't edit videos until ${list} ${several ? 'are' : 'is'} installed.`;
  return `${opening} At the start of your first reply, before anything else, ask the person whether Mirage may install ${several ? 'them' : 'it'} now. Use the mirage:setup skill: it says in one plain sentence what each tool is for and about how big it is, and how to install it. Install only what they agree to. If they say not now, call mcp__plugin_mirage_engine__setup_later.`;
}
