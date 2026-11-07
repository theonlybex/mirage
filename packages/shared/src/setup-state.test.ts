// SPDX-License-Identifier: MIT
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSetupState, SETUP_FILE, writeSetupState } from './setup-state.js';

const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'we-setup-state-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('setup state: the ffmpeg record', () => {
  it('writes and reads { path, mtimeMs, captions }, keeping the other fields', () => {
    const d = dir();
    writeSetupState(d, { askedVersion: '1.0.0' });
    writeSetupState(d, { ffmpeg: { path: '/x/ffmpeg', mtimeMs: 12.5, captions: true } });
    expect(readSetupState(d)).toEqual({ askedVersion: '1.0.0', ffmpeg: { path: '/x/ffmpeg', mtimeMs: 12.5, captions: true } });
  });

  it('drops an ffmpeg record with a wrong-typed field', () => {
    const d = dir();
    for (const bad of [{ path: 1, mtimeMs: 1, captions: true }, { path: 'p', mtimeMs: '1', captions: true }, { path: 'p', mtimeMs: 1, captions: 'yes' }, 'ffmpeg', null, [1]]) {
      writeFileSync(join(d, SETUP_FILE), JSON.stringify({ askedVersion: 'v', ffmpeg: bad }));
      expect(readSetupState(d)).toEqual({ askedVersion: 'v' });
    }
  });
});
