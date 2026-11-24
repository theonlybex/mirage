// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { claudePid } from './claude-pid.js';

describe('claudePid', () => {
  it('is the parent when start.mjs ran the program in its own process', () => {
    expect(claudePid({}, 123)).toBe(123);
  });

  it('is MIRAGE_CLAUDE_PID when start.mjs handed the program to a newer Node', () => {
    expect(claudePid({ MIRAGE_CLAUDE_PID: '456' }, 123)).toBe(456);
  });

  it('ignores a MIRAGE_CLAUDE_PID that is no pid', () => {
    for (const v of ['', 'abc', '0', '-3', '1.5']) expect(claudePid({ MIRAGE_CLAUDE_PID: v }, 123)).toBe(123);
  });
});
