import { execa } from 'execa';
import { SidecarError } from './errors.js';
import { locate, type Tool } from './locate.js';

export interface RunOptions {
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
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
  const bin = await locate(tool);
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  const child = execa(bin, args, { timeout, reject: false, all: false, stripFinalNewline: false });

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
    throw new SidecarError(tool, 'TIMEOUT', `${tool} exceeded ${timeout} ms`, 'The file may be very long or the machine is busy. Try again.', stderr);
  }
  if (res.exitCode !== 0) {
    throw new SidecarError(
      tool, 'EXIT',
      `${tool} exited with code ${res.exitCode}`,
      lastMeaningfulLine(stderr),
      stderr,
    );
  }
  return { stdout: String(res.stdout ?? ''), stderr };
}

function lastMeaningfulLine(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? 'No details from the tool.';
}
