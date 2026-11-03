// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.js';
import { VoiceoverDrop } from './VoiceoverDrop.js';

afterEach(cleanup);

const COPY = 'Play this guide and read the lines out loud as they come up. Record yourself with QuickTime or your phone, then drop the recording here.';

describe('VoiceoverDrop', () => {
  it('says what to do, and sends a dropped recording', async () => {
    const upload = vi.fn(async () => ({ ok: true, path: '/p/episodes/1/voiceover/take.m4a' }));
    render(<VoiceoverDrop video={1} upload={upload} />);
    expect(screen.getByText(COPY)).toBeTruthy();
    const file = new File(['audio'], 'take.m4a', { type: 'audio/mp4' });
    const zone = screen.getByRole('region', { name: 'Voice-over' });
    fireEvent.dragOver(zone, { dataTransfer: { files: [file], types: ['Files'] } });
    expect(zone.getAttribute('data-over')).toBe('true');
    await act(async () => void fireEvent.drop(zone, { dataTransfer: { files: [file], types: ['Files'] } }));
    expect(upload).toHaveBeenCalledWith(1, file);
    expect(screen.getByRole('status').textContent).toContain('take.m4a');
  });

  it('"Choose file" picks a recording the same way', async () => {
    const upload = vi.fn(async () => ({ ok: true, path: '/x' }));
    const { container } = render(<VoiceoverDrop video={2} upload={upload} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Choose file' }));
    expect(click).toHaveBeenCalled();
    const file = new File(['a'], 'voice.wav', { type: 'audio/wav' });
    await act(async () => void fireEvent.change(input, { target: { files: [file] } }));
    expect(upload).toHaveBeenCalledWith(2, file);
  });

  it('shows the server’s reason when the upload fails', async () => {
    const upload = vi.fn(async () => {
      throw new ApiError(413, 'That is too large.');
    });
    render(<VoiceoverDrop video={1} upload={upload} />);
    const file = new File(['a'], 'big.mov');
    await act(async () => void fireEvent.drop(screen.getByRole('region', { name: 'Voice-over' }), { dataTransfer: { files: [file], types: ['Files'] } }));
    expect(screen.getByRole('alert').textContent).toBe('That is too large.');
  });
});
