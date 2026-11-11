// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captionsReport, channelAddress, channelCaptions, channelPatterns, channelThumbnails, clockText, gatherChannel, parseVideoLines, pickVideos, readChannel, sheetArgs, viewsText, wordsFromJson3,
  type ChannelDeps, type ChannelVideo,
} from './channel.js';

const project = () => mkdtemp(join(tmpdir(), 'mirage-channel-'));
const id = (n: number) => `vid${String(n).padStart(8, '0')}`;

/** A channel of `n` videos, newest first: video k is k minutes long, has (n − k + 1) thousand views, and every third title is in capitals and starts "I BOUGHT". */
const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => i + 1).map((k) => `${id(k)}|${k * 60}|${(n - k + 1) * 1000}|NA|${k % 3 === 0 ? `I BOUGHT A WRECK | PT${k}` : `Rebuilding the thing part ${k}`}`).join('\n');

function stubs(over: Partial<ChannelDeps> = {}) {
  const calls = { ytDlp: [] as string[][], fetched: [] as string[], ffmpeg: [] as string[][] };
  const deps: ChannelDeps = {
    ytDlp: async (args) => { calls.ytDlp.push(args); return `${lines(5)}\n`; },
    fetchImage: async (url) => { calls.fetched.push(url); return new Uint8Array([1, 2, 3]); },
    runFfmpeg: async (args) => { calls.ffmpeg.push(args); await writeFile(args.at(-1)!, 'sheet'); },
    now: () => new Date('2026-11-09T10:00:00Z'),
    ...over,
  };
  return { deps, calls };
}

async function gathered(n: number) {
  const dir = await project();
  const s = stubs({ ytDlp: async () => lines(n) });
  await gatherChannel(dir, { url: '@Demo' }, s.deps);
  return dir;
}

describe('channelAddress', () => {
  it('takes a handle or the channel\'s address, lists its Videos tab, and names the folder after the handle', () => {
    for (const input of ['@MatArmstrongbmx', ' https://www.youtube.com/@MatArmstrongbmx ', 'https://youtube.com/@MatArmstrongbmx/videos', 'https://m.youtube.com/@MatArmstrongbmx/featured?x=1']) {
      expect(channelAddress(input), input).toEqual({ url: 'https://www.youtube.com/@MatArmstrongbmx/videos', slug: 'matarmstrongbmx' });
    }
    expect(channelAddress('https://www.youtube.com/channel/UCabc_DEF-123')).toEqual({ url: 'https://www.youtube.com/channel/UCabc_DEF-123/videos', slug: 'ucabc-def-123' });
    expect(channelAddress('https://www.youtube.com/c/Some.Name')).toEqual({ url: 'https://www.youtube.com/c/Some.Name/videos', slug: 'some-name' });
  });

  it('keeps the Shorts tab when the address names it, under a folder of its own', () => {
    expect(channelAddress('https://www.youtube.com/@demo/shorts')).toEqual({ url: 'https://www.youtube.com/@demo/shorts', slug: 'demo-shorts' });
  });

  it('refuses anything that is not a YouTube channel', () => {
    for (const input of ['demo', 'https://example.com/@demo', 'http://www.youtube.com/@demo', 'https://www.youtube.com/watch?v=abc', 'https://www.youtube.com/', '--exec', 'https://www.youtube.com/@demo/videos/extra']) {
      expect(() => channelAddress(input), input).toThrow(expect.objectContaining({ code: 'BAD_INPUT', message: `"${input}" isn't a YouTube channel address`, hint: "Give the channel's address, e.g. https://www.youtube.com/@handle, or just @handle." }));
    }
  });
});

describe('the numbers as they are printed', () => {
  it('views', () => {
    expect([812, 1500, 9949, 12_400, 950_000, 13_000_000, 2_500_000_000].map(viewsText)).toEqual(['812', '1.5K', '9.9K', '12K', '950K', '13.0M', '2.5B']);
  });
  it('lengths', () => {
    expect([0, 59.6, 260, 3125, 5944].map(clockText)).toEqual(['0:00', '1:00', '4:20', '52:05', '1:39:04']);
  });
});

describe('parseVideoLines', () => {
  it('reads id, length, views, the day posted and the title last, which may hold a |', () => {
    expect(parseVideoLines('abcDEF_-123|3105|13000000|NA|I BOUGHT A YACHT | PT1\r\nxyz00000001|NA|NA|NA|Upcoming\nWARNING: something\n\n')).toEqual([
      { id: 'abcDEF_-123', durationSec: 3105, views: 13_000_000, title: 'I BOUGHT A YACHT | PT1' },
      { id: 'xyz00000001', durationSec: null, views: null, title: 'Upcoming' },
    ]);
  });
});

describe('gatherChannel', () => {
  it('lists the channel with yt-dlp (no download), writes videos.json newest first, and reports the numbers', async () => {
    const dir = await project();
    const { deps, calls } = stubs();
    const report = await gatherChannel(dir, { url: 'https://www.youtube.com/@Demo', videos: 5 }, deps);
    expect(calls.ytDlp).toEqual([['--flat-playlist', '--extractor-args', 'youtubetab:approximate_date', '--playlist-end', '5', '--print', '%(id)s|%(duration)s|%(view_count)s|%(upload_date)s|%(title)s', 'https://www.youtube.com/@Demo/videos']]);
    const file = JSON.parse(await readFile(join(dir, 'analysis', 'demo', 'videos.json'), 'utf8'));
    expect(file).toMatchObject({ version: 1, url: 'https://www.youtube.com/@Demo/videos', gatheredAt: '2026-11-09T10:00:00.000Z' });
    expect(file.videos).toHaveLength(5);
    expect(file.videos[2]).toEqual({ id: id(3), title: 'I BOUGHT A WRECK | PT3', durationSec: 180, views: 3000 });
    expect(report).toEqual([
      'Channel demo: 5 videos gathered, newest first (analysis/demo/videos.json). Use name "demo" in the next channel calls.',
      'Median views: 3.0K (all 5)',
      'Length, all 5: 1:00 shortest · 2:00 quarter · 3:00 middle · 4:00 three-quarters · 5:00 longest',
      'Median views by length, all 5: 1–4 min 4.0K (3) · 4–8 min 1.5K (2)',
      'Titles, all 5: 5–6 words, 5 typical, about 27 characters · ALL CAPS on 1 of 5 (20%)',
      'Most viewed:',
      `  1. 5.0K · 1:00 · ${id(1)} · Rebuilding the thing part 1`,
      `  2. 4.0K · 2:00 · ${id(2)} · Rebuilding the thing part 2`,
      `  3. 3.0K · 3:00 · ${id(3)} · I BOUGHT A WRECK | PT3`,
      `  4. 2.0K · 4:00 · ${id(4)} · Rebuilding the thing part 4`,
      `  5. 1.0K · 5:00 · ${id(5)} · Rebuilding the thing part 5`,
      'Newest:',
      `  1. 5.0K · 1:00 · ${id(1)} · Rebuilding the thing part 1`,
      `  2. 4.0K · 2:00 · ${id(2)} · Rebuilding the thing part 2`,
      `  3. 3.0K · 3:00 · ${id(3)} · I BOUGHT A WRECK | PT3`,
      `  4. 2.0K · 4:00 · ${id(4)} · Rebuilding the thing part 4`,
      `  5. 1.0K · 5:00 · ${id(5)} · Rebuilding the thing part 5`,
      'Least viewed of the latest 5:',
      `  1. 1.0K · 5:00 · ${id(5)} · Rebuilding the thing part 5`,
      `  2. 2.0K · 4:00 · ${id(4)} · Rebuilding the thing part 4`,
      `  3. 3.0K · 3:00 · ${id(3)} · I BOUGHT A WRECK | PT3`,
      `  4. 4.0K · 2:00 · ${id(2)} · Rebuilding the thing part 2`,
      `  5. 5.0K · 1:00 · ${id(1)} · Rebuilding the thing part 1`,
    ]);
  });

  it('asks for 200 videos by default, and reports the latest 60 beside all when there are more', async () => {
    const dir = await project();
    const { deps, calls } = stubs({ ytDlp: async (args) => { calls.ytDlp.push(args); return lines(90); } });
    const report = await gatherChannel(dir, { url: '@demo' }, deps);
    expect(calls.ytDlp[0]![4]).toBe('200');
    expect(report[1]).toBe('Median views: 46K (all 90) · 61K (latest 60)');
    expect(report.filter((l) => /^(Length|Median views by length|Titles), /.test(l)).map((l) => l.split(':')[0])).toEqual([
      'Length, all 90', 'Median views by length, all 90', 'Titles, all 90', 'Length, latest 60', 'Median views by length, latest 60', 'Titles, latest 60',
    ]);
    expect(report).toContain('Median views by length, latest 60: 1–4 min 89K (3) · 4–8 min 86K (4) · 8–15 min 80K (7) · 15–30 min 69K (15) · 30–45 min 54K (15) · 45–60 min 39K (15) · over 60 min 31K (1)');
    // 12 of each, and the least viewed come from the latest 60 only (video 60 has 31K; the oldest, video 90, has 1K).
    const at = (head: string) => report.indexOf(head);
    expect(at('Newest:') - at('Most viewed:')).toBe(13);
    expect(report[at('Least viewed of the latest 60:') + 1]).toBe(`  1. 31K · 1:00:00 · ${id(60)} · I BOUGHT A WRECK | PT60`);
    expect(report.at(-1)).toBe(`  12. 42K · 49:00 · ${id(49)} · Rebuilding the thing part 49`);
  });

  it('warns about videos with no view count and leaves them out of the medians and the viewed lists', async () => {
    const dir = await project();
    const { deps } = stubs({ ytDlp: async () => `${lines(4)}\nvidupcoming1|NA|NA|NA|Coming soon` });
    const report = await gatherChannel(dir, { url: '@demo' }, deps);
    expect(report).toContain('Median views: 2.5K (all 5)');
    expect(report).toContain('⚠ 1 of 5 videos have no view count (members-only, upcoming or live) — they are left out of the medians and the most and least viewed lists');
    expect(report.filter((l) => l.includes('vidupcoming1'))).toEqual(['  5. no view count · length unknown · vidupcoming1 · Coming soon']);
  });

  it('reads the day each video was posted when the list has it, and says how often the channel posts', async () => {
    const dir = await project();
    const { deps } = stubs({ ytDlp: async () => ['vid00000001|60|3000|20261103|Three', 'vid00000002|60|2000|20261024|Two', 'vid00000003|60|1000|NA|One'].join('\n') });
    const report = await gatherChannel(dir, { url: '@demo' }, deps);
    expect(report).toContain('Posted, all 3: one every 10 days, 2026-10-24 to 2026-11-03 (2 of 3 have a date) · approximate: the list only says "2 weeks ago"');
    expect(report).toContain('  1. 3.0K · 1:00 · 2026-11-03 · vid00000001 · Three');
    expect(report).toContain('  3. 1.0K · 1:00 · vid00000003 · One');
    const file = JSON.parse(await readFile(join(dir, 'analysis', 'demo', 'videos.json'), 'utf8'));
    expect(file.videos.map((v: ChannelVideo) => v.posted)).toEqual(['2026-11-03', '2026-10-24', undefined]);
  });

  it('reads the newest videos one at a time when the page lists no lengths (a Shorts tab), never downloading', async () => {
    const dir = await project();
    const calls: string[][] = [];
    const { deps } = stubs({
      ytDlp: async (args) => {
        calls.push(args);
        if (args.includes('--flat-playlist')) return Array.from({ length: 62 }, (_, i) => `${id(i + 1)}|NA|${(62 - i) * 1000}|NA|Short ${i + 1}`).join('\n');
        const vid = args.at(-1)!.split('v=')[1]!;
        const k = Number(vid.slice(3));
        if (k === 7) throw Object.assign(new Error('yt-dlp exited with code 1'), { code: 'FAILED' });
        return `${vid}|${100 + k}|202611${String(31 - Math.ceil(k / 2)).padStart(2, '0')}\n`;
      },
    });
    const report = await gatherChannel(dir, { url: 'https://www.youtube.com/@demo/shorts' }, deps);
    const single = calls.filter((c) => !c.includes('--flat-playlist'));
    expect(single).toHaveLength(60);
    expect(single[0]).toEqual(['--skip-download', '--print', '%(id)s|%(duration)s|%(upload_date)s', `https://www.youtube.com/watch?v=${id(1)}`]);
    expect(report).toContain('Length, latest 60: 1:41 shortest · 1:57 quarter · 2:11 middle · 2:26 three-quarters · 2:40 longest (59 of 60 have a length)');
    expect(report).toContain('Length, all 62: 1:41 shortest · 1:57 quarter · 2:11 middle · 2:26 three-quarters · 2:40 longest (59 of 62 have a length)');
    expect(report).toContain('Posted, latest 60: one every 0.5 days, 2026-11-01 to 2026-11-30 (59 of 60 have a date)');
    expect(report).toContain("This page lists no lengths or dates, so those of the newest 60 were read one video at a time; the 2 older videos have none (channel { name, captions } reports one video's).");
    expect(report).toContain("⚠ 1 of 60 videos couldn't be read one by one — their length and date stay unknown");
    expect(report).toContain(`  1. 62K · 1:41 · 2026-11-30 · ${id(1)} · Short 1`);
    const file = JSON.parse(await readFile(join(dir, 'analysis', 'demo-shorts', 'videos.json'), 'utf8'));
    expect(file.videos[0]).toEqual({ id: id(1), title: 'Short 1', durationSec: 101, views: 62000, posted: '2026-11-30' });
    expect(file.videos[6]).toEqual({ id: id(7), title: 'Short 7', durationSec: null, views: 56000 });
    expect(file.videos[61]).toEqual({ id: id(62), title: 'Short 62', durationSec: null, views: 1000 });
  });

  it('stops when the person stops it while videos are read one at a time', async () => {
    const dir = await project();
    const { deps } = stubs({
      ytDlp: async (args) => {
        if (args.includes('--flat-playlist')) return `${id(1)}|NA|1000|NA|Short\n${id(2)}|NA|900|NA|Short`;
        throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
      },
    });
    await expect(gatherChannel(dir, { url: 'https://www.youtube.com/@demo/shorts' }, deps)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('says so when the page lists no videos, and writes nothing', async () => {
    const dir = await project();
    const { deps } = stubs({ ytDlp: async () => 'WARNING: nothing here\n' });
    await expect(gatherChannel(dir, { url: '@demo' }, deps)).rejects.toMatchObject({ code: 'BAD_INPUT', message: 'no videos were found at https://www.youtube.com/@demo/videos' });
    expect(existsSync(join(dir, 'analysis'))).toBe(false);
  });
});

describe('readChannel', () => {
  it('names the channels there are when the name is unknown', async () => {
    const dir = await gathered(3);
    await expect(readChannel(dir, 'other')).rejects.toMatchObject({
      code: 'BAD_INPUT', message: 'no channel "other" has been gathered in this project',
      hint: "The channels are: demo. Run channel with the channel's url first; its report says the name to use.",
    });
    await expect(readChannel(dir, '../demo')).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(readChannel(await project(), 'demo')).rejects.toMatchObject({ hint: "Run channel with the channel's url first; its report says the name to use." });
    expect((await readChannel(dir, 'demo')).videos).toHaveLength(3);
  });
});

describe('channelPatterns', () => {
  it('compares the median views with and without each pattern, over all videos and over the latest 60', async () => {
    const dir = await gathered(90);
    expect(await channelPatterns(dir, 'demo', [{ label: 'opens with I BOUGHT', regex: '^i bought' }, { label: 'part 8x', regex: 'part 8\\d?$' }, { label: 'never', regex: 'zzz' }])).toEqual([
      'Channel demo: 3 title patterns. × is the median views of the videos whose title matches against the rest: it shows what goes with more views, not what causes them.',
      'opens with I BOUGHT (/^i bought/i)',
      '  all 90: 30 match · 45K with · 46K without · ×0.97',
      '  latest 60: 20 match · 60K with · 61K without · ×0.98',
      'part 8x (/part 8\\d?$/i)',
      '  all 90: 8 match · 7.0K with · 49K without · ×0.14',
      '  latest 60: 1 match · too few to compare',
      'never (/zzz/i)',
      '  all 90: 0 match · too few to compare',
      '  latest 60: 0 match · too few to compare',
    ]);
  });

  it('a channel of 60 videos or fewer has one line per pattern', async () => {
    const dir = await gathered(9);
    expect(await channelPatterns(dir, 'demo', [{ label: 'bought', regex: 'BOUGHT' }])).toEqual([
      'Channel demo: 1 title pattern. × is the median views of the videos whose title matches against the rest: it shows what goes with more views, not what causes them.',
      'bought (/BOUGHT/i)',
      '  all 9: 3 match · 4.0K with · 5.5K without · ×0.73',
    ]);
  });

  it('a bad regex names its label and compares nothing', async () => {
    const dir = await gathered(9);
    await expect(channelPatterns(dir, 'demo', [{ label: 'ok', regex: 'a' }, { label: 'a price', regex: '([£$' }])).rejects.toMatchObject({
      code: 'BAD_INPUT', message: expect.stringMatching(/^pattern "a price": its regex can't be read \(/), hint: 'Fix that regex and run it again; nothing was compared.',
    });
  });
});

describe('pickVideos', () => {
  const videos: ChannelVideo[] = Array.from({ length: 80 }, (_, i) => ({ id: id(i + 1), title: 't', durationSec: 60, views: i === 0 ? null : i < 60 ? 1000 - i : 5 }));
  it('top: the most viewed of all; newest: the first 12; lowest: the least viewed of the latest 60', () => {
    expect(pickVideos(videos, 'top').map((v) => v.id)).toEqual(Array.from({ length: 12 }, (_, i) => id(i + 2)));
    expect(pickVideos(videos, 'newest').map((v) => v.id)).toEqual(Array.from({ length: 12 }, (_, i) => id(i + 1)));
    expect(pickVideos(videos, 'lowest').map((v) => v.id)).toEqual(Array.from({ length: 12 }, (_, i) => id(60 - i)));
  });
});

describe('channelThumbnails', () => {
  it('fetches the largest thumbnail YouTube has, tiles 12 into a sheet with ffmpeg, and lists them in tile order', async () => {
    const dir = await gathered(20);
    // No maxres for any video; video 2 has no hq720 either.
    const { deps, calls } = stubs({
      fetchImage: async (url) => {
        calls.fetched.push(url);
        return url.endsWith('maxresdefault.jpg') || url === `https://i.ytimg.com/vi/${id(2)}/hq720.jpg` ? null : new Uint8Array([9]);
      },
    });
    const report = await channelThumbnails(dir, 'demo', 'top', deps);
    expect(report[0]).toBe('wrote analysis/demo/thumbs-top.jpg (12 tiles, 4 across, in reading order: the most viewed)');
    expect(report.slice(1)).toEqual(Array.from({ length: 12 }, (_, i) => `  ${i + 1}. ${viewsText((20 - i) * 1000)} · ${clockText((i + 1) * 60)} · ${id(i + 1)} · ${(i + 1) % 3 === 0 ? `I BOUGHT A WRECK | PT${i + 1}` : `Rebuilding the thing part ${i + 1}`}`));
    expect(calls.fetched.slice(0, 5)).toEqual([
      `https://i.ytimg.com/vi/${id(1)}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${id(1)}/hq720.jpg`,
      `https://i.ytimg.com/vi/${id(2)}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${id(2)}/hq720.jpg`, `https://i.ytimg.com/vi/${id(2)}/hqdefault.jpg`,
    ]);
    expect((await readdir(join(dir, 'analysis', 'demo', 'thumbs'))).length).toBe(12);
    expect(existsSync(join(dir, 'analysis', 'demo', 'thumbs-top.jpg'))).toBe(true);
    const args = calls.ffmpeg[0]!;
    expect(args.filter((a) => a === '-i')).toHaveLength(12);
    expect(args.at(-1)).toBe(join(dir, 'analysis', 'demo', 'thumbs-top.jpg'));
    // A second sheet of the same videos fetches nothing again.
    const before = calls.fetched.length;
    await channelThumbnails(dir, 'demo', 'newest', deps);
    expect(calls.fetched.length).toBe(before);
    expect(existsSync(join(dir, 'analysis', 'demo', 'thumbs-newest.jpg'))).toBe(true);
  });

  it('leaves out a video whose thumbnail can\'t be fetched, with a ⚠, and says the least viewed are of the latest ones', async () => {
    const dir = await gathered(5);
    const { deps, calls } = stubs({ fetchImage: async (url) => (url.includes(id(4)) ? null : new Uint8Array([9])) });
    const report = await channelThumbnails(dir, 'demo', 'lowest', deps);
    expect(report[0]).toBe('wrote analysis/demo/thumbs-lowest.jpg (4 tiles, 4 across, in reading order: the least viewed of the latest 5)');
    expect(report.slice(1).map((l) => l.split(' · ')[2] ?? l)).toEqual([id(5), id(3), id(2), id(1), `⚠ no thumbnail could be fetched for ${id(4)} (Rebuilding the thing part 4) — it is left out of the sheet`]);
    expect(calls.ffmpeg[0]!.filter((a) => a === '-i')).toHaveLength(4);
  });

  it('stops when none can be fetched, before any ffmpeg', async () => {
    const dir = await gathered(3);
    const { deps, calls } = stubs({ fetchImage: async () => null });
    await expect(channelThumbnails(dir, 'demo', 'top', deps)).rejects.toMatchObject({ code: 'BAD_INPUT', message: 'no thumbnail could be fetched', hint: 'Check the internet connection and run it again.' });
    expect(calls.ffmpeg).toEqual([]);
  });
});

describe('sheetArgs', () => {
  it('scales and pads each image to 480×270 before tiling 4×3 (mixed sizes break tile)', () => {
    expect(sheetArgs(['a.jpg', 'b.jpg'], 'out.jpg')).toEqual([
      '-i', 'a.jpg', '-i', 'b.jpg', '-filter_complex',
      '[0:v]scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuvj420p[t0];' +
        '[1:v]scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuvj420p[t1];' +
        '[t0][t1]concat=n=2:v=1:a=0,tile=4x3[sheet]',
      '-map', '[sheet]', '-frames:v', '1', '-q:v', '3', 'out.jpg',
    ]);
  });
});

const json3 = (events: { t: number; words: [number, string][] }[]) =>
  JSON.stringify({ events: [{ tStartMs: 0 }, ...events.map((e) => ({ tStartMs: e.t * 1000, segs: e.words.map(([offset, utf8]) => ({ utf8, tOffsetMs: offset * 1000 })) })), { tStartMs: 1, segs: [{ utf8: '\n' }] }] });

describe('wordsFromJson3', () => {
  it('gives each word the second it is said at, and one line per caption event', () => {
    expect(wordsFromJson3(json3([{ t: 2, words: [[0, 'Here is'], [1.5, ' the front']] }, { t: 10, words: [[0, 'half.']] }]))).toEqual({
      words: [{ t: 2, w: 'Here' }, { t: 2, w: 'is' }, { t: 3.5, w: 'the' }, { t: 3.5, w: 'front' }, { t: 10, w: 'half.' }],
      lines: [{ t: 2, text: 'Here is the front' }, { t: 10, text: 'half.' }],
    });
  });
});

describe('captionsReport', () => {
  // A 12-minute video: 3 words every 2 s for the first 5 minutes, 1 word every 2 s after.
  const events = Array.from({ length: 360 }, (_, i) => ({ t: i * 2, words: (i < 150 ? [[0, `a${i}`], [0.5, 'b'], [1, 'c']] : [[0, `w${i}`]]) as [number, string][] }));
  const info = {
    title: 'I BOUGHT A WRECK', duration: 720,
    heatmap: [{ start_time: 0, end_time: 7.2, value: 1 }, { start_time: 662.4, end_time: 669.6, value: 0.9 }, { start_time: 100, end_time: 110, value: 0.2 }],
    chapters: [{ start_time: 0, end_time: 60, title: 'The wreck' }, { start_time: 60, end_time: 720, title: 'The work' }],
  };

  it('reports the pace per 5-minute block, the most replayed points, the chapters, the opening and the ending', () => {
    const { lines, transcript } = captionsReport('abc12345678', info, json3(events), 'analysis/demo');
    expect(lines.slice(0, 4)).toEqual([
      'abc12345678 “I BOUGHT A WRECK”: 12:00, 660 words (analysis/demo/abc12345678.txt)',
      '  Words a minute, per 5-minute block: 0–5 min 90 · 5–10 min 30 · 10–12 min 30',
      '  Most replayed, strongest first: 1% (0:04) · 93% (11:06) · 15% (1:45)',
      '  Chapters: 0:00 The wreck · 1:00 The work',
    ]);
    expect(lines[4]).toBe(`  First 150 s: ${Array.from({ length: 75 }, (_, i) => `a${i} b c`).join(' ')}`);
    expect(lines[5]).toBe(`  Last 100 s: ${Array.from({ length: 50 }, (_, i) => `w${310 + i}`).join(' ')}`);
    expect(lines).toHaveLength(6);
    expect(transcript!.split('\n').slice(0, 2)).toEqual(['[0:00] a0 b c', '[0:02] a1 b c']);
    expect(transcript!.endsWith('[11:58] w359\n')).toBe(true);
  });

  it('says the day the video was posted when its info has it', () => {
    const { lines } = captionsReport('abc12345678', { ...info, upload_date: '20250221' }, json3(events), 'analysis/demo');
    expect(lines.slice(2, 5)).toEqual(['  Most replayed, strongest first: 1% (0:04) · 93% (11:06) · 15% (1:45)', '  Posted: 2025-02-21', '  Chapters: 0:00 The wreck · 1:00 The work']);
  });

  it('says so when YouTube shows no replay graph and no chapters are set', () => {
    const { lines } = captionsReport('abc12345678', { duration: 720, heatmap: null, chapters: null }, json3(events), 'analysis/demo');
    expect(lines[0]).toBe('abc12345678: 12:00, 660 words (analysis/demo/abc12345678.txt)');
    expect(lines.slice(2, 4)).toEqual(['  Most replayed: YouTube shows none for this video', '  Chapters: none set']);
  });

  it('a video without captions is one ⚠, with its replay points and chapters still reported and no transcript', () => {
    for (const subs of [null, JSON.stringify({ events: [] })]) {
      expect(captionsReport('abc12345678', info, subs, 'analysis/demo')).toEqual({
        lines: [
          '⚠ abc12345678 “I BOUGHT A WRECK”: no English captions — no transcript for this video',
          '  Most replayed, strongest first: 1% (0:04) · 93% (11:06) · 15% (1:45)',
          '  Chapters: 0:00 The wreck · 1:00 The work',
        ],
        transcript: null,
      });
    }
  });
});

describe('channelCaptions', () => {
  /** A yt-dlp that writes what the real one does into the -P folder: <id>.info.json, and <id>.en.json3 unless the video has no captions. */
  function captionStubs(o: { noCaptions?: string[]; fails?: string[]; noInfo?: string[] } = {}) {
    return stubs({
      ytDlp: async function (this: void, args) {
        const out = args[args.indexOf('-P') + 1]!;
        const vid = args.at(-1)!.split('v=')[1]!;
        if (o.fails?.includes(vid)) throw Object.assign(new Error('yt-dlp exited with code 1'), { code: 'EXIT', hint: 'ERROR: [youtube] Private video' });
        if (!o.noInfo?.includes(vid)) await writeFile(join(out, `${vid}.info.json`), JSON.stringify({ title: `Video ${vid}`, duration: 60 }));
        if (!o.noCaptions?.includes(vid)) await writeFile(join(out, `${vid}.en.json3`), json3([{ t: 0, words: [[0, 'Here is the wreck.']] }, { t: 50, words: [[0, 'Peace out.']] }]));
        return '';
      },
    });
  }

  it('asks yt-dlp for captions and info only, never the video, and writes each transcript', async () => {
    const dir = await gathered(3);
    const calls: string[][] = [];
    const { deps } = captionStubs();
    const ytDlp = deps.ytDlp;
    deps.ytDlp = async (args, opts) => { calls.push(args); return ytDlp(args, opts); };
    const report = await channelCaptions(dir, 'demo', [id(1), id(2)], deps);
    const raw = join(dir, 'analysis', 'demo', 'raw');
    expect(calls).toEqual([id(1), id(2)].map((v) => ['--skip-download', '--write-auto-subs', '--sub-langs', 'en', '--sub-format', 'json3', '--write-info-json', '-P', raw, '-o', '%(id)s.%(ext)s', `https://www.youtube.com/watch?v=${v}`]));
    expect(report).toEqual([id(1), id(2)].flatMap((v) => [
      `${v} “Video ${v}”: 1:00, 6 words (analysis/demo/${v}.txt)`,
      '  Words a minute, per 5-minute block: 0–1 min 6',
      '  Most replayed: YouTube shows none for this video',
      '  Chapters: none set',
      '  First 150 s: Here is the wreck. Peace out.',
      '  Last 100 s: Here is the wreck. Peace out.',
    ]));
    expect(await readFile(join(dir, 'analysis', 'demo', `${id(1)}.txt`), 'utf8')).toBe('[0:00] Here is the wreck.\n[0:50] Peace out.\n');
  });

  it('says which video has no captions or can\'t be read, and carries on with the others', async () => {
    const dir = await gathered(5);
    const { deps } = captionStubs({ noCaptions: [id(1)], fails: [id(2)], noInfo: [id(3)] });
    const report = await channelCaptions(dir, 'demo', [id(1), id(2), id(3), id(4)], deps);
    expect(report.filter((l) => !l.startsWith('  '))).toEqual([
      `⚠ ${id(1)} “Video ${id(1)}”: no English captions — no transcript for this video`,
      `⚠ ${id(2)}: yt-dlp couldn't read this video (yt-dlp exited with code 1 — ERROR: [youtube] Private video) — it is left out`,
      `⚠ ${id(3)}: yt-dlp wrote no info for this video — it is left out`,
      `${id(4)} “Video ${id(4)}”: 1:00, 6 words (analysis/demo/${id(4)}.txt)`,
    ]);
    expect(existsSync(join(dir, 'analysis', 'demo', `${id(1)}.txt`))).toBe(false);
    expect(existsSync(join(dir, 'analysis', 'demo', `${id(4)}.txt`))).toBe(true);
  });

  it('a missing yt-dlp stops the whole call, as does an id that is not one or an unknown channel', async () => {
    const dir = await gathered(3);
    const missing = Object.assign(new Error('yt-dlp was not found'), { code: 'NOT_FOUND', hint: 'Install yt-dlp' });
    await expect(channelCaptions(dir, 'demo', [id(1)], stubs({ ytDlp: async () => { throw missing; } }).deps)).rejects.toBe(missing);
    const { deps, calls } = stubs();
    await expect(channelCaptions(dir, 'demo', [id(1), '--exec=x'], deps)).rejects.toMatchObject({ code: 'BAD_INPUT', message: '"--exec=x" isn\'t a video id' });
    await expect(channelCaptions(dir, 'nope', [id(1)], deps)).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(calls.ytDlp).toEqual([]);
  });
});
