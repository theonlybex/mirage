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

export async function run(tool: Tool, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const bin = await locate(tool);
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  const child = execa(bin, args, { timeout, reject: false, all: false, stripFinalNewline: false });

  if (opts.onStdoutLine && child.stdout) {
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        opts.onStdoutLine!(buf.slice(0, i).trimEnd());
        buf = buf.slice(i + 1);
      }
    });
  }

  const res = await child;
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
