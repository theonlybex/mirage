import { EpisodeSchema, type Catalog } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { computeSlots, mergeSlots } from './slots.js';

const catalog: Catalog = {
  version: 1,
  clips: [
    { id: 'c001', path: '/t.mov', sha256: 'a'.repeat(64), probe: { durationSec: 30, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac' }, kind: 'talking', transcript: { words: [{ w: 'Hi', start: 0.5, end: 1 }, { w: 'there.', start: 1.1, end: 2.5 }].map((w) => ({ ...w, conf: 1 })), segments: [], speech: [] }, frames: [], notes: '', moments: [] },
  ],
};
const ep = EpisodeSchema.parse({
  version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
  items: [
    { id: 'talk', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 3 }, audio: 'keep' },
    { id: 'screen', beat: 'problem', clip: 'c001', src: { in: 10, out: 16 } },
    { id: 'reveal', beat: 'truth', clip: 'c001', src: { in: 20, out: 23 }, quiet: true },
    { id: 'tail', beat: 'outro', clip: 'c001', src: { in: 24, out: 26 } },
  ],
});

describe('computeSlots', () => {
  it('finds speech-free stretches outside quiet items, sized at 170 wpm', () => {
    expect(computeSlots(ep, catalog)).toEqual([{ id: 'n1', start: 2.8, end: 9, maxWords: 16, line: '' }]);
  });
  it('honours minLen', () => {
    expect(computeSlots(ep, catalog, { minLen: 1.5 }).map((s) => [s.start, s.end])).toEqual([[2.8, 9], [12, 14]]);
  });
});

describe('mergeSlots', () => {
  it('carries written lines to the most-overlapping new slot', () => {
    const prev = [{ id: 'n1', start: 2, end: 8, maxWords: 16, line: 'Old line.' }];
    const next = [{ id: 'n1', start: 0, end: 1, maxWords: 0, line: '' }, { id: 'n2', start: 3, end: 9, maxWords: 16, line: '' }];
    expect(mergeSlots(prev, next).map((s) => s.line)).toEqual(['', 'Old line.']);
  });
});
