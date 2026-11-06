import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dtwPreset, locateWhisper, whisperLanguage, whisperModelPath, whisperSetup, wordsFromWhisperJson } from './whisper.js';

// whisper-cli -m ggml-large-v3-turbo-q5_0.bin -f <speech-retake.mp4 as 16 kHz WAV> -l auto -bs 1 -sns -nfa --dtw large.v3.turbo -ojf
const FIXTURE = readFileSync('fixtures/whisper/speech-retake.json', 'latin1');

/** A one-segment -ojf document. */
const doc = (tokens: { text: string; p?: number; t_dtw?: number; from?: number; to?: number }[], segFrom = 0) =>
  JSON.stringify({
    transcription: [{
      offsets: { from: segFrom, to: 0 },
      tokens: tokens.map((t) => ({ text: t.text, p: t.p ?? 1, t_dtw: t.t_dtw ?? -1, offsets: { from: t.from ?? 0, to: t.to ?? 0 } })),
    }],
  });

describe('wordsFromWhisperJson (recorded whisper-cli -ojf)', () => {
  const words = wordsFromWhisperJson(FIXTURE);

  it('merges tokens into words, keeps punctuation and fillers, and skips special tokens', () => {
    expect(words.map((x) => x.w).join(' ')).toBe(
      'Welcome to word edits. Um. This is scene 1. The hook. Uh. Let me say that again. This is scene 1. The hook. Now scene 2 explains how the app cuts your take.',
    );
    expect(words.some((x) => x.w.includes('[_'))).toBe(false);
  });

  it('times words from DTW, close to where the audio has them', () => {
    // Where the fixture's speech really is (ffmpeg silencedetect): "Um" 1.46–1.74, "Uh" 3.81–4.12, the pause 7.28–10.57, end 13.23.
    const at = (w: string, nth = 0) => words.filter((x) => x.w === w)[nth]!;
    expect(at('Welcome').start).toBe(0);
    expect(at('Um.').start).toBeCloseTo(1.48, 2);
    expect(at('Um.').end).toBeCloseTo(1.66, 2);
    expect(at('Uh.').start).toBeCloseTo(3.8, 2);
    expect(at('hook.', 1).end).toBeCloseTo(7.3, 2);
    expect(at('take.').end).toBeCloseTo(13.18, 2);
  });

  it('keeps a pause out of the word after it', () => {
    const now = words.find((x) => x.w === 'Now')!;
    expect(now.end).toBeCloseTo(10.76, 2);
    expect(now.start).toBeGreaterThan(10);
  });

  it('has ordered, non-negative times and confidences in [0, 1]', () => {
    for (const [i, x] of words.entries()) {
      expect(x.end).toBeGreaterThanOrEqual(x.start);
      expect(x.conf).toBeGreaterThanOrEqual(0);
      expect(x.conf).toBeLessThanOrEqual(1);
      if (i > 0) expect(x.start).toBeGreaterThanOrEqual(words[i - 1]!.start);
    }
    expect(words.find((x) => x.w === 'Welcome')!.conf).toBeCloseTo(0.668, 2);
  });
});

describe('wordsFromWhisperJson', () => {
  it('joins sub-word tokens, and a character split across tokens (raw UTF-8 bytes)', () => {
    // " café" as whisper.cpp writes it: "é" (C3 A9) split over two tokens; read as latin1, each byte is one char.
    const json = doc([{ text: ' caf', t_dtw: 20 }, { text: '\u00c3', t_dtw: 25 }, { text: '\u00a9', t_dtw: 30 }, { text: ' ol', t_dtw: 40 }, { text: 'a', t_dtw: 50 }]);
    expect(wordsFromWhisperJson(json).map((x) => [x.w, x.start, x.end])).toEqual([['café', 0, 0.3], ['ola', 0.3, 0.5]]);
  });

  it('ends a word at its last letter or digit, not at the punctuation after it', () => {
    const words = wordsFromWhisperJson(doc([{ text: ' hi', t_dtw: 40 }, { text: '.', t_dtw: 90 }, { text: ' you', t_dtw: 120 }]));
    expect(words.map((x) => [x.w, x.start, x.end])).toEqual([['hi.', 0, 0.4], ['you', 0.9, 1.2]]);
  });

  it('averages the probability of the letter and digit tokens into conf', () => {
    const words = wordsFromWhisperJson(doc([{ text: ' un', p: 0.5, t_dtw: 10 }, { text: 'til', p: 0.9, t_dtw: 20 }, { text: ',', p: 0.01, t_dtw: 30 }]));
    expect(words[0]!.conf).toBeCloseTo(0.7, 5);
  });

  it('uses the token offsets when there is no DTW timing', () => {
    const words = wordsFromWhisperJson(doc([{ text: '[_BEG_]' }, { text: ' Hello', from: 120, to: 480 }, { text: ',', from: 480, to: 500 }, { text: ' there', from: 600, to: 900 }]));
    expect(words.map((x) => [x.w, x.start, x.end])).toEqual([['Hello,', 0.12, 0.48], ['there', 0.6, 0.9]]);
  });

  it('returns no words for no speech', () => {
    expect(wordsFromWhisperJson(JSON.stringify({ transcription: [] }))).toEqual([]);
    expect(wordsFromWhisperJson('{}')).toEqual([]);
  });
});

describe('dtwPreset', () => {
  it('maps whisper.cpp model file names to --dtw presets', () => {
    expect(dtwPreset('/m/ggml-large-v3-turbo-q5_0.bin')).toBe('large.v3.turbo');
    expect(dtwPreset('ggml-large-v3-turbo.bin')).toBe('large.v3.turbo');
    expect(dtwPreset('ggml-large-v3.bin')).toBe('large.v3');
    expect(dtwPreset('ggml-base.en-q8_0.bin')).toBe('base.en');
    expect(dtwPreset('ggml-small.bin')).toBe('small');
    expect(dtwPreset('my-finetune.bin')).toBeNull();
  });
});

describe('whisperLanguage', () => {
  it('turns a locale into a whisper language code, auto-detecting when there is none', () => {
    expect(whisperLanguage('en-US')).toBe('en');
    expect(whisperLanguage('de_DE')).toBe('de');
    expect(whisperLanguage('auto')).toBe('auto');
    expect(whisperLanguage(undefined)).toBe('auto');
  });
});

describe('locating whisper.cpp', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';

  async function fakeInstall(): Promise<{ dir: string; model: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'mirage whisper '));
    await writeFile(join(dir, exe), '#!/bin/sh\n');
    await chmod(join(dir, exe), 0o755);
    const model = join(dir, 'ggml-tiny.bin');
    await writeFile(model, 'model');
    return { dir, model };
  }

  it('uses WORDEDITS_WHISPER_DIR and WORDEDITS_WHISPER_MODEL', async () => {
    const { dir, model } = await fakeInstall();
    vi.stubEnv('WORDEDITS_WHISPER_DIR', dir);
    vi.stubEnv('WORDEDITS_WHISPER_MODEL', model);
    expect(await locateWhisper()).toBe(join(dir, exe));
    expect(whisperModelPath()).toBe(model);
    expect(await whisperSetup()).toEqual({ ok: true, cli: join(dir, exe), model });
  });

  it('defaults the model to ~/.local/share/whisper-cpp/models/ggml-large-v3-turbo-q5_0.bin', () => {
    vi.stubEnv('WORDEDITS_WHISPER_MODEL', '');
    expect(whisperModelPath()).toMatch(/[/\\]\.local[/\\]share[/\\]whisper-cpp[/\\]models[/\\]ggml-large-v3-turbo-q5_0\.bin$/);
  });

  it('finds whisper-cli on PATH', async () => {
    const { dir } = await fakeInstall();
    vi.stubEnv('WORDEDITS_WHISPER_DIR', '');
    vi.stubEnv('PATH', dir);
    expect(await locateWhisper()).toBe(join(dir, exe));
  });

  it('says which half is missing', async () => {
    const { dir, model } = await fakeInstall();
    vi.stubEnv('WORDEDITS_WHISPER_DIR', dir);
    vi.stubEnv('WORDEDITS_WHISPER_MODEL', join(dir, 'nope.bin'));
    const noModel = await whisperSetup();
    expect(noModel.ok).toBe(false);
    expect(!noModel.ok && noModel.problem).toMatch(/speech model is missing.*nope\.bin.*huggingface\.co/);
    expect(!noModel.ok && noModel.problem).not.toMatch(/whisper-cli/);

    vi.stubEnv('WORDEDITS_WHISPER_DIR', join(dir, 'empty'));
    vi.stubEnv('WORDEDITS_WHISPER_MODEL', model);
    const noCli = await whisperSetup();
    expect(!noCli.ok && noCli.problem).toMatch(/whisper-cli not found in WORDEDITS_WHISPER_DIR/);
    expect(!noCli.ok && noCli.problem).not.toMatch(/speech model/);
  });
});
