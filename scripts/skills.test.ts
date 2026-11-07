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
