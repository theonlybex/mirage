// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveVideo } from '../api.js';
import { before, checkpoint, guide, note, rough } from './fixtures.js';
import { ReviewTab, reviewVersion } from './ReviewTab.js';

afterEach(cleanup);

const live = (over: Partial<LiveVideo>): LiveVideo => ({
  timeline: null, steps: [], progress: null, versions: [], notes: [], control: null, report: null, connected: true, loaded: true, gaveUp: false, ...over,
});

describe('reviewVersion', () => {
  it('plays the chosen version, else the newest delivery; never one without a video', () => {
    expect(reviewVersion([rough, guide, before, checkpoint], null)?.id).toBe('d2');
    expect(reviewVersion([rough, guide], 'd1')?.id).toBe('d1');
    expect(reviewVersion([rough, guide], 'b1')?.id).toBe('d2');
    expect(reviewVersion([before, checkpoint], null)).toBeNull();
  });
});

describe('ReviewTab', () => {
  it('shows the voice-over drop on a guide cut only, and switches versions with the picker', () => {
    const onChoose = vi.fn();
    const { rerender } = render(<ReviewTab video={1} live={live({ versions: [rough, guide] })} chosen={null} onChoose={onChoose} />);
    expect(screen.getByRole('region', { name: 'Voice-over' })).toBeTruthy();
    const picker = screen.getByLabelText('Version') as HTMLSelectElement;
    expect(picker.value).toBe('d2');
    fireEvent.change(picker, { target: { value: 'd1' } });
    expect(onChoose).toHaveBeenCalledWith('d1');
    rerender(<ReviewTab video={1} live={live({ versions: [rough, guide] })} chosen="d1" onChoose={onChoose} />);
    expect(screen.queryByRole('region', { name: 'Voice-over' })).toBeNull();
  });

  it('a note on another version switches to it', () => {
    const onChoose = vi.fn();
    render(<ReviewTab video={1} live={live({ versions: [rough, guide], notes: [note({ id: 'n1', versionId: 'd1', text: 'Earlier note' })] })} chosen={null} onChoose={onChoose} />);
    expect(screen.getByText('V1 · Rough cut')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^0:04.*Earlier note/ }));
    expect(onChoose).toHaveBeenCalledWith('d1');
  });

  it('a seek is spent once another version plays: coming back does not jump to the note again', () => {
    HTMLMediaElement.prototype.pause = vi.fn();
    const state = live({ versions: [rough, guide], notes: [note({ id: 'n1', versionId: 'd1', t: 4.2, text: 'Earlier note' })] });
    function Stateful() {
      const [chosen, setChosen] = useState<string | null>(null);
      return <ReviewTab video={1} live={state} chosen={chosen} onChoose={setChosen} />;
    }
    const { container } = render(<Stateful />);
    const loaded = () => {
      const v = container.querySelector('video')!;
      Object.defineProperty(v, 'duration', { value: 20, configurable: true });
      fireEvent(v, new Event('loadedmetadata'));
      return v;
    };
    fireEvent.click(screen.getByRole('button', { name: /^0:04.*Earlier note/ }));
    expect(loaded().currentTime).toBe(4.2);
    const picker = screen.getByLabelText('Version') as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: 'd2' } });
    loaded();
    fireEvent.change(picker, { target: { value: 'd1' } });
    expect(picker.value).toBe('d1');
    expect(loaded().currentTime).toBe(0);
  });

  it('says there is nothing to watch before the first cut', () => {
    render(<ReviewTab video={1} live={live({ versions: [before] })} chosen={null} onChoose={vi.fn()} />);
    expect(screen.getByText(/Nothing to watch yet/)).toBeTruthy();
  });
});
