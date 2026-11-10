// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type ProbeInfo } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { saveCatalog } from './ingest.js';
import { learnResults, type Features, type LearnDeps } from './learn.js';
import { bandOf, predictVideo, sitsWith, WEIGHTS } from './predict.js';
import { PredictionSchema, readPrediction } from './prediction.js';
import { saveEpisode } from './render-episode.js';
import { newVideo } from './video.js';

const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const at = (day: string) => () => new Date(`${day}T10:00:00Z`);
const word = (w: string, start: number) => ({ w, start, end: start + 0.4, conf: 1 });
const probeInfo = (durationSec: number): ProbeInfo => ({ durationSec, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', colorTransfer: null });
const tools = (sec = 40) => ({ probe: async () => probeInfo(sec) });
const NOW = { now: at('2026-11-09') };

/** A project with one 60 s clip that says "hello there" at 1 s and 2 s and "done" at 20 s. */
async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mirage-predict-'));
  await writeFile(join(dir, 'mirage.json'), JSON.stringify({ version: 1, title: 'My build', createdAt: '2026-10-01T00:00:00Z' }));
  await saveCatalog(dir, {
    version: 1,
    clips: [{
      id: 'c001', path: join(dir, 'a.mov'), sha256: 'a'.repeat(64), kind: 'talking', frames: [], notes: '', moments: [], probe: probeInfo(60),
      transcript: { words: [word('hello', 1), word('there', 2), word('done', 20)], segments: [], speech: [] },
    }],
  });
  return dir;
}

/** Video n, a build story: a 40 s cut of three shots (talk 0–10, a muted montage 10–20, the truth 20–40) with one overlay at 6 s. */
async function video(dir: string, o: { idea?: object; render?: 'final' | 'rough' | null; items?: object[]; format?: string; from?: number } = {}): Promise<number> {
  const n = await newVideo(dir, { title: 'The lamp', about: 'a', mention: '', hide: '', footage: [], ...(o.format ? { format: o.format } : {}), ...(o.from ? { from: o.from } : {}), ...(o.idea ? { idea: o.idea } : {}) });
  await saveEpisode(dir, EpisodeSchema.parse({
    version: 2, number: n, title: 't', output: { width: 1920, height: 1080, fps: 30 },
    items: o.items ?? [
      { id: 'open', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 10 }, audio: 'keep' },
      { id: 'm1', beat: 'montage', clip: 'c001', src: { in: 10, out: 20 } },
      { id: 'end', beat: 'truth', clip: 'c001', src: { in: 20, out: 40 }, audio: 'keep' },
    ],
    overlays: [{ kind: 'badge', text: 'FAILED', start: 6, end: 9 }],
  }));
  if (o.render !== null) await writeFile(join(dir, 'episodes', String(n), `${o.render ?? 'final'}.mp4`), 'x');
  return n;
}

describe('predict', () => {
  it('scores the three steps out of 10 from the measured playbook, names the weakest and up to five moments, and writes the forecast', async () => {
    const dir = await project();
    const n = await video(dir, { idea: { question: 'Will the lamp ever light?', stake: '£40 of parts' } });
    const lines = await predictVideo(dir, n, { tools: tools(), ...NOW });
    expect(lines).toEqual([
      'Forecast for video 1 “The lamp” (build-story), from the final render: an approximate reading of the cut against the playbook — not a promise, and not a view count',
      // The idea (3) and the thumbnail (2) are missed, the opening (2) is met: 10 × 2 ÷ 7.
      'Chosen (will they choose to watch): 3/10',
      '  ✓ opens on the picture (item open)',
      '  ✗ the idea has no gap on record — the playbook asks for the gap and the question before cutting',
      '  – the title: not measured — no title is chosen yet (titles.chosen in episodes/1/video.json)',
      '  ✗ no thumbnail yet — the click is on the title and the thumbnail',
      'Stayed (will they keep watching): 0/10',
      '  ✗ longest stretch with nothing new 19.6 s, 0:20.4–0:40.0 (item end), and 1 more — the playbook allows 8 s',
      '  ✗ 5 words a minute — the playbook asks for 145–200; the longest stretch without words is 0:20.4–0:40.0 (item end)',
      '  ✗ the answer (truth, item end) starts 50% of the way through, at 0:20.0 — the playbook asks for 85–93%',
      // The answer is there (4), the cut ends on its truth instead of an outro (3): 10 × 4 ÷ 7.
      'Satisfied (will they be glad they watched): 6/10',
      '  ✓ has its answer: a truth beat (item end)',
      '  ✗ ends on truth (item end), not on outro or blooper',
      'Weakest step: Stayed',
      "Moments to fix, the weakest step's first:",
      '  1. 0:20.4–0:40.0 (item end): nothing new for 19.6 s: cut into it, or put a line, a cut or an overlay there',
      '  2. 0:10.0–0:20.0 (item m1): nothing new for 10.0 s: cut into it, or put a line, a cut or an overlay there',
      '  3. 0:20.0 (item end): the answer comes early: hold it back by moving what follows item end before it, or cut what follows',
      '  4. 0:20.4–0:40.0 (item end): no words for 19.6 s: write narration over it, or cut it shorter',
      '  5. 0:02.4–0:20.0 (item open): no words for 17.6 s: write narration over it, or cut it shorter',
      'No band: this forecast compares against the playbook only — no posted build-story video has results yet, and 4 are needed (4 more)',
      'wrote episodes/1/prediction.json',
      'Fix the weakest moments, run predict again, then post.',
    ]);
    // Never a view count, and nothing a tool would log as a warning.
    expect(lines.join('\n')).not.toMatch(/views|[⚠✖]/);
    const kept = PredictionSchema.parse(await json(join(dir, 'episodes', '1', 'prediction.json')));
    expect(kept).toMatchObject({
      version: 1, video: 1, at: '2026-11-09', format: 'build-story', cut: 'final', lengthSec: 40, weakest: 'stayed', band: null, postedVideos: 0, features: [],
      steps: [
        { step: 'chosen', score: 3, rules: [{ rule: 'opening', status: 'met', weight: 2 }, { rule: 'idea', status: 'missed', weight: 3 }, { rule: 'title', status: 'unmeasured', weight: 3 }, { rule: 'thumbnail', status: 'missed', weight: 2 }] },
        { step: 'stayed', score: 0, rules: [{ rule: 'empty', status: 'missed', weight: 3 }, { rule: 'words', status: 'missed', weight: 2 }, { rule: 'answerPlace', status: 'missed', weight: 3 }] },
        { step: 'satisfied', score: 6, rules: [{ rule: 'answer', status: 'met', weight: 4 }, { rule: 'ending', status: 'missed', weight: 3 }] },
      ],
    });
    expect(kept.moments).toHaveLength(5);
    expect(kept.moments[0]).toEqual({ step: 'stayed', rule: 'empty', where: '0:20.4–0:40.0 (item end)', change: 'nothing new for 19.6 s: cut into it, or put a line, a cut or an overlay there' });
    expect(await readPrediction(dir, 1)).toEqual(kept);
  });

  it('the weights are the documented ones, and every playbook rule has one', () => {
    expect(WEIGHTS).toEqual({
      chosen: { idea: 3, firstWord: 3, title: 3, opening: 2, thumbnail: 2 },
      stayed: { empty: 3, answerPlace: 3, pace: 2, words: 2 },
      satisfied: { answer: 4, ending: 3, length: 2 },
    });
  });

  it('leaves a rule it could not measure out of the score and names it; a cut with nothing missed has no weakest step', async () => {
    const dir = await project();
    // A short whose every shot speaks: 6 s in 1.5 s shots.
    const items = ['hook', 'tease', 'tease', 'payoff'].map((beat, i) => ({ id: `s${i}`, beat, clip: 'c001', src: { in: i === 3 ? 19.9 : 0.9 + i * 0.1, out: (i === 3 ? 19.9 : 0.9 + i * 0.1) + 1.5 }, audio: 'keep' }));
    const n = await video(dir, { format: 'short', items, idea: { gap: 'a dead lamp', question: 'Will it light?' } });
    const lines = await predictVideo(dir, n, { tools: tools(6), ...NOW });
    expect(lines.slice(1, 14)).toEqual([
      'Chosen (will they choose to watch): 10/10',
      '  ✓ opens on the picture (item s0)',
      '  ✓ first word at 0.1 s — the playbook asks for one within 0.5 s',
      '  ✓ the idea is on record: gap, question (no doubt, no stake)',
      '  – the title: not measured — no title is chosen yet (titles.chosen in episodes/1/video.json)',
      'Stayed (will they keep watching): 10/10',
      '  ✓ longest stretch with nothing new 1.0 s — the playbook allows 3 s',
      '  ✓ 30.0 cuts a minute — the playbook asks for 29 or more',
      '  ✓ the answer (payoff, item s3) starts 75% of the way through — the playbook asks for 50–90%',
      'Satisfied (will they be glad they watched): 10/10',
      '  ✓ has its answer: a payoff beat (item s3)',
      '  ✓ ends on the picture, with no outro (item s3)',
      'No step is weak against the playbook',
    ]);
    expect(lines.at(-1)).toBe('Nothing to fix against the playbook.');
    // A short is not scored on a thumbnail: it has no click to win.
    expect(lines.join('\n')).not.toContain('thumbnail');
    expect((await readPrediction(dir, n))!).toMatchObject({ weakest: null, moments: [] });

    // The same cut from a clip with no transcript: the word rules are named as not measured and left out of the scores.
    await saveCatalog(dir, { version: 1, clips: [{ id: 'c001', path: join(dir, 'a.mov'), sha256: 'a'.repeat(64), kind: 'talking', frames: [], notes: '', moments: [], probe: probeInfo(60), transcript: null }] });
    const deaf = await predictVideo(dir, n, { tools: tools(6), ...NOW });
    expect(deaf.slice(1, 10)).toEqual([
      'Chosen (will they choose to watch): 10/10',
      '  ✓ opens on the picture (item s0)',
      '  – first word: not measured — item s0 keeps the sound of c001, which has no transcript',
      '  ✓ the idea is on record: gap, question (no doubt, no stake)',
      '  – the title: not measured — no title is chosen yet (titles.chosen in episodes/1/video.json)',
      'Stayed (will they keep watching): 10/10',
      '  – longest stretch with nothing new: not measured — item s0 keeps the sound of c001, which has no transcript',
      '  ✓ 30.0 cuts a minute — the playbook asks for 29 or more',
      '  ✓ the answer (payoff, item s3) starts 75% of the way through — the playbook asks for 50–90%',
    ]);
    expect((await readPrediction(dir, n))!.steps[0]!.rules).toContainEqual({ rule: 'firstWord', status: 'unmeasured', weight: 3 });
  });

  it('says which cut it read: the final render, a rough cut, or a timeline nothing was rendered from', async () => {
    const dir = await project();
    const rough = await video(dir, { render: 'rough' });
    expect((await predictVideo(dir, rough, { tools: tools(), ...NOW }))[0]).toContain('from the rough cut (there is no final render yet): an approximate reading');
    expect((await readPrediction(dir, rough))!.cut).toBe('rough');
    const none = await video(dir, { render: null });
    // Nothing to probe: the tools are never asked.
    const never = { probe: async () => { throw new Error('probed'); } };
    expect((await predictVideo(dir, none, { tools: never, ...NOW }))[0]).toContain('from the timeline (nothing is rendered yet): an approximate reading');
    expect((await readPrediction(dir, none))!.cut).toBe('timeline');
  });

  it('warns when the render is not the length of the timeline any more: the forecast is of the timeline', async () => {
    const dir = await project();
    const n = await video(dir);
    const lines = await predictVideo(dir, n, { tools: tools(55), ...NOW });
    expect(lines).toContain('⚠ the timeline is 40.0 s long and final.mp4 is 55.0 s — the timeline changed after that render, so this forecast is of the timeline, not of the file: render again before posting');
    expect((await predictVideo(dir, n, { tools: tools(40.1), ...NOW })).join('\n')).not.toContain('⚠');
  });

  it('refuses a video that is not there', async () => {
    const dir = await project();
    await expect(predictVideo(dir, 7, { tools: tools(), ...NOW })).rejects.toMatchObject({ code: 'BAD_INPUT', message: 'there is no video 7', hint: 'Run status to see the videos.' });
  });

  it("reads the playbook numbers the person's own formula sets, and says so", async () => {
    const dir = await project();
    const n = await video(dir, { idea: { gap: 'a dead lamp', question: 'Will it light?' } });
    await mkdir(join(dir, 'formulas'), { recursive: true });
    await writeFile(join(dir, 'formulas', 'build-story-mine.md'), `---\n${JSON.stringify({ id: 'build-story-mine', name: 'Mine', describe: 'Mine.', formats: ['build-story'], source: 'my videos', playbook: { emptySec: 25, answer: { beat: 'truth', fromShare: 0.4, toShare: 0.6 } } })}\n---\nRules.\n`);
    const lines = await predictVideo(dir, n, { tools: tools(), ...NOW });
    expect(lines[0]).toContain("(build-story, with your build-story-mine formula's answer, emptySec), from the final render");
    expect(lines).toContain('  ✓ longest stretch with nothing new 19.6 s — the playbook allows 25 s');
    expect(lines).toContain('  ✓ the answer (truth, item end) starts 50% of the way through — the playbook asks for 40–60%');
  });
});

describe('the band against the project\'s own posted videos', () => {
  const ID = (n: number) => `aaaaaaaaaa${n}`;
  const features = (n: number): Features => ({
    version: 1, video: n, at: '2026-10-01', format: 'build-story', width: 1920, height: 1080, lengthSec: 600,
    firstWordSec: n, answerShare: 0.8, cutsPerMin: 10 + n, medianShotSec: 4, wordsPerMin: 150, longestSilenceSec: 5, musicShare: 0.5, overlays: n, captions: 'karaoke', thumbnail: { exists: false, text: null },
    items: [{ id: 'open', beat: 'cold-open', start: 0, end: 600 }],
  });
  /** `k` posted build stories with results: video n has n seconds before its first word, 10 + n cuts a minute and n overlays. */
  async function posted(dir: string, views: number[]) {
    for (const [i] of views.entries()) {
      const n = await newVideo(dir, { title: `Video ${i + 1}`, about: 'a', mention: '', hide: '', footage: [] });
      const file = join(dir, 'episodes', String(n), 'video.json');
      await writeFile(file, JSON.stringify({ ...(await json(file)), posted: { url: `https://www.youtube.com/watch?v=${ID(n)}`, id: ID(n), at: '2026-10-10' } }));
      await writeFile(join(dir, 'episodes', String(n), 'features.json'), JSON.stringify(features(n)));
    }
    const deps: LearnDeps = { ytDlp: async (args) => JSON.stringify({ title: 'T', upload_date: '20261030', view_count: views[Number(args.at(-1)!.split('v=')[1]!.slice(-1)) - 1], like_count: 1, comment_count: 1 }), now: at('2026-11-09') };
    await learnResults(dir, {}, deps);
  }

  it('with 4 posted videos of the format, says feature by feature which half the cut sits with, and gives the band', async () => {
    const dir = await project();
    // Best first: videos 1, 3 (better half: 2 s to the first word, 12 cuts a minute, 2 overlays), then 4, 2 (weaker: 3 s, 13, 3).
    await posted(dir, [5000, 1000, 4000, 2000]);
    const n = await video(dir);
    const lines = await predictVideo(dir, n, { tools: tools(), ...NOW });
    const from = lines.indexOf('Against your 4 posted build-story videos (the middle of the better half and of the weaker half, from learn):');
    expect(from).toBeGreaterThan(0);
    // Only the numbers the halves differ on are compared.
    expect(lines.slice(from + 1, from + 5)).toEqual([
      '  Seconds before the first word: 1.0 s — with the better half (better half 2.0 s · weaker half 3.0 s)',
      '  Cuts a minute: 3.0 — with the better half (better half 12.0 · weaker half 13.0)',
      '  Overlays: 1 — with the better half (better half 2 · weaker half 3)',
      'Band: above your usual for build-story (3 with the better half, 0 with the weaker, 0 between) — what goes with better results, not proof of cause',
    ]);
    expect(lines.join('\n')).not.toMatch(/No band|views/);
    expect(await readPrediction(dir, n)).toMatchObject({
      band: 'above', postedVideos: 4,
      features: [{ feature: 'firstWordSec', value: 1, better: 2, weaker: 3, sits: 'better' }, { feature: 'cutsPerMin', value: 3, better: 12, weaker: 13, sits: 'better' }, { feature: 'overlays', value: 1, better: 2, weaker: 3, sits: 'better' }],
    });
  });

  it('with fewer than 4 posted videos, gives no band and says how many more are needed', async () => {
    const dir = await project();
    await posted(dir, [5000, 1000, 4000]);
    const n = await video(dir);
    const lines = await predictVideo(dir, n, { tools: tools(), ...NOW });
    expect(lines).toContain('No band: this forecast compares against the playbook only — 3 posted build-story videos have results, and 4 are needed (1 more)');
    expect(await readPrediction(dir, n)).toMatchObject({ band: null, postedVideos: 3, features: [] });
    // Posted videos of another format are no history for this one.
    const short = await video(dir, { format: 'short' });
    expect(await predictVideo(dir, short, { tools: tools(), ...NOW })).toContain('No band: this forecast compares against the playbook only — no posted short video has results yet, and 4 are needed (4 more)');
    expect(existsSync(join(dir, 'episodes', String(short), 'prediction.json'))).toBe(true);
  });

  it('sitsWith puts a number with the half whose middle it is nearest, or between; bandOf needs a clear majority', () => {
    // Lower is better here (seconds before the first word: better 2, weaker 5).
    expect([1, 2, 3, 3.5, 4, 5, 9].map((v) => sitsWith(v, 2, 5))).toEqual(['better', 'better', 'better', 'between', 'weaker', 'weaker', 'weaker']);
    // Higher is better (cuts a minute: better 30, weaker 21).
    expect([35, 27, 25, 24, 10].map((v) => sitsWith(v, 30, 21))).toEqual(['better', 'better', 'between', 'weaker', 'weaker']);
    expect(bandOf([])).toBeNull();
    expect(bandOf(['better', 'better', 'between'])).toBe('above');
    expect(bandOf(['weaker', 'weaker', 'weaker', 'better'])).toBe('below');
    expect(bandOf(['better', 'weaker', 'between'])).toBe('around');
    // One more with the better half out of four is not a clear majority.
    expect(bandOf(['better', 'better', 'weaker', 'between'])).toBe('around');
  });
});
