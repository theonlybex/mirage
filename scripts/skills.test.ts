// SPDX-License-Identifier: MIT
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../packages/mcp/src/server.js';

const ROOT = resolve(import.meta.dirname, '..');
const SKILLS = ['edit', 'notes', 'voiceover', 'overnight', 'setup', 'status'] as const;
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
    ]) expect(edit, `edit never explains ${message}`).toContain(message);
    const vlog = readFileSync(join(ROOT, 'plugin', 'formats', 'vlog.md'), 'utf8');
    expect(vlog).toContain('tailOut');
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
      '`a short opens on its hook: item <id> starts with <s> s of silence`',
      '`a short opens on its hook, not a <beat>: item <id>`',
      '`a short has no outro: item <id>`',
      '`a standalone short loops: the last music cue fades out at the end — set its fadeOut to 0`',
      '`a teaser short ends pointing to the full video: add a pointer beat at the end`',
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
    // The vlog's title card is a title-card beat, as the vlog format names it; vlogs count up per name.
    expect(edit).toContain('{ "id": "t1", "beat": "title-card", "card": { "text": "Sam\\nVlog #3\\n11-6-26", "style": "mono", "sec": 2 } }');
    expect(edit).toContain("`number` is one more than the highest among the project's vlogs of that name, or 1");
  });

  it('status explains the Formats line and a broken format file', () => {
    const status = read('status');
    expect(status).toContain('`Formats: <id>, <id>, …`');
    expect(status).toContain('`✖ plugin/formats/<file>: <issue>`');
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
