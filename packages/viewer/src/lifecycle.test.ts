// SPDX-License-Identifier: MIT
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { stdinIsPipe, watchLifecycle } from './lifecycle.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kinds = (k: 'pipe' | 'socket' | 'null') => () => ({ isFIFO: () => k === 'pipe', isSocket: () => k === 'socket' });

function setup(o: { pipe: boolean; ppid?: () => number; kill?: (pid: number, sig: 0) => void }) {
  const stdin = Object.assign(new EventEmitter(), { resume: vi.fn() });
  const stop = vi.fn();
  const dispose = watchLifecycle({ stop, stdin, isPipe: () => o.pipe, ppid: o.ppid ?? (() => 100), kill: o.kill ?? (() => {}), intervalMs: 10 });
  return { stdin, stop, dispose };
}

describe('stdinIsPipe', () => {
  it('is true for a pipe or a socket and false for /dev/null, a file or a closed fd', () => {
    expect(stdinIsPipe(kinds('pipe'))).toBe(true);
    expect(stdinIsPipe(kinds('socket'))).toBe(true);
    expect(stdinIsPipe(kinds('null'))).toBe(false);
    expect(
      stdinIsPipe(() => {
        throw Object.assign(new Error('bad fd'), { code: 'EBADF' });
      }),
    ).toBe(false);
  });
});

describe('watchLifecycle', () => {
  it('stdin ending stops it when stdin is a pipe', () => {
    const { stdin, stop, dispose } = setup({ pipe: true });
    expect(stdin.listenerCount('end')).toBe(1);
    stdin.emit('end');
    stdin.emit('close');
    expect(stop).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('/dev/null as stdin does not stop it, however it ends', async () => {
    const { stdin, stop, dispose } = setup({ pipe: false });
    stdin.emit('end');
    stdin.emit('close');
    await sleep(60);
    expect(stop).not.toHaveBeenCalled();
    dispose();
  });

  it('a changed parent pid stops it', async () => {
    let ppid = 100;
    const { stop, dispose } = setup({ pipe: false, ppid: () => ppid });
    await sleep(40);
    expect(stop).not.toHaveBeenCalled();
    ppid = 1;
    await sleep(60);
    expect(stop).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('a parent that is gone (ESRCH) stops it; one we may not signal (EPERM) does not', async () => {
    const gone = setup({
      pipe: false,
      kill: () => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      },
    });
    const alive = setup({
      pipe: false,
      kill: () => {
        throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
      },
    });
    await sleep(60);
    expect(gone.stop).toHaveBeenCalledTimes(1);
    expect(alive.stop).not.toHaveBeenCalled();
    gone.dispose();
    alive.dispose();
  });

  it('dispose turns the watchdog off', async () => {
    let ppid = 100;
    const { stop, dispose } = setup({ pipe: false, ppid: () => ppid });
    dispose();
    ppid = 1;
    await sleep(60);
    expect(stop).not.toHaveBeenCalled();
  });
});
