// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backup, before, checkpoint, guide, rough } from '../review/fixtures.js';
import { VersionsList } from './VersionsList.js';

afterEach(cleanup);

const setup = () => {
  const post = vi.fn(async () => ({}));
  const onPlay = vi.fn();
  render(<VersionsList video={1} versions={[rough, before, checkpoint, guide]} onPlay={onPlay} post={post} />);
  return { post, onPlay };
};

describe('VersionsList', () => {
  it('lists deliveries as V<k> · <label> · <date> and the "Before this edit" entries, newest first', () => {
    setup();
    const labels = screen.getAllByRole('listitem').map((li) => li.querySelector('.version__title')!.textContent);
    expect(labels).toHaveLength(3);
    expect(labels[0]).toMatch(/^V2 · Guide cut \(record your voice-over over this\) · .+/);
    expect(labels[1]).toMatch(/^Before this edit · .+/);
    expect(labels[2]).toMatch(/^V1 · Rough cut · .+/);
  });

  it('keeps checkpoints hidden until "Show steps"', () => {
    setup();
    expect(screen.queryByText(/Timeline checked/)).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Show steps' }));
    expect(screen.getByText(/Timeline checked/)).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    fireEvent.click(screen.getByRole('switch', { name: 'Show steps' }));
    expect(screen.queryByText(/Timeline checked/)).toBeNull();
  });

  it('shows the backups made when going back under "Show steps", with their label', () => {
    render(<VersionsList video={1} versions={[rough, before, checkpoint, backup]} onPlay={() => {}} post={vi.fn()} />);
    expect(screen.queryByText(/Before going back to/)).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Show steps' }));
    const item = screen.getAllByRole('listitem')[0]!;
    expect(item.querySelector('.version__title')!.textContent).toMatch(/^Before going back to “Timeline checked” · .+/);
    expect(within(item).getByText('What was there before going back')).toBeTruthy();
    expect(within(item).getByRole('button', { name: 'Go back to this version' })).toBeTruthy();
    cleanup();
    // Only a backup so far: the switch is offered.
    render(<VersionsList video={1} versions={[backup]} onPlay={() => {}} post={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'Show steps' })).toBeTruthy();
  });

  it('Play opens the version in Review; only versions with a video have it', () => {
    const { onPlay } = setup();
    const items = screen.getAllByRole('listitem');
    expect(within(items[1]!).queryByRole('button', { name: /Play/ })).toBeNull();
    fireEvent.click(within(items[2]!).getByRole('button', { name: 'Play V1' }));
    expect(onPlay).toHaveBeenCalledWith('d1');
  });

  it('asks before going back to a version, and goes back only on yes', async () => {
    const { post } = setup();
    const v1 = screen.getAllByRole('listitem')[2]!;
    fireEvent.click(within(v1).getByRole('button', { name: 'Go back to this version' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Go back to “Rough cut”?')).toBeTruthy();
    expect(within(dialog).getByText("What's there now is kept as a version too.")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(post).not.toHaveBeenCalled();

    fireEvent.click(within(v1).getByRole('button', { name: 'Go back to this version' }));
    await act(async () => void fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Go back' })));
    expect(post).toHaveBeenCalledWith('/api/restore', { video: 1, id: 'd1' });
    expect(screen.getByRole('status').textContent).toContain('Went back to “Rough cut”');
  });

  it('says when there are no versions yet', () => {
    render(<VersionsList video={1} versions={[]} onPlay={() => {}} post={vi.fn()} />);
    expect(screen.getByText(/No versions yet/)).toBeTruthy();
  });
});
