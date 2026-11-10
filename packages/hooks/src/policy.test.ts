// SPDX-License-Identifier: MIT
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionState } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { fileDecision, isChanging, isStage, stepLabel, videoOf } from './policy.js';

const E = (x: string) => `mcp__plugin_mirage_engine__${x}`;
const session = (video: number | null): SessionState => ({ video, overnight: null, awakePid: null });
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'mirage-policy-')));

describe('stepLabel', () => {
  const rows: [string, unknown, string, string][] = [
    [E('new_project'), {}, 'Starting the project', 'Project started'],
    [E('new_video'), {}, 'Setting up the video', 'Video set up'],
    [E('ingest'), {}, 'Cataloguing your clips', 'Clips catalogued'],
    [E('music'), {}, 'Reading the music', 'Music read'],
    [E('check'), { video: 1 }, 'Checking the timeline', 'Timeline checked'],
    [E('cut'), { video: 1 }, 'Rendering the rough cut', 'Rough cut rendered'],
    [E('slots'), { video: 1 }, 'Finding room for narration', 'Narration slots found'],
    [E('guide'), { video: 1 }, 'Rendering the guide video', 'Guide video rendered'],
    [E('vo'), { video: 1 }, 'Fitting your voice-over', 'Voice-over fitted'],
    [E('speak'), { video: 1 }, 'Reading the narration aloud', 'Narration read and fitted'],
    [E('render'), { video: 1 }, 'Rendering the final video', 'Final video rendered'],
    [E('versions'), { video: 1 }, 'Checking', 'Checked'],
    [E('status'), {}, 'Checking', 'Checked'],
    [E('restore'), { video: 1 }, 'Going back to an earlier version', 'Went back'],
    [E('get_notes'), { video: 1 }, 'Reading your notes', 'Read your notes'],
    [E('note_status'), { video: 1 }, 'Updating a note', 'Note updated'],
    [E('log'), { video: 1 }, 'Making a note for you', 'Noted'],
    [E('overnight'), {}, 'Getting ready for overnight', 'Ready for overnight'],
    [E('setup_later'), {}, 'Noting that for later', 'Noted for later'],
    [E('formats'), {}, 'Looking up the formats', 'Formats looked up'],
    [E('formulas'), { id: 'episode' }, 'Looking up the formulas', 'Formulas looked up'],
    [E('channel'), { url: '@demo' }, 'Reading the channel', 'Channel read'],
    [E('posted'), { video: 1, url: 'https://youtu.be/aaaaaaaaaa1' }, 'Noting where the video is posted', 'Posted video noted'],
    [E('learn'), {}, 'Reading how your videos did', 'Results read'],
    [E('predict'), { video: 2 }, 'Forecasting how the video will do', 'Forecast ready'],
    [E('thumbnail'), { video: 1 }, 'Picking thumbnail frames', 'Thumbnail frames ready'],
    [E('thumbnail'), { video: 1, at: 12.5 }, 'Writing the thumbnail', 'Thumbnail written'],
    [E('thumbnail'), { video: 1, at: 0, text: 'Ship it' }, 'Writing the thumbnail', 'Thumbnail written'],
    ['Read', { file_path: '/p/frames/c001/0001.jpg' }, 'Looking at clips', 'Looked at clips'],
    ['Read', { file_path: '/p/episodes/1/summary.md' }, 'Reading summary.md', 'Read summary.md'],
    ['Write', { file_path: '/p/episodes/1/episode.json' }, 'Writing the timeline', 'Timeline written'],
    ['Edit', { file_path: '/p/episodes/2/episode.json' }, 'Writing the timeline', 'Timeline written'],
    ['MultiEdit', { file_path: '/p/catalog.json' }, 'Describing clips', 'Clips described'],
    ['Write', { file_path: '/p/catalog.json' }, 'Describing clips', 'Clips described'],
    ['Edit', { file_path: '/p/episodes/1/summary.md' }, 'Saving summary.md', 'Saved summary.md'],
    ['Glob', { pattern: '**/*.json' }, 'Looking through the project', 'Looked through the project'],
    ['Grep', { pattern: 'x' }, 'Looking through the project', 'Looked through the project'],
    ['mcp__plugin_hyperframes_studio__render', {}, 'Working', 'Done'],
    ['Bash', { command: 'ls' }, 'Working', 'Done'],
    ['WebFetch', { url: 'x' }, 'Working', 'Done'],
    [E('something_new'), {}, 'Working', 'Done'],
  ];
  it.each(rows)('%s %j', (tool, input, label, doneLabel) => {
    expect(stepLabel(tool, input)).toEqual({ label, doneLabel });
  });

  it('copes with odd input', () => {
    expect(stepLabel('Read', undefined)).toEqual({ label: 'Working', doneLabel: 'Done' });
    expect(stepLabel('Write', 'not an object')).toEqual({ label: 'Working', doneLabel: 'Done' });
    expect(stepLabel('Read', { file_path: 'C:\\proj\\episodes\\1\\summary.md' })).toEqual({ label: 'Reading summary.md', doneLabel: 'Read summary.md' });
  });
});

describe('videoOf', () => {
  const p = '/proj';
  it('takes the engine input video, then a file path, then the session', () => {
    expect(videoOf(E('check'), { video: 3 }, p, session(1))).toBe(3);
    expect(videoOf('Write', { file_path: '/proj/episodes/4/episode.json' }, p, session(1))).toBe(4);
    expect(videoOf('Read', { file_path: 'episodes/5/summary.md' }, p, session(1))).toBe(5);
    expect(videoOf('Bash', { command: 'ls' }, p, session(2))).toBe(2);
    expect(videoOf(E('ingest'), { folder: '/x' }, p, session(2))).toBe(2);
    expect(videoOf(E('thumbnail'), { video: 4 }, p, session(2))).toBe(4);
    expect(videoOf('Bash', {}, p, session(null))).toBeNull();
  });

  it('gives no video to the tools that make one', () => {
    expect(videoOf(E('new_project'), { title: 'x' }, p, session(2))).toBeNull();
    expect(videoOf(E('new_video'), { title: 'x' }, p, session(2))).toBeNull();
    expect(videoOf(E('setup_later'), {}, p, session(2))).toBeNull();
    expect(videoOf(E('formats'), { id: 'short' }, p, session(2))).toBeNull();
    expect(videoOf(E('formulas'), { id: 'episode' }, p, session(2))).toBeNull();
    expect(videoOf(E('channel'), { name: 'demo', thumbnails: 'top' }, p, session(2))).toBeNull();
    // learn is about every posted video (its studio numbers name one inside `studio`); posted is about the video it names.
    expect(videoOf(E('learn'), { studio: { video: 3, clickRate: 4 } }, p, session(2))).toBeNull();
    expect(videoOf(E('posted'), { video: 3, url: 'https://youtu.be/aaaaaaaaaa1' }, p, session(2))).toBe(3);
    // predict forecasts the video it names.
    expect(videoOf(E('predict'), { video: 3 }, p, session(2))).toBe(3);
  });

  it('ignores odd input', () => {
    expect(videoOf(E('check'), { video: 'x' }, p, session(1))).toBe(1);
    expect(videoOf(E('check'), { video: -2 }, p, session(1))).toBe(1);
    expect(videoOf('Write', null, p, session(null))).toBeNull();
    expect(videoOf('Write', 7, p, session(null))).toBeNull();
    expect(videoOf('Write', { file_path: '/elsewhere/episodes/9/episode.json' }, p, session(null))).toBeNull();
    expect(videoOf('Write', { file_path: 'C:\\proj\\episodes\\1\\episode.json' }, p, session(null))).toBeNull();
  });
});

describe('isChanging and isStage', () => {
  const p = '/proj';
  it('counts engine tools but the read-only ones, and saves inside episodes/ or of catalog.json', () => {
    for (const t of ['check', 'cut', 'ingest', 'restore', 'note_status', 'new_video', 'vo', 'speak']) expect(isChanging(E(t), {}, p)).toBe(true);
    for (const t of ['versions', 'status', 'get_notes', 'log', 'formats', 'thumbnail', 'formulas', 'channel', 'posted', 'learn', 'predict']) expect(isChanging(E(t), {}, p)).toBe(false);
    expect(isChanging('Write', { file_path: '/proj/episodes/1/episode.json' }, p)).toBe(true);
    expect(isChanging('Edit', { file_path: '/proj/episodes/1/notes/x.txt' }, p)).toBe(true);
    expect(isChanging('MultiEdit', { file_path: '/proj/catalog.json' }, p)).toBe(true);
    expect(isChanging('Write', { file_path: '/proj/README.md' }, p)).toBe(false);
    expect(isChanging('Read', { file_path: '/proj/episodes/1/episode.json' }, p)).toBe(false);
    expect(isChanging('Bash', { command: 'rm -rf /' }, p)).toBe(false);
    expect(isChanging('Write', undefined, p)).toBe(false);
  });

  it('isStage is true only for the engine stages', () => {
    for (const t of ['ingest', 'check', 'cut', 'slots', 'guide', 'vo', 'speak', 'render']) expect(isStage(E(t))).toBe(true);
    for (const t of ['new_project', 'new_video', 'music', 'versions', 'restore', 'status', 'log', 'overnight', 'setup_later', 'formats', 'thumbnail', 'formulas', 'channel', 'posted', 'learn', 'predict']) expect(isStage(E(t))).toBe(false);
    expect(isStage('check')).toBe(false);
    expect(isStage('Write')).toBe(false);
  });
});

describe('fileDecision', () => {
  it('denies writes into footage, allows the timeline files, and leaves the rest alone', () => {
    const project = tmp();
    const footage = tmp();
    mkdirSync(join(project, 'episodes', '1'), { recursive: true });
    const deny = { deny: 'Footage folders are read-only in Mirage.' };
    expect(fileDecision('Write', { file_path: join(footage, 'a.mov') }, project, [footage])).toEqual(deny);
    expect(fileDecision('Edit', { file_path: join(footage, 'sub', 'new', 'b.txt') }, project, [footage])).toEqual(deny);
    expect(fileDecision('NotebookEdit', { notebook_path: join(footage, 'n.ipynb') }, project, [footage])).toEqual(deny);
    expect(fileDecision('MultiEdit', { file_path: footage }, project, [footage])).toEqual(deny);
    expect(fileDecision('Write', { file_path: join(project, 'catalog.json') }, project, [footage])).toBe('allow');
    expect(fileDecision('Write', { file_path: 'catalog.json' }, project, [footage])).toBe('allow');
    expect(fileDecision('Edit', { file_path: join(project, 'episodes', '1', 'episode.json') }, project, [footage])).toBe('allow');
    expect(fileDecision('MultiEdit', { file_path: join(project, 'episodes', '12', 'summary.md') }, project, [footage])).toBe('allow');
    expect(fileDecision('NotebookEdit', { file_path: join(project, 'catalog.json') }, project, [footage])).toBeNull();
    expect(fileDecision('Write', { file_path: join(project, 'episodes', '1', 'other.json') }, project, [footage])).toBeNull();
    expect(fileDecision('Write', { file_path: join(project, 'episodes', '1', 'x', 'episode.json') }, project, [footage])).toBeNull();
    expect(fileDecision('Write', { file_path: `${footage}-other/a.mov` }, project, [footage])).toBeNull();
    expect(fileDecision('Read', { file_path: join(footage, 'a.mov') }, project, [footage])).toBeNull();
    expect(fileDecision('Write', {}, project, [footage])).toBeNull();
    expect(fileDecision('Write', 'x', project, [footage])).toBeNull();
    const dotdot = { deny: 'Use a plain path inside the project (no “..”).' };
    expect(fileDecision('Write', { file_path: 'episodes/1/l/../episode.json' }, project, [footage])).toEqual(dotdot);
    expect(fileDecision('NotebookEdit', { notebook_path: `${footage}/../x.ipynb` }, project, [footage])).toEqual(dotdot);
    expect(fileDecision('Edit', { file_path: 'a\\..\\catalog.json' }, project, [footage])).toEqual(dotdot);
    expect(fileDecision('Read', { file_path: '../x' }, project, [footage])).toBeNull();
  });

  it('denies writes into the plugin\'s own formats, formulas and skills, and leaves the project\'s formulas folder alone', () => {
    const project = tmp();
    const plugin = tmp();
    for (const f of ['formats', 'formulas', 'skills', 'dist']) mkdirSync(join(plugin, f), { recursive: true });
    const deny = { deny: "Mirage's own formats, formulas and skills are read-only. Save your own formula in the project's formulas folder, under a new name." };
    expect(fileDecision('Write', { file_path: join(plugin, 'formulas', 'episode.md') }, project, [], plugin)).toEqual(deny);
    expect(fileDecision('Edit', { file_path: join(plugin, 'formulas', 'new.md') }, project, [], plugin)).toEqual(deny);
    expect(fileDecision('MultiEdit', { file_path: join(plugin, 'formats', 'vlog.md') }, project, [], plugin)).toEqual(deny);
    expect(fileDecision('Write', { file_path: join(plugin, 'skills', 'edit', 'SKILL.md') }, project, [], plugin)).toEqual(deny);
    expect(fileDecision('NotebookEdit', { notebook_path: join(plugin, 'skills', 'n.ipynb') }, project, [], plugin)).toEqual(deny);
    // Through a link in the project too.
    symlinkSync(join(plugin, 'formulas'), join(project, 'theirs'));
    expect(fileDecision('Write', { file_path: join(project, 'theirs', 'episode.md') }, project, [], plugin)).toEqual(deny);
    // The person's own formula and analysis, a read of Mirage's, and the rest of the plugin are not this guard's business.
    expect(fileDecision('Write', { file_path: join(project, 'formulas', 'mine.md') }, project, [], plugin)).toBeNull();
    expect(fileDecision('Write', { file_path: join(project, 'analysis', 'demo', 'diagnosis.md') }, project, [], plugin)).toBeNull();
    expect(fileDecision('Read', { file_path: join(plugin, 'formulas', 'episode.md') }, project, [], plugin)).toBeNull();
    expect(fileDecision('Write', { file_path: join(plugin, 'dist', 'x.txt') }, project, [], plugin)).toBeNull();
    expect(fileDecision('Write', { file_path: `${join(plugin, 'formulas')}-mine/a.md` }, project, [], plugin)).toBeNull();
    // Without a known plugin folder there is nothing to guard.
    expect(fileDecision('Write', { file_path: join(plugin, 'formulas', 'episode.md') }, project, [])).toBeNull();
    expect(fileDecision('Write', { file_path: join(plugin, 'formulas', 'episode.md') }, project, [], '')).toBeNull();
  });

  it('sees through symlinks, both ways', () => {
    const project = tmp();
    const real = tmp();
    symlinkSync(real, join(project, 'clips'));
    // A path through a link in the project into the footage folder.
    expect(fileDecision('Write', { file_path: join(project, 'clips', 'new.mov') }, project, [real])).toEqual({ deny: 'Footage folders are read-only in Mirage.' });
    // A footage folder named through a link; the write names the real folder.
    const viaLink = join(tmp(), 'footage-link');
    symlinkSync(real, viaLink);
    expect(fileDecision('Edit', { file_path: join(real, 'x.txt') }, project, [viaLink])).toEqual({ deny: 'Footage folders are read-only in Mirage.' });
    // A dangling link pointing into footage.
    symlinkSync(join(real, 'not-yet.mov'), join(project, 'dangling.mov'));
    expect(fileDecision('Write', { file_path: join(project, 'dangling.mov') }, project, [real])).toEqual({ deny: 'Footage folders are read-only in Mirage.' });
  });
});
