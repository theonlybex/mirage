// SPDX-License-Identifier: MIT
// The plugin end to end, without a model: the driver plays Claude Code (hooks, the engine over MCP, Write, the viewer
// monitor) on a temp project, and the viewer page is used in Chromium as the person would.
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Driver } from './driver.js';

type Clip = { id: string; path: string; probe: { durationSec: number } };
type VersionMeta = { id: string; kind: string; label: string; sessionId?: string };

const SEND_NOTES_LINE = 'Mirage viewer: the person sent 1 note(s) on video 1 (Rough cut). Use the mirage:notes skill for video 1.';

let driver: Driver | null = null;

test.afterEach(async ({}, info) => {
  // A failed test keeps its temp project to look at; its path is in the output.
  const failed = info.status !== info.expectedStatus;
  if (failed && driver) console.log(`kept the temp project: ${driver.root}`);
  await driver?.close(failed);
  driver = null;
});

/** The clip of the catalog that came from the footage file `name`. */
async function clipId(d: Driver, name: string): Promise<string> {
  const catalog = JSON.parse(await readFile(join(d.project, 'catalog.json'), 'utf8')) as { clips: Clip[] };
  const clip = catalog.clips.find((c) => c.path.endsWith(`/${name}`));
  if (!clip) throw new Error(`${name} is not in the catalog: ${catalog.clips.map((c) => c.path).join(', ')}`);
  return clip.id;
}

/** What a stopped or cancelled command must not leave in a video's folder: work folders, half-written renders, its lock. */
async function leftovers(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.startsWith('.work-') || f.includes('.partial-') || f === '.mirage.lock');
}

const episode = (items: unknown[], output = { width: 1280, height: 720, fps: 30 }) =>
  `${JSON.stringify({ version: 2, number: 1, title: 'The first cut', output, items }, null, 2)}\n`;

/** SessionStart, new_project, new_video and ingest, with the viewer started as the monitor would and opened on the Edit tab. */
async function setUp(page: Page, d: Driver): Promise<void> {
  await d.startEngine();
  d.startViewer();
  // Not a Mirage project yet: SessionStart has nothing to say.
  expect((await d.sessionStart()).stdout).toBe('');
  expect((await d.tool('new_project', { title: 'Build story' })).text).toBe(`created ${d.project}`);
  // The monitor starts the viewer once mirage.json is there; its first line carries the address.
  const url = await d.viewerUrl();
  expect((await d.tool('new_video', { title: 'The first cut', about: 'Testing Mirage end to end', footage: [d.clips] })).text).toMatch(/^video 1 created \(format build-story: /);
  await page.goto(`${url}#/v/1/edit`);
  await expect(page.getByRole('heading', { name: 'Steps' })).toBeVisible();
  const ingest = await d.tool('ingest', { folder: d.clips });
  expect(ingest.isError, ingest.text).toBe(false);
  expect(ingest.text).toContain('clips added');
}

test('an edit shows up live, and notes reach Claude', async ({ page }) => {
  const d = (driver = await Driver.create());
  await setUp(page, d);

  const tone = await clipId(d, 'tone-6s.mp4');
  const silent = await clipId(d, 'silent-6s.mp4');
  const write = await d.write(
    'episodes/1/episode.json',
    episode([
      { id: 'open', beat: 'cold-open', clip: tone, src: { in: 0, out: 5 } },
      { id: 'fail', beat: 'problem', clip: silent, src: { in: 1, out: 5 } },
    ]),
  );
  expect(write.denied).toBeNull();
  const check = await d.tool('check', { video: 1 });
  expect(check.isError, check.text).toBe(false);
  const cut = await d.tool('cut', { video: 1 });
  expect(cut.isError, cut.text).toBe(false);

  // Edit: the timeline's Picture lane and the steps.
  const picture = page.locator('[data-lane="picture"] > [role="listitem"]');
  await expect(picture).toHaveCount(2);
  await expect(page.locator('.steps .step__label', { hasText: /^Rough cut rendered$/ })).toBeVisible();

  // Versions: the rough cut is V1.
  await page.getByRole('link', { name: 'Versions' }).click();
  await expect(page.getByText('V1 · Rough cut', { exact: false })).toBeVisible();

  // Review: the rough cut plays.
  await page.getByRole('link', { name: 'Review' }).click();
  const video = page.locator('video.player__video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { message: 'the rough cut loads' }).toBeGreaterThanOrEqual(2);

  // A note at the clicked moment: go to 2.5 s, click the picture, write it, add it.
  await video.evaluate(
    (v: HTMLVideoElement) =>
      new Promise<void>((ok) => {
        v.addEventListener('seeked', () => ok(), { once: true });
        v.currentTime = 2.5;
      }),
  );
  await page.locator('.player__surface').click({ position: { x: 200, y: 150 } });
  await expect(page.locator('.composer__when')).toHaveText(/^Note at 0:02/);
  await page.getByLabel('Your note').fill('too dark');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('button', { name: /^0:02: too dark\./ })).toBeVisible();

  // Send: Claude hears the viewer's line.
  await page.getByRole('button', { name: 'Send notes (1)' }).click();
  expect(await d.waitForLine((l) => l.includes('note(s)'))).toBe(SEND_NOTES_LINE);
  // And the note is there for Claude, at the moment that was clicked.
  const notes = await d.tool('get_notes', { video: 1 });
  expect(notes.text).toMatch(/^Note n1 at 2\.5 s: too dark$/m);
});

test('pause now, a correction on resume, then stop goes back to the last finished step', async ({ page }) => {
  const d = (driver = await Driver.create({
    // A 60 s clip: tone-6s.mp4 ten times over, so the cut takes several seconds.
    extraClips: (clips, env) =>
      new Promise<void>((ok, fail) => {
        const ffmpeg = join(env.WORDEDITS_FFMPEG_DIR!, 'ffmpeg');
        const args = ['-v', 'error', '-y', '-stream_loop', '9', '-i', join(clips, 'tone-6s.mp4'), '-c', 'copy', join(clips, 'long take.mp4')];
        const p = spawn(ffmpeg, args, { stdio: 'inherit' });
        p.on('error', fail);
        p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited with ${code}`))));
      }),
  }));
  await setUp(page, d);

  const tone = await clipId(d, 'tone-6s.mp4');
  const silent = await clipId(d, 'silent-6s.mp4');
  const long = await clipId(d, 'long take.mp4');
  expect((await d.write('episodes/1/episode.json', episode([
    { id: 'open', beat: 'cold-open', clip: tone, src: { in: 0, out: 5 } },
    { id: 'fail', beat: 'problem', clip: silent, src: { in: 1, out: 5 } },
  ]))).denied).toBeNull();
  // A finished stage: its checkpoint is where Stop goes back to.
  expect((await d.tool('check', { video: 1 })).isError).toBe(false);
  // Then a slow cut: one 60 s item, in 4K at 60 fps.
  expect((await d.write('episodes/1/episode.json', episode([{ id: 'long', beat: 'montage', clip: long, src: { in: 0, out: 60 } }], { width: 3840, height: 2160, fps: 60 }))).denied).toBeNull();

  // Pause now while the cut runs: the cut stops.
  const cutting = d.tool('cut', { video: 1 });
  void cutting.catch(() => {}); // awaited below; a test that fails first mustn't also report it unhandled
  await expect(page.locator('.runbar__progress')).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: /Pause now/ }).click();
  const cut = await cutting;
  expect(cut.isError).toBe(true);
  expect(cut.text).toContain('Stopped by the person');
  const ep = join(d.project, 'episodes', '1');
  expect(await leftovers(ep), 'nothing half-made after Pause now').toEqual([]);
  await expect(page.locator('.runbar')).toHaveAttribute('data-state', 'paused');

  // The next step is held while paused.
  let settled = false;
  const next = d.tool('cut', { video: 1 }).finally(() => (settled = true));
  void next.catch(() => {}); // as above: close() ends a hook still held when the test fails
  await page.waitForTimeout(2000);
  expect(settled, 'the PreToolUse hook holds the next step while paused').toBe(false);

  // Resume with a correction: the held step is denied with the person's words.
  await page.getByLabel('Correction').fill('keep the intro');
  await page.getByRole('button', { name: 'Resume with this' }).click();
  const held = await next;
  expect(held.denied).toContain('“keep the intro”');

  // Stop: the page asks, then the Stop hook goes back to the last finished step when Claude's turn ends.
  const lastCheckpoint = await lastFinished(d);
  const checkpointed = await readFile(join(ep, 'versions', lastCheckpoint.id, 'episode.json'), 'utf8');
  // Before Stop, episode.json is the 60 s one, not the checkpoint's.
  expect(await readFile(join(ep, 'episode.json'), 'utf8')).not.toBe(checkpointed);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Stop the edit?' }).getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.runbar')).toHaveAttribute('data-state', 'stopping');
  await d.stop();

  expect(await readFile(join(ep, 'episode.json'), 'utf8')).toBe(checkpointed);
  expect(lastCheckpoint.label).toBe('Timeline checked');
  expect(await leftovers(ep), 'nothing half-made after Stop').toEqual([]);
  // The stop is cleared, so the person isn't locked out.
  await expect(page.locator('.runbar')).not.toHaveAttribute('data-state', 'stopping');
});

/** This session's newest checkpoint or "before" version of video 1 (version ids sort by time): where Stop goes back to. */
async function lastFinished(d: Driver): Promise<VersionMeta> {
  const dir = join(d.project, 'episodes', '1', 'versions');
  const metas: VersionMeta[] = [];
  for (const id of (await readdir(dir)).sort()) {
    const meta = await readFile(join(dir, id, 'meta.json'), 'utf8').then((t) => JSON.parse(t) as VersionMeta, () => null);
    if (meta?.id === id) metas.push(meta);
  }
  const last = metas.filter((v) => v.sessionId === d.sessionId && (v.kind === 'checkpoint' || v.kind === 'before')).at(-1);
  if (!last) throw new Error(`no checkpoint of this session in ${dir}`);
  return last;
}
