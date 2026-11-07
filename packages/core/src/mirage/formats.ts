// SPDX-License-Identifier: MIT
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BeatSchema, CaptionsSchema, strictObject } from '@wordedits/shared';
import { z } from 'zod';
import { MirageError } from './errors.js';
import { describeZodError } from './json-file.js';
import type { Captions, Video } from '@wordedits/shared';

const even = z.number().int().positive().refine((n) => n % 2 === 0, { message: 'must be even' });

/**
 * The front matter of a format file (`plugin/formats/<id>.md`): a JSON object between two `---` lines. The rest of the
 * file is the format's rules, in Markdown.
 */
export const FormatSchema = strictObject({
  /** Equal to the file's name without `.md`. */
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  describe: z.string().min(1),
  /** Words a person uses for this kind of video ("reel", "day in the life"): Claude picks the format from them. */
  words: z.array(z.string().min(1)),
  /** The beat words the format's videos are built from, in the order they usually come. */
  beats: z.array(BeatSchema).min(1),
  /** The length the format aims for, in seconds. */
  targetSec: z.number().positive().optional(),
  /** A video longer than this gets a warning. */
  warnPastSec: z.number().positive().optional(),
  output: strictObject({ width: even, height: even }).optional(),
  captions: CaptionsSchema.optional(),
  /**
   * The kind of short a video of this format is made as when it doesn't say. Its presence also makes the format a short
   * for `check` (the hook, outro and loop warnings, and the Shorts and Reels covered-area check on a vertical frame): a new
   * vertical format should include `"short": {...}` to get the covered-area check. `new_video { from }` without a format
   * makes a video of the format whose id is `short`, whatever other formats have this.
   */
  short: strictObject({ kind: z.enum(['teaser', 'standalone']) }).optional(),
});

export type Format = z.infer<typeof FormatSchema> & {
  /**
   * The caption `style` and `position` the file itself writes (`captions` above has CaptionsSchema's defaults filled in):
   * what `check` holds a cut to. Left out when the file sets no captions.
   */
  statedCaptions?: Partial<Pick<Captions, 'style' | 'position'>>;
  /** The Markdown after the front matter: what the format asks of the cut. */
  rules: string;
  /** The file name inside the formats folder, `short.md`. */
  file: string;
};

/** This module as source or as its package build: packages/core/src/mirage or packages/core/dist/mirage. */
const SOURCE_LAYOUT = /[\\/]packages[\\/]core[\\/](?:src|dist)[\\/]mirage$/;

/**
 * The plugin's own formats folder, found from the code that runs like the fonts are: `from` (a file URL or path, default
 * this module) is either this source file (packages/core/src/mirage/formats.ts, or its build in packages/core/dist/mirage
 * → the repository's plugin/formats) or the bundle (plugin/dist/engine.mjs → plugin/formats). Each layout has one
 * folder, so a bundle never looks outside its own plugin.
 */
export function formatsDir(from: string = import.meta.url): string {
  const here = dirname(from.startsWith('file:') ? fileURLToPath(from) : resolve(from));
  return SOURCE_LAYOUT.test(here) ? resolve(here, '..', '..', '..', '..', 'plugin', 'formats') : resolve(here, '..', 'formats');
}

/** A format file split into its front matter (parsed) and its rules, or why it can't be. */
function splitFile(text: string): { front: unknown; rules: string } | string {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trimEnd() !== '---') return 'no front matter: the file must start with a --- line, a JSON object, and a --- line';
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (end < 0) return 'front matter has no closing --- line';
  let front: unknown;
  try {
    front = JSON.parse(lines.slice(1, end).join('\n'));
  } catch (e) {
    return `front matter is not valid JSON (${(e as Error).message})`;
  }
  if (front === null || typeof front !== 'object' || Array.isArray(front)) return 'front matter must be a JSON object';
  return { front, rules: lines.slice(end + 1).join('\n') };
}

/**
 * Reads every `<id>.md` in the formats folder (`dir`, default the plugin's own). A file that can't be used is left out
 * and named in `problems` as `✖ plugin/formats/<file>: <why>`: one typo never stops the other formats or the engine.
 * The formats come in the order of their file names.
 */
export function loadFormats(dir: string = formatsDir()): { formats: Format[]; problems: string[] } {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return { formats: [], problems: ['✖ plugin/formats: the folder is missing or unreadable'] };
  }
  const formats: Format[] = [];
  const problems: string[] = [];
  for (const file of names) {
    const problem = (why: string) => problems.push(`✖ plugin/formats/${file}: ${why}`);
    let text: string;
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch (e) {
      problem(`can't be read (${(e as Error).message})`);
      continue;
    }
    const split = splitFile(text);
    if (typeof split === 'string') {
      problem(split);
      continue;
    }
    const parsed = FormatSchema.safeParse(split.front);
    if (!parsed.success) {
      problem(describeZodError(parsed.error));
      continue;
    }
    const stem = file.slice(0, -'.md'.length);
    if (parsed.data.id !== stem) {
      problem(`id: the id "${parsed.data.id}" must be the file name, "${stem}"`);
      continue;
    }
    const raw = (split.front as { captions?: Partial<Captions> }).captions;
    const statedCaptions = raw && { ...(raw.style !== undefined ? { style: raw.style } : {}), ...(raw.position !== undefined ? { position: raw.position } : {}) };
    formats.push({ ...parsed.data, ...(statedCaptions ? { statedCaptions } : {}), rules: split.rules, file });
  }
  return { formats, problems };
}

/** The format of a video: the one it names, else the build story (a video without video.json, or whose format is unknown, is a build story too; `check` reports an unknown one). */
export function formatOf(video: Video | null, formats: Format[]): Format {
  const id = video?.format ?? 'build-story';
  const found = formats.find((f) => f.id === id) ?? formats.find((f) => f.id === 'build-story');
  if (!found) throw new MirageError('BAD_INPUT', "Mirage's build-story format is missing or broken", 'Run the formats tool to see what is wrong with plugin/formats, or reinstall the Mirage plugin.');
  return found;
}
