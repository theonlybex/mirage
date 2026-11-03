// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineView } from '../../view-types.js';
import { LiveTimeline } from './LiveTimeline.js';

const item = (id: string, start: number, end: number, over: Partial<TimelineView['items'][number]> = {}): TimelineView['items'][number] => ({
  id, beat: 'cold-open', clip: 'c001', start, end, thumb: `/media/${id}.jpg`, quiet: false, speed: 1, ...over,
});

const view = (over: Partial<TimelineView> = {}): TimelineView => ({
  status: 'ok',
  title: 'Build story',
  durationSec: 20,
  items: [item('i1', 0, 10), item('i2', 10, 20, { beat: 'montage', quiet: true, speed: 4 })],
  overlays: [{ kind: 'callout', text: 'It works', tone: 'pass', start: 1, end: 3 }],
  music: [{ track: 'calm', start: 0, end: 12 }],
  slots: [{ id: 's1', start: 0, end: 4, line: 'Hello there.', maxWords: 10 }],
  voice: [{ slot: 's1', start: 0.5, end: 4 }],
  ...over,
});

window.history.replaceState(null, '', '/?k=secret');

const at = (lane: string, key: string) => document.querySelector(`[data-lane="${lane}"] [data-key="${key}"]`);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('LiveTimeline', () => {
  it('draws the four lanes: pictures, what is on screen, music and narration', () => {
    render(<LiveTimeline view={view()} />);
    expect(at('picture', 'i1')).not.toBeNull();
    expect(at('picture', 'i2')?.getAttribute('data-quiet')).toBe('true');
    expect(at('picture', 'i2')?.getAttribute('data-beat')).toBe('montage');
    expect(screen.getByText('It works')).toBeTruthy();
    expect(screen.getByText('calm')).toBeTruthy();
    expect(screen.getByText('Hello there.')).toBeTruthy();
    expect(document.querySelector('[data-lane="narration"] [data-voice]')).not.toBeNull();
    // Thumbnails carry the session key the page was opened with.
    expect(at('picture', 'i1')?.querySelector('img')?.getAttribute('src')).toBe('/media/i1.jpg?k=secret');
  });

  it('marks new items as entering and keeps removed ones 200 ms as exiting', () => {
    vi.useFakeTimers();
    const { rerender } = render(<LiveTimeline view={view()} />);
    expect(at('picture', 'i1')?.getAttribute('data-state')).toBeNull();

    rerender(<LiveTimeline view={view({ items: [item('i2', 0, 10), item('i3', 10, 18)] })} />);
    expect(at('picture', 'i3')?.getAttribute('data-state')).toBe('entering');
    expect(at('picture', 'i2')?.getAttribute('data-state')).toBeNull();
    expect(at('picture', 'i1')?.getAttribute('data-state')).toBe('exiting');

    act(() => void vi.advanceTimersByTime(199));
    expect(at('picture', 'i1')).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(at('picture', 'i1')).toBeNull();
    act(() => void vi.advanceTimersByTime(100));
    expect(at('picture', 'i3')?.getAttribute('data-state')).toBeNull();
  });

  it('shows "Being edited…" while the timeline file is being written', () => {
    const { rerender } = render(<LiveTimeline view={view()} />);
    expect(screen.queryByText('Being edited…')).toBeNull();
    rerender(<LiveTimeline view={view({ status: 'editing' })} />);
    expect(screen.getByText('Being edited…')).toBeTruthy();
    // The last good timeline stays on screen.
    expect(at('picture', 'i1')).not.toBeNull();
  });

  it('says so when there is no timeline yet', () => {
    render(<LiveTimeline view={view({ status: 'empty', durationSec: 0, items: [], overlays: [], music: [], slots: [], voice: [] })} />);
    expect(screen.getByText(/No timeline yet/)).toBeTruthy();
  });

  it('scrolls inside the lanes past 60 items and fits the width otherwise', () => {
    const many = Array.from({ length: 61 }, (_, i) => item(`m${i}`, i, i + 1));
    const { rerender } = render(<LiveTimeline view={view()} />);
    const track = () => document.querySelector<HTMLElement>('[data-track]')!;
    expect(track().style.minWidth).toBe('');
    rerender(<LiveTimeline view={view({ durationSec: 61, items: many })} />);
    expect(track().style.minWidth).not.toBe('');
  });
});
