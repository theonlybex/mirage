// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { note, rough } from './fixtures.js';
import { Player } from './Player.js';
import { timecode } from './timecode.js';

afterEach(cleanup);

/** A player whose video is at 4.2 s and whose picture is 200 × 100 px at the page's corner. */
function setup() {
  const post = vi.fn(async (_path: string, body: unknown) => ({ ...(body as object), id: 'n1' }));
  const { container } = render(<Player video={1} version={rough} notes={[note({ id: 'n9', t: 2 })]} post={post} />);
  const video = container.querySelector('video')!;
  Object.defineProperty(video, 'currentTime', { value: 4.2, writable: true, configurable: true });
  Object.defineProperty(video, 'duration', { value: 20, configurable: true });
  const pause = vi.fn();
  video.pause = pause;
  fireEvent(video, new Event('loadedmetadata'));
  const surface = container.querySelector<HTMLElement>('.player__surface')!;
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON: () => ({}) });
  const gesture = (from: [number, number], to: [number, number]) => {
    fireEvent.pointerDown(surface, { clientX: from[0], clientY: from[1], pointerId: 1, button: 0 });
    if (from[0] !== to[0] || from[1] !== to[1]) fireEvent.pointerMove(surface, { clientX: to[0], clientY: to[1], pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: to[0], clientY: to[1], pointerId: 1 });
  };
  const add = async (text: string) => {
    const composer = screen.getByRole('region', { name: 'New note' });
    fireEvent.change(within(composer).getByLabelText('Your note'), { target: { value: text } });
    await act(async () => void fireEvent.click(within(composer).getByRole('button', { name: 'Add' })));
  };
  return { post, video, pause, surface, gesture, add };
}

describe('timecode', () => {
  it('is m:ss, with hours past the hour', () => {
    expect(timecode(4.2)).toBe('0:04');
    expect(timecode(65.9)).toBe('1:05');
    expect(timecode(3600 + 62)).toBe('1:01:02');
    expect(timecode(Number.NaN)).toBe('0:00');
  });
});

describe('Player', () => {
  it('a click at 4.2 s pauses and opens the composer showing 0:04', async () => {
    const { post, pause, gesture, add } = setup();
    expect(screen.queryByRole('region', { name: 'New note' })).toBeNull();
    gesture([50, 50], [50, 50]);
    expect(pause).toHaveBeenCalled();
    const composer = screen.getByRole('region', { name: 'New note' });
    expect(within(composer).getByText('0:04')).toBeTruthy();
    expect((within(composer).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
    await add('Too slow here');
    expect(post).toHaveBeenCalledWith('/api/notes', { video: 1, versionId: 'd1', t: 4.2, text: 'Too slow here', box: null });
    expect(screen.queryByRole('region', { name: 'New note' })).toBeNull();
  });

  it('a drag records a box between 0 and 1', async () => {
    const { post, gesture, add } = setup();
    gesture([20, 10], [120, 60]);
    await add('Blur this');
    expect(post).toHaveBeenLastCalledWith('/api/notes', { video: 1, versionId: 'd1', t: 4.2, text: 'Blur this', box: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } });
  });

  it('a drag past the edge of the picture stays inside it', async () => {
    const { post, gesture, add } = setup();
    gesture([150, 80], [260, -30]);
    await add('Crop');
    const box = (post.mock.calls.at(-1)![1] as { box: Record<string, number> }).box;
    expect(box).toEqual({ x: 0.75, y: 0, w: 0.25, h: 0.8 });
    for (const v of Object.values(box)) expect(v >= 0 && v <= 1).toBe(true);
  });

  it('Cancel closes the composer without saving', () => {
    const { post, gesture } = setup();
    gesture([50, 50], [50, 50]);
    fireEvent.click(within(screen.getByRole('region', { name: 'New note' })).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'New note' })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('has a floating toolbar with play, a scrubber with note markers and the timecode', () => {
    setup();
    const bar = screen.getByRole('toolbar', { name: 'Player' });
    expect(within(bar).getByRole('button', { name: 'Play' })).toBeTruthy();
    const scrubber = within(bar).getByRole('slider', { name: 'Position' });
    expect(scrubber.getAttribute('max')).toBe('20');
    expect(bar.querySelectorAll('.player__marker')).toHaveLength(1);
    expect(within(bar).getByText('0:04 / 0:20')).toBeTruthy();
    // The keyboard way to add a note.
    fireEvent.click(within(bar).getByRole('button', { name: 'Add a note here' }));
    expect(within(screen.getByRole('region', { name: 'New note' })).getByText('0:04')).toBeTruthy();
  });

  it('goes to a note it is asked to (once the video has loaded) and pauses there', () => {
    const { container } = render(<Player video={1} version={rough} notes={[]} seek={{ t: 9, nonce: 1 }} post={vi.fn()} />);
    const video = container.querySelector('video')!;
    const pause = vi.fn();
    video.pause = pause;
    Object.defineProperty(video, 'duration', { value: 20, configurable: true });
    fireEvent(video, new Event('loadedmetadata'));
    expect(video.currentTime).toBe(9);
    expect(pause).toHaveBeenCalled();
    expect(within(screen.getByRole('toolbar', { name: 'Player' })).getByText('0:09 / 0:20')).toBeTruthy();
  });
});
