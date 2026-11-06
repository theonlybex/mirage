// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { StepLine } from '../../view-types.js';
import { StepList, stepRows } from './StepList.js';

const t = (s: number) => new Date(Date.parse('2026-11-02T12:00:00Z') + s * 1000).toISOString();
const line = (s: number, id: string, label: string, status: 'running' | 'done' | 'failed' | 'denied', detail?: string): StepLine => ({
  at: t(s), id, tool: 'mcp__mirage__cut', label, status, ...(detail ? { detail } : {}),
});

afterEach(cleanup);

describe('stepRows', () => {
  it('shows each step once, where it started, with its newest state', () => {
    const rows = stepRows([line(0, 'a', 'Checking the timeline', 'running'), line(1, 'b', 'Reading x', 'running'), line(2, 'a', 'Timeline checked', 'done')]);
    expect(rows.map((r) => (r.kind === 'step' ? `${r.line.label}:${r.line.status}` : r.kind))).toEqual(['Timeline checked:done', 'Reading x:running']);
  });
});

describe('StepList', () => {
  it('lists steps newest last, with a check for done and a live spinner for running', () => {
    render(<StepList steps={[line(0, 'a', 'Timeline checked', 'done'), line(5, 'b', 'Rendering the rough cut', 'running')]} />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-status'))).toEqual(['done', 'running']);
    expect(items[1]!.textContent).toContain('Rendering the rough cut');
    expect(items[1]!.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(items[0]!.querySelector('[aria-live]')).toBeNull();
  });

  it('shows what went wrong for a failed step', () => {
    render(<StepList steps={[line(0, 'a', 'Rendering the rough cut', 'failed', 'ffmpeg ran out of disk space')]} />);
    const item = screen.getByRole('listitem');
    expect(item.getAttribute('data-status')).toBe('failed');
    expect(within(item).getByText('ffmpeg ran out of disk space')).toBeTruthy();
  });

  it('says the correction was passed on for a denied step', () => {
    render(<StepList steps={[line(0, 'a', 'Rendering the rough cut', 'denied')]} />);
    expect(within(screen.getByRole('listitem')).getByText('Your correction was passed on')).toBeTruthy();
  });

  it('marks where Claude finished a turn, and says when there is nothing yet', () => {
    const { rerender } = render(<StepList steps={[]} />);
    expect(screen.getByText(/No steps yet/)).toBeTruthy();
    rerender(<StepList steps={[line(0, 'a', 'Timeline checked', 'done'), { at: t(1), type: 'turn-end' }]} />);
    expect(screen.getByRole('separator')).toBeTruthy();
  });
});
