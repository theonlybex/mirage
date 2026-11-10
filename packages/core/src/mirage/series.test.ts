// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type ProbeInfo } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { checkEpisode } from './check.js';
import { saveCatalog } from './ingest.js';
import { learnResults, markPosted, type LearnDeps } from './learn.js';
import { lengthLimit } from './playbook.js';
import { loadFormats } from './formats.js';
import { PLATFORMS, predictVideo } from './predict.js';
import { readPrediction } from './prediction.js';
import { saveEpisode } from './render-episode.js';
import { addEpisode, findSeries, listSeries, planSeries, readSeries, seriesLine, seriesReport, seriesSlug, updateSeries } from './series.js';
import { newVideo, readVideo, writeVideo } from './video.js';

const at = (day: string) => () => new Date(`${day}T10:00:00Z`);
const word = (w: string, start: number) => ({ w, start, end: start + 0.4, conf: 1 });
const probeInfo = (durationSec: number): ProbeInfo => ({ durationSec, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', colorTransfer: null });
const tools = (sec = 40) => ({ probe: async () => probeInfo(sec) });
const NOW = { now: at('2026-11-09') };

/** A project with one 60 s clip that says a word every second for its first 30 s. */
async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mirage-series-'));
  await writeFile(join(dir, 'a.mov'), 'x');
  await writeFile(join(dir, 'mirage.json'), JSON.stringify({ version: 1, title: 'My build', createdAt: '2026-10-01T00:00:00Z' }));
  await saveCatalog(dir, {
    version: 1,
    clips: [{
      id: 'c001', path: join(dir, 'a.mov'), sha256: 'a'.repeat(64), kind: 'talking', frames: [], notes: '', moments: [], probe: probeInfo(60),
      transcript: { words: Array.from({ length: 60 }, (_, i) => word('word', i * 0.5)), segments: [], speech: [] },
    }],
  });
  return dir;
}

type More = Partial<Parameters<typeof newVideo>[1]>;
async function video(dir: string, items: object[], more: More = {}, output = { width: 1920, height: 1080, fps: 30 }, extra: object = {}): Promise<number> {
  const n = await newVideo(dir, { title: 'The lamp', about: 'a', mention: '', hide: '', footage: [], idea: { gap: 'a dead lamp', question: 'Will it light?' }, ...more });
  await saveEpisode(dir, EpisodeSchema.parse({ version: 2, number: n, title: 't', output, items, overlays: [], ...extra }));
  await writeFile(join(dir, 'episodes', String(n), 'final.mp4'), 'x');
  return n;
}
const shot = (id: string, beat: string, from: number, to: number, more: object = {}) => ({ id, beat, clip: 'c001', src: { in: from, out: to }, audio: 'keep', ...more });
const STORY = [shot('open', 'cold-open', 0, 10), shot('end', 'truth', 10, 20), shot('out', 'outro', 20, 24)];
const playbook = async (dir: string, n: number) => (await checkEpisode(dir, n)).playbook;
const mine = async (dir: string, format: string, pb: object) => {
  await mkdir(join(dir, 'formulas'), { recursive: true });
  await writeFile(join(dir, 'formulas', `${format}-mine.md`), `---\n${JSON.stringify({ id: `${format}-mine`, name: 'Mine', describe: 'd', formats: [format], source: 's', playbook: pb })}\n---\nMine.\n`);
};

describe('series', () => {
  it('makes a slug from a name, and refuses a name with nothing to make one from', () => {
    expect(seriesSlug('The Lamp Build!')).toBe('the-lamp-build');
    expect(seriesSlug('  Café 2 ')).toBe('cafe-2');
    expect(() => seriesSlug('!!')).toThrow('"!!" can\'t name a series');
  });

  it('starts a series with the fields the person gave, adds episodes in order, and keeps a grouped view on disk', async () => {
    const dir = await project();
    const planned = await planSeries(dir, 'The Lamp', { question: 'Will the lamp ever light?', signOff: 'See you in the shed.', counts: { 'cost so far': { value: 40, unit: '£' } }, thumbnail: { face: 'left' } }, 'build-story', new Date('2026-11-09T10:00:00Z'));
    expect(planned).toMatchObject({ created: true, ignored: [], series: { slug: 'the-lamp', name: 'The Lamp', format: 'build-story', episodes: [], thumbnail: { face: 'left', share: 0.34 } } });
    // Nothing is written until a video joins.
    expect(existsSync(join(dir, 'series'))).toBe(false);
    const one = await video(dir, STORY, { series: 'the-lamp' });
    await addEpisode(dir, planned.series, one);
    const two = await video(dir, STORY, { title: 'The switch', series: 'the-lamp' });
    // By its name or its slug; on a series that exists the other fields are not applied.
    const again = await planSeries(dir, 'the lamp', { signOff: 'Bye.' }, 'build-story');
    expect(again).toMatchObject({ created: false, ignored: ['signOff'] });
    await addEpisode(dir, again.series, two);
    await addEpisode(dir, (await readSeries(dir, 'the-lamp'))!, two);
    expect(await readSeries(dir, 'the-lamp')).toEqual({
      version: 1, slug: 'the-lamp', name: 'The Lamp', format: 'build-story', question: 'Will the lamp ever light?', signOff: 'See you in the shed.',
      counts: { 'cost so far': { value: 40, unit: '£' } }, thumbnail: { face: 'left', share: 0.34 }, episodes: [1, 2], createdAt: '2026-11-09T10:00:00.000Z',
    });
    // The videos stay where they were: the folder groups them by number.
    expect(existsSync(join(dir, 'episodes', '1', 'final.mp4'))).toBe(true);
    const readme = await readFile(join(dir, 'series', 'the-lamp', 'README.md'), 'utf8');
    for (const words of [
      '# The Lamp', '- The big question: Will the lamp ever light?', '- Open question for the next episode: none on record', '- Running counts: cost so far 40 £', '- Thumbnail layout: the face on the left, 34% of the width',
      '1. Video 1 “The lamp”: final · [episodes/1/](../../episodes/1/) · [final.mp4](../../episodes/1/final.mp4)', '2. Video 2 “The switch”: final',
    ]) expect(readme, words).toContain(words);
  });

  it('updates the open question, the counts, the sign-off, the title shape and the layout; lists and shows', async () => {
    const dir = await project();
    const n = await video(dir, STORY, { series: 'the-lamp' });
    await addEpisode(dir, (await planSeries(dir, 'The Lamp', {}, 'build-story')).series, n);
    expect((await listSeries(dir)).series.map(seriesLine)).toEqual(['Series “The Lamp” (series/the-lamp/, build-story): video 1 · no open question on record']);
    const s = await updateSeries(dir, 'the-lamp', {
      openQuestion: 'Will the new switch fit?', video: 1, counts: { 'cost so far': { value: 55, unit: '£' }, 'attempts used': { value: 2 } }, signOff: 'See you in the shed.', titleShape: 'I BOUGHT A [broken thing]', thumbnail: { face: 'right', share: 0.3 },
    });
    expect(s).toMatchObject({ openQuestion: 'Will the new switch fit?', openQuestionFrom: 1, counts: { 'cost so far': { value: 55, unit: '£' }, 'attempts used': { value: 2 } }, thumbnail: { face: 'right', share: 0.3 } });
    expect(await seriesReport(dir, s)).toEqual([
      'Series “The Lamp” (series/the-lamp/, build-story): video 1 · open question: “Will the new switch fit?”',
      '  The big question: none on record',
      '  The open question was left by video 1',
      '  Running counts: cost so far 55 £ · attempts used 2',
      '  Sign-off: See you in the shed.',
      '  Title shape: I BOUGHT A [broken thing]',
      '  Thumbnail layout: the face on the right, 30% of the width',
      '  Video 1 “The lamp”: final',
      '  The grouped view is series/the-lamp/README.md',
    ]);
    // A count set to null is removed, an empty text clears its field, and the rest stays.
    const less = await updateSeries(dir, 'The Lamp', { counts: { 'attempts used': null }, openQuestion: '' });
    expect(less.counts).toEqual({ 'cost so far': { value: 55, unit: '£' } });
    expect(less.openQuestion).toBeUndefined();
    expect(less.openQuestionFrom).toBeUndefined();
    expect(less.signOff).toBe('See you in the shed.');
    await expect(updateSeries(dir, 'the-lamp', { openQuestion: 'Q?', video: 7 })).rejects.toThrow('video 7 isn\'t an episode of the series "The Lamp"');
    await expect(findSeries(dir, 'the-car')).rejects.toMatchObject({ message: 'there is no series "the-car"', hint: 'The series are: the-lamp. new_video with series starts one.' });
  });

  it('leaves a series whose file broke out of the list, as one ✖ line, and never writes over it', async () => {
    const dir = await project();
    await addEpisode(dir, (await planSeries(dir, 'Good', {}, 'vlog')).series, 1);
    await mkdir(join(dir, 'series', 'bad'), { recursive: true });
    await writeFile(join(dir, 'series', 'bad', 'series.json'), '{"version":1,"slug":"bad","name":"Bad","format":"vlog","counts":{},"episodes":[],"createdAt":"x","colour":"red"}');
    const { series, problems } = await listSeries(dir);
    expect(series.map((s) => s.slug)).toEqual(['good']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^✖ series\/bad\/series\.json: .*colour/);
    await expect(planSeries(dir, 'Bad', {}, 'vlog')).rejects.toThrow(/series\/bad\/series\.json/);
  });

  it('check says, for a video in a series, whether an open question is on record for the next episode', async () => {
    const dir = await project();
    const n = await video(dir, STORY, { series: 'the-lamp' });
    await addEpisode(dir, (await planSeries(dir, 'The Lamp', {}, 'build-story')).series, n);
    expect((await playbook(dir, n)).at(-1)).toBe("  ✗ the series “The Lamp” has no open question on record for the next episode — every episode's outro leaves one");
    await updateSeries(dir, 'the-lamp', { openQuestion: 'Will the new switch fit?', video: n });
    expect((await playbook(dir, n)).at(-1)).toBe('  ✓ the series “The Lamp” has an open question on record, left by this episode for the next one: “Will the new switch fit?”');
    const next = await video(dir, STORY, { series: 'the-lamp' });
    await addEpisode(dir, (await readSeries(dir, 'the-lamp'))!, next);
    expect((await playbook(dir, next)).at(-1)).toBe('  ✓ the series “The Lamp” has an open question on record, left by video 1: “Will the new switch fit?”');
    // A video in no series has no such line.
    const alone = await video(dir, STORY);
    expect((await playbook(dir, alone)).join('\n')).not.toContain('series');
    // The forecast names the series.
    expect((await predictVideo(dir, next, { tools: tools(24), ...NOW }))[0]).toContain('Forecast for video 2 “The lamp”, series “The Lamp” (build-story)');
  });
});

describe('the playbook: the title, the length, the pace per beat and the loop', () => {
  it('holds the chosen title against the format\'s title shape, and says it is not measured while none is chosen', async () => {
    const dir = await project();
    const n = await video(dir, STORY);
    const title = async (chosen?: string) => {
      const v = (await readVideo(dir, n))!;
      await writeVideo(dir, n, { ...v, titles: { ...(chosen ? { chosen } : {}), options: ['A', 'B', 'C'] } });
      return (await playbook(dir, n)).find((l) => l.includes('title'))!;
    };
    expect(await title()).toBe('  – the title: not measured — no title is chosen yet (titles.chosen in episodes/1/video.json)');
    expect(await title('I BOUGHT A DEAD LAMP FOR £40')).toBe("  ✓ the chosen title “I BOUGHT A DEAD LAMP FOR £40” fits the format's title shape: in capitals, has a number, 7 words");
    expect(await title('Rebuilding the lamp')).toBe("  ✗ the chosen title “Rebuilding the lamp” misses the format's title shape: not in capitals; no number; 3 words, not 6–8 — the title shape is in capitals, has a number, 6–8 words");
    expect(await title('I FIXED THE OLD LAMP IN THE SHED')).toBe("  ✗ the chosen title “I FIXED THE OLD LAMP IN THE SHED” misses the format's title shape: no number (it is in capitals, 8 words) — the title shape is in capitals, has a number, 6–8 words");
    // A miss is one of the forecast's moments, under Chosen, and weighs 3 there.
    const lines = await predictVideo(dir, n, { tools: tools(24), ...NOW });
    expect(lines.join('\n')).toContain("episodes/1/video.json (titles.chosen): offer the person a title that is in capitals, has a number, 6–8 words, and never a claim the video does not deliver; when they keep this one on purpose, it is the video's experiment");
    expect((await readPrediction(dir, n))!.steps[0]!.rules).toContainEqual({ rule: 'title', status: 'missed', weight: 3 });
    // The vlog's classic shape and the short's question, from their own format files.
    const { formats } = loadFormats();
    expect(formats.find((f) => f.id === 'vlog')!.playbook!.title).toEqual({ allCaps: true, endsWith: '!!', words: { min: 3, max: 8 } });
    expect(formats.find((f) => f.id === 'short')!.playbook!.title).toEqual({ endsWith: '?' });
    const short = await video(dir, [shot('h', 'hook', 0, 2), shot('p', 'payoff', 2, 4), shot('l', 'loop', 4, 6)], { format: 'short', titles: { chosen: 'Did it actually light? (PART 2)' } }, { width: 1080, height: 1920, fps: 30 });
    expect((await playbook(dir, short)).find((l) => l.includes('title'))).toBe("  ✓ the chosen title “Did it actually light? (PART 2)” fits the format's title shape: ends with ?");
  });

  it("takes a format's length from the person's formula: a target, and a limit that defaults to 1.5 × the target", async () => {
    const dir = await project();
    const n = await video(dir, STORY);
    // The build story sets no length: no line.
    expect((await playbook(dir, n)).join('\n')).not.toContain('long —');
    await mine(dir, 'build-story', { targetSec: 20 });
    const r = await checkEpisode(dir, n);
    expect(r.playbook[0]).toBe("Playbook (build-story, with your build-story-mine formula's targetSec):");
    expect(r.playbook).toContain('  ✓ 0:24 long — it aims for 0:20 and warns past 0:30');
    await mine(dir, 'build-story', { targetSec: 10, warnPastSec: 20 });
    expect((await checkEpisode(dir, n)).warnings).toContain("the video is 0:24, longer than your build-story-mine formula's 0:20 — cut whole bits rather than thinning laughs");
    // A short's limit never goes past the platforms' 3:00, whatever a formula says.
    const short = loadFormats().formats.find((f) => f.id === 'short')!;
    expect(lengthLimit(short, null, { targetSec: 30, warnPastSec: 600 }, true)).toEqual({ limit: 180, whose: "the Short format's 3:00", aim: 30 });
    expect(lengthLimit(short, null, { targetSec: 30 }, true)).toEqual({ limit: 45, whose: "your short-mine formula's 0:45", aim: 30 });
    expect(lengthLimit(short, null)).toEqual({ limit: 180, whose: "the Short format's 3:00", aim: null });
  });

  it('measures the pace of the beats the playbook names, and of what comes after one, beside the whole cut', async () => {
    const dir = await project();
    // Bits of 2 s (30 cuts a minute), a held headline, then one 12 s shot after it (5 cuts a minute) and the tag.
    const items = [shot('co', 'cold-open', 0, 2), shot('b1', 'bit', 2, 4), shot('b2', 'bit', 4, 6), shot('b3', 'bit', 6, 8), shot('h', 'headline', 8, 18), shot('b4', 'bit', 18, 30), shot('t', 'tag', 30, 34)];
    const n = await video(dir, items, { format: 'vlog' });
    expect((await playbook(dir, n)).find((l) => l.includes('cuts a minute'))).toBe(
      '  ✗ 12.5 cuts a minute outside headline — the playbook asks for 15 or more; the longest shot is item b4, 12.0 s (0:18.0–0:30.0); in bit 13.3, under its 15 or more; after the headline 5.0, under its 20 or more',
    );
    const moments = (await checkEpisode(dir, n)).measured!.results.find((r) => r.rule === 'pace')!.moments;
    // The whole cut's longest shots first, then each beat's own.
    expect(moments!.slice(2)).toEqual([
      { where: '0:18.0–0:30.0 (item b4)', change: 'in bit, the longest shot is 12.0 s: cut inside it, or trim it' },
      { where: '0:18.0–0:30.0 (item b4)', change: 'after the headline, the longest shot is 12.0 s: cut inside it, or trim it' },
    ]);
    // Bits fast enough, and a fast back half: each is named with its range, and the line is met.
    const quick = [shot('co', 'cold-open', 0, 2), shot('b1', 'bit', 2, 4), shot('b2', 'bit', 4, 6), shot('h', 'headline', 8, 18), shot('b3', 'bit', 18, 20), shot('b4', 'bit', 20, 22), shot('t', 'tag', 30, 34)];
    const m = await video(dir, quick, { format: 'vlog' });
    expect((await playbook(dir, m)).find((l) => l.includes('cuts a minute'))).toBe('  ✓ 21.4 cuts a minute outside headline — the playbook asks for 15 or more; in bit 30.0 (15 or more); after the headline 30.0 (20 or more)');
  });

  it("measures a standalone short's loop as far as a timeline shows it: its last beat, and a last cue that doesn't fade", async () => {
    const dir = await project();
    const tall = { width: 1080, height: 1920, fps: 30 };
    const beats = [shot('h', 'hook', 0, 2), shot('p', 'payoff', 2, 4), shot('l', 'loop', 4, 6)];
    const n = await video(dir, beats, { format: 'short' }, tall);
    expect(await playbook(dir, n)).toContain("  ✓ ends on its loop beat (item l) — whether its last line leads back into the first shot is not measured: Mirage can't hear that");
    const cut = await video(dir, beats.slice(0, 2), { format: 'short' }, tall);
    expect(await playbook(dir, cut)).toContain('  ✗ ends on payoff (item p), not on a loop beat — a standalone short ends where the restart flows into the hook');
    // A teaser has no loop to measure.
    const teaser = await video(dir, beats.slice(0, 2), { format: 'short', from: n }, tall);
    expect((await playbook(dir, teaser)).join('\n')).not.toContain('loop');
  });
});

describe('a short, per platform', () => {
  it('holds the same cut against what YouTube Shorts, Instagram Reels and TikTok each state, without a score, and keeps it in prediction.json', async () => {
    const dir = await project();
    const tall = { width: 1080, height: 1920, fps: 30 };
    const n = await video(dir, [shot('h', 'hook', 0, 2), shot('p', 'payoff', 2, 4), shot('l', 'loop', 4, 6)], { format: 'short' }, tall, { captions: { style: 'pop', position: 'middle' } });
    const lines = await predictVideo(dir, n, { tools: tools(6), ...NOW });
    const from = lines.findIndex((l) => l.startsWith('Per platform'));
    expect(lines.slice(from, from + 19)).toEqual([
      'Per platform, the same cut against what each platform itself says (formulas youtube, instagram and tiktok) — no platform publishes weights, so these are not scores:',
      '  YouTube Shorts:',
      '    ✓ 0:06 long — YouTube takes Shorts up to 3:00',
      '    ✓ opens on the picture, its first word at 0.0 s — YouTube names no number: there is no click, so the opening is the whole pitch',
      '    ✓ ends on the picture, with no outro (item l)',
      "    ✓ no caption or overlay falls where the app's buttons cover the picture",
      '    – not measurable from a cut: viewed vs swiped away, the percentage viewed and likes (YouTube Studio shows them once it is posted)',
      '  Instagram Reels:',
      "    ✓ 0:06 long — Instagram recommends reels of 3:00 or less to people who don't follow the account",
      '    ✓ opens on the picture, its first word at 0.0 s — Instagram says to make the first 3 seconds engaging; whether they are is not something a cut shows',
      '    ✓ ends on the picture, with no outro (item l)',
      "    ✓ no caption or overlay falls where the app's buttons cover the picture",
      "    – not measurable from a cut: sends, watch time and likes, whether the sound is on or trending, a watermark of another app in the footage, and whether Instagram counts it as original (the app's insights show the numbers once it is posted)",
      '  TikTok:',
      '    ✓ 0:06 long — every TikTok account can post up to 3:00 (some up to 10:00)',
      '    ✓ opens on the picture, its first word at 0.0 s — TikTok, in its advice to advertisers, puts the point in the first 3 seconds; whether it lands is not something a cut shows',
      '    ✓ ends on the picture, with no outro (item l)',
      '    – the covered areas: not measured — TikTok publishes no fixed margins (check holds the cut to the Shorts and Reels areas only)',
      "    – not measurable from a cut: whether viewers finish it (TikTok's strongest stated signal), shares, comments, the sound, the caption and hashtags, and whether TikTok counts it as original (the app's analytics show the numbers once it is posted)",
    ]);
    const kept = (await readPrediction(dir, n))!;
    expect(kept.platforms!.map((p) => [p.platform, p.rules.map((r) => `${r.rule} ${r.status}`).join(', ')])).toEqual([
      ['youtube', 'length met, opening met, ending met, covered met, unseen unmeasured'],
      ['instagram', 'length met, opening met, ending met, covered met, unseen unmeasured'],
      ['tiktok', 'length met, opening met, ending met, covered unmeasured, unseen unmeasured'],
    ]);
    // The platforms' own lengths, as their formula files state them.
    expect(PLATFORMS.map((p) => [p.id, p.limitSec, p.openingSec])).toEqual([['youtube', 180, null], ['instagram', 180, 3], ['tiktok', 180, 3]]);
  });

  it('names a miss per platform: a late first word, an outro, captions under the buttons; a long video has no such section', async () => {
    const dir = await project();
    const tall = { width: 1080, height: 1920, fps: 30 };
    // Four silent seconds first (the clip speaks until 30 s), then an outro; phrase captions at the bottom.
    const n = await video(dir, [shot('h', 'hook', 40, 44), shot('p', 'payoff', 0, 2), shot('o', 'outro', 2, 4)], { format: 'short' }, tall);
    const text = (await predictVideo(dir, n, { tools: tools(8), ...NOW })).join('\n');
    for (const words of [
      '    ✗ opens on the picture, its first word at 4.0 s — YouTube names no number',
      '    ✗ opens on the picture, its first word at 4.0 s — Instagram says to make the first 3 seconds engaging',
      '    ✗ a short has no outro: item o',
      "    ✗ 1 caption or overlay falls where the app's buttons cover the picture — check names each",
    ]) expect(text, words).toContain(words);
    const long = await video(dir, STORY);
    expect((await predictVideo(dir, long, { tools: tools(24), ...NOW })).join('\n')).not.toContain('Per platform');
    expect((await readPrediction(dir, long))!.platforms).toBeUndefined();
  });
});

describe('posted and learn: other platforms, the recorded title, an unknown format', () => {
  const info = (views: number, title = 'T') => JSON.stringify({ title, upload_date: '20261101', duration: 6, view_count: views, like_count: 10, comment_count: 1 });
  const deps = (title?: string): LearnDeps => ({ ytDlp: async () => info(1000, title), now: at('2026-11-09') });

  it('records where else a short went, keeps the numbers typed for each platform apart, and compares only YouTube\'s', async () => {
    const dir = await project();
    const n = await video(dir, [shot('h', 'hook', 0, 2), shot('p', 'payoff', 2, 4), shot('l', 'loop', 4, 6)], { format: 'short', series: 'lamp-shorts' }, { width: 1080, height: 1920, fps: 30 });
    await addEpisode(dir, (await planSeries(dir, 'Lamp shorts', {}, 'short')).series, n);
    const lines = await markPosted(dir, n, 'https://www.youtube.com/shorts/abcdefghijk', {
      tools: tools(6), ...NOW, also: [{ platform: 'instagram', url: 'https://www.instagram.com/reel/Cx1/?igsh=abc' }, { platform: 'tiktok', url: 'https://www.tiktok.com/@me/video/123' }],
    });
    expect(lines[1]).toBe('also posted on Instagram (https://www.instagram.com/reel/Cx1/) and TikTok (https://www.tiktok.com/@me/video/123) — Mirage reads no numbers there: give learn the ones you see in the app, as studio with platform');
    expect((await readVideo(dir, n))!.posted).toEqual({
      url: 'https://www.youtube.com/shorts/abcdefghijk', id: 'abcdefghijk', at: '2026-11-09',
      also: [{ platform: 'instagram', url: 'https://www.instagram.com/reel/Cx1/' }, { platform: 'tiktok', url: 'https://www.tiktok.com/@me/video/123' }],
    });
    await expect(markPosted(dir, n, 'https://youtu.be/abcdefghijk', { tools: tools(6), ...NOW, also: [{ platform: 'tiktok', url: 'https://www.instagram.com/reel/Cx1/' }] }))
      .rejects.toMatchObject({ message: 'also: "https://www.instagram.com/reel/Cx1/" isn\'t an address on TikTok', hint: "Give the video's own https address on that platform, or leave it out." });

    await learnResults(dir, { studio: { video: n, viewedVsSwiped: 71 } }, deps());
    const report = await learnResults(dir, { studio: { video: n, platform: 'instagram', views: 12000, shares: 40, percentViewed: 61 } }, deps());
    expect(report).toContain('  Video 1 “T” (series “Lamp shorts”): 8 days old, main read · 1.0K views · 125 a day · 10.0 likes per 1,000 views · 1.0 comments per 1,000 views · Studio (2026-11-09): 71% viewed vs swiped');
    expect(report).toContain('  Elsewhere, video 1: Instagram https://www.instagram.com/reel/Cx1/ — 12K views · 40 shares · 61% viewed (typed by the person, 2026-11-09) · TikTok https://www.tiktok.com/@me/video/123 — no numbers given yet');
    expect(report.at(-2)).toBe('Instagram and TikTok numbers are the ones the person typed: Mirage reads numbers only from YouTube, and every comparison above is of the YouTube numbers.');
    const evidence = JSON.parse(await readFile(join(dir, 'results', 'evidence.json'), 'utf8')).formats[0].videos[0];
    expect(evidence.series).toBe('Lamp shorts');
    expect(evidence.studio).toEqual({ at: '2026-11-09', viewedVsSwiped: 71 });
    expect(evidence.elsewhere).toEqual([
      { platform: 'instagram', url: 'https://www.instagram.com/reel/Cx1/', numbers: { at: '2026-11-09', platform: 'instagram', views: 12000, shares: 40, percentViewed: 61 } },
      { platform: 'tiktok', url: 'https://www.tiktok.com/@me/video/123', numbers: null },
    ]);
  });

  it('says when the live title differs from the one Mirage recorded as chosen', async () => {
    const dir = await project();
    const n = await video(dir, STORY, { titles: { chosen: 'I BOUGHT A DEAD LAMP FOR £40', options: ['I BOUGHT A DEAD LAMP FOR £40'] } });
    await markPosted(dir, n, 'https://youtu.be/abcdefghijk', { tools: tools(24), ...NOW });
    const differs = await learnResults(dir, {}, deps('Fixing a lamp'));
    expect(differs).toContain("  Title, video 1: live on YouTube it is “Fixing a lamp”, and Mirage recorded “I BOUGHT A DEAD LAMP FOR £40” as the one chosen — they differ, and the title numbers here are the live title's");
    expect(JSON.parse(await readFile(join(dir, 'results', 'evidence.json'), 'utf8')).formats[0].videos[0].recordedTitle).toBe('I BOUGHT A DEAD LAMP FOR £40');
    const same = await learnResults(dir, {}, deps('I BOUGHT A DEAD LAMP FOR £40'));
    expect(same.join('\n')).not.toContain('Title, video');
  });

  it('warns when video.json names a format Mirage does not have: the snapshot is a build story\'s', async () => {
    const dir = await project();
    const n = await video(dir, STORY, { format: 'vlogg' });
    const lines = await markPosted(dir, n, 'https://youtu.be/abcdefghijk', { tools: tools(24), ...NOW });
    expect(lines).toContain('⚠ video.json names the format "vlogg", which isn\'t one of Mirage\'s (build-story, short, vlog) — features.json describes the cut as a build story: fix format in episodes/1/video.json, then call posted again');
    expect(JSON.parse(await readFile(join(dir, 'episodes', '1', 'features.json'), 'utf8')).format).toBe('build-story');
    const fine = await video(dir, STORY);
    expect((await markPosted(dir, fine, 'https://youtu.be/abcdefghijl', { tools: tools(24), ...NOW })).join('\n')).not.toContain('⚠');
  });

  it('snapshots how the thumbnail was made, from its thumbnail.json', async () => {
    const dir = await project();
    const n = await video(dir, STORY);
    await writeFile(join(dir, 'episodes', '1', 'thumbnail.jpg'), 'x');
    await writeFile(join(dir, 'episodes', '1', 'thumbnail.json'), JSON.stringify({ made: 'two-sources', face: { image: 'photos/me.jpg' }, subject: { at: 12 }, layout: { face: 'left', share: 0.34 }, text: null }));
    const lines = await markPosted(dir, n, 'https://youtu.be/abcdefghijk', { tools: tools(24), ...NOW });
    expect(lines.join('\n')).toContain('a thumbnail from two sources (face on the left) without text');
    expect(JSON.parse(await readFile(join(dir, 'episodes', '1', 'features.json'), 'utf8')).thumbnail).toEqual({ exists: true, text: false, made: 'two-sources', layout: { face: 'left', share: 0.34 } });
  });
});
