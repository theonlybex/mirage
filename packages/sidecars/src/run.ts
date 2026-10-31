import { execa } from 'execa';
import { SidecarError } from './errors.js';
import { installHint, locate, type Tool } from './locate.js';

export interface RunOptions {
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
  /** Working directory for the child process. */
  cwd?: string;
  /** Hint used when the binary cannot be started at all. */
  notFoundHint?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface LineSplitter {
  feed(chunk: string): void;
  flush(): void;
}

/**
 * Splits a stream of arbitrarily-chunked text into newline-delimited lines,
 * invoking `onLine` for each complete line as soon as it is seen. Any
 * trailing, unterminated data must be flushed explicitly via `flush()` once
 * the stream has ended, or it is lost.
 */
export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  let buf = '';
  return {
    feed(chunk: string) {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i).trimEnd());
        buf = buf.slice(i + 1);
      }
    },
    flush() {
      if (buf.length > 0) {
        onLine(buf.trimEnd());
        buf = '';
      }
    },
  };
}

export async function run(tool: Tool, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return runPath(tool, await locate(tool), args, { notFoundHint: installHint(tool), ...opts });
}

/** Runs a binary at a known path. `name` is used in errors. */
export async function runPath(name: string, bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  const child = execa(bin, args, { timeout, reject: false, all: false, stripFinalNewline: false, cwd: opts.cwd });

  let splitter: LineSplitter | undefined;
  if (opts.onStdoutLine && child.stdout) {
    splitter = createLineSplitter(opts.onStdoutLine);
    child.stdout.on('data', (chunk: Buffer) => {
      splitter!.feed(chunk.toString('utf8'));
    });
  }

  const res = await child;
  splitter?.flush();
  const stderr = String(res.stderr ?? '');
  if (res.timedOut) {
    throw new SidecarError(name, 'TIMEOUT', `${name} exceeded ${timeout} ms`, 'The file may be very long or the machine is busy. Try again.', stderr);
  }
  if (res.exitCode === undefined && res.signal) {
    throw new SidecarError(name, 'EXIT', `${name} was stopped by ${res.signal}`, lastMeaningfulLine(stderr), stderr);
  }
  if (res.exitCode === undefined) {
    // The process never ran (ENOENT, EACCES, ENOEXEC: missing, not executable, or not a binary).
    throw new SidecarError(name, 'NOT_FOUND', `${name} could not be started`, opts.notFoundHint ?? 'The program could not be started.', String(res.stderr || res.originalMessage || ''));
  }
  if (res.exitCode !== 0) {
    throw new SidecarError(name, 'EXIT', `${name} exited with code ${res.exitCode}`, lastMeaningfulLine(stderr), stderr);
  }
  return { stdout: String(res.stdout ?? ''), stderr };
}

function lastMeaningfulLine(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? 'No details from the tool.';
}
