import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Word } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { extractWav } from './ffmpeg.js';
import { probe } from './ffprobe.js';
import { sentenceSegments, speechRanges, transcribeAudio } from './transcribe.js';
import { whisperSetup } from './whisper.js';

const w = (text: string, start: number, end: number): Word => ({ w: text, start, end, conf: 1 });

describe('sentenceSegments', () => {
  it('splits on sentence-ending punctuation and keeps a trailing unpunctuated run', () => {
    const segs = sentenceSegments([w('Hi', 0, 0.2), w('there.', 0.2, 0.5), w('Who', 1, 1.2), w('are', 1.2, 1.3), w('you?', 1.3, 1.6), w('Bye', 2, 2.3)]);
    expect(segs).toEqual([
      { start: 0, end: 0.5, text: 'Hi there.' },
      { start: 1, end: 1.6, text: 'Who are you?' },
      { start: 2, end: 2.3, text: 'Bye' },
    ]);
  });
});

describe('speechRanges', () => {
  it('merges words separated by less than 0.3 s', () => {
    expect(speechRanges([w('a', 0, 0.2), w('b', 0.4, 0.6), w('c', 1.5, 1.8)])).toEqual([[0, 0.6], [1.5, 1.8]]);
  });
  it('returns [] for no words', () => {
    expect(speechRanges([])).toEqual([]);
  });
});

describe.skipIf(!(await whisperSetup()).ok)('transcribeAudio (whisper.cpp installed)', () => {
  it('returns timed words, keeps fillers, and finds the pause', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we tx '));
    const wav = join(dir, 'audio.wav');
    await extractWav('fixtures/speech-retake.mp4', wav);
    const t = await transcribeAudio(wav);
    const tokens = t.words.map((x) => x.w.toLowerCase().replace(/[^\p{L}']/gu, ''));
    expect(tokens).toContain('welcome');
    expect(tokens).toContain('hook');
    expect(tokens.some((x) => ['um', 'uh', 'ah', 'er'].includes(x))).toBe(true);
    for (let i = 1; i < t.words.length; i++) expect(t.words[i].start).toBeGreaterThanOrEqual(t.words[i - 1].start);
    expect(t.words.every((x) => x.w === x.w.trim() && x.w.length > 0)).toBe(true);
    const duration = (await probe('fixtures/speech-retake.mp4')).durationSec;
    expect(t.words.at(-1)!.end).toBeLessThanOrEqual(duration + 0.05);
    expect(t.segments.length).toBeGreaterThanOrEqual(4);
    expect(t.speech.length).toBeGreaterThanOrEqual(2);
    // The 3 s pause (7.3–10.6 s) is between two speech ranges.
    expect(t.speech.some(([, end], i) => end < 7.6 && (t.speech[i + 1]?.[0] ?? 0) > 10)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }, 300_000);

  it('transcribes with a locale, and names whisper-cli when it cannot run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we tx '));
    const wav = join(dir, 'audio.wav');
    await extractWav('fixtures/speech-retake.mp4', wav);
    expect((await transcribeAudio(wav, { locale: 'en-US' })).words.length).toBeGreaterThan(20);
    await expect(transcribeAudio(join(dir, 'missing.wav'))).rejects.toMatchObject({ name: 'SidecarError', tool: 'whisper-cli', code: 'EXIT' });
    await rm(dir, { recursive: true, force: true });
  }, 300_000);
});

describe('transcribeAudio without whisper.cpp', () => {
  it('says what is missing', async () => {
    const was = process.env.WORDEDITS_WHISPER_DIR;
    process.env.WORDEDITS_WHISPER_DIR = join(tmpdir(), 'no-whisper-here');
    try {
      await expect(transcribeAudio('x.wav')).rejects.toMatchObject({ name: 'SidecarError', tool: 'whisper-cli', code: 'NOT_FOUND', hint: expect.stringContaining('WORDEDITS_WHISPER_DIR') });
    } finally {
      if (was === undefined) delete process.env.WORDEDITS_WHISPER_DIR;
      else process.env.WORDEDITS_WHISPER_DIR = was;
    }
  });
});
