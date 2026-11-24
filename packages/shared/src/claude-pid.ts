// SPDX-License-Identifier: MIT
/**
 * The Claude Code process that started this one: MIRAGE_CLAUDE_PID when scripts/start.mjs handed it to a newer Node than
 * the one on PATH, else the parent (start.mjs runs the program in its own process).
 */
export function claudePid(env: NodeJS.ProcessEnv = process.env, ppid = process.ppid): number {
  const pid = Number(env.MIRAGE_CLAUDE_PID);
  return Number.isInteger(pid) && pid > 0 ? pid : ppid;
}
