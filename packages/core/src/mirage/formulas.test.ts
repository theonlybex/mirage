// SPDX-License-Identifier: MIT
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadFormats } from './formats.js';
import { formulaLine, FormulaSchema, formulasDir, loadFormulas, mineId } from './formulas.js';

const FM = { id: 'demo', name: 'Demo formula', describe: 'A demo.', formats: ['short'], source: '@demo (latest 50 videos), measured 2026-11-09' };
const file = (fm: unknown, body = 'Rules.\n') => `---\n${typeof fm === 'string' ? fm : JSON.stringify(fm)}\n---\n${body}`;

async function folder(files: Record<string, string>, sub?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mirage-formulas-'));
  const dir = sub ? join(root, sub) : root;
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return root;
}

describe('the plugin\'s formula files', () => {
  const { formulas, problems } = loadFormulas();
  const by = Object.fromEntries(formulas.map((f) => [f.id, f]));

  it('are in the repository\'s plugin/formulas and all load, as Mirage\'s own', () => {
    expect(formulasDir().endsWith(join('plugin', 'formulas'))).toBe(true);
    expect(problems).toEqual([]);
    expect(formulas.map((f) => f.id)).toEqual(['algorithm', 'episode', 'instagram', 'short', 'tiktok', 'vlog', 'youtube']);
    for (const f of formulas) {
      expect(f.origin, f.id).toBe('mirage');
      expect(f.body.trim().length, f.id).toBeGreaterThan(500);
      expect(f.path).toBe(join(formulasDir(), f.file));
    }
  });

  it('name only formats that exist, and every format has a formula of its own', () => {
    const formats = loadFormats().formats.map((f) => f.id);
    for (const f of formulas) for (const id of f.formats) expect(formats, `${f.file} names the format ${id}`).toContain(id);
    expect(by.algorithm!.formats).toEqual(['build-story', 'short', 'vlog']);
    expect(by.youtube!.formats).toEqual(['build-story', 'short', 'vlog']);
    expect(by.episode!.formats).toEqual(['build-story']);
    expect(by.vlog!.formats).toEqual(['vlog']);
    expect(by.short!.formats).toEqual(['short']);
  });

  it('say what they were measured on, and when', () => {
    expect(by.episode!.source).toBe("Mat Armstrong's channel (latest 200 videos, 24 thumbnails, the captions of 3 videos), measured 2026-11-09");
    expect(by.vlog!.source).toBe("David Dobrik's channel (all 569 videos, 24 thumbnails, a 9-video breakdown), measured 2026-11-09");
    for (const f of formulas) expect(f.source, f.id).toContain('2026-11-09');
  });

  it('keep the numbers, the caveat on ×, the estimate label and what was not measured', () => {
    for (const id of ['algorithm', 'episode', 'vlog']) expect(by[id]!.body, id).toContain('not proof of cause');
    for (const id of ['episode', 'vlog']) {
      expect(by[id]!.body, id).toContain('## 7. What matters most (my estimate)');
      expect(by[id]!.body, id).toContain('an estimate, not a measurement');
      expect(by[id]!.body, id).toContain('## Checklist before publishing');
      expect(by[id]!.body, id).toContain('## Every measured detail');
    }
    for (const f of formulas) expect(f.body, `${f.id} never says what was not measured`).toMatch(/^#{2,3} Not measured(?: \/ not published)?$/m);
    for (const words of ['×1.35', '×1.21', '×0.82', '85–93%', '40–55 seconds', '145–200 words a minute', '13.0M against 8.6–9.9M', '35%']) expect(by.episode!.body, words).toContain(words);
    for (const words of ['×1.62', '×1.17', '×1.33', '×1.00', '50–90 seconds', '15–25 cuts a minute', '2.4×', '30%']) expect(by.vlog!.body, words).toContain(words);
    for (const words of ['Score each 0–2. Under 7 of 12, change the idea, not the edit.', '### 11. Repeat the frame', '| **Face** |', 'Nothing here has been tested on your own videos yet.']) expect(by.algorithm!.body, words).toContain(words);
    for (const words of ['"The audience is the algorithm."', 'Subscribers skip about 90% of uploads', 'https://support.google.com/youtube/answer/16089387', 'https://blog.youtube/inside-youtube/on-youtubes-recommendation-system/']) expect(by.youtube!.body, words).toContain(words);
    for (const words of ['*(YouTube)*', '*(study)*', '*(rule of thumb)*', '70%+ viewed vs swiped', '0.05%', 'first 2–3 seconds']) expect(by.short!.body, words).toContain(words);
  });

  it('has one algorithm file per platform a short goes to, each in the same shape: the platform\'s own words first, what differs, what it means for a cut, what is not published, and its sources', () => {
    const by = Object.fromEntries(formulas.map((f) => [f.id, f]));
    for (const [id, name, own] of [['instagram', 'Instagram', 'https://about.instagram.com/blog/announcements/instagram-ranking-explained'], ['tiktok', 'TikTok', 'https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you']] as const) {
      const f = by[id]!;
      expect(f.formats, id).toEqual(['short']);
      expect(f.source, id).toContain('read 2026-11-09');
      const heads = [`## In ${name}'s own words`, '## What differs from YouTube Shorts', '## What it means for a cut', '## What a cut can be checked for', '## Not measured / not published', '## Sources'];
      const at = heads.map((h) => f.body.indexOf(`\n${h}\n`));
      for (const [i, h] of heads.entries()) expect(at[i], `${id}: ${h}`).toBeGreaterThan(i ? at[i - 1]! : 0);
      for (const words of ['Researched online on 2026-11-09.', '**How far to trust this.**', 'publishes no thresholds', 'Nothing here was measured by Mirage', 'Cannot be measured from the cut:', "Mirage's `predict` holds a short to these", own]) expect(f.body, `${id}: ${words}`).toContain(words);
      // Its own statements come before anyone else's in the sources.
      expect(f.body.indexOf(own, at[5])).toBeLessThan(f.body.indexOf('Others:', at[5]) > 0 ? f.body.indexOf('Others:', at[5]) : Infinity);
    }
    // No number of the platform's is given without where it came from.
    expect(by.instagram!.body).toContain('3 minutes or less');
    expect(by.instagram!.body).toContain('*(Meta, written for ads; no figure is published for ordinary reels)*');
    expect(by.tiktok!.body).toContain('*(TikTok, for ads)*');
    expect(by.tiktok!.body).toContain('*(study');
    // YouTube's file names its Shorts part, which a short points at.
    expect(by.youtube!.body).toContain('\n## YouTube Shorts\n');
    expect(by.short!.body).toContain('**One file per platform.**');
  });

  it('stand alone: no local file names, no pictures, no worked example', () => {
    for (const f of formulas) {
      expect(f.body, f.id).not.toMatch(/\.(jpg|png)\b/);
      expect(f.body, f.id).not.toMatch(/the-algorithm\.md|creator-formulas\.md|vlogs-playbook\.md|viral-rules|episode-formula\.md|vlog-formula\.md|thumbnails\//);
      expect(f.body, f.id).not.toContain('Frigg');
    }
  });

  it('each format file points to its formulas', () => {
    const rules = Object.fromEntries(loadFormats().formats.map((f) => [f.id, f.rules]));
    for (const [format, formula] of [['build-story', 'episode'], ['vlog', 'vlog'], ['short', 'short']] as const) {
      expect(rules[format], format).toContain(`The measurements behind these rules: \`formulas { id: "${formula}" }\`; the reasoning under every format: \`formulas { id: "algorithm" }\`; how YouTube judges a video: \`formulas { id: "youtube" }\`.`);
    }
  });
});

describe('loadFormulas', () => {
  it('reads the front matter and the Markdown after it', async () => {
    const dir = await folder({ 'demo.md': file(FM, '# Demo\n\nOpen on the question.\n') });
    expect(loadFormulas(dir)).toEqual({
      formulas: [{ ...FM, origin: 'mirage', body: '# Demo\n\nOpen on the question.\n', file: 'demo.md', path: join(dir, 'demo.md') }],
      problems: [],
    });
  });

  it('adds the project\'s own after Mirage\'s, marked yours', async () => {
    const dir = await folder({ 'b.md': file({ ...FM, id: 'b' }), 'a.md': file({ ...FM, id: 'a' }) });
    const project = await folder({ 'mine.md': file({ ...FM, id: 'mine', formats: [] }), 'aa.md': file({ ...FM, id: 'aa' }) }, 'formulas');
    const { formulas, problems } = loadFormulas(dir, project);
    expect(problems).toEqual([]);
    expect(formulas.map((f) => [f.id, f.origin])).toEqual([['a', 'mirage'], ['b', 'mirage'], ['aa', 'yours'], ['mine', 'yours']]);
    expect(formulas[3]).toMatchObject({ formats: [], path: join(project, 'formulas', 'mine.md') });
  });

  it('passes over the project\'s changes.md, the log of changes to the person\'s formulas', async () => {
    const dir = await folder({ 'a.md': file({ ...FM, id: 'a' }) });
    const project = await folder({ 'short-mine.md': file({ ...FM, id: 'short-mine' }), 'changes.md': '# Changes to my formulas\n\n## 2026-11-09 · short · Open on the hook\n' }, 'formulas');
    expect(loadFormulas(dir, project)).toMatchObject({ formulas: [{ id: 'a' }, { id: 'short-mine', origin: 'yours' }], problems: [] });
    // Only there: a changes.md among Mirage's own would be a broken formula file.
    const own = await folder({ 'changes.md': 'notes' });
    expect(loadFormulas(own).problems).toEqual(['✖ plugin/formulas/changes.md: no front matter: the file must start with a --- line, a JSON object, and a --- line']);
  });

  it('a project without a formulas folder has none of its own, and that is no problem', async () => {
    const dir = await folder({ 'a.md': file({ ...FM, id: 'a' }) });
    expect(loadFormulas(dir, await mkdtemp(join(tmpdir(), 'mirage-formulas-')))).toMatchObject({ formulas: [{ id: 'a' }], problems: [] });
  });

  it('never lets a project file replace one of Mirage\'s own: it is left out and named', async () => {
    const dir = await folder({ 'episode.md': file({ ...FM, id: 'episode' }, 'Mirage\'s.\n'), 'broken.md': file('{') });
    const project = await folder({ 'episode.md': file({ ...FM, id: 'episode' }, 'Theirs.\n'), 'broken.md': file({ ...FM, id: 'broken' }), 'mine.md': file({ ...FM, id: 'mine' }) }, 'formulas');
    const { formulas, problems } = loadFormulas(dir, project);
    expect(formulas.map((f) => [f.id, f.origin, f.body])).toEqual([['episode', 'mirage', 'Mirage\'s.\n'], ['mine', 'yours', 'Rules.\n']]);
    expect(problems).toEqual([
      expect.stringMatching(/^✖ plugin\/formulas\/broken\.md: front matter is not valid JSON \(/),
      // Even a built-in that is broken keeps its name.
      '✖ formulas/broken.md: "broken" is one of Mirage\'s own formulas, which can\'t be changed — save yours under another name',
      '✖ formulas/episode.md: "episode" is one of Mirage\'s own formulas, which can\'t be changed — save yours under another name',
    ]);
  });

  it('puts each broken file in problems as one ✖ naming it, and still loads the others', async () => {
    const dir = await folder({
      'good.md': file({ ...FM, id: 'good' }),
      'mismatch.md': file({ ...FM, id: 'other' }),
      'nofront.md': 'just words\n',
      'notes.txt': 'not a formula',
    });
    const project = await folder({
      'mine.md': file({ ...FM, id: 'mine' }),
      'unknown.md': file({ ...FM, id: 'unknown', words: ['x'] }),
      'twolines.md': file({ ...FM, id: 'twolines', source: 'one\ntwo' }),
      'nosource.md': file({ id: 'nosource', name: 'N', describe: 'd', formats: [] }),
      'noend.md': '---\n{"id":"noend"}\n',
    }, 'formulas');
    const { formulas, problems } = loadFormulas(dir, project);
    expect(formulas.map((f) => f.id)).toEqual(['good', 'mine']);
    expect(problems).toEqual([
      '✖ plugin/formulas/mismatch.md: id: the id "other" must be the file name, "mismatch"',
      '✖ plugin/formulas/nofront.md: no front matter: the file must start with a --- line, a JSON object, and a --- line',
      '✖ formulas/noend.md: front matter has no closing --- line',
      expect.stringMatching(/^✖ formulas\/nosource\.md: source: /),
      '✖ formulas/twolines.md: source: must be one line',
      '✖ formulas/unknown.md: unknown key "words" (valid keys: id, name, describe, formats, source, playbook)',
    ]);
  });

  it('says so when Mirage\'s folder is missing, without throwing, and still reads the project\'s', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'mirage-formulas-')), 'nope');
    expect(loadFormulas(dir)).toEqual({ formulas: [], problems: ['✖ plugin/formulas: the folder is missing or unreadable'] });
    const project = await folder({ 'mine.md': file({ ...FM, id: 'mine' }) }, 'formulas');
    expect(loadFormulas(dir, project)).toMatchObject({ formulas: [{ id: 'mine', origin: 'yours' }], problems: ['✖ plugin/formulas: the folder is missing or unreadable'] });
  });
});

describe('FormulaSchema', () => {
  it('needs an id of lower-case words, a one-line describe and source, and a list of formats that may be empty', () => {
    expect(FormulaSchema.safeParse(FM).success).toBe(true);
    expect(FormulaSchema.safeParse({ ...FM, formats: [] }).success).toBe(true);
    expect(FormulaSchema.safeParse({ ...FM, id: 'My Formula' }).success).toBe(false);
    expect(FormulaSchema.safeParse({ ...FM, describe: 'a\nb' }).success).toBe(false);
    expect(FormulaSchema.safeParse({ ...FM, source: '' }).success).toBe(false);
    expect(FormulaSchema.safeParse({ ...FM, formats: 'short' }).success).toBe(false);
  });

  it('may carry a playbook, the same object a format file has, and refuses one that is not', () => {
    expect(FormulaSchema.safeParse({ ...FM, playbook: { firstWordSec: 1.5, cutsPerMin: { min: 24 } } }).success).toBe(true);
    expect(FormulaSchema.safeParse({ ...FM, playbook: { firstWordSec: 'soon' } }).success).toBe(false);
    expect(FormulaSchema.safeParse({ ...FM, playbook: { hookSec: 1 } }).success).toBe(false);
    expect(mineId('short')).toBe('short-mine');
  });

  it("none of Mirage's own formulas carries a playbook: the numbers are the format files', and only a person's formula replaces them", () => {
    for (const f of loadFormulas().formulas) expect(f.playbook, f.id).toBeUndefined();
  });
});

describe('formulaLine', () => {
  it('names the formula, its formats, what it was measured on, and whose it is', () => {
    const base = { ...FM, body: '', file: 'demo.md', path: '/x/demo.md' };
    expect(formulaLine({ ...base, origin: 'mirage' })).toBe("demo — Demo formula: A demo. (formats: short; measured on: @demo (latest 50 videos), measured 2026-11-09) (Mirage's, can't be changed)");
    expect(formulaLine({ ...base, origin: 'yours', formats: [] })).toBe('demo — Demo formula: A demo. (formats: none; measured on: @demo (latest 50 videos), measured 2026-11-09) (yours)');
  });
});

describe('formulasDir', () => {
  it('from the bundle is the plugin\'s own formulas folder (plugin/dist/engine.mjs → plugin/formulas)', async () => {
    const plugin = await mkdtemp(join(tmpdir(), 'we formulas '));
    expect(formulasDir(pathToFileURL(join(plugin, 'dist', 'engine.mjs')).href)).toBe(join(plugin, 'formulas'));
  });

  it('from the source or its build is the repository\'s plugin/formulas', () => {
    for (const where of ['src', 'dist']) expect(formulasDir(join('x', 'repo', 'packages', 'core', where, 'mirage', 'formulas.js'))).toMatch(/repo[\\/]plugin[\\/]formulas$/);
  });
});
