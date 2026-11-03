// SPDX-License-Identifier: AGPL-3.0-or-later
import { fstatSync } from 'node:fs';

/** Whether stdin (fd 0) is a pipe or a socket, i.e. something whose end means the parent let go. /dev/null, a file or a closed fd are not. */
export function stdinIsPipe(fstat: (fd: number) => { isFIFO(): boolean; isSocket(): boolean } = fstatSync): boolean {
  try {
    const s = fstat(0);
    return s.isFIFO() || s.isSocket();
  } catch {
    return false;
  }
}

export type LifecycleDeps = {
  /** Called once when the viewer should end. */
  stop: () => void;
  stdin: { on(event: 'end' | 'close', listener: () => void): unknown; resume(): unknown };
  isPipe?: () => boolean;
  ppid?: () => number;
  kill?: (pid: number, signal: 0) => void;
  intervalMs?: number;
};

/**
 * When to end besides signals. stdin ending counts only if stdin is a pipe or socket: /dev/null and a closed stdin end at
 * once and would stop the viewer for nothing. A watchdog (every 2 s) ends it when the parent is gone: the parent pid
 * changed (we were re-parented) or signalling it says ESRCH. Returns a function that turns both off.
 */
export function watchLifecycle(o: LifecycleDeps): () => void {
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    o.stop();
  };
  if ((o.isPipe ?? stdinIsPipe)()) {
    o.stdin.on('end', stop);
    o.stdin.on('close', stop);
    o.stdin.resume();
  }
  const ppid = o.ppid ?? (() => process.ppid);
  const kill = o.kill ?? ((pid: number, signal: 0) => void process.kill(pid, signal));
  const parent = ppid();
  const timer = setInterval(() => {
    if (ppid() !== parent) return stop();
    try {
      kill(parent, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') stop();
    }
  }, o.intervalMs ?? 2000);
  timer.unref();
  return () => {
    done = true;
    clearInterval(timer);
  };
}
