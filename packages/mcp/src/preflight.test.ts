// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { preflight, type PreflightDeps } from './preflight.js';

const GB = 1024 ** 3;
const fine = (over: Partial<PreflightDeps> = {}): PreflightDeps => ({
  onBattery: async () => false,
  freeBytes: async () => 500 * GB,
  footageBytes: async () => 20 * GB,
  which: async () => true,
  transcriber: async () => true,
  ...over,
});

describe('preflight', () => {
  it('is ok with no problems when the Mac is plugged in, has room and has its tools', async () => {
    expect(await preflight({ project: '/p', videos: [1, 2], deps: fine() })).toEqual({ ok: true, problems: [] });
  });

  it('asks to plug in when on battery', async () => {
    const r = await preflight({ project: '/p', videos: [1], deps: fine({ onBattery: async () => true }) });
    expect(r).toEqual({ ok: false, problems: ['Plug in your Mac. Overnight editing needs the power adapter.'] });
  });

  it('asks for space: at least 10 GB, or twice the footage of tonight\'s videos', async () => {
    const small = await preflight({ project: '/p', videos: [1], deps: fine({ freeBytes: async () => 5 * GB, footageBytes: async () => 1 * GB }) });
    expect(small.problems).toEqual(["Free up space: Mirage needs about 10 GB on this disk for tonight's videos."]);
    // two videos of 30 GB footage each: 2 × 60 GB
    const big = await preflight({ project: '/p', videos: [1, 2], deps: fine({ freeBytes: async () => 100 * GB, footageBytes: async () => 30 * GB }) });
    expect(big.problems).toEqual(["Free up space: Mirage needs about 120 GB on this disk for tonight's videos."]);
    const enough = await preflight({ project: '/p', videos: [1, 2], deps: fine({ freeBytes: async () => 120 * GB, footageBytes: async () => 30 * GB }) });
    expect(enough.ok).toBe(true);
  });

  it('names each missing tool and says what to run', async () => {
    const r = await preflight({ project: '/p', videos: [1], deps: fine({ which: async (c) => c === 'ffprobe' }) });
    expect(r.problems).toEqual(["ffmpeg isn't installed. Run /mirage:setup."]);
    const none = await preflight({ project: '/p', videos: [1], deps: fine({ which: async () => false }) });
    expect(none.problems).toEqual(["ffmpeg isn't installed. Run /mirage:setup.", "ffprobe isn't installed. Run /mirage:setup."]);
  });

  it('says to build the speech helper when it is missing', async () => {
    const r = await preflight({ project: '/p', videos: [1], deps: fine({ transcriber: async () => false }) });
    expect(r).toEqual({ ok: false, problems: ["The speech helper isn't built yet. Run /mirage:status."] });
  });

  it('reports every problem at once', async () => {
    const r = await preflight({ project: '/p', videos: [1], deps: fine({ onBattery: async () => true, which: async () => false, freeBytes: async () => 0, transcriber: async () => false }) });
    expect(r.problems).toHaveLength(5);
  });
});
