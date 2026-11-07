// SPDX-License-Identifier: MIT
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSetupState, SETUP_FILE, writeSetupState } from '@wordedits/shared/setup-state';
import { missingTools, setupNotice, type MissingTool } from './setup-notice.js';

const WIN = process.platform === 'win32';
const now = new Date('2026-11-06T12:00:00Z');

const FIRST_NOTICE_FFPROBE_AND_MODEL =
  "Mirage, the video-editing plugin, was just installed or updated, and it can't edit videos until FFmpeg (ffprobe) and whisper.cpp's speech model are installed. " +
  'At the start of your first reply, before anything else, ask the person whether Mirage may install them now. ' +
  'Use the mirage:setup skill: it says in one plain sentence what each tool is for and about how big it is, and how to install it. ' +
  'Install only what they agree to. If they say not now, call mcp__plugin_mirage_engine__setup_later.';

let root: string;
let dataDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mirage-setup-'));
  dataDir = join(root, 'data');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A folder holding empty executable files, each named as an executable of this platform. */
function folderWith(name: string, ...tools: string[]): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const t of tools) writeFileSync(join(dir, WIN ? `${t}.exe` : t), '', { mode: 0o755 });
  return dir;
}

describe('missingTools', () => {
  it('finds the tools the engine finds: override folders, then PATH; whisper also in installer folders', () => {
    const bin = folderWith('bin', 'ffmpeg', 'ffprobe', 'whisper-cli');
    const home = join(root, 'home');
    const model = join(home, '.local', 'share', 'whisper-cpp', 'models', 'ggml-large-v3-turbo-q5_0.bin');
    const modelFile = join(root, 'other-model.bin');
    writeFileSync(modelFile, '');
    const platform = process.platform;

    expect(missingTools({ env: { PATH: bin }, platform, home, whisperDirs: [] })).toEqual(['speech-model']);
    expect(missingTools({ env: { PATH: '' }, platform, home, whisperDirs: [] })).toEqual(['ffmpeg', 'ffprobe', 'whisper-cli', 'speech-model']);
    expect(missingTools({ env: { PATH: '', WORDEDITS_FFMPEG_DIR: bin, WORDEDITS_WHISPER_DIR: bin, WORDEDITS_WHISPER_MODEL: modelFile }, platform, home, whisperDirs: [] })).toEqual([]);

    // the default model place
    mkdirSync(join(home, '.local', 'share', 'whisper-cpp', 'models'), { recursive: true });
    writeFileSync(model, '');
    expect(missingTools({ env: { PATH: bin }, platform, home, whisperDirs: [] })).toEqual([]);
    // an override that is set must hold the model itself, not fall back to the default place
    expect(missingTools({ env: { PATH: bin, WORDEDITS_WHISPER_MODEL: join(root, 'nope.bin') }, platform, home, whisperDirs: [] })).toEqual(['speech-model']);
  });

  it('looks only in an override folder once it is set, as the engine does', () => {
    const bin = folderWith('bin', 'ffmpeg', 'ffprobe', 'whisper-cli');
    const empty = folderWith('empty');
    const home = join(root, 'home');
    const env = { PATH: bin, WORDEDITS_FFMPEG_DIR: empty, WORDEDITS_WHISPER_DIR: empty };
    expect(missingTools({ env, platform: process.platform, home, whisperDirs: [] })).toEqual(['ffmpeg', 'ffprobe', 'whisper-cli', 'speech-model']);
  });

  it('also looks for whisper-cli in the folders passed as whisperDirs', () => {
    const inst = folderWith('installer', 'whisper-cli');
    const env = { PATH: '' };
    expect(missingTools({ env, platform: process.platform, home: root, whisperDirs: [inst] })).toEqual(['ffmpeg', 'ffprobe', 'speech-model']);
    expect(missingTools({ env, platform: process.platform, home: root, whisperDirs: [] })).toContain('whisper-cli');
  });

  it.skipIf(WIN)('does not take a file that is not executable', () => {
    const bin = folderWith('bin', 'ffmpeg', 'ffprobe', 'whisper-cli');
    chmodSync(join(bin, 'ffmpeg'), 0o644);
    const home = join(root, 'home');
    expect(missingTools({ env: { PATH: bin }, platform: process.platform, home, whisperDirs: [] })).toEqual(['ffmpeg', 'speech-model']);
    // the model file only has to exist
    const model = join(root, 'model.bin');
    writeFileSync(model, '');
    chmodSync(model, 0o644);
    expect(missingTools({ env: { PATH: bin, WORDEDITS_WHISPER_MODEL: model }, platform: process.platform, home, whisperDirs: [] })).toEqual(['ffmpeg']);
  });

  it('names only the one of ffmpeg and ffprobe that is missing', () => {
    const bin = folderWith('bin', 'ffmpeg', 'whisper-cli');
    expect(missingTools({ env: { PATH: bin }, platform: process.platform, home: root, whisperDirs: [] })).toEqual(['ffprobe', 'speech-model']);
  });

  it('does not take a folder for an executable', () => {
    const bin = folderWith('bin');
    mkdirSync(join(bin, WIN ? 'ffmpeg.exe' : 'ffmpeg'));
    expect(missingTools({ env: { PATH: bin }, platform: process.platform, home: root, whisperDirs: [] })).toContain('ffmpeg');
  });

  it('uses ; as the PATH separator on win32 and : elsewhere', () => {
    const a = folderWith('a', 'ffmpeg');
    const b = folderWith('b', 'ffprobe');
    if (WIN) {
      expect(missingTools({ env: { PATH: `${a};${b}` }, platform: 'win32', home: root, whisperDirs: [] })).toEqual(['whisper-cli', 'speech-model']);
    } else {
      expect(missingTools({ env: { PATH: `${a}:${b}` }, platform: 'darwin', home: root, whisperDirs: [] })).toEqual(['whisper-cli', 'speech-model']);
      // a ';' is just part of a folder name on this platform
      expect(missingTools({ env: { PATH: `${a};${b}` }, platform: 'darwin', home: root, whisperDirs: [] })).toContain('ffmpeg');
    }
  });
});

describe('setupNotice', () => {
  it('asks once anywhere per version, then only in a Mirage project', () => {
    const o = { dataDir, version: '0.2.0', now, missing: ['ffmpeg'] as MissingTool[] };
    expect(setupNotice({ ...o, inProject: false })).toContain('FFmpeg');
    expect(setupNotice({ ...o, inProject: false })).toBeNull();
    expect(setupNotice({ ...o, inProject: true })).not.toBeNull();
    expect(setupNotice({ ...o, version: '0.3.0', inProject: false })).not.toBeNull();
  });

  it('says nothing when nothing is missing, and nothing for 7 days after not now', () => {
    expect(setupNotice({ dataDir, version: 'v', inProject: true, now, missing: [] })).toBeNull();
    writeSetupState(dataDir, { laterUntil: new Date(now.getTime() + 86_400_000).toISOString() });
    expect(setupNotice({ dataDir, version: 'v', inProject: true, now, missing: ['ffmpeg'] })).toBeNull();
    expect(setupNotice({ dataDir, version: 'v', inProject: false, now, missing: ['ffmpeg'] })).toBeNull();
    writeSetupState(dataDir, { laterUntil: 'soon' });
    expect(setupNotice({ dataDir, version: 'v', inProject: true, now, missing: ['ffmpeg'] })).not.toBeNull();
    writeSetupState(dataDir, { laterUntil: new Date(now.getTime() - 1).toISOString() });
    expect(setupNotice({ dataDir, version: 'v', inProject: true, now, missing: ['ffmpeg'] })).not.toBeNull();
  });

  it('records the version also when it shows the notice in a project, so another folder does not ask again', () => {
    const o = { dataDir, version: 'v', now, missing: ['ffmpeg'] as MissingTool[] };
    expect(setupNotice({ ...o, inProject: true })).not.toBeNull();
    expect(readSetupState(dataDir)).toEqual({ askedVersion: 'v' });
    expect(setupNotice({ ...o, inProject: false })).toBeNull();
    // inside a project it is still shown every session
    expect(setupNotice({ ...o, inProject: true })).not.toBeNull();
  });

  it('remembers nothing without a data folder, but still shows the notice in a project', () => {
    const o = { dataDir: '', version: 'v', now, missing: ['ffmpeg'] as MissingTool[] };
    expect(setupNotice({ ...o, inProject: true })).not.toBeNull();
    expect(setupNotice({ ...o, inProject: true })).not.toBeNull();
  });

  it('builds the notice from fixed text only', () => {
    expect(setupNotice({ dataDir, version: 'v', inProject: false, now, missing: ['ffprobe', 'speech-model'] })).toBe(FIRST_NOTICE_FFPROBE_AND_MODEL);
  });

  it('names the tools in plain words, and uses is/it for one and are/them for several', () => {
    const notice = (missing: MissingTool[]) => setupNotice({ dataDir: join(root, `d${missing.join('')}`), version: 'v', inProject: true, now, missing })!;
    expect(notice(['ffmpeg'])).toMatch(/^This Mirage project can't edit videos until FFmpeg is installed\. .* whether Mirage may install it now\./);
    expect(notice(['ffmpeg', 'ffprobe'])).toContain('until FFmpeg is installed');
    expect(notice(['ffmpeg', 'ffprobe'])).toContain('install it now');
    expect(notice(['ffprobe'])).toContain('until FFmpeg (ffprobe) is installed');
    expect(notice(['whisper-cli'])).toContain('until whisper.cpp is installed');
    expect(notice(['speech-model'])).toContain("until whisper.cpp's speech model is installed");
    expect(notice(['whisper-cli', 'speech-model'])).toContain('until whisper.cpp with its speech model is installed');
    expect(notice(['whisper-cli', 'speech-model'])).toContain('install it now');
    expect(notice(['ffmpeg', 'ffprobe', 'whisper-cli', 'speech-model'])).toContain('until FFmpeg and whisper.cpp with its speech model are installed');
    expect(notice(['ffmpeg', 'ffprobe', 'whisper-cli', 'speech-model'])).toContain('install them now');
    expect(notice(['ffmpeg', 'whisper-cli', 'speech-model'])).toContain('until FFmpeg and whisper.cpp with its speech model are installed');
    expect(notice(['ffmpeg', 'speech-model'])).toContain("until FFmpeg and whisper.cpp's speech model are installed");
  });
});

describe('setup state', () => {
  it('reads a missing, empty or broken setup.json as no state', () => {
    expect(readSetupState(dataDir)).toEqual({});
    mkdirSync(dataDir, { recursive: true });
    for (const text of ['', '{', '[]', 'null', '"x"', '{"askedVersion":3}', '{"laterUntil":null}']) {
      writeFileSync(join(dataDir, SETUP_FILE), text);
      expect(readSetupState(dataDir)).toEqual({});
    }
  });

  it('keeps the fields of the right type and drops the rest', () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, SETUP_FILE), '{"askedVersion":"1","laterUntil":5,"other":true}');
    expect(readSetupState(dataDir)).toEqual({ askedVersion: '1' });
  });

  it('merges a patch into the file and creates the folder', () => {
    writeSetupState(dataDir, { askedVersion: '1' });
    writeSetupState(dataDir, { laterUntil: '2026-11-13T00:00:00.000Z' });
    expect(readSetupState(dataDir)).toEqual({ askedVersion: '1', laterUntil: '2026-11-13T00:00:00.000Z' });
    writeSetupState(dataDir, { askedVersion: '2' });
    expect(readSetupState(dataDir)).toEqual({ askedVersion: '2', laterUntil: '2026-11-13T00:00:00.000Z' });
  });

  it('never throws when it cannot write', () => {
    const file = join(root, 'a-file');
    writeFileSync(file, '');
    expect(() => writeSetupState(join(file, 'inside'), { askedVersion: '1' })).not.toThrow();
  });
});
