// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatOf, FormatSchema, formatsDir, loadFormats, type Format } from './formats.js';

const FM = {
  id: 'demo', name: 'Demo', describe: 'A demo format.', words: ['demo'], beats: ['open', 'close'],
};
const file = (fm: unknown, body = 'Rules.\n') => `---\n${typeof fm === 'string' ? fm : JSON.stringify(fm)}\n---\n${body}`;

async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mirage-formats-'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

describe('the plugin\'s format files', () => {
  const dir = formatsDir();
  it('are in the repository\'s plugin/formats and all load, build-story first', () => {
    expect(dir.endsWith(join('plugin', 'formats'))).toBe(true);
    const { formats, problems } = loadFormats();
    expect(problems).toEqual([]);
    expect(formats.map((f) => f.id)).toEqual(['build-story', 'short', 'vlog']);
    expect(formats.map((f) => f.file)).toEqual(['build-story.md', 'short.md', 'vlog.md']);
    for (const f of formats) expect(f.rules.trim().length, f.id).toBeGreaterThan(0);
  });

  it('hold the exact front matter', () => {
    const by = Object.fromEntries(loadFormats().formats.map((f) => [f.id, f]));
    expect(by['build-story']).toMatchObject({
      name: 'Build story', describe: 'A build told as a story: the stakes, the failures, a montage, the reveal.',
      words: ['build', 'episode', 'part', 'series', 'project', 'devlog'],
      beats: ['cold-open', 'title', 'recap', 'new-toy', 'problem', 'montage', 'twist', 'truth', 'outro', 'blooper'],
      output: { width: 1920, height: 1080 },
    });
    expect(by['build-story']!.targetSec).toBeUndefined();
    expect(by.short).toMatchObject({
      name: 'Short', describe: '20–45 s vertical video that opens on its hook; made from a big video it\'s a teaser pointing to it.',
      words: ['short', 'shorts', 'reel', 'reels', 'tiktok', 'teaser', 'clip'], beats: ['hook', 'tease', 'pointer', 'payoff', 'loop'],
      targetSec: 45, warnPastSec: 60, output: { width: 1080, height: 1920 }, captions: { style: 'pop', position: 'middle' }, short: { kind: 'teaser' },
    });
    expect(by.vlog).toMatchObject({
      name: 'Vlog', describe: 'A day or a week of someone\'s life told as a few funny bits, ending on the headline bit.',
      words: ['vlog', 'day in the life', 'trip', 'week', 'hanging out', 'weekend'],
      beats: ['cold-open', 'title-card', 'premise', 'bit', 'headline', 'sponsor', 'plugs', 'tag'],
      targetSec: 260, warnPastSec: 400, output: { width: 1920, height: 1080 }, captions: { style: 'chosen' },
    });
  });

  it('have rules that name every beat of their front matter, as `beat`', () => {
    for (const f of loadFormats().formats) {
      for (const beat of f.beats) expect(f.rules, `${f.file} never names its ${beat} beat`).toContain(`\`${beat}\``);
    }
  });

  it('the build story points to the edit skill, whose build-story rules are pinned there', () => {
    const story = loadFormats().formats.find((f) => f.id === 'build-story')!;
    expect(story.rules).toContain('mirage:edit');
    // It has a Packaging part, so it can't say it adds nothing.
    expect(story.rules).not.toContain('This file adds nothing to them.');
    expect(story.rules).toContain("its Packaging part below only points to the edit skill's");
  });

  it('the short keeps the payoff in the big video, and says how the two kinds end', () => {
    const short = loadFormats().formats.find((f) => f.id === 'short')!;
    expect(short.rules).toContain("A teaser short never shows the headline's reveal.");
    for (const words of ['frame 0', 'Full video on my channel', 'Related video', 'link in the bio', '1080×1920', '"style": "pop", "position": "middle"', '`from`']) {
      expect(short.rules, `short never says ${words}`).toContain(words);
    }
  });

  it('the vlog has the playbook\'s numbers and guardrails', () => {
    const vlog = loadFormats().formats.find((f) => f.id === 'vlog')!;
    for (const words of ['8–15 s', '2 s', '30–50 s', '`mono`', 'Vlog #', 'Cut out on the laugh', 'one song per bit', 'Cut whole bits before thinning laughs', '`hide`', 'injur', "the number counts up from the project's last vlog of that name by itself"]) {
      expect(vlog.rules, `vlog never says ${words}`).toContain(words);
    }
  });
});

describe('packaging in the format files', () => {
  const body = (id: string) => loadFormats().formats.find((f) => f.id === id)!.rules;
  it('every format has a packaging part naming its title style', () => {
    for (const id of ['build-story', 'short', 'vlog']) expect(body(id), `${id} has no packaging part`).toContain('## Packaging');
    expect(body('vlog')).toContain('ALL CAPS');
    expect(body('vlog')).toContain('"This was a bad idea"');
    expect(body('short')).toContain('asks the big video\'s question');
    expect(body('build-story')).toContain('all caps with a number');
  });
  it('each says what its thumbnail shows', () => {
    expect(body('vlog')).toContain('no text, no arrows, unless the person asks for words');
    expect(body('short')).toContain('cover (1080×1920)');
    expect(body('build-story')).toContain('before/after');
    // Descriptions: the licence lines come from the music library.
    expect(body('short')).toContain('with facts from the person, the catalog or the music library only');
    expect(body('vlog')).toContain('but the person, the catalog and the music library');
  });
});

describe('loadFormats', () => {
  it('reads front matter (a JSON object between --- lines) and the rules after it', async () => {
    const dir = await folder({ 'demo.md': file({ ...FM, targetSec: 30 }, '# Rules\n\nOpen on the joke.\n') });
    const { formats, problems } = loadFormats(dir);
    expect(problems).toEqual([]);
    expect(formats).toEqual([{ ...FM, targetSec: 30, rules: '# Rules\n\nOpen on the joke.\n', file: 'demo.md' }]);
  });

  it('reads a file with Windows line endings', async () => {
    const dir = await folder({ 'demo.md': file({ ...FM }, 'Line one.\n').replace(/\n/g, '\r\n') });
    const { formats, problems } = loadFormats(dir);
    expect(problems).toEqual([]);
    expect(formats[0]).toMatchObject({ id: 'demo', rules: 'Line one.\n' });
  });

  it('reads a file that starts with a byte order mark (as some Windows editors save it)', async () => {
    const dir = await folder({ 'demo.md': '\uFEFF' + file({ ...FM }, 'Line one.\n') });
    const { formats, problems } = loadFormats(dir);
    expect(problems).toEqual([]);
    expect(formats[0]).toMatchObject({ id: 'demo', rules: 'Line one.\n' });
  });

  it('keeps the caption style and position the file itself writes, without the schema\'s defaults', async () => {
    const dir = await folder({ 'a.md': file({ ...FM, id: 'a', captions: { style: 'chosen' } }), 'b.md': file({ ...FM, id: 'b', captions: { style: 'pop', position: 'middle', highlight: ['x'] } }), 'c.md': file({ ...FM, id: 'c' }) });
    const by = Object.fromEntries(loadFormats(dir).formats.map((f) => [f.id, f]));
    expect(by.a!.statedCaptions).toEqual({ style: 'chosen' });
    expect(by.a!.captions).toMatchObject({ style: 'chosen', position: 'bottom' });
    expect(by.b!.statedCaptions).toEqual({ style: 'pop', position: 'middle' });
    expect(by.c).not.toHaveProperty('statedCaptions');
    const plugin = Object.fromEntries(loadFormats().formats.map((f) => [f.id, f.statedCaptions]));
    expect(plugin).toEqual({ 'build-story': undefined, short: { style: 'pop', position: 'middle' }, vlog: { style: 'chosen' } });
  });

  it('puts a broken file in problems as one ✖ naming it, and still loads the others', async () => {
    const dir = await folder({
      'good.md': file({ ...FM, id: 'good' }),
      'badjson.md': file('{"id": "badjson",'),
      'unknown.md': file({ ...FM, id: 'unknown', wrods: ['x'] }),
      'mismatch.md': file({ ...FM, id: 'other' }),
      'nofront.md': 'just rules\n',
      'badbeat.md': file({ ...FM, id: 'badbeat', beats: ['Title Card'] }),
      'noend.md': '---\n{"id":"noend"}\n',
      'odd.md': file({ ...FM, id: 'odd', output: { width: 1081, height: 1920 } }),
      'notes.txt': 'not a format',
    });
    const { formats, problems } = loadFormats(dir);
    expect(formats.map((f) => f.id)).toEqual(['good']);
    expect(problems).toEqual([
      '✖ plugin/formats/badbeat.md: beats[0]: Invalid string: must match pattern /^[a-z][a-z0-9-]*$/',
      expect.stringMatching(/^✖ plugin\/formats\/badjson\.md: front matter is not valid JSON \(/),
      '✖ plugin/formats/mismatch.md: id: the id "other" must be the file name, "mismatch"',
      '✖ plugin/formats/noend.md: front matter has no closing --- line',
      '✖ plugin/formats/nofront.md: no front matter: the file must start with a --- line, a JSON object, and a --- line',
      '✖ plugin/formats/odd.md: output.width: must be even',
      '✖ plugin/formats/unknown.md: unknown key "wrods" (valid keys: id, name, describe, words, beats, targetSec, warnPastSec, output, captions, short)',
    ]);
  });

  it('says so when the folder is missing, without throwing', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'mirage-formats-')), 'nope');
    expect(loadFormats(dir)).toEqual({ formats: [], problems: ['✖ plugin/formats: the folder is missing or unreadable'] });
  });

  it('says a front matter that is not an object is a problem', async () => {
    const { problems } = loadFormats(await folder({ 'a.md': file('[1, 2]') }));
    expect(problems).toEqual(['✖ plugin/formats/a.md: front matter must be a JSON object']);
  });
});

describe('FormatSchema', () => {
  it('needs a non-empty list of beats, even output sizes and an id of lower-case words', () => {
    expect(FormatSchema.safeParse(FM).success).toBe(true);
    expect(FormatSchema.safeParse({ ...FM, beats: [] }).success).toBe(false);
    expect(FormatSchema.safeParse({ ...FM, id: 'Demo' }).success).toBe(false);
    expect(FormatSchema.safeParse({ ...FM, id: '1demo' }).success).toBe(false);
    expect(FormatSchema.safeParse({ ...FM, output: { width: 1080, height: 1919 } }).success).toBe(false);
    expect(FormatSchema.safeParse({ ...FM, short: { kind: 'standalone' } }).success).toBe(true);
    expect(FormatSchema.safeParse({ ...FM, short: { kind: 'other' } }).success).toBe(false);
  });
});

describe('formatsDir', () => {
  it('from the bundle is the plugin\'s own formats folder (plugin/dist/engine.mjs → plugin/formats)', async () => {
    const plugin = await mkdtemp(join(tmpdir(), 'we formats '));
    expect(formatsDir(pathToFileURL(join(plugin, 'dist', 'engine.mjs')).href)).toBe(join(plugin, 'formats'));
    expect(formatsDir(join(plugin, 'dist', 'engine.mjs'))).toBe(join(plugin, 'formats'));
  });

  it('from the source or its build is the repository\'s plugin/formats', () => {
    const root = join('x', 'repo');
    for (const where of ['src', 'dist']) expect(formatsDir(join(root, 'packages', 'core', where, 'mirage', 'formats.js'))).toMatch(/repo[\\/]plugin[\\/]formats$/);
    expect(existsSync(join(formatsDir(), 'short.md'))).toBe(true);
  });

  it('never looks outside its own plugin folder', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'we cache '));
    const plugin = join(cache, 'a', 'b', 'c', 'plugin');
    await mkdir(join(cache, 'a', 'plugin', 'formats'), { recursive: true });
    expect(formatsDir(join(plugin, 'dist', 'engine.mjs'))).toBe(join(plugin, 'formats'));
  });
});

describe('formatOf', () => {
  const build = { id: 'build-story' } as Format;
  const short = { id: 'short' } as Format;
  it('is the build story for a video with no format, or no video.json at all', () => {
    const video = { version: 1 as const, title: 't', about: '', mention: '', hide: '', footage: [], createdAt: 'x' };
    expect(formatOf(null, [short, build])).toBe(build);
    expect(formatOf(video, [short, build])).toBe(build);
  });
  it('is the named format', () => {
    const video = { version: 1 as const, title: 't', about: '', mention: '', hide: '', footage: [], createdAt: 'x', format: 'short' };
    expect(formatOf(video, [short, build])).toBe(short);
  });
  it('falls back to the build story for an unknown id (check reports it)', () => {
    const video = { version: 1 as const, title: 't', about: '', mention: '', hide: '', footage: [], createdAt: 'x', format: 'nope' };
    expect(formatOf(video, [short, build])).toBe(build);
  });
  it('the repository\'s files give the build story for a video without a format', async () => {
    const { formats } = loadFormats();
    expect(formatOf(null, formats).id).toBe('build-story');
    expect((await readFile(join(formatsDir(), 'build-story.md'), 'utf8')).startsWith('---\n')).toBe(true);
  });
});
