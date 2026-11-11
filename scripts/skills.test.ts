// SPDX-License-Identifier: MIT
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PlaybookSchema } from '../packages/core/src/mirage/formats.js';
import { MIN_TO_COMPARE, READS } from '../packages/core/src/mirage/learn.js';
import { WEIGHTS } from '../packages/core/src/mirage/predict.js';
import { TOOL_NAMES } from '../packages/mcp/src/server.js';

const ROOT = resolve(import.meta.dirname, '..');
const SKILLS = ['edit', 'notes', 'voiceover', 'overnight', 'setup', 'status', 'analyse', 'learn'] as const;
type Skill = (typeof SKILLS)[number];
const ENGINE = 'mcp__plugin_mirage_engine__';

const read = (name: Skill) => readFileSync(join(ROOT, 'plugin', 'skills', name, 'SKILL.md'), 'utf8');

/**
 * The frontmatter as Claude Code's YAML reader would see it, for the subset skills use: `key: value` lines, the value plain
 * or in double quotes. A plain value YAML would misread (one holding `: ` or ` #`, or starting with a YAML indicator) fails.
 */
function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error('no frontmatter at the top');
  const out: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^([a-z][a-z-]*): (.+)$/.exec(line);
    if (!kv) throw new Error(`not a key: value line: ${line}`);
    const [, key, raw] = kv as unknown as [string, string, string];
    if (raw.startsWith('"')) {
      out[key] = JSON.parse(raw) as string;
    } else {
      if (/: | #|^[-?:,[\]{}#&*!|>'%@`]/.test(raw)) throw new Error(`${key}: plain value YAML would misread (quote it): ${raw}`);
      out[key] = raw;
    }
  }
  return out;
}

/** The engine tools a skill names, as `mcp__plugin_mirage_engine__<tool>`. */
const toolsNamed = (text: string) => [...new Set([...text.matchAll(/mcp__plugin_mirage_engine__([a-z_]+)/g)].map((x) => x[1]!))];

/**
 * The old CLI skill's rule lines in their tool spelling. Only command spellings change: `pnpm mirage <cmd> <project> <n>`
 * becomes the tool `<cmd>`, the `--add`/`--slots` flags become the tool's `add`/`slots`, and paths lose their `<project>/` (the project is
 * the folder Claude Code runs in). One more: Claude can't send the guide file, the viewer shows it. Every other word stays.
 */
function toolSpelling(line: string): string {
  return line
    .replaceAll('`pnpm mirage ingest <project> <clips folder>`', '`ingest` with each of the video\'s footage folders')
    .replaceAll('`pnpm mirage music <project>`', '`music`')
    .replaceAll('`pnpm mirage vo <project> <n> <recording>`', '`vo` with the recording')
    .replace(/`pnpm mirage (\w+) <project> <n>`/g, '`$1`')
    .replace(/`--add --slots (\w+)`/g, '`add: true, slots: ["$1"]`')
    .replaceAll('`--add`', '`add: true`')
    .replaceAll('`<project>/', '`')
    .replaceAll('Then `guide` and send `guide.mp4`.', 'Then `guide`.');
}

describe('the plugin skills', () => {
  it.each(SKILLS)('%s has frontmatter with its name and a description', (name) => {
    const fm = frontmatter(read(name));
    expect(fm.name).toBe(name);
    expect(fm.description?.length).toBeGreaterThan(40);
  });

  it('edit has the description from the plan', () => {
    expect(frontmatter(read('edit')).description).toBe(
      'Make or change a Mirage video: catalogue the clips, write the timeline, render the rough cut, write narration lines and the guide. Use when the person wants to make a video, drops footage, or asks for changes to a Mirage video.',
    );
  });

  it.each(SKILLS)('%s names only engine tools that exist', (name) => {
    for (const tool of toolsNamed(read(name))) expect(TOOL_NAMES, `${ENGINE}${tool}`).toContain(tool);
  });

  it('edit names every engine tool it uses', () => {
    const named = toolsNamed(read('edit'));
    for (const tool of ['new_project', 'new_video', 'status', 'ingest', 'music', 'check', 'cut', 'slots', 'guide', 'vo', 'render']) expect(named).toContain(tool);
    // A tool spoken of by its short name (`cut`, `vo` …) must also be named in full somewhere in the skill.
    const short = [...read('edit').matchAll(/`([a-z_]+)`/g)].map((x) => x[1]!).filter((w) => TOOL_NAMES.includes(w));
    for (const tool of new Set(short)) expect(named, `edit uses \`${tool}\` without naming ${ENGINE}${tool}`).toContain(tool);
  });

  it.each([
    ['notes', ['get_notes', 'note_status', 'cut', 'guide', 'render']],
    ['voiceover', ['vo', 'render']],
    ['overnight', ['overnight', 'log']],
    ['setup', ['status', 'setup_later']],
    ['status', ['status', 'setup_later']],
    ['analyse', ['channel', 'formulas', 'formats', 'new_project']],
    ['learn', ['posted', 'learn', 'formulas', 'status', 'channel', 'new_video', 'predict']],
  ] as const)('%s names the engine tools it runs', (name, tools) => {
    const named = toolsNamed(read(name));
    for (const tool of tools) expect(named).toContain(tool);
  });

  it.each(SKILLS)('%s never mentions the command-line tool', (name) => {
    expect(read(name)).not.toContain('pnpm mirage');
  });

  it('edit keeps every rule line of the old skill, in tool spelling', () => {
    const edit = read('edit');
    const old = readFileSync(join(ROOT, 'scripts', 'fixtures', 'old-skill-warnings.txt'), 'utf8').split('\n').filter((l) => l.trim());
    expect(old.length).toBeGreaterThan(20);
    for (const line of old) {
      const now = toolSpelling(line);
      expect(now).not.toContain('pnpm mirage');
      expect(edit.includes(now), `edit lost: ${now}`).toBe(true);
    }
  });

  it('edit teaches the captions field: its styles, and pop for every new vertical video', () => {
    const edit = read('edit');
    expect(edit).toContain('captions');
    for (const style of ['phrase', 'pop', 'karaoke', 'chosen', 'off']) expect(edit, `edit never names the ${style} style`).toContain(`\`${style}\``);
    expect(edit).toContain('For every new short or vertical video, write "captions": { "style": "pop", "position": "middle" } into episode.json.');
  });

  it('edit teaches the move field: its keys, and the punch-in sentence', () => {
    const edit = read('edit');
    expect(edit).toContain('`move`');
    for (const key of ['zoom', 'focus', 'ease', 'start', 'end']) expect(edit, `edit never names move's ${key}`).toContain(`\`${key}\``);
    expect(edit).toContain('A punch-in is a move whose start is 0.15 s or less before its end, on the line just before the laugh.');
    expect(edit).toContain("move ends at");
    expect(edit).toContain("move starts at");
  });

  it('edit teaches J- and L-cuts: the fields, the rules, the sentence and each new warning', () => {
    const edit = read('edit');
    for (const key of ['leadIn', 'tailOut']) expect(edit, `edit never names ${key}`).toContain(`\`${key}\``);
    expect(edit).toContain('An L-cut lets a laugh or a reaction ring under the next shot; a J-cut lets the next scene\'s sound arrive first.');
    for (const message of [
      "`⚠ item <id> has leadIn/tailOut but doesn't keep its own sound (audio \"keep\" at speed 1) — it does nothing`",
      "`⚠ item <id>'s leadIn of <x> s is shortened to <y> s — <reason>`",
      "`⚠ voice-over line <slot> plays over item <id>'s carried-over sound (<a>–<b> s) — shorten the leadIn/tailOut or move the line`",
      "`⚠ item <id>'s carried-over sound (<a>–<b> s) plays over item <other>'s own words — shorten the leadIn/tailOut, or let the next shot start quieter`",
    ]) expect(edit, `edit never explains ${message}`).toContain(message);
    expect(edit).toContain("A `leadIn` or `tailOut` into a text card brings its words' captions over the card, as narration does.");
    const vlog = readFileSync(join(ROOT, 'plugin', 'formats', 'vlog.md'), 'utf8');
    expect(vlog).toContain('tailOut');
    expect(vlog).toContain('Let the laugh ring with a short `tailOut` when the next shot is quiet.');
    expect(vlog.match(/Cut out on the laugh/g)).toHaveLength(1);
  });

  it('edit teaches card items and the name, subtitle and timecard overlays', () => {
    const edit = read('edit');
    expect(edit).toContain('`card`');
    for (const word of ['mono', 'bold', 'image', 'sec']) expect(edit, `edit never names the card's ${word}`).toContain(`\`${word}\``);
    for (const kind of ['name', 'subtitle', 'timecard']) expect(edit, `edit never names the ${kind} overlay`).toContain(`\`${kind}\``);
    expect(edit).toContain('`sub`');
    expect(edit).toContain("A subtitle's text is words actually said at that moment: copy them from the transcript, never write new ones.");
    expect(edit).toContain("card image <path> is missing");
    expect(edit).toContain("isn't a PNG or JPEG");
    expect(edit).toContain("doesn't match what's said at");
    expect(edit).toContain('"9:41"');
    expect(edit).toContain('With `chosen` captions, place a few yourself; the person can add more.');
    expect(edit).toContain('Use `subtitle` only with captions style `chosen` (or `off`): automatic captions draw in the same place, over it.');
    expect(edit).toContain('`subtitle overlay <k> ("<text>") shows over the automatic captions — use captions style chosen, or remove it`');
    expect(edit).toContain("- Mark text cards `quiet` unless narration over the card is wanted (with narration over a text card, the captions can cover the card's text).");
    expect(edit).toContain("Follow the guardrails: only people who agreed to be on camera, what the person said must not show (`hide`) stays out, and the edit shouldn't make anyone look worse than they were.");
    expect(edit).not.toContain("the playbook's guardrails");
  });

  it('edit teaches sound effects and music dips: the field, the seven built-ins, the sfx folder and the rules', () => {
    const edit = read('edit');
    expect(edit).toContain('`sfx`');
    for (const key of ['sound', 'at', 'gainDb']) expect(edit, `edit never names sfx's ${key}`).toContain(`\`${key}\``);
    for (const name of ['whoosh', 'swoosh-out', 'hit', 'riser', 'pop', 'ding', 'click']) expect(edit, `edit never names the ${name} sound`).toContain(`\`${name}\``);
    expect(edit).toContain('`dips`');
    expect(edit).toContain('`sfx/`');
    expect(edit).toContain("Leave a sound effect out rather than use one that doesn't fit; the person reviews the finished edit, and a sound they don't like comes back as a note.");
  });

  it('edit picks a format from the person\'s words, says it in one line and follows its rules', () => {
    const edit = read('edit');
    expect(edit).toContain('Pick the format from the person\'s own words and the footage, and say which in one line before planning, e.g. "Editing this as a vlog: cold open, title card, premise, bits, headline, plugs, tag."');
    expect(toolsNamed(edit)).toContain('formats');
    expect(edit).toContain('`formats`');
    expect(edit).toContain('`from`');
    expect(edit).toContain('`new_video { from, format: "short" }`');
    expect(edit).toContain('a few shorts from this?');
    // The new_video row documents the new inputs and the reply that names the format.
    const row = edit.split('\n').find((l) => l.startsWith('| `mcp__plugin_mirage_engine__new_video` |'))!;
    for (const input of ['format?', 'from?', 'vlog?', 'targetSec?']) expect(row, `new_video row lacks ${input}`).toContain(input);
    expect(row).toContain('video <n> created (format <id>: <beat> → <beat> → …)');
  });

  it('edit passes on each format message from check, in plain words with what to do', () => {
    const edit = read('edit');
    for (const message of [
      '`item <id>\'s beat "<beat>" isn\'t one of the <name> format\'s beats (<b1>, <b2>, …)`',
      '`the video is <m:ss>, longer than the <name> format\'s <m:ss> — cut whole bits rather than thinning laughs`',
      '`a short opens on its hook, not a <beat>: item <id>`',
      '`a short has no outro: item <id>`',
      '`a standalone short loops: the last music cue fades out at the end — set its fadeOut to 0`',
      '`a teaser short answers one small question and leaves the big one open: add a payoff beat`',
      '`a standalone short pays off its hook: add a payoff beat`',
      '`a short never ends on a full-screen card: item <id> — end on the last shot, with at most an overlay over it`',
      '`<what> falls where the Shorts and Reels buttons cover it (<area>) — leave it out, or use a callout`',
      '`captions at the bottom falls where the Shorts and Reels buttons cover it (bottom 20%) — set captions position middle`',
      '`the video is <w>×<h>, not the <name> format\'s <w>×<h>`',
      '`captions are <style>/<position>, not the <name> format\'s <style>/<position>`',
      '`longer than this video\'s <m:ss> limit`',
      '`— cut whole moments`',
      '`✖ video.json: unknown format "<id>"`',
      '`✖ plugin/formats/<file>: <issue>`',
    ]) expect(edit, `edit never explains ${message}`).toContain(message);
    expect(edit).toContain("If the hook is something you see rather than hear (the thing about to happen), don't trim into it: tell the person instead.");
    // The warnings the shorts fixes removed are gone: no pointer is demanded, no end card suggested, no length called favoured.
    for (const gone of ['add a pointer beat at the end', 'Full video on my channel', 'starts with <s> s of silence', 'cuts off as he reaches for the switch']) expect(edit, gone).not.toContain(gone);
    expect(edit).toContain("A short's limit is 3:00, the longest YouTube Shorts and Instagram Reels take, and no `targetSec` moves it: a short has no favoured length, only that limit.");
    // The vlog's title card is a title-card beat, as the vlog format names it; vlogs count up per name.
    expect(edit).toContain('{ "id": "t1", "beat": "title-card", "card": { "text": "Sam\\nVlog #3\\n11-6-26", "style": "mono", "sec": 2 } }');
    expect(edit).toContain("`number` is one more than the highest among the project's vlogs of that name, or 1");
  });

  it('edit explains the playbook section of check: every line, that a miss is fixed or recorded as the experiment, and whose numbers they are', () => {
    const edit = read('edit');
    const part = edit.slice(edit.indexOf('### The playbook lines'), edit.indexOf("The build story's beats and the rules that go with them follow."));
    for (const words of [
      '`Playbook (<format>):`',
      'a playbook, not advice',
      '`✓` met or `✗` missed, with the measured number, the target and, for a miss, the item or the time where it happens',
      '`– <rule>: not measured — <reason>`',
      'A `✗` is not an error and never stops `cut` or `render`.',
      "fix it in the timeline, then `check` again; or, when the person chooses to break that rule on purpose, record it as the video's `experiment`",
      '`"experiment": { "rule", "change", "expect" }`',
      "`Playbook (<format>, with your <format>-mine formula's <key>, <key>):`",
      '`✖ formulas/<format>-mine.md: <issue>`',
      '`✗ opens on a full-screen card (item <id>) — the playbook opens on the picture`',
      '`✗ first word at <s> s (the cut opens on item <id>) — the playbook asks for one within <t> s`',
      '`✗ no word is spoken — the playbook asks for one within <t> s`',
      '`✗ the idea has no <gap and no question> on record — the playbook asks for the gap and the question before cutting`',
      '`✗ longest stretch with nothing new <s> s, <from>–<to> (item <id>), and <k> more — the playbook allows <t> s`',
      'Narration is not needed where the picture tells the situation: silence over changing pictures is not empty.',
      '`✗ <r> cuts a minute — the playbook asks for <range>; the longest shot is item <id>, <s> s (<from>–<to>)`',
      '`✗ <w> words a minute — the playbook asks for <range>; the longest stretch without words is <from>–<to> (item <id>)`',
      '`(counting the written narration lines, not recorded yet)`',
      '`✗ the answer (<beat>, item <id>) starts <p>% of the way through, at <m:ss.s> — the playbook asks for <a>–<b>%`',
      '`✗ no <beat> beat in the cut — the playbook asks for the answer on screen`',
      '`✗ ends on <beat> (item <id>), not on <beat> or <beat>`',
      '`✓ <m:ss> long — it aims for <m:ss> and warns past <m:ss>`',
      'is said once, by the `⚠`',
    ]) expect(part, `edit never says ${words}`).toContain(words);
    expect(edit.split('\n').find((l) => l.startsWith('| `mcp__plugin_mirage_engine__check` |'))).toContain('`Playbook (<format>):`');
  });

  it('every playbook line the engine can print is one the edit skill explains, and every ⚠ a short can get', () => {
    const edit = read('edit');
    const source = readFileSync(join(ROOT, 'packages/core/src/mirage/playbook.ts'), 'utf8');
    const targets = [...source.matchAll(/— (the playbook (?:asks|allows|opens)[^`'$]*)/g)].map((m) => m[1]!.trim()).filter((t) => t.length > 12);
    expect(targets.length).toBeGreaterThanOrEqual(5);
    for (const words of new Set(targets)) expect(edit, `edit never explains the playbook line “${words}”`).toContain(words);
    // Each ⚠ of a short, up to its first ${…}.
    const warnings = [...source.matchAll(/`(a (?:teaser |standalone )?short [^`]*)`/g)].map((m) => m[1]!.split('${')[0]!.trim());
    expect(warnings).toHaveLength(5);
    for (const words of warnings) expect(edit, `edit never explains the ⚠ starting “${words}”`).toContain(words);
  });

  it('edit forecasts the cut after render: predict, fix the weakest moments, predict again, then post, with the weights and what it cannot see', () => {
    const edit = read('edit');
    expect(toolsNamed(edit)).toContain('predict');
    const row = edit.split('\n').find((l) => l.startsWith('| `mcp__plugin_mirage_engine__predict` |'))!;
    for (const words of ['`{ video }`', 'never a view count', 'chosen, stayed, satisfied', '`episodes/<n>/prediction.json`']) expect(row, `predict row lacks ${words}`).toContain(words);
    const part = edit.slice(edit.indexOf('### Forecast before posting'), edit.indexOf('When `thumbnail` answers with a `✖` or a `⚠`'));
    expect(edit.indexOf('### Thumbnail, title and description')).toBeLessThan(edit.indexOf('### Forecast before posting'));
    for (const words of [
      'predict, fix the weakest moments, predict again, then post',
      'It is a forecast, not a promise, and it never gives a view count; say so to the person.',
      '`from the final render`, `from the rough cut (there is no final render yet)` or `from the timeline (nothing is rendered yet)`',
      '`Chosen (will they choose to watch): <k>/10`, `Stayed (will they keep watching): <k>/10` and `Satisfied (will they be glad they watched): <k>/10`',
      '`formulas { id: "youtube" }`',
      "10 × the weights of its rules that are met ÷ the weights of its rules that could be measured; a rule that was not measured is left out and named",
      '| Chosen | the idea on record 3 · the first word in time 3 · the chosen title in the format\'s shape 3 · opens on the picture (a short: on its hook) 2 · a thumbnail exists 2 (not for a short, which has no click) |',
      '| Stayed | no empty stretch 3 · where the answer starts 3 · the pace 2 · the words a minute 2 |',
      '| Satisfied | the answer is in the cut 4 · the ending 3 · the length within its limit 2 |',
      'they are not corrected by results',
      '`Weakest step: <step>`', '`No step is weak against the playbook`', "`Moments to fix, the weakest step's first:`",
      '`Band: below your usual for <format>`, `around` or `above`',
      '`with the weaker half`, `between the halves`',
      'what goes with better results, not proof of cause',
      '`No band: this forecast compares against the playbook only — <k> posted <format> videos have results, and 4 are needed (<m> more)`',
      'When earlier forecasts were wrong, say so and trust this one less.',
      'Never present a score as how many people will watch.',
      '`⚠ the timeline is <a> s long and <file> is <b> s — the timeline changed after that render, so this forecast is of the timeline, not of the file: render again before posting`',
      '`✖ there is no video <n>`', '`✖ results/evidence.json: …`', '`✖ ffprobe was not found`',
    ]) expect(part, `edit never says ${words}`).toContain(words);
    // The table is the engine's own weighting.
    expect(WEIGHTS).toEqual({ chosen: { idea: 3, firstWord: 3, title: 3, opening: 2, thumbnail: 2 }, stayed: { empty: 3, answerPlace: 3, pace: 2, words: 2 }, satisfied: { answer: 4, ending: 3, length: 2 } });
    expect(MIN_TO_COMPARE).toBe(4);
  });

  it('every ✖ and ⚠ the predict code can print is one the edit skill explains', () => {
    const edit = read('edit');
    const source = readFileSync(join(ROOT, 'packages/core/src/mirage/predict.ts'), 'utf8');
    const warnings = [...source.matchAll(/`(⚠ [^`]*)`/g)].map((m) => m[1]!.split(/\$\{[^}]*\}/).pop()!.trim()).filter((t) => t.length > 12);
    expect(warnings).toHaveLength(1);
    for (const tail of warnings) expect(edit, `edit never explains the ⚠ ending “${tail}”`).toContain(tail);
    const refusals = [...source.matchAll(/new MirageError\('[A-Z_]+', (?:[^?\n]*\? )?[`'"]((?:\\.|[^`'"\\])+)[`'"]/g)].map((m) => m[1]!.split('${')[0]!.replace(/\\(.)/g, '$1').trim());
    expect(refusals).toEqual(['there is no video']);
    for (const head of refusals) expect(edit, `edit never explains the ✖ starting “${head}”`).toContain(head);
  });

  it('edit picks thumbnails and writes titles and descriptions from the person and the catalog only', () => {
    const edit = read('edit');
    expect(toolsNamed(edit)).toContain('thumbnail');
    const row = edit.split('\n').find((l) => l.startsWith('| `mcp__plugin_mirage_engine__thumbnail` |'))!;
    for (const input of ['video', 'at?', 'text?', 'focus?']) expect(row, `thumbnail row lacks ${input}`).toContain(input);
    expect(edit).toContain('Look at the candidate frames, pick the one where a face shows the strongest reaction with its cause in frame, and write the thumbnail without text unless the person asks for some.');
    for (const words of ['thumbs/cand-', 'thumbnail.jpg', 'Show it to the person', '3 title options', 'never a claim the video does not deliver', 'People in the video', 'music/library.json', 'only facts the person gave you or the catalog holds']) {
      expect(edit, `edit never says ${words}`).toContain(words);
    }
    // The tool's ✖ and ⚠ lines are passed on in plain words.
    for (const message of ['`video <n> has no cut yet`', '`thumbnail text is <k> words — keep it to 4 or fewer`', '`<at> s is outside the video (0–<D> s)`', '`text and focus go with at (…)`']) {
      expect(edit, `edit never explains ${message}`).toContain(message);
    }
  });

  it('edit passes the at a candidate names, shows the person the thumbnail\'s path, and says what focus can move', () => {
    const edit = read('edit');
    for (const words of [
      'passing the `at` value shown on that frame\'s line',
      "don't rule out a frame because a caption covers the face",
      'give them the full path to `thumbnail.jpg`',
      'describe the frame in a line, since reading the JPEG shows it only to you',
      "Footage the thumbnail's shape at `zoom` 1 is shown whole, and `focus` doesn't move it.",
      'named after the title as `<title>.jpg` (not `thumbnail.jpg`)',
      'with facts from the person, the catalog or the music library only',
    ]) expect(edit, `edit never says ${words}`).toContain(words);
    expect(edit).not.toContain('(Read the JPEG)');
    expect(edit).not.toContain('`thumbnail.jpg` is copied together with the finished video');
  });

  it('overnight makes candidates and a thumbnail after the final render and logs them for the person to confirm', () => {
    const overnight = read('overnight');
    expect(toolsNamed(overnight)).toContain('thumbnail');
    expect(overnight).toContain('After the final render, call `mcp__plugin_mirage_engine__thumbnail` for candidates and once with `at` for the best one, and log it with kind `guess` for the person to confirm.');
    // The guess names the file; the titles and description are written too, from what Mirage holds, gaps asked about.
    for (const words of ["Name the thumbnail's path in that guess", 'write the 3 title options and the description into `episodes/<n>/summary.md`', 'with facts from the catalog and the music library only', 'logged with kind `question`']) {
      expect(overnight, `overnight never says ${words}`).toContain(words);
    }
  });

  it('status explains the Formats line and a broken format file', () => {
    const status = read('status');
    expect(status).toContain('`Formats: <id>, <id>, …`');
    expect(status).toContain('`✖ plugin/formats/<file>: <issue>`');
  });

  it('status explains the Formulas line, the person\'s own, and a broken formula file', () => {
    const status = read('status');
    for (const words of ['`Formulas: <id>, <id>, …`', '`; yours: <id>, …`', '`✖ formulas/<file>: <issue>`', '`✖ plugin/formulas/<file>: <issue>`', "which can't be changed — save yours under another name", 'mirage:analyse']) {
      expect(status, `status never says ${words}`).toContain(words);
    }
  });

  it('edit says where the measurements behind the formats are, and follows the person\'s own formula', () => {
    const edit = read('edit');
    expect(toolsNamed(edit)).toContain('formulas');
    const row = edit.split('\n').find((l) => l.startsWith('| `mcp__plugin_mirage_engine__formulas` |'))!;
    expect(row).toContain('`{ id? }`');
    expect(row).toContain('`(yours)`');
    for (const words of ["`formulas` holds the measurements behind the formats (Mirage's own, which can't be changed) and the person's own formulas", 'mirage:analyse', 'A formula never licenses inventing anything.']) {
      expect(edit, `edit never says ${words}`).toContain(words);
    }
  });

  it('setup says yt-dlp is optional and only for mirage:analyse and mirage:learn, with both installs', () => {
    const setup = read('setup');
    const step = setup.slice(setup.indexOf('## Step 4c ·'), setup.indexOf('## Step 5 ·'));
    expect(step).toContain('## Step 4c · yt-dlp (optional; only for mirage:analyse and mirage:learn)');
    for (const words of ['the `mirage:learn` skill (the `learn` engine tool, which reads how the person\'s own posted videos did)', '- macOS: `brew install yt-dlp`', '- Windows: `winget install yt-dlp`', 'WORDEDITS_YTDLP_DIR', 'Mirage never downloads a video with it', '`✖ yt-dlp was not found`']) expect(step, `setup never says ${words}`).toContain(words);
    expect(setup).toContain("- yt-dlp is optional and only needed for `mirage:analyse` and `mirage:learn` (step 4c): don't install it unless the person wants to analyse a channel or learn from their posted videos.");
    expect(setup).toContain('| yt-dlp (only for mirage:analyse and mirage:learn) | | |');
    // It is not one of the tools Mirage asks about at the start of a session.
    expect(setup.slice(setup.indexOf('**Asking first**'), setup.indexOf('**How to work through it**'))).not.toContain('yt-dlp');
  });

  describe('analyse', () => {
    const analyse = read('analyse');

    it('says when to use it: to learn from a channel, and to find out why the person\'s own isn\'t working', () => {
      const { description } = frontmatter(analyse);
      for (const words of ["why a channel's videos do well", 'their own or another channel', 'add a formula of their own', "why the person's own channel isn't working", "why their videos aren't getting views"]) expect(description, words).toContain(words);
    });

    it('documents each shape of the channel tool and the formulas tool', () => {
      const lines = analyse.split('\n');
      expect(lines.find((l) => l.startsWith('| `mcp__plugin_mirage_engine__channel` |'))).toContain('`{ url, videos? }`');
      for (const shape of ['`{ name, patterns: [{ label, regex }] }`', '`{ name, thumbnails: "top" \\| "newest" \\| "lowest" }`', '`{ name, captions: [ids] }`']) expect(analyse, shape).toContain(shape);
      expect(lines.find((l) => l.startsWith('| `mcp__plugin_mirage_engine__formulas` |'))).toContain('`(yours)`');
      for (const words of ['`analysis/<name>/videos.json`', '`analysis/<name>/thumbs-<which>.jpg`', '`analysis/<name>/<id>.txt`', 'default 200, at most 1000']) expect(analyse, words).toContain(words);
    });

    it('has the steps in order, from the two questions to the written formula', () => {
      const heads = ['## 0. Ask', '## 1. Gather the videos', '## 2. Titles', '## 3. Thumbnails', '## 4. Inside the video', '## 5. Find the question underneath', '## 6. Write the formula', '## When it is the person\'s own channel', '## When a tool stops'];
      const at = heads.map((h) => analyse.indexOf(`\n${h}\n`));
      for (const [i, h] of heads.entries()) expect(at[i], h).toBeGreaterThan(i ? at[i - 1]! : 0);
      for (const words of [
        'Ask only two things, in one message:',
        '`channel { url }`. Read the three lists',
        'propose 8–12 patterns',
        '**Judge on the latest 60 first.** Older videos have had longer to collect views, and the channel was smaller then',
        '`too few to compare` means one side has under 3 videos',
        '`channel { name, thumbnails: "top" }` and `channel { name, thumbnails: "lowest" }`',
        'Count, out of 12 on each sheet',
        'what differs between the top sheet and the lowest sheet',
        'a first episode or a typical hit, a middle one, and a recent one',
        'how often a doubt',
        'Read `formulas { id: "algorithm" }`',
        "without this creator's budget, fame or friends",
        "Never just copy the creator's subject",
        'Write `formulas/<id>.md` in the project',
        '"formats":["short"]',
        '**What matters most (my estimate)**',
        '**Not measured.**',
        'show it with `formulas { id }`',
        'it is now listed under `formulas`',
      ]) expect(analyse, `analyse never says ${words}`).toContain(words);
    });

    it('keeps the rules of honesty', () => {
      for (const words of [
        '**"×" shows what goes with more views, never proof of cause.**',
        '**The share-per-part table is an estimate.**',
        '**Say what was not measured.**',
        "The one exception: the person's own channel, when they give you the numbers from YouTube Studio.",
        '**Only public data.**',
        '**Never download a video.**',
        "**Other creators' thumbnails stay in `analysis/`.**",
        '**Never invent a number.**',
        "**Never copy the creator's subject.**",
      ]) expect(analyse, `analyse never says ${words}`).toContain(words);
    });

    it('never writes into the plugin: a person\'s formula goes in the project, under a new id', () => {
      for (const words of [
        "**Mirage's own formulas, formats and skills are read-only.** Never write into the plugin's folders. A person's formula goes only in the project's `formulas/` folder. To change a Mirage rule for themselves, the person saves their own formula under a new id; they never edit or replace Mirage's.",
        "not one of Mirage's own (`algorithm`, `youtube`, `instagram`, `tiktok`, `episode`, `vlog`, `short`)",
        "`Mirage's own formats, formulas and skills are read-only. Save your own formula in the project's formulas folder, under a new name.`",
      ]) expect(analyse, `analyse never says ${words}`).toContain(words);
    });

    it('diagnoses the person\'s own channel: scores, their top against their lowest, the Studio numbers, diagnosis.md, then their formula', () => {
      const own = analyse.slice(analyse.indexOf("## When it is the person's own channel"), analyse.indexOf('## When a tool stops'));
      for (const words of [
        '`captions` for 2 of their best and 2 of their weakest videos',
        'the latest 10–20',
        'gap, question, doubt, stake, one picture, face; 0–2 each',
        '`formulas { id: "algorithm" }`',
        '`formulas { id: "episode" }`, `"vlog"` or `"short"`',
        '**Compare their own top videos with their own lowest**',
        'most trustworthy evidence there is, because it is their audience choosing',
        'the click rate on impressions, the average percentage viewed, and for Shorts "viewed vs swiped away"',
        '`formulas { id: "youtube" }`',
        'chose to watch', 'stuck around', 'enjoyed it',
        'Never guess a click or retention rate.',
        '**Write `analysis/<name>/diagnosis.md`.**',
        'a reading of public data',
        'not proof',
        '**What is working**', '**What is missing**', 'one concrete change',
        'the biggest first',
        '**Write their own formula** to `formulas/<id>.md`',
        'Show it with `formulas { id }`',
      ]) expect(own, `the own-channel path never says ${words}`).toContain(words);
    });

    it('explains every ✖ and ⚠ the channel and formulas tools can print', () => {
      for (const message of [
        '`✖ yt-dlp was not found`',
        '`Install yt-dlp (macOS: brew install yt-dlp; Windows: winget install yt-dlp) or set WORDEDITS_YTDLP_DIR to a folder containing yt-dlp.`',
        '`✖ yt-dlp not found in WORDEDITS_YTDLP_DIR (<folder>)`',
        '`✖ yt-dlp could not be started`',
        '`✖ yt-dlp exited with code <n>`',
        '`✖ yt-dlp exceeded <ms> ms`',
        '`✖ "<input>" isn\'t a YouTube channel address`',
        '`✖ no videos were found at <url>`',
        '`✖ no channel "<name>" has been gathered in this project`',
        '`✖ channel does one thing per call`',
        '`✖ give url or name, not both: the name comes from the url`',
        '`✖ name is needed: which gathered channel this is about`',
        '`✖ videos goes with url (how many videos to list)`',
        '`✖ pattern "<label>": its regex can\'t be read (<why>)`',
        '`✖ "<id>" isn\'t a video id`',
        '`✖ no thumbnail could be fetched`',
        '`✖ ffmpeg was not found`',
        '`✖ analysis/<name>/videos.json: …`',
        '`✖ no Mirage project at …`',
        '`✖ Stopped by the person before it finished.`',
        '`⚠ <k> of <n> videos have no view count (members-only, upcoming or live) — they are left out of the medians and the most and least viewed lists`',
        '`⚠ no thumbnail could be fetched for <id> (<title>) — it is left out of the sheet`',
        '`⚠ <id> “<title>”: no English captions — no transcript for this video`',
        '`⚠ <id>: yt-dlp couldn\'t read this video (<why>) — it is left out`',
        '`⚠ <id>: yt-dlp wrote no info for this video — it is left out`',
        '`Most replayed: YouTube shows none for this video`',
        '`✖ unknown formula "<id>"`',
        '`✖ formulas/<file>: <issue>`',
        '`✖ formulas/<file>: "<id>" is one of Mirage\'s own formulas, which can\'t be changed — save yours under another name`',
        '`✖ plugin/formulas/<file>: <issue>`',
        '`✖ plugin/formulas: the folder is missing or unreadable`',
      ]) expect(analyse, `analyse never explains ${message}`).toContain(message);
      expect(analyse).toMatch(/Never run `yt-dlp`, `ffmpeg` or `pnpm` yourself/);
    });

    it('every ✖ and ⚠ the channel code can print is one the skill explains', () => {
      // The literal end of each warning in the source (after its last ${…}), which the skill must hold.
      const sources = ['packages/core/src/mirage/channel.ts', 'packages/core/src/mirage/formulas.ts', 'packages/sidecars/src/ytdlp.ts'].map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
      const warnings = [...sources.matchAll(/[`'](⚠ [^`']*)[`']/g)].map((m) => m[1]!.split(/\$\{[^}]*\}/).pop()!.trim()).filter((t) => t.length > 12);
      expect(warnings.length).toBeGreaterThanOrEqual(4);
      for (const tail of warnings) expect(analyse, `analyse never explains the ⚠ ending “${tail}”`).toContain(tail);
    });
  });

  describe('learn', () => {
    const learn = read('learn');

    it('says when to use it: a video is posted, how the videos did, what Mirage learned, improving the formula, or status says learn is due', () => {
      const { description } = frontmatter(learn);
      for (const words of ['says a video is posted', 'how their videos did', 'what Mirage has learned', 'to improve their formula', 'when status says learn is due']) expect(description, words).toContain(words);
      expect(learn).toContain('This is a saved process: run it without the person explaining it.');
    });

    it('documents the posted and learn tools, and the files they write', () => {
      const lines = learn.split('\n');
      expect(lines.find((l) => l.startsWith('| `mcp__plugin_mirage_engine__posted` |'))).toContain('`{ video, url, also?: [{ platform, url }] }`');
      expect(lines.find((l) => l.startsWith('| `mcp__plugin_mirage_engine__learn` |'))).toContain('`{ studio?: { video, platform?, clickRate?, percentViewed?, avgViewSec?, viewedVsSwiped?, drops?: [{ at, note? }], spikes?: [{ at }], views?, likes?, comments?, shares?, saves? } }`');
      for (const words of ['`episodes/<n>/features.json`', '`results/<n>.json`', '`results/evidence.json`', '`formulas/changes.md`', '`formulas/<format>-mine.md`', '`build-story-mine`, `vlog-mine`, `short-mine`']) expect(learn, words).toContain(words);
    });

    it('has the steps in order, from the posted video to putting a rule back', () => {
      const heads = ['## The three reads', '## The rules', '## 1. A video was just posted', '## 2. Read how the videos did', "## 3. Read the person's formula for that format", '## 4. Decide what changes', '## 5. Write the change', '## 6. Report to the person', '## 7. Putting a rule back', '## When a tool stops'];
      const at = heads.map((h) => learn.indexOf(`\n${h}\n`));
      for (const [i, h] of heads.entries()) expect(at[i], h).toBeGreaterThan(i ? at[i - 1]! : 0);
      for (const words of [
        'Ask only for the address',
        '`posted { video, url }`',
        'ask once, in one message, for the numbers only they can see, and say they are optional',
        'YouTube Studio → Content → the video → Analytics',
        'Read its report, then `results/evidence.json`',
        '"formats":["build-story"]',
        "learned from this project's own posted videos",
        "it sits on top of Mirage's formula for that format (`formulas { id: \"episode\" }` for a build story, `\"vlog\"`, `\"short\"`)",
        "List nothing it hasn't evidence for.",
        '## Observations so far',
        '- Before: "<the old wording, word for word; or: no rule>"',
        '- After:', '- Evidence:', '- Confidence:', '- Try next:',
        'Keep the old wording verbatim, so it can be put back.',
        'what was improved and why', 'what stayed the same and why', 'what is only an observation so far',
        'When nothing changed, say that, and how many more videos are needed',
        'restore the `Before` wording in the formula word for word',
        'Never delete an entry.',
      ]) expect(learn, `learn never says ${words}`).toContain(words);
    });

    it('states the rules a change is decided under', () => {
      for (const words of [
        '**A rule changes only when three or more videos point the same way**, or when the gap between the better half and the weaker half is clear with 4 or more videos.',
        'One or two videos give an **observation**',
        '**Tie every change to one of the three steps** in `formulas { id: "youtube" }`, and say which number it rests on',
        'chose to watch', 'stuck around', 'enjoyed it',
        '**What viewers replay is evidence about moments, not about the whole video.**',
        '**"×" and the better and weaker halves show what goes with better results, never proof of cause.**',
        "**Never copy a number into a rule that `results/evidence.json` doesn't hold. Never invent a result.**",
        "**Never touch Mirage's own formulas.**",
        "it wins over Mirage's packaging and pacing advice as far as the mirage:edit skill says",
      ]) expect(learn, `learn never says ${words}`).toContain(words);
    });

    it('reports to the person in four parts, in order', () => {
      const step = learn.slice(learn.indexOf('## 6. Report to the person'), learn.indexOf('## 7. Putting a rule back'));
      const parts = ['1. **How the video did**', '2. **Why, as far as the evidence shows**', '3. **What was changed in the formula**', '4. **The experiment for the next video**, and what would count as it working'];
      const at = parts.map((p) => step.indexOf(p));
      for (const [i, p] of parts.entries()) expect(at[i], p).toBeGreaterThan(i ? at[i - 1]! : 0);
      expect(step).toContain('at which read (early, main or late)');
      expect(step).toContain('which moments viewers replayed or left');
    });

    it('reads each video three times, and judges a short early, a long video at the main read', () => {
      for (const words of [
        'an **early read** 3 days after it went up, the **main read** at 7 days, and a **late read** at 28 days',
        'These day counts are starting points, not measurements.',
        'A short may be judged at the early read; a long video at the main read.',
        'The late read only confirms or corrects what the main read said',
        '`learn is due: video 3 (early read), video 1 (late read)`',
        '`before the early read`, `early read`, `main read` or `late read`',
        '`Early: videos … are before the main read (7 days) — what they show so far is early and may still change`',
      ]) expect(learn, `learn never says ${words}`).toContain(words);
      // The day counts the skill and the status skill name are the engine's.
      expect(READS).toEqual({ early: 3, main: 7, late: 28 });
    });

    it('learns from titles, thumbnails and where viewers left, and says what only the person can see', () => {
      for (const words of [
        '`Title words: better half 6 · weaker half 9`',
        '`Title in ALL CAPS: better half 2 of 2 · weaker half 0 of 2`',
        'Read `episodes/<n>/thumbnail.jpg` and note yourself: a face or not and its expression, the subject and its state, text or none',
        'whether `episodes/<n>/thumbnail.jpg` exists, and whether it was written with text',
        '`drops: [{ at, note? }]`', '`spikes: [{ at }]`',
        '`Viewers left (Studio), video <n>: <m:ss> during item <id> (beat <beat>) — “<note>” · …`',
        '"viewers left during item m3 (beat problem)"',
        'Public data has only the "most replayed" graph',
        'Mirage does not sign in to YouTube or Google: the Studio numbers are the ones the person types.',
      ]) expect(learn, `learn never says ${words}`).toContain(words);
    });

    it('runs one experiment per video: the step that failed, the hook first for shorts, a rule or tried and dropped', () => {
      for (const words of [
        '**Find the step that failed.**',
        'Fix only that part. A video that did well needs no experiment: keep what it did',
        '**For shorts the hook comes first.** Viewers swipe with no decision to make, so the first seconds are the whole pitch. When viewed vs swiped is the weak number, the experiment is on the opening',
        'Each video carries at most one deliberate change against its format\'s formula, so its effect can be read.',
        'Choose it by reading `formulas { id: "algorithm" }`, the format\'s Mirage formula (`"episode"`, `"vlog"` or `"short"`) and the person\'s `<format>-mine` formula',
        "`new_video`'s `experiment`",
        '`"experiment": { "rule", "change", "expect" }`',
        '`Experiments:`',
        '`Video <n> changed “<rule>”: <change>. Expected: <expect>. So far on <number> it has <x> against a middle of <y> for the other <k> videos: higher`',
        'it becomes a rule in the person\'s formula',
        'record it in `changes.md` as tried and dropped',
      ]) expect(learn, `learn never says ${words}`).toContain(words);
    });

    it('learns from the niche when the person\'s own videos are too few, without copying, and marks it untested', () => {
      for (const words of [
        '`too few to compare` does not stop the process: learn from the niche instead.',
        'the `niche` entry of `mirage.json`',
        '"niche": { "short": ["https://www.youtube.com/@leader/shorts"]',
        'ask the person which channels are the leaders in their niche',
        'Use the mirage:analyse skill (`channel`) on the most-watched of them',
        'the captions of 2–3 of its videos',
        'Adapt the principle; never copy the subject, the wording or the look.',
        'it came from a niche channel, which one, and that it is untested on this audience until one of the person\'s own videos confirms it',
        '## From the niche (untested here)',
      ]) expect(learn, `learn never says ${words}`).toContain(words);
    });

    it('explains the report: the ranking and which ages it favours, the halves, too few, and the three words of confidence', () => {
      for (const words of [
        '`Most replayed, video <n>: <m:ss> (<p>%) item <id>, <beat> · …`',
        '`Most replayed: YouTube shows none for …`',
        "`Ranked by views at <d> days old, the newest video's age …`",
        "`Ranked by views a day, because the reads so far don't let the videos be compared at the same age …`: this favours newer videos",
        '`Seconds before the first word: better half 1.2 s · weaker half 3.4 s`',
        '`too few to compare: <k> videos — <m> more needed`',
        '`Confidence, <format>: <k> posted videos — a weak signal` (under 5 videos), `a fair signal` (5–9) or `a strong signal` (10 or more)',
      ]) expect(learn, `learn never explains ${words}`).toContain(words);
    });

    it("reads the forecast against the result, says how often it was right, and distrusts a forecast that has been wrong", () => {
      for (const words of [
        "`Forecast against result, video <n>: predicted above your usual for <format> (chosen 8/10 · stayed 6/10 · satisfied 10/10; weakest: stayed) · it landed 1 of 5 in the ranking, in the better half — the band was right`",
        '`— the band was wrong (it landed below)`',
        '`predicted against the playbook only (…)`',
        '`— too few videos to say whether the band was right`',
        "`it is the format's only posted video, so there is no ranking to hold it against yet`",
        '`Forecasts so far: the band was right for <r> of <t> posted videos`',
        '`Forecasts so far: none can be judged yet — a forecast is judged once it gave a band and its format has 4 posted videos`',
        "The forecast's weights are fixed and do not correct themselves, so this count is how far to trust it",
        'say plainly when the forecast has been wrong',
        "treat the next forecast's band as a weak hint",
        '`✖ episodes/<n>/prediction.json: …`',
        'When the video had a forecast, say what it predicted, where the video landed, and how often the forecast has been right so far.',
      ]) expect(learn, `learn never says ${words}`).toContain(words);
      // Every fixed phrase of the forecast lines in the code is in the skill.
      const source = readFileSync(join(ROOT, 'packages/core/src/mirage/learn.ts'), 'utf8');
      for (const words of ['Forecast against result, video', 'in the ranking', ' — the band was right', 'Forecasts so far: the band was right for', 'Forecasts so far: none can be judged yet']) {
        expect(source, words).toContain(words);
        expect(learn, words).toContain(words);
      }
    });

    it("adjusts the playbook through the person's own formula, never Mirage's files: a rule with a number sets that key", () => {
      for (const words of [
        '**The playbook numbers.**',
        '`firstWordSec`, `answer` (`beat`, `fromShare`, `toShare`), `emptySec`, `cutsPerMin` (`min`, `max`, `except`, `beats`, `after`), `wordsPerMin` (`min`, `max`), `ideaNeeded`, `endsOn`, `title` (`allCaps`, `hasNumber`, `firstPerson`, `endsWith`, `words`), `targetSec`, `warnPastSec`',
        "Mirage's files stay as they are; the person's results adjust the playbook through their own formula.",
        '`"playbook":{"firstWordSec":1.5}`',
        "`Playbook (<format>, with your <format>-mine formula's firstWordSec):`",
        'An observation never changes a playbook number.',
        'Putting a rule back (step 7) puts its number back too',
      ]) expect(learn, `learn never says ${words}`).toContain(words);
      // The keys the skill names are the schema's.
      expect(Object.keys(PlaybookSchema.shape)).toEqual(['firstWordSec', 'answer', 'emptySec', 'cutsPerMin', 'wordsPerMin', 'ideaNeeded', 'endsOn', 'title', 'targetSec', 'warnPastSec']);
    });

    it('explains every ✖ and ⚠ the posted and learn tools can print', () => {
      for (const message of [
        '`✖ "<input>" isn\'t a YouTube video address`',
        '`✖ there is no video <n>`',
        '`✖ video <n> has no video.json to record it in`',
        '`✖ video <n> has no final render yet`',
        '`✖ no video is posted yet`',
        "`✖ video <n> isn't posted yet, so it has no Studio numbers to keep`",
        '`✖ studio needs at least one number`',
        '`✖ yt-dlp was not found`',
        '`Install yt-dlp (macOS: brew install yt-dlp; Windows: winget install yt-dlp) or set WORDEDITS_YTDLP_DIR to a folder containing yt-dlp.`',
        '`✖ yt-dlp could not be started`',
        '`✖ ffprobe was not found`',
        '`✖ results/<n>.json: …`',
        '`✖ episodes/<n>/features.json: …`',
        '`✖ no Mirage project at …`',
        '`✖ Stopped by the person before it finished. The numbers read so far are kept.`',
        '`⚠ the timeline is <a> s long and final.mp4 is <b> s — the timeline changed after the final render, so features.json may not describe the video that was posted`',
        "`⚠ video <n> (<id>): yt-dlp couldn't read it (<why>) — it is left out`",
        "`⚠ video <n>: on YouTube it is <m:ss> long and its cut was <m:ss> — the moments viewers replayed or left can't be tied to the cut's items`",
        '`⚠ video <n>: its address changed since its numbers were last read — the earlier numbers were of <url> and are dropped`',
        '`No posted video could be read, so there is nothing to compare yet.`',
      ]) expect(learn, `learn never explains ${message}`).toContain(message);
      expect(learn).toMatch(/Never run `yt-dlp` or `pnpm` yourself/);
    });

    it('every ✖ and ⚠ the learn code can print is one the skill explains', () => {
      const source = readFileSync(join(ROOT, 'packages/core/src/mirage/learn.ts'), 'utf8');
      // The literal end of each warning in the source (after its last ${…}), which the skill must hold.
      const warnings = [...source.matchAll(/`(⚠ [^`]*)`/g)].map((m) => m[1]!.split(/\$\{[^}]*\}/).pop()!.trim()).filter((t) => t.length > 12);
      expect(warnings).toHaveLength(5);
      for (const tail of warnings) expect(learn, `learn never explains the ⚠ ending “${tail}”`).toContain(tail);
      // Each refusal's message, up to its first ${…}.
      const refusals = [...source.matchAll(/new MirageError\('[A-Z_]+', (?:[^?\n]*\? )?[`'"]((?:\\.|[^`'"\\])+)[`'"]/g)].map((m) => m[1]!.split('${')[0]!.replace(/\\(.)/g, '$1').trim());
      expect(refusals.length).toBeGreaterThanOrEqual(5);
      for (const head of refusals) expect(learn, `learn never explains the ✖ starting “${head}”`).toContain(head);
    });
  });

  it('the other skills hand over to learn: edit when a video is live or learn is due, status on its Results line, analyse once videos are posted', () => {
    const edit = read('edit');
    for (const words of [
      'When the person says the video is live (posted, uploaded, published), use the mirage:learn skill',
      'When its `Results:` line says `learn is due`, use the mirage:learn skill first',
      "named `<format>-mine` (`build-story-mine`, `vlog-mine`, `short-mine`): a video being edited follows it when there is one",
      "Ask for the four only for formats whose rules ask for them, leave out any the person didn't give, and never invent one.",
      'pass what the person and the footage gave for it as `idea`: `gap`, `question`, `doubt` and `stake`',
    ]) expect(edit, `edit never says ${words}`).toContain(words);
    expect(edit.split('\n').find((l) => l.startsWith('| `mcp__plugin_mirage_engine__new_video` |'))).toContain('idea?: { gap?, question?, doubt?, stake? }, experiment?: { rule, change, expect }');
    expect(edit).toContain("pass it as `new_video`'s `experiment` (`rule`, `change`, `expect`) and make that one change in the edit, and no other departure from the formula: one change per video, so its effect can be read.");
    const status = read('status');
    for (const words of ['`Results: <k> videos posted · last read <day>`', '`· learn is due: video <n> (<read> read), …`', '3 days after it went up (the early read), at 7 days (the main read) and at 28 days (the late read)', '`· not read yet`', '`Results: no video posted yet`', 'mirage:learn']) {
      expect(status, `status never says ${words}`).toContain(words);
    }
    expect(read('analyse')).toContain('Once videos made with Mirage are posted, the mirage:learn skill keeps this diagnosis current');
  });

  describe('series, thumbnails from two sources, the title and the platforms', () => {
    const edit = read('edit');
    const format = (id: string) => readFileSync(join(ROOT, 'plugin', 'formats', `${id}.md`), 'utf8');

    it('edit starts and joins a series with new_video, reads it before an episode and brings it up to date after the final render', () => {
      const row = edit.split('\n').find((l) => l.startsWith('| `mcp__plugin_mirage_engine__new_video` |'))!;
      expect(row).toContain('series?: { name, question?, openQuestion?, counts?, signOff?, titleShape?, thumbnail?: { face, share? } }');
      expect(edit.split('\n').find((l) => l.startsWith('| `mcp__plugin_mirage_engine__series` |'))).toContain('`{ name?, video?, question?, openQuestion?, counts?, signOff?, titleShape?, thumbnail?: { face, share? } }`');
      for (const words of [
        '**A series.**', 'pass `series: { name }` to `new_video`', 'a folder `series/<slug>/` with `series.json`',
        '`started the series “<name>” (series/<slug>/) as episode <k> · no open question on record`',
        '`added to the series “<name>” (series/<slug>/) as episode <k> · open question: “…”`',
        "The videos stay in `episodes/<n>/`; the series folder groups them by number, and its `README.md` lists each episode's title, stage and files",
        "the open question is where this episode's `recap` starts, the counts are the numbers its counters and narration carry on from",
        '`⚠ the series “<name>” already exists, so <fields> were not applied — change a series with the series tool`',
        '**The series, after the final render.**', '`series { name, openQuestion, video: n }`',
        'Every number comes from the person or the catalog: ask when you don\'t have it, and never invent a question or a count.',
        "`✗ the series “<name>” has no open question on record for the next episode — every episode's outro leaves one`",
        '`✓ the series “<name>” has an open question on record, left by video <k>: “…”`',
        '`✖ there is no series "<name>"`', '`✖ "<name>" can\'t name a series`', '`✖ video <n> isn\'t an episode of the series "<name>"`',
        '`✖ name is needed: which series to change`', '`✖ video goes with openQuestion (the episode whose outro left it)`', '`✖ series/<slug>/series.json: …`',
      ]) expect(edit, `edit never says ${words}`).toContain(words);
      const story = format('build-story');
      for (const words of ['A series is a folder, `series/<slug>/`', "Its `recap` reads the series' open question and counts (`series { name }`)", 'with numbers from the person or the catalog only', "the same sign-off every episode (the series' `signOff`)"]) {
        expect(story, `build-story never says ${words}`).toContain(words);
      }
      const status = read('status');
      for (const words of ['`Series “<name>” (series/<slug>/, <format>): videos <n>, <n> · open question: “…”`', '`· no open question on record`', '`✖ series/<slug>/series.json: <issue>`']) expect(status, `status never says ${words}`).toContain(words);
    });

    it('every refusal and warning of the series and two-source thumbnail code is one the edit skill explains', () => {
      const sources = ['packages/core/src/mirage/series.ts', 'packages/core/src/mirage/thumbnail.ts'].map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
      const refusals = [...sources.matchAll(/new MirageError\('[A-Z_]+', (?:[^?\n]*\? )?[`'"]((?:\\.|[^`'"\\])+)[`'"]/g)].map((m) => m[1]!.split('${')[0]!.split(' (')[0]!.replace(/\\(.)/g, '$1').trim()).filter((t) => t.length > 12);
      expect(refusals.length).toBeGreaterThanOrEqual(6);
      for (const head of refusals) expect(edit, `edit never explains the ✖ starting “${head}”`).toContain(head);
      for (const words of [
        '`a thumbnail from two sources takes face and subject (…), and no at or focus of its own`',
        '`the <face or subject> needs at (a second of the video) or image (a picture inside the project), one of the two`',
        "`the <face or subject>'s picture <path> is missing`", "`… isn't a PNG or JPEG`", '`… must be a plain path inside the project`',
        '`the <face or subject>: the video shows a card at <t> s`', '`a thumbnail from two sources is for a landscape video`', "`the face's share of the width goes from 0.2 to 0.5`",
        "`⚠ this thumbnail has the face on the <side> at <p>% of the width, and the series “<name>” keeps it on the <side> at <p>% — leave side and share out so every episode matches, or change the series' layout with the series tool`",
      ]) expect(edit, `edit never explains ${words}`).toContain(words);
      // The one ⚠ a series' layout can raise, word for word from the code.
      expect(sources).toContain("leave side and share out so every episode matches, or change the series' layout with the series tool");
    });

    it('edit builds a thumbnail from two sources when no frame has both, takes a photo, keeps one layout per series and never promises a cut-out', () => {
      const row = edit.split('\n').find((l) => l.startsWith('| `mcp__plugin_mirage_engine__thumbnail` |'))!;
      expect(row).toContain('face?: { at?, image?, focus? }, subject?: { at?, image?, focus? }, side?, share?');
      for (const words of [
        '**Two sources, when no single frame has both.**', '`thumbnail { video: n, face: { at | image, focus? }, subject: { at | image, focus? } }`',
        'ask them for a photo when the footage has no good face', 'about a third of the width',
        'Nothing is cut out and no background is removed: Mirage has no tool for that, so never promise it.',
        "is the series' own when the video is in a series and you pass none, so every episode matches",
        '`series { name, thumbnail: { face, share? } }`', 'It is for a landscape video; a vertical cover is one frame.',
        '`wrote episodes/<n>/thumbnail.jpg (1280×720, from two sources: the face (<source>) on the <side>, <p>% of the width, and the subject (<source>) filling the rest)`',
        '`episodes/<n>/thumbnail.json`',
      ]) expect(edit, `edit never says ${words}`).toContain(words);
      for (const id of ['build-story', 'vlog']) expect(format(id), id).toContain('`thumbnail { face, subject }`');
      expect(format('build-story')).toContain('They are two crops side by side; nothing is cut out.');
    });

    it('the chosen title is recorded and measured: edit writes it, the formats state their title shape, and learn says when the live one differs', () => {
      for (const words of [
        '`"titles": { "chosen": "<the title they picked>", "options": ["<each option offered>"] }`',
        "`✗ the chosen title “<title>” misses the format's title shape: <what it lacks> (it is <what it has>) — the title shape is <shape>`",
        "`✓ the chosen title “<title>” fits the format's title shape: …`",
        '`– the title: not measured — no title is chosen yet (titles.chosen in episodes/<n>/video.json)`',
        "What the forecast cannot see: the picture, the joke, what the title says (only its shape), whether the idea is any good.",
      ]) expect(edit, `edit never says ${words}`).toContain(words);
      const front = (id: string) => JSON.parse(format(id).split('\n')[1]!).playbook;
      expect(front('build-story').title).toEqual({ allCaps: true, hasNumber: true, words: { min: 6, max: 8 } });
      expect(front('vlog').title).toEqual({ allCaps: true, endsWith: '!!', words: { min: 3, max: 8 } });
      expect(front('short').title).toBeUndefined();
      expect(front('vlog').cutsPerMin).toEqual({ min: 15, except: ['headline'], beats: { bit: { min: 15 } }, after: { beat: 'headline', min: 20, except: ['sponsor', 'plugs', 'tag'] } });
      const learn = read('learn');
      for (const words of [
        "`Title, video <n>: live on YouTube it is “<live>”, and Mirage recorded “<chosen>” as the one chosen — they differ, and the title numbers here are the live title's`",
        'Titles are one of the most important parts', '`Thumbnail from two sources: better half 1 of 2 · weaker half 0 of 2`', '`Video <n> “<title>” (series “<name>”): …`',
      ]) expect(learn, `learn never says ${words}`).toContain(words);
      // The lines the skill quotes are the code's.
      const source = readFileSync(join(ROOT, 'packages/core/src/mirage/learn.ts'), 'utf8');
      for (const words of ["as the one chosen — they differ, and the title numbers here are the live title's", 'Thumbnail from two sources: better half']) expect(source, words).toContain(words);
    });

    it('the playbook lines for the pace per beat and the loop are explained, and a miss said by a ⚠ is said once', () => {
      for (const words of [
        '`<r> cuts a minute … ; in <beat> <r>, under its <range>; after the <beat> <r> (<range>)`',
        "A vlog's held `headline` is left out: its \"2 changes a minute\" is about camera angles, which a timeline doesn't show.",
        '`✗ ends on <beat> (item <id>), not on a loop beat — a standalone short ends where the restart flows into the hook`',
        "`✓ ends on its loop beat (item <id>) … — whether its last line leads back into the first shot is not measured: Mirage can't hear that`",
        "a standalone short's fading last cue",
      ]) expect(edit, `edit never says ${words}`).toContain(words);
      const source = readFileSync(join(ROOT, 'packages/core/src/mirage/playbook.ts'), 'utf8');
      for (const words of ['not on a loop beat — a standalone short ends where the restart flows into the hook', "whether its last line leads back into the first shot is not measured: Mirage can't hear that", "has no open question on record for the next episode — every episode's outro leaves one"]) expect(source, words).toContain(words);
    });

    it('the length is the format\'s and the person\'s formula\'s, and narration follows the format\'s density', () => {
      expect(edit).not.toContain('13 minutes');
      expect(format('build-story')).not.toContain('13 minutes');
      for (const words of [
        "The length is the format's and the person's own formula's, never a number from this skill",
        '`targetSec` and `warnPastSec` in its `playbook`',
        "`longer than your <format>-mine formula's <m:ss>`", "A short's limit stays 3:00 whatever a formula says.",
        "How much narration a video carries is its format's, not a blanket rule either way.",
        'When the playbook sets `wordsPerMin`', 'narration is not necessary where the picture is enough to understand the situation',
        'Leave a slot empty if the picture speaks for itself.',
      ]) expect(edit, `edit never says ${words}`).toContain(words);
      expect(format('build-story')).toContain('Mirage sets no length for a build story.');
      expect(format('vlog')).toContain('a vlog can be short, since too much is too much');
      const voiceover = read('voiceover');
      for (const words of ['A slot with no line is not a missing line.', 'where the playbook sets `wordsPerMin`', 'a slot is left empty when the picture speaks for itself', 'mcp__plugin_mirage_engine__series']) expect(voiceover, `voiceover never says ${words}`).toContain(words);
    });

    it('a short has one algorithm file per platform, predict holds it to each, and Instagram and TikTok numbers are typed', () => {
      const short = format('short');
      for (const id of ['youtube', 'instagram', 'tiktok']) expect(short, id).toContain(`\`formulas { id: "${id}" }\``);
      expect(short).toContain('`posted { video, url, also: [{ platform: "instagram" | "tiktok", url }] }`');
      const rules = readFileSync(join(ROOT, 'plugin', 'formulas', 'short.md'), 'utf8');
      for (const id of ['youtube', 'instagram', 'tiktok']) expect(rules, id).toContain(`\`formulas { id: "${id}" }\``);
      for (const words of [
        '`Per platform, the same cut against what each platform itself says (formulas youtube, instagram and tiktok) — no platform publishes weights, so these are not scores:`',
        '`YouTube Shorts:`, `Instagram Reels:` and `TikTok:`',
        "`✓ 0:34 long — Instagram recommends reels of 3:00 or less to people who don't follow the account`",
        '`– the covered areas: not measured — TikTok publishes no fixed margins …`', '`– not measurable from a cut: …`',
        'never turn them into a score',
      ]) expect(edit, `edit never says ${words}`).toContain(words);
      const source = readFileSync(join(ROOT, 'packages/core/src/mirage/predict.ts'), 'utf8');
      for (const words of ['Per platform, the same cut against what each platform itself says (formulas youtube, instagram and tiktok) — no platform publishes weights, so these are not scores:', "Instagram recommends reels of 3:00 or less to people who don't follow the account", 'the covered areas: not measured — TikTok publishes no fixed margins', 'not measurable from a cut: ']) expect(source, words).toContain(words);
      const learn = read('learn');
      for (const words of [
        '**Instagram and TikTok.**', 'Mirage reads public numbers only from YouTube; it reads nothing on Instagram or TikTok.',
        '`also: [{ platform: "instagram", url }, { platform: "tiktok", url }]`',
        '`also posted on Instagram (<url>) and TikTok (<url>) — Mirage reads no numbers there: give learn the ones you see in the app, as studio with platform`',
        '`studio: { video, platform: "instagram" | "tiktok", … }`', '`platform` left out means YouTube.',
        '`Elsewhere, video <n>: Instagram <url> — <views> views · <k> shares · … (typed by the person, <day>) · TikTok <url> — no numbers given yet`',
        '`Instagram and TikTok numbers are the ones the person typed: Mirage reads numbers only from YouTube, and every comparison above is of the YouTube numbers.`',
        '`✖ also: "<url>" isn\'t an address on Instagram`',
        '`⚠ video.json names the format "<id>", which isn\'t one of Mirage\'s (<ids>) — features.json describes the cut as a build story: fix format in episodes/<n>/video.json, then call posted again`',
      ]) expect(learn, `learn never says ${words}`).toContain(words);
    });

    it('analyse saves a starting point into the person\'s formula for the format, without being asked, and never over their own results', () => {
      const analyse = read('analyse');
      const at = ["\n## 6. Write the formula\n", "\n## 7. Save a starting point in the person's formula\n", "\n## When it is the person's own channel\n"].map((h) => analyse.indexOf(h));
      expect(at[0]).toBeGreaterThan(0);
      expect(at[1]).toBeGreaterThan(at[0]!);
      expect(at[2]).toBeGreaterThan(at[1]!);
      const step = analyse.slice(at[1]!, at[2]!);
      for (const words of [
        'do this without being asked', '`formulas/<format>-mine.md` (`build-story-mine`, `vlog-mine`, `short-mine`)',
        '**Length**', '**Pace**', '**Narration density**', '**Where the answer lands**', '**Title shapes**', '**Thumbnail layout**',
        "the formula's `\"playbook\"` front matter, the override `check` and `predict` already read",
        '`"targetSec"`', '`"warnPastSec"`', '`"wordsPerMin": { "min", "max" }`', '`"answer": { "beat", "fromShare", "toShare" }`', '`"title": { "allCaps", "hasNumber", "firstPerson", "endsWith", "words": { "min", "max" } }`',
        '`"playbook":{"targetSec":1800,"warnPastSec":2400,"wordsPerMin":{"min":150,"max":190}}`',
        "Never a number you didn't measure, and no cut rate: public data has none.",
        '`## From the niche (untested here)`', 'Every line names the channel it came from and the date',
        'They are starting points, not rules. The mirage:learn skill confirms or replaces each one from the person\'s own results',
        '**Never write over the person\'s own results.**', 'as an alternative to try', 'leave the playbook key as it is',
        'each format keeps its own length this way (a series\' episodes can be long, a vlog short)',
        '`✖ formulas/<format>-mine.md: <issue>`',
      ]) expect(step, `analyse step 7 never says ${words}`).toContain(words);
      // The example front matter is a playbook the engine accepts, and the heading is the learn skill's own.
      expect(PlaybookSchema.safeParse({ targetSec: 1800, warnPastSec: 2400, wordsPerMin: { min: 150, max: 190 } }).success).toBe(true);
      expect(read('learn')).toContain('## From the niche (untested here)');
      expect(read('learn')).toContain('a starting number the mirage:analyse skill saved there from a niche channel');
    });
  });

  it('overnight leaves out a vlog title card it has no name and date for, and asks', () => {
    expect(read('overnight')).toContain('- A vlog whose `episodes/<n>/video.json` has no `vlog` (its name and date): leave out the title card and log a `question` asking for the vlog\'s name and the day it was filmed. The vlog rules say never guess the date.');
  });

  it('the copy the plan fixes word for word is there', () => {
    const edit = read('edit');
    expect(edit).toContain("Here's the rough cut in Mirage's viewer. Click on the video to leave notes, then press Send notes.");
    expect(edit).toContain('Never write inside footage folders. Never invent footage, numbers or events.');
    expect(read('overnight')).toContain("Done for tonight. Mirage's viewer has the morning report.");
    expect(read('setup')).toContain('brew install whisper-cpp');
    expect(read('setup')).toContain('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin');
    expect(read('setup')).not.toMatch(/xcode-select|Parakeet/);
  });

  it('setup asks first, with a reason for each missing tool, and calls setup_later on "not now"', () => {
    const setup = read('setup');
    for (const line of [
      "- **Node.js** — runs Mirage itself: its engine and the viewer you watch your videos in.",
      "- **FFmpeg** — does the actual video work: cutting, joining, captions, music and the final export.",
      "- **whisper.cpp and its speech model (about 574 MB)** — lets Claude hear what's said in your clips, so it can pick the best takes and write captions; it runs on your computer, nothing is uploaded.",
      "- **Kokoro AI voice (about 260 MB, optional)** — reads narration aloud if you don't record your own; it downloads the first time you use it, so there's nothing to install now.",
    ]) expect(setup.split('\n')).toContain(line);
    expect(setup.indexOf('**Asking first**')).toBeLessThan(setup.indexOf('**How to work through it**'));
    expect(setup).toContain('`/mirage:setup` works any time');
    // With no Node the engine never started, so setup_later doesn't exist: the skill must not send Claude to it.
    expect(setup).toContain("If Node is the missing tool, don't call it");
  });

  it('setup asks for an FFmpeg that can draw captions: the reason, the check, the macOS install and the status line', () => {
    const setup = read('setup');
    const lines = setup.split('\n');
    const reason = "- **FFmpeg with caption support** — the plain Homebrew FFmpeg can't draw captions or text on the video, so Mirage needs Homebrew's complete build, ffmpeg-full; it's a bigger install because it brings the caption and font libraries.";
    const ffmpegLine = lines.findIndex((l) => l.startsWith('- **FFmpeg** — '));
    expect(lines[ffmpegLine + 1]).toBe(reason);
    expect(setup.indexOf(reason)).toBeLessThan(setup.indexOf('**How to work through it**'));
    const step3 = setup.slice(setup.indexOf('## Step 3 ·'), setup.indexOf('## Step 4 ·'));
    expect(step3).toContain('- macOS: `brew install ffmpeg-full`');
    expect(step3).toContain('/opt/homebrew/opt/ffmpeg-full/bin');
    expect(step3).toContain('ffmpeg -hide_banner -filters | grep -w ass');
    expect(step3).toContain('On a Mac, installing needs no restart (Mirage looks in the ffmpeg-full folder itself); on Windows, start a new Claude Code session first so Mirage sees the new PATH.');
    expect(step3).not.toContain('Installing needs no restart.');
    expect(step3).not.toMatch(/brew install ffmpeg(?!-full)/);
    expect(setup).not.toMatch(/brew install ffmpeg(?!-full)/);
    const step0 = setup.slice(setup.indexOf('## Step 0 ·'), setup.indexOf('## Step 1 ·'));
    expect(step0).toContain("`ffmpeg: can't draw captions — <path> was built without libass. <hint>`");
    expect(step0).toMatch(/can't draw captions[^\n]*step 3/);
    expect(read('status')).toContain("`ffmpeg: can't draw captions");
  });

  it('the skills that run on engine output say to use the tool when a message suggests a command', () => {
    for (const name of ['edit', 'voiceover'] as const) expect(read(name)).toMatch(/never run `pnpm`/i);
  });

  it.each(['notes', 'voiceover', 'overnight'] as const)('%s loads the edit skill first, whose rules it relies on', (name) => {
    expect(read(name)).toContain('First load the `mirage:edit` skill with the Skill tool, then ');
  });

  it('the old CLI skill and setup file are gone, so there is one source', () => {
    expect(existsSync(join(ROOT, '.claude', 'skills', 'mirage-episode'))).toBe(false);
    expect(existsSync(join(ROOT, 'setup', 'connect-tools.md'))).toBe(false);
  });
});
