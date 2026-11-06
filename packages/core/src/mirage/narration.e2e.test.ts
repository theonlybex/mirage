// SPDX-License-Identifier: MIT
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EpisodeSchema } from '@wordedits/shared';
import { kokoroSpeaker, ttsSetup, whisperSetup } from '@wordedits/sidecars';
import { afterAll, describe, expect, it } from 'vitest';
import { normalizeWord } from '../autoedit/takes.js';
import { realMediaTools } from '../media-tools.js';
import { ingestClips } from './ingest.js';
import { speakNarration } from './narration.js';
import { loadEpisode, renderEpisode, saveEpisode } from './render-episode.js';
import { updateSlots } from './reports.js';
import { timelineDuration } from './timeline.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');
const LINES = ['Frigg finally showed up after ninety pulls.', 'I lost the fifty fifty, but it was worth it.'];

// Real Kokoro: runs where it is set up already (speak or /mirage:setup fetched it), or with MIRAGE_E2E_KOKORO=1, which lets the
// test download it (about 260 MB) like a first speak does.
describe.skipIf(ttsSetup().state !== 'ok' && !process.env.MIRAGE_E2E_KOKORO)('AI narration end to end', () => {
  let project = '';
  let passed = false;
  afterAll(async () => {
    if (passed && project) await rm(project, { recursive: true, force: true });
  });

  it('reads two lines with Kokoro, fits them and renders them with captions', async () => {
    const tools = await realMediaTools();
    project = await mkdtemp(join(tmpdir(), 'mirage speak e2e '));
    const clips = join(project, 'clips');
    await mkdir(clips);
    await copyFile(join(FIXTURES, 'noaudio-6s.mp4'), join(clips, 'shot.mp4'));
    await ingestClips({ project, clipsDir: clips, tools });
    // Two stretches of picture for narration, with a quiet item between them: two slots.
    await saveEpisode(project, EpisodeSchema.parse({
      version: 2, number: 1, title: 'Narrated', output: { width: 640, height: 360, fps: 30 },
      items: [
        { id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 6 } },
        { id: 'b', beat: 'problem', clip: 'c001', src: { in: 0, out: 1.5 }, quiet: true },
        { id: 'c', beat: 'truth', clip: 'c001', src: { in: 0, out: 6 } },
      ],
    }));
    const { slots } = await updateSlots(project, 1);
    expect(slots.map((s) => s.id)).toEqual(['n1', 'n2']);
    const ep = await loadEpisode(project, 1);
    await saveEpisode(project, { ...ep, slots: ep.slots.map((s, i) => ({ ...s, line: LINES[i] })) });

    const steps: string[] = [];
    const r = await speakNarration({ project, episode: 1, tools, speaker: kokoroSpeaker(), voice: 'af_heart', speed: 1, onStep: (m) => steps.push(m) });
    console.log(`speak: ${r.audioSec} s of narration in ${r.synthSec} s; ${steps.join(' | ')}`);
    expect(r.report.lines.map((l) => [l.slot, l.status])).toEqual([['n1', 'placed'], ['n2', 'placed']]);
    expect(r.recording).toBe('episodes/1/narration-1.wav');

    const final = await renderEpisode({ project, episode: 1, mode: 'final', tools });
    const fitted = await loadEpisode(project, 1);
    const probe = await tools.probe(final.outputPath);
    expect(probe.hasAudio).toBe(true);
    expect(Math.abs(probe.durationSec - timelineDuration(fitted))).toBeLessThanOrEqual(0.1);
    // Captions say the lines as written.
    const srt = await readFile(final.srtPath!, 'utf8');
    for (const word of ['Frigg', 'ninety', 'worth']) expect(srt).toContain(word);

    // The mixed narration is speech whisper can hear, at the times the fit placed it.
    if ((await whisperSetup()).ok) {
      const wav = join(project, 'final.wav');
      await tools.extractWav(final.outputPath, wav);
      const heard = await tools.transcribe(wav, { locale: 'en-US' });
      const said = new Set(heard.words.map((w) => normalizeWord(w.w)));
      for (const w of ['finally', 'showed', 'pulls', 'lost', 'worth']) expect(said).toContain(w);
      const line2 = fitted.voiceover!.lines.find((l) => l.slot === 'n2')!;
      const lost = heard.words.find((w) => normalizeWord(w.w) === 'lost')!;
      expect(lost.start).toBeGreaterThan(line2.at - 0.2);
    }
    passed = true;
  }, 900_000);
});
