// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PauseSheet, remainingSeconds } from './PauseSheet.js';

const now = Date.parse('2026-11-02T12:00:00Z');
const progress = (fraction: number, elapsedSec: number) => ({
  command: 'cut',
  fraction,
  startedAt: new Date(now - elapsedSec * 1000).toISOString(),
  updatedAt: new Date(now - 1000).toISOString(),
});

afterEach(cleanup);

describe('remainingSeconds', () => {
  it('is elapsed × (1 − f) / f once f ≥ 0.02, else unknown', () => {
    expect(remainingSeconds(progress(0.5, 150), now)).toBe(150);
    expect(remainingSeconds(progress(0.25, 60), now)).toBe(180);
    expect(remainingSeconds(progress(0.01, 60), now)).toBeNull();
  });
});

describe('PauseSheet', () => {
  it('offers both ways to pause, with how long the step has left', () => {
    const onPause = vi.fn();
    render(<PauseSheet open onOpenChange={() => {}} label="Rendering the rough cut" progress={progress(0.5, 150)} now={now} onPause={onPause} />);
    const after = screen.getByRole('button', { name: /Pause after this step/ });
    expect(after.textContent).toContain('“Rendering the rough cut” finishes in about 3 min');
    const right = screen.getByRole('button', { name: /Pause now/ });
    expect(right.textContent).toContain('Stops “Rendering the rough cut” now. It can run again later.');

    fireEvent.click(after);
    expect(onPause).toHaveBeenLastCalledWith('after-step');
    fireEvent.click(right);
    expect(onPause).toHaveBeenLastCalledWith('now');
  });

  it('says "finishes soon" while too little is done to tell', () => {
    render(<PauseSheet open onOpenChange={() => {}} label="Rendering the rough cut" progress={progress(0.01, 30)} now={now} onPause={() => {}} />);
    expect(screen.getByRole('button', { name: /Pause after this step/ }).textContent).toContain('“Rendering the rough cut” finishes soon');
  });

  it('shows nothing while closed', () => {
    render(<PauseSheet open={false} onOpenChange={() => {}} label="x" progress={progress(0.5, 10)} now={now} onPause={() => {}} />);
    expect(screen.queryByRole('button', { name: /Pause now/ })).toBeNull();
  });
});
