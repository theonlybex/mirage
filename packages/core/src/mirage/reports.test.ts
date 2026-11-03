// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type Catalog, type Clip } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { saveCatalog } from './ingest.js';
import { checkReport, ingestReport, musicReport, renderReport, slotsReport, updateSlots, voReport } from './reports.js';
import { loadEpisode, saveEpisode } from './render-episode.js';

const episode = EpisodeSchema.parse({
  version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
  items: [
    { id: 'open', beat: 'cold-open', clip: 'c001', src: { in: 12.5, out: 18 } },
    { id: 'fix', beat: 'problem', clip: 'c001', src: { in: 20, out: 24 }, quiet: true },
  ],
  overlays: [{ kind: 'label', text: 'hi', start: 1, end: 2 }],
  music: [{ track: 'beat.wav', start: 0, end: 5 }],
});

describe('checkReport', () => {
  it('lists the timeline items, then the total, notes and warnings', () => {
    const lines = checkReport({ episode, notes: ['snapped a to 1.0 s'], warnings: ['overlay 1 is long'] });
    expect(lines[0]).toBe('  1  cold-open open         c001  12.50–18.00  ×1  0.00–5.50');
    expect(lines[1]).toMatch(/^  2  problem   fix          c001  20.00–24.00  ×1  5\.50–9\.50  quiet$/);
    expect(lines[2]).toMatch(/^total .* · 2 items · 1 overlays · 1 music cues$/);
    expect(lines.slice(3)).toEqual(['• snapped a to 1.0 s', '⚠ overlay 1 is long']);
  });
});

describe('ingestReport', () => {
  it('counts added clips and prints skips and warnings', () => {
    const lines = ingestReport({
      added: [{ id: 'c001' } as Clip, { id: 'c002' } as Clip],
      skipped: [{ file: 'a.mov', reason: 'already in the catalog' }, { file: 'b.mov', reason: 'no video' }],
      warnings: ['c002 is HDR'],
    });
    expect(lines).toEqual(['  skipped a.mov: already in the catalog', '⚠ skipped b.mov: no video', '⚠ c002 is HDR', '✓ 2 clips added, 2 skipped']);
    expect(ingestReport({ added: [], skipped: [], warnings: [] })).toEqual(['✓ 0 clips added']);
  });
});

describe('musicReport', () => {
  it('says when the folder has no tracks', () => {
    expect(musicReport('/p/music', { tracks: [], warnings: ['x missing'] })).toEqual(['  no tracks in /p/music', '⚠ x missing']);
  });
  it('lists tracks with their tempo', () => {
    const lines = musicReport('/p/music', {
      tracks: [
        { file: 'a.wav', mood: 'upbeat', licence: 'CC0', bpm: 120.04, beatOffset: 0, durationSec: 60.4 },
        { file: 'b.wav', mood: 'relaxed', licence: 'CC0', bpm: null, beatOffset: null, durationSec: null },
      ],
      warnings: [],
    });
    expect(lines).toEqual(['  a.wav  upbeat  120.0 BPM  60 s', '  b.wav  relaxed  no clear beat']);
  });
});

describe('renderReport', () => {
  it('prints the output, its captions and warnings', () => {
    expect(renderReport({ outputPath: '/p/episodes/1/final.mp4', srtPath: '/p/episodes/1/final.srt', durationSec: 75, warnings: ['line n2 edited'] })).toEqual([
      '✓ /p/episodes/1/final.mp4 (1:15)',
      '  captions: /p/episodes/1/final.srt',
      '⚠ line n2 edited',
    ]);
    expect(renderReport({ outputPath: '/p/rough.mp4', srtPath: null, durationSec: 5, warnings: [] })).toHaveLength(1);
  });
});

describe('slotsReport', () => {
  const slot = (id: string, start: number, end: number, maxWords: number, line: string) => ({ id, start, end, maxWords, line });
  it('lists slots, over-budget lines, moved and dropped lines and the totals', () => {
    const lines = slotsReport({
      slots: [slot('n1', 2.8, 9, 16, ''), slot('n2', 12, 14, 2, 'one two three')],
      moved: [{ line: 'moved line', from: slot('n3', 1, 2, 3, 'moved line'), to: slot('n4', 5, 6, 3, 'moved line') }],
      dropped: [slot('n5', 30, 31, 3, 'gone')],
    });
    expect(lines).toEqual([
      '  n1  2.8–9.0 s  ≤16 words  (no line yet)',
      '  n2  12.0–14.0 s  ≤2 words  one two three  ⚠ over budget (3 > 2 words)',
      '⚠ moved line (was n3 1.0–2.0, now n4 5.0–6.0): "moved line" — it followed its picture; check it still fits',
      '⚠ dropped line (was n5 30.0–31.0): "gone"',
      '✓ 2 slots, 1 with lines, 1 dropped',
    ]);
  });
  it('warns about lines that are not English or have no words', () => {
    const lines = slotsReport({ slots: [slot('n1', 0, 3, 5, 'これは日本語です'), slot('n2', 4, 7, 5, '...')], moved: [], dropped: [] });
    expect(lines).toContain("⚠ n1's line isn't in English — voice-over matching supports English only for now");
    expect(lines).toContain('⚠ n2\'s line has no words to read ("...") — write words, or leave it empty');
    expect(lines[lines.length - 1]).toBe('✓ 2 slots, 0 with lines');
  });
  it('says "1 slot" in the singular', () => {
    expect(slotsReport({ slots: [slot('n1', 0, 3, 5, '')], moved: [], dropped: [] }).at(-1)).toBe('✓ 1 slot, 0 with lines');
  });
});

describe('voReport', () => {
  it('describes each line and what is missing', () => {
    const lines = voReport(
      {
        lines: [
          { slot: 'n1', status: 'placed', takes: 2, overrunSec: 0.5 },
          { slot: 'n2', status: 'partial', takes: 1, overrunSec: 0 },
          { slot: 'n3', status: 'missing', takes: 0, overrunSec: 0 },
          { slot: 'n4', status: 'kept', takes: 0, overrunSec: 0 },
          { slot: 'n5', status: 'too long', takes: 1, overrunSec: 1.2 },
        ],
        extendedSec: 1.5,
        warnings: ['careful'],
      },
      3,
    );
    expect(lines[0]).toBe('  n1  placed  (2 takes, used the last)  held picture +0.5s');
    expect(lines[1]).toContain('re-read the whole line with vo --add --slots n2');
    expect(lines[2]).toBe('  n3  missing');
    expect(lines[3]).toBe('  n4  kept the earlier take (not found in this recording)');
    expect(lines[4]).toBe('  n5  too long: runs 1.2s past its slot, more than the picture can hold — shorten it or give it a longer slot, then vo --add');
    expect(lines.slice(5)).toEqual([
      '✓ voice-over fitted, episode 1.50 s longer',
      '⚠ not found: n3 — record just those lines, then: pnpm mirage vo <project> 3 <new recording> --add',
      '⚠ careful',
    ]);
  });
});

describe('updateSlots', () => {
  it('finds the slots, carries lines over and saves them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-reports-'));
    const clip: Clip = {
      id: 'c001', path: '/t.mov', sha256: 'a'.repeat(64), kind: 'talking', frames: [], notes: '', moments: [],
      probe: { durationSec: 30, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', colorTransfer: null },
      transcript: { words: [{ w: 'Hi', start: 0.5, end: 1, conf: 1 }], segments: [], speech: [] },
    };
    const catalog: Catalog = { version: 1, clips: [clip] };
    await mkdir(join(dir, 'episodes', '1'), { recursive: true });
    await saveCatalog(dir, catalog);
    await saveEpisode(dir, EpisodeSchema.parse({
      version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
      items: [
        { id: 'talk', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 3 }, audio: 'keep' },
        { id: 'screen', beat: 'problem', clip: 'c001', src: { in: 10, out: 16 } },
      ],
    }));
    const r = await updateSlots(dir, 1);
    expect(r.slots.length).toBeGreaterThan(0);
    expect(r.moved).toEqual([]);
    const saved = await loadEpisode(dir, 1);
    expect(saved.slots).toEqual(r.slots);
    expect(saved.slotsCut).toBeDefined();
  });
});
