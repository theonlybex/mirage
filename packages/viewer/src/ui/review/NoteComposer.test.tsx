// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteComposer } from './NoteComposer.js';

/** A stand-in MediaRecorder: `failStart` makes start() throw. */
class FakeRecorder {
  static failStart = false;
  static last: FakeRecorder | null = null;
  static isTypeSupported = () => true;
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  stop = vi.fn(() => {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['x']) });
    this.onstop?.();
  });
  constructor() {
    FakeRecorder.last = this;
  }
  start() {
    if (FakeRecorder.failStart) throw new DOMException('cannot start', 'NotSupportedError');
    this.state = 'recording';
  }
}

let trackStop: ReturnType<typeof vi.fn>;
beforeEach(() => {
  FakeRecorder.failStart = false;
  FakeRecorder.last = null;
  trackStop = vi.fn();
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] })) },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const setup = () => {
  const sendAudio = vi.fn(async () => ({ text: 'Make it shorter' }));
  render(<NoteComposer video={1} t={4} box={null} still={null} onAdd={vi.fn(async () => {})} onCancel={vi.fn()} sendAudio={sendAudio} />);
  return { sendAudio, mic: screen.getByRole('button', { name: 'Hold to talk' }) };
};

describe('NoteComposer hold-to-talk', () => {
  it('stops recording when the button loses focus', async () => {
    setup();
    const mic = screen.getByRole('button', { name: 'Hold to talk' });
    await act(async () => void fireEvent.keyDown(mic, { key: ' ' }));
    expect(FakeRecorder.last?.state).toBe('recording');
    expect(screen.getByRole('button', { name: 'Release to stop' })).toBeTruthy();
    await act(async () => void fireEvent.blur(mic));
    expect(FakeRecorder.last?.stop).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
  });

  it('gives the microphone back when the recorder will not start', async () => {
    FakeRecorder.failStart = true;
    const { mic } = setup();
    await act(async () => void fireEvent.keyDown(mic, { key: ' ' }));
    expect(trackStop).toHaveBeenCalled();
    expect(screen.getByText('The microphone didn’t start. Type the note instead.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hold to talk' })).toBeTruthy();
  });

  it('says how to allow the microphone when it is refused', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
    const { mic } = setup();
    await act(async () => void fireEvent.keyDown(mic, { key: ' ' }));
    expect(screen.getByText(/Mirage can’t use the microphone/)).toBeTruthy();
  });
});
