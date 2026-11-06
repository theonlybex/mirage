// SPDX-License-Identifier: MIT
import { SidecarError } from '@wordedits/sidecars';
import { describe, expect, it } from 'vitest';
import { asCancelled } from './cancel.js';

describe('asCancelled', () => {
  const boom = new Error('boom');
  it('turns any error into CANCELLED once the signal aborted', () => {
    const ac = new AbortController();
    ac.abort();
    expect(asCancelled(boom, ac.signal)).toMatchObject({ name: 'MirageError', code: 'CANCELLED', message: 'Stopped before it finished', hint: 'Nothing was changed. Run it again to finish.' });
  });
  it('turns a sidecar CANCELLED error into CANCELLED', () => {
    expect(asCancelled(new SidecarError('ffmpeg', 'CANCELLED', 'ffmpeg was stopped', 'Stopped on request.'))).toMatchObject({ code: 'CANCELLED' });
  });
  it('returns other errors as they are', () => {
    expect(asCancelled(boom)).toBe(boom);
    expect(asCancelled(boom, new AbortController().signal)).toBe(boom);
    const exit = new SidecarError('ffmpeg', 'EXIT', 'x', 'y');
    expect(asCancelled(exit)).toBe(exit);
  });
});
