// SPDX-License-Identifier: MIT
// The SessionStart notice that has Claude ask a new person whether Mirage may install its missing tools. This runs in
// every Claude Code session, so it stays fast: sync node:fs only, no process spawns, nothing from @wordedits/core.
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { readSetupState, writeSetupState } from '@wordedits/shared/setup-state';

/** 'ffmpeg-captions': an FFmpeg is there, but the engine recorded that it can't draw captions (no libass). */
export type MissingTool = 'ffmpeg' | 'ffmpeg-captions' | 'ffprobe' | 'whisper-cli' | 'speech-model';

const DEFAULT_MODEL = 'ggml-large-v3-turbo-q5_0.bin';

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** A file the engine could run: on win32 the file check alone, elsewhere also X_OK (as packages/sidecars/src/locate.ts). */
function isExecutable(p: string, platform: NodeJS.Platform): boolean {
  if (!isFile(p)) return false;
  if (platform === 'win32') return true;
  try {
    accessSync(p, constants.X_OK);
    return true;
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

/** Homebrew's complete FFmpeg is keg-only (never on PATH): where the engine looks for it after PATH (packages/sidecars/src/locate.ts). Windows has none. */
export function kegDirsFor(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return [];
  return ['/opt/homebrew/opt/ffmpeg-full/bin', '/usr/local/opt/ffmpeg-full/bin', '/home/linuxbrew/.linuxbrew/opt/ffmpeg-full/bin'];
}

/**
 * Every executable file named `tool`, as the engine finds it, in order: only in `override` when that is set, else on PATH, then `extra`.
 * The paths are the folder entries joined to the name, not resolved, as the engine stores them in setup.json.
 * (FFmpeg is not looked for in ffmpeg-static: the plugin doesn't ship it.)
 */
function findAll(tool: string, o: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform }, override: string | undefined, extra: string[]): string[] {
  const p = o.platform === 'win32' ? path.win32 : path.posix;
  const name = o.platform === 'win32' ? `${tool}.exe` : tool;
  const dirs = override ? [override] : [...(o.env.PATH ?? '').split(p.delimiter).filter(Boolean), ...extra];
  const files: string[] = [];
  for (const dir of dirs) {
    const file = p.join(dir, name);
    if (!files.includes(file) && isExecutable(file, o.platform)) files.push(file);
  }
  return files;
}

/**
 * Whether the ffmpeg the engine would use is recorded (in setup.json, by the engine, which asked it with `-filters`) as unable to
 * draw captions: the record must be of the very file found, same path and same mtime (`statSync` follows symlinks, as the engine's
 * `stat` does). Only a lone ffmpeg is flagged: with another one around (say ffmpeg-full just installed in its keg folder) the engine
 * may choose differently and the record is no proof, so it stays quiet until the engine has asked again. Never starts a process.
 */
function lacksCaptions(ffmpegs: string[], dataDir: string | undefined): boolean {
  if (!dataDir || ffmpegs.length !== 1) return false;
  const rec = readSetupState(dataDir).ffmpeg;
  if (!rec || rec.captions || rec.path !== ffmpegs[0]) return false;
  try {
    return statSync(rec.path).mtimeMs === rec.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Which of the tools Mirage needs are missing, in the order the engine needs them. `env`, `platform` and `home` are
 * arguments so tests control them; `whisperDirs` replaces the installers' folders where whisper-cli is also looked for,
 * `kegDirs` the folders of Homebrew's ffmpeg-full, and `dataDir` is the plugin's data folder, where the engine's record of
 * whether the FFmpeg can draw captions is read (without it, no FFmpeg is called captions-less).
 */
export function missingTools(o: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string; whisperDirs?: string[]; kegDirs?: string[]; dataDir?: string }): MissingTool[] {
  const p = o.platform === 'win32' ? path.win32 : path.posix;
  const missing: MissingTool[] = [];
  const keg = o.kegDirs ?? kegDirsFor(o.platform);
  const ffmpegs = findAll('ffmpeg', o, o.env.WORDEDITS_FFMPEG_DIR, keg);
  if (ffmpegs.length === 0) missing.push('ffmpeg');
  else if (lacksCaptions(ffmpegs, o.dataDir)) missing.push('ffmpeg-captions');
  if (findAll('ffprobe', o, o.env.WORDEDITS_FFMPEG_DIR, keg).length === 0) missing.push('ffprobe');
  if (findAll('whisper-cli', o, o.env.WORDEDITS_WHISPER_DIR, o.whisperDirs ?? installerDirs(o.env, o.platform, o.home)).length === 0) missing.push('whisper-cli');
  const model = o.env.WORDEDITS_WHISPER_MODEL || p.join(o.home, '.local', 'share', 'whisper-cpp', 'models', DEFAULT_MODEL);
  if (!isFile(model)) missing.push('speech-model');
  return missing;
}

/** The plain names of what is missing, and whether the joined list has several items ("whisper.cpp with its speech model" is one). */
function describeMissing(missing: MissingTool[]): { list: string; several: boolean } {
  // The complete build brings ffprobe too, so it covers a missing ffprobe in one name.
  const ffmpeg = missing.includes('ffmpeg') ? 'FFmpeg' : missing.includes('ffmpeg-captions') ? 'FFmpeg with caption support' : missing.includes('ffprobe') ? 'FFmpeg (ffprobe)' : null;
  const whisper = missing.includes('whisper-cli');
  const model = missing.includes('speech-model');
  const names: string[] = [];
  if (ffmpeg) names.push(ffmpeg);
  if (whisper && model) names.push('whisper.cpp with its speech model');
  else if (whisper) names.push('whisper.cpp');
  else if (model) names.push("whisper.cpp's speech model");
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '');
  return { list, several: names.length > 1 };
}

/**
 * The notice that has Claude ask the person whether Mirage may install what is missing, or null when nothing needs
 * asking: nothing missing, "not now" still holds, or (outside a Mirage project) this version was already asked about.
 * Showing it anywhere records the version, so outside a project it is shown once per version and a person first asked
 * in a project isn't asked again elsewhere; inside a project it is shown every session. The text is fixed; nothing from the person's files goes into it.
 */
export function setupNotice(o: { dataDir: string; version: string; inProject: boolean; now: Date; missing: MissingTool[] }): string | null {
  if (o.missing.length === 0) return null;
  // Without a data folder nothing can be remembered: it is shown in a project and not outside one.
  const state = o.dataDir ? readSetupState(o.dataDir) : {};
  const until = state.laterUntil === undefined ? NaN : Date.parse(state.laterUntil);
  if (until > o.now.getTime()) return null;
  if (!o.inProject && state.askedVersion === o.version) return null;
  if (o.dataDir) writeSetupState(o.dataDir, { askedVersion: o.version });
  const { list, several } = describeMissing(o.missing);
  const opening = o.inProject
    ? `This Mirage project can't edit videos until ${list} ${several ? 'are' : 'is'} installed.`
    : `Mirage, the video-editing plugin, was just installed or updated, and it can't edit videos until ${list} ${several ? 'are' : 'is'} installed.`;
  return `${opening} At the start of your first reply, before anything else, ask the person whether Mirage may install ${several ? 'them' : 'it'} now. Use the mirage:setup skill: it says in one plain sentence what each tool is for and about how big it is, and how to install it. Install only what they agree to. If they say not now, call mcp__plugin_mirage_engine__setup_later.`;
}
