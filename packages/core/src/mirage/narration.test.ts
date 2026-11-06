// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, TranscriptSchema } from '@wordedits/shared';
import type { Speaker } from '@wordedits/sidecars';
import { describe, expect, it } from 'vitest';
import type { MediaTools } from '../media-tools.js';
import { assembleNarration, lineSentences, narrationTargets, nextNarrationFile, sentenceWords, speakNarration, spreadWords, voicedSpan, wavBytes } from './narration.js';
import { loadEpisode, saveEpisode } from './render-episode.js';
import { speakReport } from './reports.js';
import { readWavMono } from './word-timing.js';

const RATE = 24000;
const WORD_SEC = 0.3;

/** Kokoro's shape of output: 0.1 s of silence, a tone for each word (a 0.15 s pause after a comma), 0.1 s of silence. */
function fakeAudio(text: string, speed = 1): Float32Array {
  const parts: number[] = [];
  const pad = () => parts.push(...new Array(Math.round(0.1 * RATE)).fill(0));
  pad();
  for (const w of text.split(' ')) {
    const n = Math.round((WORD_SEC / speed) * RATE);
    for (let i = 0; i < n; i++) parts.push(0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE));
    if (/,$/.test(w)) parts.push(...new Array(Math.round(0.15 * RATE)).fill(0));
  }
  pad();
  return Float32Array.from(parts);
}

/** A speaker that records what it was asked to read. */
function fakeSpeaker() {
  const calls: { text: string; voice: string; speed: number }[] = [];
  const steps: string[] = [];
  const speaker: Speaker = {
    prepare: async (o) => o.onStep?.('Downloading the Kokoro voice model, once: 92 MB'),
    speak: async (text, o) => {
      calls.push({ text, voice: o.voice, speed: o.speed });
      return { samples: fakeAudio(text, o.speed), sampleRate: RATE };
    },
  };
  return { speaker, calls, steps };
}

/** Nothing in speak may transcribe: the synthesized transcript is already known. */
const tools = {
  extractWav: async () => {
    throw new Error('speak must not extract audio');
  },
  transcribe: async () => {
    throw new Error('speak must not transcribe');
  },
} as unknown as MediaTools;

async function project(lines: [string, number, number, string][]) {
  const dir = await mkdtemp(join(tmpdir(), 'mirage-speak-'));
  await saveEpisode(dir, EpisodeSchema.parse({
    version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
    items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 20 } }],
    slots: lines.map(([id, start, end, line]) => ({ id, start, end, maxWords: 8, line })),
  }));
  return dir;
}

describe('lineSentences', () => {
  it('splits a line into sentences and drops pieces with no words', () => {
    expect(lineSentences('  Frigg showed up.  Finally!  Was it worth it? ')).toEqual(['Frigg showed up.', 'Finally!', 'Was it worth it?']);
    expect(lineSentences('One line, no stop')).toEqual(['One line, no stop']);
    expect(lineSentences('Done. …')).toEqual(['Done.']);
  });

  it('reads a very long sentence in clauses', () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ') + ', ' + Array.from({ length: 30 }, (_, i) => `x${i}`).join(' ');
    const parts = lineSentences(long);
    expect(parts).toHaveLength(2);
    expect(parts[0].endsWith('w29,')).toBe(true);
  });
});

describe('voicedSpan', () => {
  it('finds the voice inside the silence around it, and the pause at a comma', () => {
    const v = voicedSpan(fakeAudio('one two, three'), RATE)!;
    expect(v.start / RATE).toBeCloseTo(0.1, 1);
    expect(v.end / RATE).toBeCloseTo(0.1 + 3 * WORD_SEC + 0.15, 1);
    expect(v.quiet).toHaveLength(1);
    expect(v.quiet[0][0] / RATE).toBeCloseTo(0.1 + 2 * WORD_SEC, 1);
    expect(voicedSpan(new Float32Array(RATE), RATE)).toBeNull();
  });
});

describe('word timing', () => {
  it('spreads words over a stretch by how long they take to say, end to end', () => {
    const w = spreadWords('a longword 4', 1, 2);
    expect(w.map((x) => x.w)).toEqual(['a', 'longword', '4']);
    expect(w[0].start).toBe(1);
    expect(w[2].end).toBe(2);
    expect(w[1].end - w[1].start).toBeGreaterThan(w[0].end - w[0].start);
    for (let i = 1; i < w.length; i++) expect(w[i].start).toBe(w[i - 1].end);
  });

  it('puts the clauses of a sentence on either side of its pauses', () => {
    const w = sentenceWords('first part, second part', 0, 4, [[1.8, 2.2]]);
    expect(w.find((x) => x.w === 'part,')!.end).toBe(1.8);
    expect(w.find((x) => x.w === 'second')!.start).toBe(2.2);
    // Fewer pauses than clause breaks: spread over the whole sentence.
    expect(sentenceWords('a, b, c', 0, 3, [[1, 1.2]])[0].start).toBe(0);
  });
});

describe('assembleNarration', () => {
  it('joins lines in order with gaps, and its transcript has every written word where it is spoken, each line a sentence', () => {
    const lines = [
      { slot: 'n1', sentences: [{ text: 'Open settings', samples: fakeAudio('Open settings') }] },
      { slot: 'n2', sentences: [{ text: 'Then toggle it.', samples: fakeAudio('Then toggle it.') }, { text: 'Done!', samples: fakeAudio('Done!') }] },
    ];
    const r = assembleNarration(lines, RATE, { lead: 0.3, sentence: 0.3, line: 0.8 });
    expect(r.transcript.words.map((w) => w.w)).toEqual(['Open', 'settings.', 'Then', 'toggle', 'it.', 'Done!']);
    TranscriptSchema.parse(r.transcript);
    expect(r.lines.map((l) => l.slot)).toEqual(['n1', 'n2']);
    // Each sentence trimmed to its voice with 30 ms either side.
    expect(r.lines[0].start).toBeCloseTo(0.3, 2);
    expect(r.lines[0].end - r.lines[0].start).toBeCloseTo(2 * WORD_SEC + 0.06, 2);
    expect(r.lines[1].start - r.lines[0].end).toBeCloseTo(0.8, 2);
    expect(r.transcript.words[0].start).toBeCloseTo(0.33, 2);
    // The audio under each word is the voice.
    const v = voicedSpan(r.samples.subarray(Math.round(r.lines[1].start * RATE)), RATE)!;
    expect(v.start / RATE).toBeCloseTo(0.03, 2);
    expect(r.samples.length / RATE).toBeCloseTo(r.lines[1].end + 0.3, 2);
  });

  it('skips a sentence that came back silent', () => {
    const r = assembleNarration([{ slot: 'n1', sentences: [{ text: 'Hi.', samples: new Float32Array(RATE) }] }, { slot: 'n2', sentences: [{ text: 'Yes.', samples: fakeAudio('Yes.') }] }], RATE);
    expect(r.lines.map((l) => l.slot)).toEqual(['n2']);
    expect(r.transcript.words.map((w) => w.w)).toEqual(['Yes.']);
  });
});

describe('wavBytes', () => {
  it('writes 16-bit mono PCM that reads back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-wav-'));
    const samples = fakeAudio('one two');
    await writeFile(join(dir, 'a.wav'), wavBytes(samples, RATE));
    const back = (await readWavMono(join(dir, 'a.wav')))!;
    expect(back.sampleRate).toBe(RATE);
    expect(back.samples.length).toBe(samples.length);
    expect(Math.abs(back.samples[3000] - samples[3000])).toBeLessThan(1e-4);
  });
});

describe('nextNarrationFile', () => {
  it('is a new name after the highest one there', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-names-'));
    expect(await nextNarrationFile(dir)).toBe('narration-1.wav');
    await writeFile(join(dir, 'narration-1.wav'), '');
    await writeFile(join(dir, 'narration-7.wav'), '');
    await writeFile(join(dir, 'narration-x.wav'), '');
    expect(await nextNarrationFile(dir)).toBe('narration-8.wav');
  });
});

describe('narrationTargets', () => {
  it('is the written lines in slot order, or just the listed ones', async () => {
    const ep = await loadEpisode(await project([['n2', 10, 14, 'Second.'], ['n1', 0, 4, 'First.'], ['n3', 15, 19, '']]), 1);
    expect(narrationTargets(ep).map((s) => s.id)).toEqual(['n1', 'n2']);
    expect(narrationTargets(ep, ['n2']).map((s) => s.id)).toEqual(['n2']);
    expect(() => narrationTargets(ep, ['n3'])).toThrow('slot n3 has no written line');
    expect(() => narrationTargets(ep, ['n9'])).toThrow('there is no slot n9');
  });
});

describe('speakNarration', () => {
  it('reads every line, saves a new recording and fits it without transcribing', async () => {
    const dir = await project([['n1', 0, 4, 'Open the settings.'], ['n2', 10, 14, 'Then pick a colour. It saves itself.']]);
    const { speaker, calls } = fakeSpeaker();
    const steps: string[] = [];
    const r = await speakNarration({ project: dir, episode: 1, tools, speaker, voice: 'am_michael', speed: 1, onStep: (m) => steps.push(m) });
    expect(calls).toEqual([
      { text: 'Open the settings.', voice: 'am_michael', speed: 1 },
      { text: 'Then pick a colour.', voice: 'am_michael', speed: 1 },
      { text: 'It saves itself.', voice: 'am_michael', speed: 1 },
    ]);
    expect(steps[0]).toBe('Downloading the Kokoro voice model, once: 92 MB');
    expect(r.recording).toBe('episodes/1/narration-1.wav');
    expect(r.report.lines.map((l) => [l.slot, l.status])).toEqual([['n1', 'placed'], ['n2', 'placed']]);
    expect(r.spedUp).toEqual([]);
    const ep = await loadEpisode(dir, 1);
    expect(ep.voiceover!.recording).toBe('episodes/1/narration-1.wav');
    expect(ep.voiceover!.lines.map((l) => l.text)).toEqual(['Open the settings.', 'Then pick a colour. It saves itself.']);
    const transcript = TranscriptSchema.parse(JSON.parse(await readFile(join(dir, 'episodes', '1', ep.voiceover!.transcripts['episodes/1/narration-1.wav']), 'utf8')));
    expect(transcript.words.map((w) => w.w).join(' ')).toBe('Open the settings. Then pick a colour. It saves itself.');
    // Each line plays from its own stretch of the recording.
    const [a, b] = ep.voiceover!.lines;
    expect(a.src.out).toBeLessThan(b.src.in);
    expect(speakReport(r, 1, 'am_michael')[0]).toMatch(/^• Read 2 lines with am_michael: \d+\.\d s of narration in \d+\.\d s, saved as episodes\/1\/narration-1\.wav$/);

    // A second run never overwrites the first recording; with slots it reads just those and keeps the rest.
    const again = await speakNarration({ project: dir, episode: 1, tools, speaker, voice: 'am_michael', speed: 1, slots: ['n2'] });
    expect(again.recording).toBe('episodes/1/narration-2.wav');
    expect(calls.slice(3).map((c) => c.text)).toEqual(['Then pick a colour.', 'It saves itself.']);
    expect(existsSync(join(dir, 'episodes', '1', 'narration-1.wav'))).toBe(true);
    const after = await loadEpisode(dir, 1);
    expect(after.voiceover!.lines.map((l) => [l.slot, l.recording ?? after.voiceover!.recording])).toEqual([['n1', 'episodes/1/narration-1.wav'], ['n2', 'episodes/1/narration-2.wav']]);
  });

  it('reads a line too long for its slot faster, up to 1.15×, then lets the fit hold the picture', async () => {
    // Eight words at 0.3 s = 2.4 s of voice, in a 2.5 s slot that has room for 2.4 s: no speed-up.
    // Twelve words = 3.6 s: needs 1.5×, so it is read at 1.15× and the picture is held for the rest.
    const dir = await project([['n1', 0, 2.5, 'one two three four five six seven eight'], ['n2', 10, 12.5, 'a b c d e f g h i j k l']]);
    const { speaker, calls } = fakeSpeaker();
    const r = await speakNarration({ project: dir, episode: 1, tools, speaker, voice: 'af_heart', speed: 1 });
    expect(r.spedUp).toEqual([{ slot: 'n2', speed: 1.15 }]);
    expect(calls.map((c) => c.speed)).toEqual([1, 1, 1.15]);
    expect(r.report.lines.find((l) => l.slot === 'n2')!.overrunSec).toBeGreaterThan(0);
    expect(speakReport(r, 1, 'af_heart')).toContain('• n2 was read at 1.15× to fit its slot');
  });

  it('refuses before reading anything: no lines, an unknown voice, a bad speed, lines not in English', async () => {
    const { speaker, calls } = fakeSpeaker();
    const none = await project([['n1', 0, 4, '']]);
    await expect(speakNarration({ project: none, episode: 1, tools, speaker, voice: 'af_heart', speed: 1 })).rejects.toMatchObject({ code: 'NOTHING_MATCHED', message: 'No narration lines are written yet' });
    const one = await project([['n1', 0, 4, 'Hello there.']]);
    await expect(speakNarration({ project: one, episode: 1, tools, speaker, voice: 'xx_nobody', speed: 1 })).rejects.toMatchObject({ code: 'BAD_INPUT', message: 'There is no voice xx_nobody' });
    await expect(speakNarration({ project: one, episode: 1, tools, speaker, voice: 'af_heart', speed: 3 })).rejects.toMatchObject({ code: 'BAD_INPUT', message: 'Speed 3 is out of range' });
    const russian = await project([['n1', 0, 4, 'Привет всем']]);
    await expect(speakNarration({ project: russian, episode: 1, tools, speaker, voice: 'af_heart', speed: 1 })).rejects.toMatchObject({ code: 'NOTHING_MATCHED', message: 'Voice-over matching supports English only for now' });
    expect(calls).toEqual([]);
    expect((await readdir(join(one, 'episodes', '1'))).filter((f) => f.endsWith('.wav'))).toEqual([]);
  });

  it('a stopped run saves no recording and leaves episode.json alone', async () => {
    const dir = await project([['n1', 0, 4, 'Open the settings.'], ['n2', 10, 14, 'Then pick a colour.']]);
    const before = await readFile(join(dir, 'episodes', '1', 'episode.json'), 'utf8');
    const ac = new AbortController();
    const speaker: Speaker = {
      prepare: async () => {},
      speak: async (text) => {
        ac.abort();
        return { samples: fakeAudio(text), sampleRate: RATE };
      },
    };
    await expect(speakNarration({ project: dir, episode: 1, tools, speaker, voice: 'af_heart', speed: 1, signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await readdir(join(dir, 'episodes', '1'))).toEqual(['episode.json']);
    expect(await readFile(join(dir, 'episodes', '1', 'episode.json'), 'utf8')).toBe(before);
  });
});
