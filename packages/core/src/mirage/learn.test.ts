// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type ProbeInfo } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { saveCatalog } from './ingest.js';
import { confidence, FeaturesSchema, learnResults, markPosted, READS, readAt, readDue, replayPeaks, resultsLine, titleFeatures, videoAddress, viewsAtAge, type Features, type LearnDeps } from './learn.js';
import { saveEpisode } from './render-episode.js';
import { newVideo, readVideo } from './video.js';

const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const at = (day: string) => () => new Date(`${day}T10:00:00Z`);
const word = (w: string, start: number) => ({ w, start, end: start + 0.4, conf: 1 });
const probeInfo = (durationSec: number): ProbeInfo => ({ durationSec, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', colorTransfer: null });
const tools = (finalSec = 40) => ({ probe: async () => probeInfo(finalSec) });

/** A project with one 60 s clip that says "hello there" at 1 s and 2 s and "done" at 20 s. */
async function project(transcript = true): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mirage-learn-'));
  await writeFile(join(dir, 'mirage.json'), JSON.stringify({ version: 1, title: 'My build', createdAt: '2026-10-01T00:00:00Z' }));
  await saveCatalog(dir, {
    version: 1,
    clips: [{
      id: 'c001', path: join(dir, 'a.mov'), sha256: 'a'.repeat(64), kind: 'talking', frames: [], notes: '', moments: [], probe: probeInfo(60),
      transcript: transcript ? { words: [word('hello', 1), word('there', 2), word('done', 20)], segments: [], speech: [] } : null,
    }],
  });
  return dir;
}

/** Video n: a 40 s cut of three shots (talk 0–10, a muted montage 10–20, talk 20–40) with music under 5–25 s and one overlay, rendered. */
async function video(dir: string, o: { format?: string; from?: number; beats?: [string, string, string]; idea?: object; final?: boolean } = {}): Promise<number> {
  const n = await newVideo(dir, { title: 'The lamp', about: 'a', mention: '', hide: '', footage: [], ...(o.format ? { format: o.format } : {}), ...(o.from ? { from: o.from } : {}), ...(o.idea ? { idea: o.idea } : {}) });
  const [b1, b2, b3] = o.beats ?? ['cold-open', 'montage', 'truth'];
  await saveEpisode(dir, EpisodeSchema.parse({
    version: 2, number: n, title: 't', output: { width: 1920, height: 1080, fps: 30 },
    items: [
      { id: 'open', beat: b1, clip: 'c001', src: { in: 0, out: 10 }, audio: 'keep' },
      { id: 'm1', beat: b2, clip: 'c001', src: { in: 10, out: 20 } },
      { id: 'end', beat: b3, clip: 'c001', src: { in: 20, out: 40 }, audio: 'keep' },
    ],
    overlays: [{ kind: 'badge', text: 'FAILED', start: 6, end: 9 }],
    music: [{ track: 'drive.mp3', start: 5, end: 20 }, { track: 'drive.mp3', start: 15, end: 25 }],
  }));
  if (o.final !== false) await writeFile(join(dir, 'episodes', String(n), 'final.mp4'), 'x');
  return n;
}

describe('videoAddress', () => {
  it('takes a watch, youtu.be or Shorts address and keeps the id, without what a share link adds', () => {
    for (const input of ['https://www.youtube.com/watch?v=abcDEF_-123', ' https://youtube.com/watch?v=abcDEF_-123&t=42s&list=PL1 ', 'https://m.youtube.com/watch?si=x&v=abcDEF_-123', 'https://youtu.be/abcDEF_-123?si=share']) {
      expect(videoAddress(input), input).toEqual({ id: 'abcDEF_-123', url: 'https://www.youtube.com/watch?v=abcDEF_-123' });
    }
    expect(videoAddress('https://www.youtube.com/shorts/abcDEF_-123?feature=share')).toEqual({ id: 'abcDEF_-123', url: 'https://www.youtube.com/shorts/abcDEF_-123' });
  });

  it('refuses anything that is not one YouTube video', () => {
    for (const input of ['abcDEF_-123', 'https://www.youtube.com/@demo', 'https://www.youtube.com/watch', 'https://www.youtube.com/watch?v=a b', 'http://youtu.be/abcDEF_-123', 'https://example.com/watch?v=abcDEF_-123', 'https://youtu.be/', 'https://www.youtube.com/shorts/abcDEF_-123/extra', '--exec']) {
      expect(() => videoAddress(input), input).toThrow(expect.objectContaining({
        code: 'BAD_INPUT', message: `"${input}" isn't a YouTube video address`,
        hint: "Give the video's own address, e.g. https://www.youtube.com/watch?v=…, https://youtu.be/… or https://www.youtube.com/shorts/….",
      }));
    }
  });
});

describe('posted', () => {
  it('records the address in video.json and writes the snapshot of the cut', async () => {
    const dir = await project();
    const n = await video(dir, { idea: { question: 'Will the lamp ever light?', stake: '£40 of parts' } });
    const lines = await markPosted(dir, n, 'https://youtu.be/abcDEF_-123?si=x', { tools: tools(), now: at('2026-11-09') });
    expect(lines).toEqual([
      'video 1 “The lamp” is posted at https://www.youtube.com/watch?v=abcDEF_-123',
      'wrote episodes/1/features.json: build-story · 1920×1080 · 0:40 · first word at 1.0 s · answer at 50% · 3.0 cuts a minute · typical shot 10.0 s · 5 words a minute · longest stretch without words 19.6 s · music under 50% · 1 overlay · captions phrase · no thumbnail',
      'Run learn to read its numbers.',
    ]);
    expect((await readVideo(dir, n))!.posted).toEqual({ url: 'https://www.youtube.com/watch?v=abcDEF_-123', id: 'abcDEF_-123', at: '2026-11-09' });
    const features = FeaturesSchema.parse(await json(join(dir, 'episodes', '1', 'features.json')));
    expect(features).toEqual({
      version: 1, video: 1, at: '2026-11-09', format: 'build-story', width: 1920, height: 1080, lengthSec: 40,
      firstWordSec: 1, answerShare: 0.5, cutsPerMin: 3, medianShotSec: 10, wordsPerMin: 4.5, longestSilenceSec: 19.6, musicShare: 0.5, overlays: 1, captions: 'phrase',
      idea: { question: 'Will the lamp ever light?', stake: '£40 of parts' }, thumbnail: { exists: false, text: null },
      items: [{ id: 'open', beat: 'cold-open', start: 0, end: 10 }, { id: 'm1', beat: 'montage', start: 10, end: 20 }, { id: 'end', beat: 'truth', start: 20, end: 40 }],
    });
  });

  it('records the video\'s experiment, and what Mirage knows of its thumbnail', async () => {
    const dir = await project();
    const n = await video(dir);
    const file = join(dir, 'episodes', '1', 'video.json');
    const experiment = { rule: 'Open on the first word', change: 'opens on the result', expect: 'a higher percentage viewed' };
    await writeFile(file, JSON.stringify({ ...(await json(file)), experiment }));
    const known = async () => {
      const lines = await markPosted(dir, n, 'https://youtu.be/abcDEF_-123', { tools: tools() });
      return [lines[1]!.split(' · ').slice(-2).join(' · '), (await json(join(dir, 'episodes', '1', 'features.json'))).thumbnail];
    };
    expect(await known()).toEqual(['no thumbnail · experiment on “Open on the first word”', { exists: false, text: null }]);
    expect((await json(join(dir, 'episodes', '1', 'features.json'))).experiment).toEqual(experiment);
    // A thumbnail put there by hand: Mirage doesn't know whether it has text.
    await writeFile(join(dir, 'episodes', '1', 'thumbnail.jpg'), 'x');
    expect(await known()).toEqual(['a thumbnail · experiment on “Open on the first word”', { exists: true, text: null }]);
    await writeFile(join(dir, 'episodes', '1', 'thumbnail.json'), JSON.stringify({ at: 12, text: 'IT WORKS' }));
    expect(await known()).toEqual(['a thumbnail with text · experiment on “Open on the first word”', { exists: true, text: true }]);
    await writeFile(join(dir, 'episodes', '1', 'thumbnail.json'), JSON.stringify({ at: 12, text: null }));
    expect(await known()).toEqual(['a thumbnail without text · experiment on “Open on the first word”', { exists: true, text: false }]);
  });

  it('called again, replaces the address and takes the snapshot again', async () => {
    const dir = await project();
    const n = await video(dir);
    await markPosted(dir, n, 'https://youtu.be/abcDEF_-123', { tools: tools(), now: at('2026-11-09') });
    const lines = await markPosted(dir, n, 'https://www.youtube.com/watch?v=zzzzzzzzzz9', { tools: tools(), now: at('2026-11-12') });
    expect(lines[0]).toBe('video 1 “The lamp” is posted at https://www.youtube.com/watch?v=zzzzzzzzzz9 (it was https://www.youtube.com/watch?v=abcDEF_-123)');
    expect((await readVideo(dir, n))!.posted).toEqual({ url: 'https://www.youtube.com/watch?v=zzzzzzzzzz9', id: 'zzzzzzzzzz9', at: '2026-11-12' });
    expect((await json(join(dir, 'episodes', '1', 'features.json'))).at).toBe('2026-11-12');
  });

  it('refuses a video without a final render, a video that is not there, and a bad address, writing nothing', async () => {
    const dir = await project();
    const n = await video(dir, { final: false });
    await expect(markPosted(dir, n, 'https://youtu.be/abcDEF_-123', { tools: tools() })).rejects.toMatchObject({ message: 'video 1 has no final render yet', hint: 'Run render first: a video is posted from its final.mp4.' });
    await expect(markPosted(dir, 7, 'https://youtu.be/abcDEF_-123', { tools: tools() })).rejects.toMatchObject({ message: 'there is no video 7', hint: 'Run status to see the videos.' });
    await mkdir(join(dir, 'episodes', '8'));
    await expect(markPosted(dir, 8, 'https://youtu.be/abcDEF_-123', { tools: tools() })).rejects.toMatchObject({ message: 'video 8 has no video.json to record it in' });
    await expect(markPosted(dir, n, 'https://www.youtube.com/@demo', { tools: tools() })).rejects.toMatchObject({ message: '"https://www.youtube.com/@demo" isn\'t a YouTube video address' });
    expect((await readVideo(dir, n))!.posted).toBeUndefined();
    expect(existsSync(join(dir, 'episodes', '1', 'features.json'))).toBe(false);
  });

  it('warns when the final render is not the length of the timeline any more', async () => {
    const dir = await project();
    const n = await video(dir);
    const lines = await markPosted(dir, n, 'https://youtu.be/abcDEF_-123', { tools: tools(52.5), now: at('2026-11-09') });
    expect(lines.at(-2)).toBe('⚠ the timeline is 40.0 s long and final.mp4 is 52.5 s — the timeline changed after the final render, so features.json may not describe the video that was posted');
    expect((await readVideo(dir, n))!.posted?.id).toBe('abcDEF_-123');
  });

  it('a short says its kind and whether it ends on a pointer; only a standalone short has an answer beat', async () => {
    const dir = await project();
    const big = await video(dir);
    const teaser = await video(dir, { format: 'short', from: big, beats: ['hook', 'tease', 'pointer'] });
    const alone = await video(dir, { format: 'short', beats: ['hook', 'payoff', 'loop'] });
    const lines = await markPosted(dir, teaser, 'https://www.youtube.com/shorts/aaaaaaaaaa1', { tools: tools(), now: at('2026-11-09') });
    expect(lines[0]).toBe('video 2 “The lamp” is posted at https://www.youtube.com/shorts/aaaaaaaaaa1');
    expect(lines[1]).toMatch(/^wrote episodes\/2\/features\.json: short · 1920×1080 · 0:40 · first word at 1\.0 s · 3\.0 cuts a minute · .* · captions phrase · teaser, ends on a pointer · no thumbnail$/);
    expect(await json(join(dir, 'episodes', '2', 'features.json'))).toMatchObject({ format: 'short', answerShare: null, short: { kind: 'teaser', endsOnPointer: true } });
    expect((await markPosted(dir, alone, 'https://www.youtube.com/shorts/aaaaaaaaaa2', { tools: tools() }))[1]).toMatch(/ · answer at 25% · .* · standalone, no pointer at the end · no thumbnail$/);
    expect(await json(join(dir, 'episodes', '3', 'features.json'))).toMatchObject({ answerShare: 0.25, short: { kind: 'standalone', endsOnPointer: false } });
    expect(existsSync(join(dir, 'episodes', '1', 'features.json'))).toBe(false);
  });

  it('leaves the word numbers out when a kept clip has no transcript, and a vlog\'s answer is its headline', async () => {
    const dir = await project(false);
    const n = await video(dir, { format: 'vlog', beats: ['cold-open', 'bit', 'headline'] });
    const lines = await markPosted(dir, n, 'https://youtu.be/abcDEF_-123', { tools: tools() });
    expect(lines[1]).toContain(' · words not known (a kept clip has no transcript) · answer at 50% · 3.0 cuts a minute · typical shot 10.0 s · music under 50% · ');
    expect(await json(join(dir, 'episodes', '1', 'features.json'))).toMatchObject({ format: 'vlog', firstWordSec: null, wordsPerMin: null, longestSilenceSec: null, answerShare: 0.5 });
  });
});

// ---- learn ----

const ID = (n: number) => `aaaaaaaaaa${n}`;
const features = (n: number, over: Partial<Features> = {}): Features => ({
  version: 1, video: n, at: '2026-10-01', format: 'build-story', width: 1920, height: 1080, lengthSec: 600,
  firstWordSec: n, answerShare: 0.8, cutsPerMin: 10 + n, medianShotSec: 4, wordsPerMin: 150, longestSilenceSec: 5, musicShare: 0.5, overlays: n, captions: 'karaoke', thumbnail: { exists: false, text: null },
  items: [{ id: 'open', beat: 'cold-open', start: 0, end: 60 }, { id: 'm1', beat: 'montage', start: 60, end: 480 }, { id: 'end', beat: 'truth', start: 480, end: 600 }],
  ...over,
});

/** Video n of a new project, posted on `day` at the address of ID(n), with its features snapshot. */
async function postedVideo(dir: string, day: string, over: Partial<Features> | null = {}): Promise<number> {
  const n = await newVideo(dir, { title: `Video ${String.fromCharCode(64 + (await count(dir)) + 1)}`, about: 'a', mention: '', hide: '', footage: [] });
  const file = join(dir, 'episodes', String(n), 'video.json');
  await writeFile(file, JSON.stringify({ ...(await json(file)), posted: { url: `https://www.youtube.com/watch?v=${ID(n)}`, id: ID(n), at: day } }));
  if (over) await writeFile(join(dir, 'episodes', String(n), 'features.json'), JSON.stringify(features(n, over)));
  return n;
}
const count = async (dir: string) => (existsSync(join(dir, 'episodes')) ? (await import('node:fs/promises')).readdir(join(dir, 'episodes')).then((f) => f.length) : 0);

type Info = { title?: string; upload_date?: string; duration?: number; view_count?: number; like_count?: number | null; comment_count?: number | null; heatmap?: { start_time: number; end_time: number; value: number }[] | null };
/** A yt-dlp that answers with `info[id]` for each video's address (an Error there is thrown), and remembers what it was asked. */
function ytDlp(info: Record<string, Info | Error>, day: string) {
  const calls: string[][] = [];
  const deps: LearnDeps = {
    ytDlp: async (args) => {
      calls.push(args);
      const answer = info[args.at(-1)!.split('v=')[1]!];
      if (answer instanceof Error) throw answer;
      return JSON.stringify({ formats: [{ url: 'ignored' }], ...answer });
    },
    now: at(day),
  };
  return { deps, calls };
}

describe('learn', () => {
  it('refuses a project with no posted video, and Studio numbers for a video that is not posted or with no number', async () => {
    const dir = await project();
    await video(dir);
    const { deps, calls } = ytDlp({}, '2026-11-09');
    const hint = 'When a video is live, call posted with its number and its YouTube address, then learn.';
    await expect(learnResults(dir, {}, deps)).rejects.toMatchObject({ code: 'BAD_INPUT', message: 'no video is posted yet', hint });
    await expect(learnResults(dir, { studio: { video: 1, clickRate: 4 } }, deps)).rejects.toMatchObject({ message: "video 1 isn't posted yet, so it has no Studio numbers to keep", hint });
    await expect(learnResults(dir, { studio: { video: 1 } }, deps)).rejects.toMatchObject({ message: 'studio needs at least one number' });
    expect(calls).toEqual([]);
    expect(existsSync(join(dir, 'results'))).toBe(false);
  });

  it('reads each posted video\'s info with yt-dlp (never the video), keeps a snapshot per day and reports the numbers', async () => {
    const dir = await project();
    await postedVideo(dir, '2026-10-10');
    await postedVideo(dir, '2026-10-30');
    const first = ytDlp({
      [ID(1)]: { title: 'I BUILT A LAMP', upload_date: '20261010', duration: 600, view_count: 12_000, like_count: 480, comment_count: 36, heatmap: [{ start_time: 0, end_time: 6, value: 1 }, { start_time: 6, end_time: 12, value: 0.9 }, { start_time: 240, end_time: 246, value: 0.7 }, { start_time: 540, end_time: 546, value: 0.8 }, { start_time: 300, end_time: 306, value: 0.2 }] },
      [ID(2)]: { title: 'THE LAMP FAILED', upload_date: '20261030', duration: 600, view_count: 3000, like_count: null },
    }, '2026-11-09');
    const lines = await learnResults(dir, {}, first.deps);
    expect(first.calls).toEqual([1, 2].map((n) => ['--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings', `https://www.youtube.com/watch?v=${ID(n)}`]));
    expect(lines).toEqual([
      'Format build-story: 2 posted videos, read 2026-11-09',
      '  Video 1 “I BUILT A LAMP”: 30 days old, late read · 12K views · 400 a day · 40.0 likes per 1,000 views · 3.0 comments per 1,000 views',
      '  Video 2 “THE LAMP FAILED”: 10 days old, main read · 3.0K views · 300 a day · no like count · no comment count',
      '  Most replayed, video 1: 0:03 (1%) item open, cold-open · 9:03 (91%) item end, truth · 4:03 (41%) item m1, montage',
      '  Most replayed: YouTube shows none for video 2',
      "  Ranked by views a day, because the reads so far don't let the videos be compared at the same age: this favours newer videos, which get most of their views in their first days",
      '  Best first: video 1 (400) · video 2 (300)',
      '  too few to compare: 2 videos — 2 more needed',
      '  Confidence, build-story: 2 posted videos — a weak signal',
      'The better and weaker halves show what goes with more views, never what causes them. The same evidence is in results/evidence.json.',
    ]);
    expect(await json(join(dir, 'results', '1.json'))).toMatchObject({
      version: 1, video: 1, id: ID(1), url: `https://www.youtube.com/watch?v=${ID(1)}`, title: 'I BUILT A LAMP', uploadDate: '2026-10-10', durationSec: 600,
      snapshots: [{ at: '2026-11-09', views: 12_000, likes: 480, comments: 36 }], heatmap: [{ start: 0, end: 6, value: 1 }, {}, {}, {}, {}], studio: [],
    });
    expect((await json(join(dir, 'results', '2.json'))).heatmap).toBeNull();

    // The same day again: the latest read wins. A later day: the history is kept.
    await learnResults(dir, {}, ytDlp({ [ID(1)]: { view_count: 12_500, like_count: 500, comment_count: 40 }, [ID(2)]: { view_count: 3100 } }, '2026-11-09').deps);
    await learnResults(dir, {}, ytDlp({ [ID(1)]: { title: 'I BUILT A LAMP (FINALLY)', view_count: 14_000, like_count: 520, comment_count: 41 }, [ID(2)]: { view_count: 9000 } }, '2026-11-19').deps);
    expect(await json(join(dir, 'results', '1.json'))).toMatchObject({
      title: 'I BUILT A LAMP (FINALLY)', uploadDate: '2026-10-10', heatmap: null,
      snapshots: [{ at: '2026-11-09', views: 12_500, likes: 500, comments: 40 }, { at: '2026-11-19', views: 14_000, likes: 520, comments: 41 }],
    });
  });

  it('compares videos at the same age once the reads allow it, and says which age', async () => {
    const dir = await project();
    await postedVideo(dir, '2026-10-10');
    await postedVideo(dir, '2026-10-30');
    const info = (a: number, b: number) => ({ [ID(1)]: { upload_date: '20261010', view_count: a }, [ID(2)]: { upload_date: '20261030', view_count: b } });
    await learnResults(dir, {}, ytDlp(info(1000, 100), '2026-10-12').deps); // video 1 at 2 days old
    const lines = await learnResults(dir, {}, ytDlp(info(9000, 6000), '2026-11-09').deps); // video 1 at 30 days, video 2 at 10
    // Video 1 at 10 days: 1,000 + (9,000 − 1,000) × 8 / 28.
    expect(lines).toContain("  Ranked by views at 10 days old, the newest video's age (worked out between two reads where there was none on that day): no age is favoured, but only each video's first 10 days count");
    expect(lines).toContain('  Best first: video 2 (6.0K) · video 1 (3.3K)');
    const evidence = await json(join(dir, 'results', 'evidence.json'));
    expect(evidence.formats[0]).toMatchObject({ rankedBy: 'views-at-the-same-age', rankedAtAgeDays: 10, ranking: [{ video: 2, value: 6000 }, { video: 1, value: 3285.7 }], halves: null, confidence: 'weak' });
  });

  it('with 4 or more videos of a format, sets the better half against the weaker half on each feature, per format', async () => {
    const dir = await project();
    for (const k of [1, 2, 3, 4, 5]) await postedVideo(dir, '2026-10-10', k === 5 ? null : {});
    await postedVideo(dir, '2026-10-10', { format: 'short', firstWordSec: null, answerShare: null, short: { kind: 'teaser', endsOnPointer: true } });
    const views = [5000, 1000, 4000, 2000, 3000, 700];
    const titles = ['I BUILT A LAMP IN 7 DAYS', 'Lamp update', 'WILL MY LAMP WORK? (FINALLY)', 'A quiet week!!', 'Video E', 'Video F'];
    const { deps } = ytDlp(Object.fromEntries(views.map((v, i) => [ID(i + 1), { title: titles[i], upload_date: '20261030', view_count: v, like_count: 10, comment_count: 1 }])), '2026-11-09');
    const lines = await learnResults(dir, {}, deps);
    // Every video was read at 10 days old, so they are compared at that age.
    const from = lines.indexOf('  Best first: video 1 (5.0K) · video 3 (4.0K) · video 5 (3.0K) · video 4 (2.0K) · video 2 (1.0K)');
    expect(from).toBeGreaterThan(0);
    expect(lines[from - 1]).toMatch(/^  Ranked by views at 10 days old, /);
    // Video 5 has no features.json, and is the middle video of five: it is in neither half.
    expect(lines.slice(from + 1, from + 18)).toEqual([
      '  Better half (videos 1, 3) against weaker half (videos 4, 2), the middle value of each:',
      '    Length: better half 10:00 · weaker half 10:00',
      '    Seconds before the first word: better half 2.0 s · weaker half 3.0 s',
      '    Where the answer starts: better half 80% · weaker half 80%',
      '    Cuts a minute: better half 12.0 · weaker half 13.0',
      '    Typical shot: better half 4.0 s · weaker half 4.0 s',
      '    Words a minute: better half 150 · weaker half 150',
      '    Longest stretch without words: better half 5.0 s · weaker half 5.0 s',
      '    Share of the length under music: better half 50% · weaker half 50%',
      '    Overlays: better half 2 · weaker half 3',
      '    Title words: better half 6 · weaker half 2.5',
      '    Title in ALL CAPS: better half 2 of 2 · weaker half 0 of 2',
      '    Title has a number: better half 1 of 2 · weaker half 0 of 2',
      '    Title in the first person: better half 2 of 2 · weaker half 0 of 2',
      '    Title ends with ? or !!: better half 1 of 2 · weaker half 1 of 2',
      '    Title ends with a bracket tag: better half 1 of 2 · weaker half 0 of 2',
      '  Confidence, build-story: 5 posted videos — a fair signal',
    ]);
    expect(lines.slice(from + 18)).toEqual([
      'Format short: 1 posted video, read 2026-11-09',
      '  Video 6 “Video F”: 10 days old, main read · 700 views · 70 a day · 14.3 likes per 1,000 views · 1.4 comments per 1,000 views',
      '  Most replayed: YouTube shows none for video 6',
      '  too few to compare: 1 video — 3 more needed',
      '  Confidence, short: 1 posted video — a weak signal',
      'The better and weaker halves show what goes with more views, never what causes them. The same evidence is in results/evidence.json.',
    ]);
    const evidence = await json(join(dir, 'results', 'evidence.json'));
    expect(evidence).toMatchObject({ version: 1, at: '2026-11-09', leftOut: [] });
    expect(evidence.formats.map((f: { format: string }) => f.format)).toEqual(['build-story', 'short']);
    expect(evidence.formats[0].halves).toMatchObject({ better: [1, 3], weaker: [4, 2] });
    expect(evidence.formats[0].halves.features).toContainEqual({ feature: 'firstWordSec', better: 2, weaker: 3 });
    expect(evidence.formats[0].halves.titles).toEqual([
      { feature: 'words', better: 6, weaker: 2.5 }, { feature: 'allCaps', better: 2, weaker: 0 }, { feature: 'hasNumber', better: 1, weaker: 0 },
      { feature: 'firstPerson', better: 2, weaker: 0 }, { feature: 'endsEmphatic', better: 1, weaker: 1 }, { feature: 'bracketTag', better: 1, weaker: 0 },
    ]);
    expect(evidence.formats[0].videos[2]).toMatchObject({ read: 'main', titleFeatures: { words: 5, allCaps: true, hasNumber: false, firstPerson: true, endsEmphatic: true, bracketTag: true } });
    expect(evidence.formats[0].videos[4]).toMatchObject({ video: 5, features: null, views: 3000, viewsPerDay: 300, likesPer1000: 3.3 });
    expect(evidence.formats[0].videos[0].features).toEqual(features(1));
  });

  it("holds each video's forecast against where it landed in its format's ranking, and counts how often the band was right", async () => {
    const dir = await project();
    for (const k of [1, 2, 3, 4]) await postedVideo(dir, '2026-10-10');
    await postedVideo(dir, '2026-10-10', { format: 'short', firstWordSec: null, answerShare: null, short: { kind: 'teaser', endsOnPointer: false } });
    const forecast = (n: number, band: 'below' | 'around' | 'above' | null, format = 'build-story') => writeFile(join(dir, 'episodes', String(n), 'prediction.json'), JSON.stringify({
      version: 1, video: n, at: '2026-10-09', format, cut: 'final', lengthSec: 600, weakest: 'stayed', band, postedVideos: band ? 4 : 0, features: [], moments: [],
      steps: [{ step: 'chosen', score: 8, rules: [] }, { step: 'stayed', score: 6, rules: [] }, { step: 'satisfied', score: null, rules: [] }],
    }));
    // Video 1 lands first and was forecast above; video 2 lands last and was forecast above; video 3 had no band; video 4 no forecast at all.
    await forecast(1, 'above');
    await forecast(2, 'above');
    await forecast(3, null);
    await forecast(5, 'above', 'short');
    const views = [5000, 1000, 4000, 2000, 700];
    const { deps } = ytDlp(Object.fromEntries(views.map((v, i) => [ID(i + 1), { upload_date: '20261030', view_count: v, like_count: 10, comment_count: 1 }])), '2026-11-09');
    const lines = await learnResults(dir, {}, deps);
    const scores = 'chosen 8/10 · stayed 6/10 · satisfied not scored; weakest: stayed';
    expect(lines.filter((l) => l.includes('Forecast'))).toEqual([
      `  Forecast against result, video 1: predicted above your usual for build-story (${scores}) · it landed 1 of 4 in the ranking, in the better half — the band was right`,
      `  Forecast against result, video 2: predicted above your usual for build-story (${scores}) · it landed 4 of 4 in the ranking, in the weaker half — the band was wrong (it landed below)`,
      `  Forecast against result, video 3: predicted against the playbook only (${scores}) · it landed 2 of 4 in the ranking, in the better half`,
      `  Forecast against result, video 5: predicted above your usual for short (${scores}) · it is the format's only posted video, so there is no ranking to hold it against yet`,
      'Forecasts so far: the band was right for 1 of 2 posted videos',
    ]);
    // The forecast lines come before the format's confidence, and the count after every format.
    expect(lines.findIndex((l) => l.startsWith('  Forecast against result, video 3'))).toBe(lines.indexOf('  Confidence, build-story: 4 posted videos — a weak signal') - 1);
    expect(lines.at(-2)).toBe('Forecasts so far: the band was right for 1 of 2 posted videos');
    const evidence = await json(join(dir, 'results', 'evidence.json'));
    expect(evidence.formats[0].forecasts).toEqual([
      { video: 1, band: 'above', weakest: 'stayed', scores: [{ step: 'chosen', score: 8 }, { step: 'stayed', score: 6 }, { step: 'satisfied', score: null }], rank: 1, of: 4, landed: 'above', right: true },
      expect.objectContaining({ video: 2, rank: 4, landed: 'below', right: false }),
      expect.objectContaining({ video: 3, band: null, rank: 2, landed: 'above', right: null }),
    ]);
    expect(evidence.formats[1].forecasts).toEqual([expect.objectContaining({ video: 5, band: 'above', rank: 1, of: 1, landed: null, right: null })]);
  });

  it('says no forecast can be judged yet when none gave a band or the format has too few videos, marks an early one, and has no forecast line without a forecast', async () => {
    const dir = await project();
    for (const k of [1, 2]) await postedVideo(dir, '2026-11-05');
    const { deps } = ytDlp({ [ID(1)]: { upload_date: '20261105', view_count: 900 }, [ID(2)]: { upload_date: '20261105', view_count: 500 } }, '2026-11-09');
    expect((await learnResults(dir, {}, deps)).join('\n')).not.toContain('Forecast');
    expect((await json(join(dir, 'results', 'evidence.json'))).formats[0].forecasts).toEqual([]);
    await writeFile(join(dir, 'episodes', '2', 'prediction.json'), JSON.stringify({
      version: 1, video: 2, at: '2026-11-04', format: 'build-story', cut: 'final', lengthSec: 600, weakest: null, band: 'below', postedVideos: 4, features: [], moments: [],
      steps: [{ step: 'chosen', score: 10, rules: [] }, { step: 'stayed', score: 10, rules: [] }, { step: 'satisfied', score: 10, rules: [] }],
    }));
    expect((await learnResults(dir, {}, deps)).filter((l) => l.includes('Forecast'))).toEqual([
      '  Forecast against result, video 2: predicted below your usual for build-story (chosen 10/10 · stayed 10/10 · satisfied 10/10) · it landed 2 of 2 in the ranking — too few videos to say whether the band was right (early: before its main read)',
      'Forecasts so far: none can be judged yet — a forecast is judged once it gave a band and its format has 4 posted videos',
    ]);
    // A forecast file that was edited and broke stops learn, naming the key.
    await writeFile(join(dir, 'episodes', '2', 'prediction.json'), JSON.stringify({ version: 1, video: 2 }));
    await expect(learnResults(dir, {}, deps)).rejects.toMatchObject({ message: expect.stringMatching(/^episodes\/2\/prediction\.json: /) });
  });

  it('says how far the sample can be trusted: under 5 weak, 5–9 fair, 10 or more strong', () => {
    expect([1, 4, 5, 9, 10, 40].map(confidence)).toEqual(['weak', 'weak', 'fair', 'fair', 'strong', 'strong']);
  });

  it('a format with 10 posted videos is a strong signal', async () => {
    const dir = await project();
    for (let k = 1; k <= 10; k++) await postedVideo(dir, '2026-10-10');
    const { deps } = ytDlp(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`aaaaaaaaaa${i + 1}`, { upload_date: '20261030', view_count: 100 * (i + 1) }])), '2026-11-09');
    expect(await learnResults(dir, {}, deps)).toContain('  Confidence, build-story: 10 posted videos — a strong signal');
  });

  it('keeps the Studio numbers given for a video, adds later ones to them, and reports the newest of each', async () => {
    const dir = await project();
    await postedVideo(dir, '2026-10-10');
    const info = { [ID(1)]: { upload_date: '20261010', view_count: 12_000, like_count: 480, comment_count: 36 } };
    await learnResults(dir, { studio: { video: 1, clickRate: 4.25, percentViewed: 38 } }, ytDlp(info, '2026-11-09').deps);
    await learnResults(dir, { studio: { video: 1, avgViewSec: 190 } }, ytDlp(info, '2026-11-09').deps);
    const lines = await learnResults(dir, { studio: { video: 1, clickRate: 5, viewedVsSwiped: 71 } }, ytDlp(info, '2026-11-12').deps);
    expect(lines[1]).toBe('  Video 1 “Video A”: 33 days old, late read · 12K views · 364 a day · 40.0 likes per 1,000 views · 3.0 comments per 1,000 views · Studio (2026-11-12): click rate 5% · 38% viewed · average view 3:10 · 71% viewed vs swiped');
    expect((await json(join(dir, 'results', '1.json'))).studio).toEqual([{ at: '2026-11-09', clickRate: 4.25, percentViewed: 38, avgViewSec: 190 }, { at: '2026-11-12', clickRate: 5, viewedVsSwiped: 71 }]);
    expect((await json(join(dir, 'results', 'evidence.json'))).formats[0].videos[0].studio).toEqual({ at: '2026-11-12', clickRate: 5, percentViewed: 38, avgViewSec: 190, viewedVsSwiped: 71 });
  });

  it('ties where viewers left or rewatched (from the person\'s Studio graph) to the item of the cut playing there', async () => {
    const dir = await project();
    await postedVideo(dir, '2026-10-10');
    const info = { [ID(1)]: { upload_date: '20261010', duration: 600, view_count: 500 } };
    const lines = await learnResults(dir, { studio: { video: 1, drops: [{ at: 20, note: 'the long intro' }, { at: 300 }], spikes: [{ at: 500 }] } }, ytDlp(info, '2026-11-09').deps);
    expect(lines).toContain('  Viewers left (Studio), video 1: 0:20 during item open (beat cold-open) — “the long intro” · 5:00 during item m1 (beat montage)');
    expect(lines).toContain('  Viewers rewatched (Studio), video 1: 8:20 during item end (beat truth)');
    expect((await json(join(dir, 'results', 'evidence.json'))).formats[0].videos[0]).toMatchObject({
      left: [{ sec: 20, item: 'open', beat: 'cold-open', note: 'the long intro' }, { sec: 300, item: 'm1', beat: 'montage', note: null }],
      rewatched: [{ sec: 500, item: 'end', beat: 'truth' }],
    });
    // A later call with other numbers keeps them; new drops replace the old.
    await learnResults(dir, { studio: { video: 1, clickRate: 4 } }, ytDlp(info, '2026-11-10').deps);
    await learnResults(dir, { studio: { video: 1, drops: [{ at: 45 }] } }, ytDlp(info, '2026-11-11').deps);
    expect((await json(join(dir, 'results', 'evidence.json'))).formats[0].videos[0]).toMatchObject({ studio: { clickRate: 4, spikes: [{ at: 500 }] }, left: [{ sec: 45, item: 'open', note: null }] });
  });

  it('says which read each video is at, and marks what is seen before the main read as early', async () => {
    const dir = await project();
    for (const day of ['2026-10-01', '2026-11-01', '2026-11-05', '2026-11-08']) await postedVideo(dir, day);
    const { deps } = ytDlp(Object.fromEntries([1, 2, 3, 4].map((n) => [ID(n), { view_count: 100 * n }])), '2026-11-09');
    const lines = await learnResults(dir, {}, deps);
    expect(lines.slice(1, 5).map((l) => l.split(' · ')[0])).toEqual([
      '  Video 1 “Video A”: 39 days old, late read', '  Video 2 “Video B”: 8 days old, main read', '  Video 3 “Video C”: 4 days old, early read', '  Video 4 “Video D”: 1 day old, before the early read',
    ]);
    expect(lines).toContain('  Early: videos 3, 4 are before the main read (7 days) — what they show so far is early and may still change');
    expect((await json(join(dir, 'results', 'evidence.json'))).formats[0].videos.map((v: { read: string | null }) => v.read)).toEqual(['late', 'main', 'early', null]);
  });

  it('reports a video\'s experiment against the format\'s other videos, on the number it named or else on the ranking\'s', async () => {
    const dir = await project();
    await postedVideo(dir, '2026-10-10');
    await postedVideo(dir, '2026-10-10');
    await postedVideo(dir, '2026-10-10', { experiment: { rule: 'Open on the first word', change: 'opens on the result, no greeting', expect: 'a higher percentage viewed' } });
    await postedVideo(dir, '2026-11-07', { experiment: { rule: 'Title', change: 'a question as the title', expect: 'more views' } });
    const info = Object.fromEntries([1, 2, 3, 4].map((n) => [ID(n), { upload_date: n === 4 ? '20261107' : '20261010', view_count: 1000 * n, like_count: 10, comment_count: 1 }]));
    await learnResults(dir, { studio: { video: 1, percentViewed: 30 } }, ytDlp(info, '2026-11-09').deps);
    await learnResults(dir, { studio: { video: 2, percentViewed: 40 } }, ytDlp(info, '2026-11-09').deps);
    const lines = await learnResults(dir, { studio: { video: 3, percentViewed: 52.5 } }, ytDlp(info, '2026-11-09').deps);
    const from = lines.indexOf('  Experiments:');
    expect(lines.slice(from + 1, from + 3)).toEqual([
      '    Video 3 changed “Open on the first word”: opens on the result, no greeting. Expected: a higher percentage viewed. So far on the percentage viewed it has 52.5% against a middle of 35% for the other 2 videos: higher',
      // Video 4 named views, and has no Studio number: it is held against the others on the ranking measure.
      '    Video 4 changed “Title”: a question as the title. Expected: more views. So far on views a day it has 2.0K against a middle of 67 for the other 3 videos: higher (early: before its main read)',
    ]);
    const evidence = await json(join(dir, 'results', 'evidence.json'));
    expect(evidence.formats[0].experiments).toEqual([
      { video: 3, rule: 'Open on the first word', change: 'opens on the result, no greeting', expect: 'a higher percentage viewed', measure: 'the percentage viewed', value: 52.5, others: 35, otherVideos: 2 },
      { video: 4, rule: 'Title', change: 'a question as the title', expect: 'more views', measure: 'views a day', value: 2000, others: 66.7, otherVideos: 3 },
    ]);
    expect(lines.filter((l) => l.startsWith('  Experiments:'))).toHaveLength(1);
  });

  it('a video yt-dlp cannot read is one ⚠ and is left out; the rest carries on, and its Studio numbers are still kept', async () => {
    const dir = await project();
    for (const _ of [1, 2, 3]) await postedVideo(dir, '2026-10-10');
    const gone = Object.assign(new Error('yt-dlp exited with code 1'), { code: 'EXIT', hint: 'ERROR: [youtube] aaaaaaaaaa2: Private video' });
    const { deps } = ytDlp({ [ID(1)]: { upload_date: '20261010', view_count: 500 }, [ID(2)]: gone, [ID(3)]: { title: 'Premiere' } }, '2026-11-09');
    const lines = await learnResults(dir, { studio: { video: 2, clickRate: 3 } }, deps);
    expect(lines[0]).toBe('Format build-story: 1 posted video, read 2026-11-09');
    expect(lines.filter((l) => l.startsWith('⚠'))).toEqual([
      "⚠ video 2 (aaaaaaaaaa2): yt-dlp couldn't read it (yt-dlp exited with code 1 — ERROR: [youtube] aaaaaaaaaa2: Private video) — it is left out",
      "⚠ video 3 (aaaaaaaaaa3): yt-dlp couldn't read it (it has no view count: private, upcoming or live) — it is left out",
    ]);
    expect((await json(join(dir, 'results', 'evidence.json'))).leftOut).toEqual([
      { video: 2, why: 'yt-dlp exited with code 1 — ERROR: [youtube] aaaaaaaaaa2: Private video' }, { video: 3, why: 'it has no view count: private, upcoming or live' },
    ]);
    expect(await json(join(dir, 'results', '2.json'))).toMatchObject({ snapshots: [], studio: [{ at: '2026-11-09', clickRate: 3 }] });
    expect(existsSync(join(dir, 'results', '3.json'))).toBe(false);
    // None readable: the ⚠ lines, and a line saying so.
    const none = await learnResults(dir, {}, ytDlp({ [ID(1)]: gone, [ID(2)]: gone, [ID(3)]: gone }, '2026-11-10').deps);
    expect(none).toHaveLength(4);
    expect(none.at(-1)).toBe('No posted video could be read, so there is nothing to compare yet.');
  });

  it('stops for a missing yt-dlp or when the person stops it, instead of leaving every video out', async () => {
    const dir = await project();
    await postedVideo(dir, '2026-10-10');
    const missing = Object.assign(new Error('yt-dlp was not found'), { code: 'NOT_FOUND' });
    await expect(learnResults(dir, {}, ytDlp({ [ID(1)]: missing }, '2026-11-09').deps)).rejects.toBe(missing);
    const stopped = new AbortController();
    stopped.abort();
    await expect(learnResults(dir, {}, ytDlp({}, '2026-11-09').deps, { signal: stopped.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not tie what viewers replay to the cut when the posted video is not the cut\'s length, and says so', async () => {
    const dir = await project();
    await postedVideo(dir, '2026-10-10');
    const { deps } = ytDlp({ [ID(1)]: { upload_date: '20261010', duration: 660, view_count: 500, heatmap: [{ start_time: 330, end_time: 336, value: 1 }] } }, '2026-11-09');
    const lines = await learnResults(dir, {}, deps);
    expect(lines).toContain('  Most replayed, video 1: 5:33 (50%)');
    expect(lines).toContain("⚠ video 1: on YouTube it is 11:00 long and its cut was 10:00 — the moments viewers replayed or left can't be tied to the cut's items");
    expect((await json(join(dir, 'results', 'evidence.json'))).formats[0].videos[0].mostReplayed).toEqual([{ sec: 333, share: 0.5045, item: null, beat: null }]);
  });

  it('starts a video\'s numbers afresh when it was posted again under another address, and says so', async () => {
    const dir = await project();
    const n = await postedVideo(dir, '2026-10-10');
    await learnResults(dir, { studio: { video: 1, clickRate: 4 } }, ytDlp({ [ID(1)]: { view_count: 500 } }, '2026-11-01').deps);
    const file = join(dir, 'episodes', String(n), 'video.json');
    await writeFile(file, JSON.stringify({ ...(await json(file)), posted: { url: 'https://www.youtube.com/watch?v=bbbbbbbbbb1', id: 'bbbbbbbbbb1', at: '2026-11-05' } }));
    const lines = await learnResults(dir, {}, ytDlp({ bbbbbbbbbb1: { view_count: 20 } }, '2026-11-09').deps);
    expect(lines).toContain(`⚠ video 1: its address changed since its numbers were last read — the earlier numbers were of https://www.youtube.com/watch?v=${ID(1)} and are dropped`);
    // No upload date from YouTube: its age counts from the day it was recorded as posted.
    expect(lines[1]).toBe('  Video 1 “Video A”: 4 days old, early read · 20 views · 5 a day · no like count · no comment count');
    expect(await json(join(dir, 'results', '1.json'))).toMatchObject({ id: 'bbbbbbbbbb1', snapshots: [{ at: '2026-11-09', views: 20 }], studio: [] });
  });
});

describe('the pieces of the report', () => {
  it('replayPeaks takes the strongest points, passing over one that touches a point already taken', () => {
    const h = (start: number, value: number) => ({ start, end: start + 6, value });
    expect(replayPeaks([h(0, 0.5), h(6, 1), h(12, 0.9), h(60, 0.3), h(120, 0.8), h(126, 0.7), h(300, 0.1)]).map((p) => p.start)).toEqual([6, 120, 60]);
    expect(replayPeaks([h(0, 1)])).toHaveLength(1);
  });

  it('viewsAtAge reads a day that was read, draws a line between the reads either side, and guesses nothing outside them', () => {
    const reads = [{ ageDays: 2, views: 100 }, { ageDays: 10, views: 500 }, { ageDays: 30, views: 900 }];
    expect([2, 6, 10, 20, 30].map((a) => viewsAtAge(reads, a))).toEqual([100, 300, 500, 700, 900]);
    expect(viewsAtAge(reads, 1)).toBeNull();
    expect(viewsAtAge(reads, 31)).toBeNull();
  });
});

describe('resultsLine', () => {
  const on = (day: string) => new Date(`${day}T10:00:00Z`);

  it('says how many videos are posted, when they were last read, and which video has which read due', async () => {
    const dir = await project();
    expect(await resultsLine(dir, on('2026-11-09'))).toBe('Results: no video posted yet');
    await video(dir);
    expect(await resultsLine(dir, on('2026-11-09'))).toBe('Results: no video posted yet');
    await postedVideo(dir, '2026-11-09');
    await postedVideo(dir, '2026-11-09');
    // Nothing is due before the early read, 3 days after posting.
    expect(await resultsLine(dir, on('2026-11-11'))).toBe('Results: 2 videos posted · not read yet');
    expect(await resultsLine(dir, on('2026-11-12'))).toBe('Results: 2 videos posted · not read yet · learn is due: video 2 (early read), video 3 (early read)');
    await learnResults(dir, {}, ytDlp({ [ID(2)]: { view_count: 5 }, [ID(3)]: new Error('private') }, '2026-11-12').deps);
    expect(await resultsLine(dir, on('2026-11-13'))).toBe('Results: 2 videos posted · last read 2026-11-12 · learn is due: video 3 (early read)');
    // At 7 days the main read is due, whatever was read before it; a read taken late counts for the reads before it.
    expect(await resultsLine(dir, on('2026-11-16'))).toBe('Results: 2 videos posted · last read 2026-11-12 · learn is due: video 2 (main read), video 3 (main read)');
    await learnResults(dir, {}, ytDlp({ [ID(2)]: { view_count: 9 }, [ID(3)]: { view_count: 9 } }, '2026-11-17').deps);
    expect(await resultsLine(dir, on('2026-12-06'))).toBe('Results: 2 videos posted · last read 2026-11-17');
    expect(await resultsLine(dir, on('2026-12-07'))).toBe('Results: 2 videos posted · last read 2026-11-17 · learn is due: video 2 (late read), video 3 (late read)');
    // After the late read nothing is due again.
    await learnResults(dir, {}, ytDlp({ [ID(2)]: { view_count: 20 }, [ID(3)]: { view_count: 20 } }, '2026-12-08').deps);
    expect(await resultsLine(dir, on('2027-06-01'))).toBe('Results: 2 videos posted · last read 2026-12-08');
  });

  it('the three reads are at 3, 7 and 28 days', () => {
    expect(READS).toEqual({ early: 3, main: 7, late: 28 });
    expect([0, 2, 3, 6, 7, 27, 28, 400].map(readAt)).toEqual([null, null, 'early', 'early', 'main', 'main', 'late', 'late']);
    expect(readDue(2, [])).toBeNull();
    expect(readDue(5, [])).toBe('early');
    expect(readDue(5, [3])).toBeNull();
    expect(readDue(9, [3])).toBe('main');
    expect(readDue(30, [3, 8])).toBe('late');
    expect(readDue(30, [29])).toBeNull();
  });
});

describe('titleFeatures', () => {
  it('counts the words and says what the title is made of', () => {
    expect(titleFeatures('I BOUGHT A WRECK FOR £500 (BIG MISTAKE)')).toEqual({ words: 8, allCaps: true, hasNumber: true, firstPerson: true, endsEmphatic: false, bracketTag: true });
    expect(titleFeatures('Did he actually say yes?')).toEqual({ words: 5, allCaps: false, hasNumber: false, firstPerson: false, endsEmphatic: true, bracketTag: false });
    expect(titleFeatures('WE DID IT!! [4K]')).toMatchObject({ firstPerson: true, endsEmphatic: true, bracketTag: true, hasNumber: true });
    // "Mine" and "Igloo" are not the first person; one ! is not !!.
    expect(titleFeatures('Mine tour of the Igloo!')).toMatchObject({ firstPerson: false, endsEmphatic: false });
  });
});
