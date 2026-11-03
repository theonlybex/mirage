// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Progress, StepLine, VersionView } from '../../view-types.js';
import { InterruptedBanner, interruptedStep } from './InterruptedBanner.js';

const now = Date.parse('2026-11-02T12:00:00Z');
const ago = (s: number) => new Date(now - s * 1000).toISOString();
const running = (s: number, label = 'Rendering the rough cut'): StepLine => ({ at: ago(s), id: 'r1', tool: 'mcp__mirage__cut', label, status: 'running' });
const done = (s: number): StepLine => ({ at: ago(s), id: 'd1', tool: 'mcp__mirage__check', label: 'Timeline checked', status: 'done' });
const progress = (updatedSec: number): Progress => ({ command: 'cut', fraction: 0.3, startedAt: ago(600), updatedAt: ago(updatedSec) });
const version = (id: string, kind: VersionView['kind'], s: number, label: string): VersionView => ({
  version: 1, id, kind, label, createdAt: ago(s), sessionId: 's', delivery: null, render: null, hasEpisode: true, hasSummary: false,
});
const versions = [version('v1', 'before', 900, 'Before this edit'), version('v2', 'checkpoint', 700, 'Timeline checked'), version('v3', 'delivery', 650, 'Rough cut')];

afterEach(cleanup);

describe('interruptedStep', () => {
  it('is the newest step when it is still running with no sign of life for 120 s', () => {
    expect(interruptedStep([done(300), running(121)], null, now)?.label).toBe('Rendering the rough cut');
    expect(interruptedStep([done(300), running(200)], progress(121), now)?.label).toBe('Rendering the rough cut');
  });

  it('is nothing while the step is recent, progress is fresh, a turn ended after it, or the newest step is done', () => {
    expect(interruptedStep([running(60)], null, now)).toBeNull();
    expect(interruptedStep([running(600)], progress(10), now)).toBeNull();
    expect(interruptedStep([running(600), { at: ago(500), type: 'turn-end' }], null, now)).toBeNull();
    expect(interruptedStep([running(600), done(500)], null, now)).toBeNull();
    expect(interruptedStep([], null, now)).toBeNull();
  });
});

describe('InterruptedBanner', () => {
  it('shows where the edit stopped and goes back to the newest checkpoint', () => {
    const onGoBack = vi.fn();
    render(<InterruptedBanner steps={[done(300), running(200)]} progress={null} versions={versions} now={now} onGoBack={onGoBack} />);
    expect(screen.getByText('This edit stopped at “Rendering the rough cut”.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go back to the last finished step' }));
    expect(onGoBack).toHaveBeenCalledWith('v2');
  });

  it('never goes back to a backup (what was there before a go-back), however new: the newest checkpoint or "before"', () => {
    const onGoBack = vi.fn();
    const withBackup = [...versions, version('v4', 'backup', 100, 'Before going back to “Timeline checked”')];
    render(<InterruptedBanner steps={[running(200)]} progress={null} versions={withBackup} now={now} onGoBack={onGoBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go back to the last finished step' }));
    expect(onGoBack).toHaveBeenCalledWith('v2');
    cleanup();
    // A "before" newer than the newest checkpoint (a later session's first change) is where it goes.
    const onGoBack2 = vi.fn();
    render(<InterruptedBanner steps={[running(200)]} progress={null} versions={[...withBackup, version('v5', 'before', 400, 'Before this edit')]} now={now} onGoBack={onGoBack2} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go back to the last finished step' }));
    expect(onGoBack2).toHaveBeenCalledWith('v5');
  });

  it('goes away on "Keep things as they are"', () => {
    render(<InterruptedBanner steps={[running(200)]} progress={null} versions={versions} now={now} onGoBack={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep things as they are' }));
    expect(screen.queryByText(/This edit stopped/)).toBeNull();
  });

  it('is hidden while the person has paused the edit', () => {
    render(<InterruptedBanner steps={[running(200)]} progress={null} versions={versions} now={now} paused onGoBack={() => {}} />);
    expect(screen.queryByText(/This edit stopped/)).toBeNull();
  });

  it('is hidden while the edit is alive', () => {
    render(<InterruptedBanner steps={[running(30)]} progress={null} versions={versions} now={now} onGoBack={() => {}} />);
    expect(screen.queryByText(/This edit stopped/)).toBeNull();
  });
});
