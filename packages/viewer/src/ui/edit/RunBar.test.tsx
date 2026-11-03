// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Control, Progress, StepLine, VersionView } from '../../view-types.js';
import { RunBar, runState } from './RunBar.js';

const now = Date.parse('2026-11-02T12:00:00Z');
const ago = (s: number) => new Date(now - s * 1000).toISOString();
const control = (over: Partial<Control> = {}): Control => ({ version: 1, paused: false, pauseNow: false, stop: null, correction: null, updatedAt: ago(0), ...over });
const running: StepLine = { at: ago(10), id: 'r1', tool: 'mcp__mirage__cut', label: 'Rendering the rough cut', status: 'running' };
const done: StepLine = { at: ago(20), id: 'd1', tool: 'mcp__mirage__check', label: 'Timeline checked', status: 'done' };
const progress: Progress = { command: 'cut', fraction: 0.5, startedAt: ago(150), updatedAt: ago(1) };
const versions: VersionView[] = [
  { version: 1, id: 'v2', kind: 'checkpoint', label: 'Timeline checked', createdAt: ago(20), sessionId: 's', delivery: null, render: null, hasEpisode: true, hasSummary: false },
];

afterEach(cleanup);

const setup = (o: { control?: Control; steps?: StepLine[]; progress?: Progress | null }) => {
  const post = vi.fn(async () => ({}));
  render(<RunBar video={1} control={o.control ?? control()} steps={o.steps ?? [done, running]} progress={o.progress ?? null} versions={versions} now={now} post={post} />);
  return post;
};

describe('runState', () => {
  it('reads Working, Pausing, Paused, Stopping and Idle from control and steps', () => {
    expect(runState(control(), [done, running])).toBe('working');
    expect(runState(control(), [done])).toBe('working');
    expect(runState(control({ paused: true }), [done, running])).toBe('pausing');
    expect(runState(control({ paused: true }), [done])).toBe('paused');
    expect(runState(control({ stop: { at: ago(1) } }), [running])).toBe('stopping');
    expect(runState(control(), [])).toBe('idle');
    expect(runState(control(), [done, { at: ago(5), type: 'turn-end' }])).toBe('idle');
    expect(runState(control({ paused: true }), [])).toBe('paused');
  });
});

describe('RunBar', () => {
  it('while working offers Pause and Stop; Pause asks how when a step with progress is running', async () => {
    const post = setup({ progress });
    expect(screen.getByText('Working')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await act(async () => void fireEvent.click(await screen.findByRole('button', { name: /Pause now/ })));
    expect(post).toHaveBeenCalledWith('/api/control', { video: 1, pause: 'now' });
  });

  it('pauses straight away when no step with progress is running', async () => {
    const post = setup({ steps: [done] });
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Pause' })));
    expect(screen.queryByRole('button', { name: /Pause now/ })).toBeNull();
    expect(post).toHaveBeenCalledWith('/api/control', { video: 1, pause: 'after-step' });
  });

  it('while paused offers Resume and a correction box', async () => {
    const post = setup({ control: control({ paused: true }), steps: [done] });
    expect(screen.getByText('Paused')).toBeTruthy();
    const box = screen.getByPlaceholderText('Tell Mirage what to change…');
    const withThis = screen.getByRole('button', { name: 'Resume with this' }) as HTMLButtonElement;
    expect(withThis.disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'keep the intro' } });
    await act(async () => void fireEvent.click(withThis));
    expect(post).toHaveBeenCalledWith('/api/control', { video: 1, resume: { correction: 'keep the intro' } });
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Resume' })));
    expect(post).toHaveBeenCalledWith('/api/control', { video: 1, resume: {} });
  });

  it('asks before stopping, naming the step it goes back to', async () => {
    const post = setup({});
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stop the edit?')).toBeTruthy();
    expect(screen.getByText('Mirage goes back to the last finished step, “Timeline checked”. Nothing before it is lost.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => void fireEvent.click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Stop')!));
    expect(post).toHaveBeenCalledWith('/api/control', { video: 1, stop: true });
  });

  it('treats an edit that stopped part-way as idle, but keeps Resume while the pause is on', () => {
    const stale: StepLine = { ...running, at: ago(300) };
    setup({ steps: [done, stale], progress: { ...progress, updatedAt: ago(200) } });
    expect(screen.getByText('Idle')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    cleanup();
    setup({ control: control({ paused: true }), steps: [done, stale] });
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
  });

  it('shows Stopping and Idle without controls', () => {
    setup({ control: control({ stop: { at: ago(1) } }) });
    expect(screen.getByText('Stopping')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    cleanup();
    setup({ steps: [] });
    expect(screen.getByText('Idle')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });
});
