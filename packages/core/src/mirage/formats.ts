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

const share = z.number().min(0).max(1);
const atLeastOne = (o: object) => Object.values(o).some((v) => v !== undefined);
const range = strictObject({ min: z.number().min(0).optional(), max: z.number().positive().optional() }).refine(atLeastOne, { message: 'needs min or max' });

/**
 * A format's playbook: the numbers its rules state, so `check` can measure a cut against them (its `Playbook (<format>):`
 * section) and `predict` can score it. Every key is optional: a format states only what its rules and formulas give a
 * number for, and only what can be measured honestly from the timeline, the catalog's transcripts and the narration
 * lines. A person's own formula for the format (`formulas/<format>-mine.md` in the project) may carry the same object in
 * its front matter: each key it has replaces the format's for that project.
 */
export const PlaybookSchema = strictObject({
  /** The first word is spoken within this many seconds. */
  firstWordSec: z.number().min(0).optional(),
  /**
   * The beat that holds the answer, and where it should start, 0–1 of the length. A teaser short has no answer of its
   * own to place (it leaves the big video's question open), so this is not measured on one.
   */
  answer: strictObject({ beat: BeatSchema, fromShare: share, toShare: share }).refine((a) => a.fromShare <= a.toShare, { message: 'fromShare must not be after toShare' }).optional(),
  /** The longest stretch, in seconds, in which nothing new may happen: no word (kept sound or narration), no cut and no overlay starting. */
  emptySec: z.number().positive().optional(),
  /**
   * Cuts a minute. `except` names beats whose time and cuts are left out (a vlog's held `headline`). Where the format gives
   * a pace for particular beats, `beats` holds each one's own range (measured over that beat's shots only), and `after`
   * the range for what comes after a beat (the shots that start once its last item has ended, `except` its named beats: a
   * vlog's back half, after the `headline`). The whole-cut number stays.
   */
  cutsPerMin: strictObject({
    min: z.number().min(0).optional(), max: z.number().positive().optional(), except: z.array(BeatSchema).optional(),
    beats: z.record(BeatSchema, range).optional(),
    after: strictObject({ beat: BeatSchema, min: z.number().min(0).optional(), max: z.number().positive().optional(), except: z.array(BeatSchema).optional() })
      .refine((c) => c.min !== undefined || c.max !== undefined, { message: 'needs min or max' }).optional(),
  }).refine((c) => c.min !== undefined || c.max !== undefined, { message: 'needs min or max' }).optional(),
  /** Spoken words a minute over the whole video. */
  wordsPerMin: strictObject({ min: z.number().min(0).optional(), max: z.number().positive().optional() }).refine(atLeastOne, { message: 'needs min or max' }).optional(),
  /** Whether the video's `idea` (video.json: gap, question, doubt, stake) is expected: its gap and its question at least. */
  ideaNeeded: z.boolean().optional(),
  /** The beats a video of the format ends on: its last item is one of them. */
  endsOn: z.array(BeatSchema).min(1).optional(),
  /**
   * The measurable parts of the format's title style, held against the title the person chose (video.json's
   * `titles.chosen`): in capitals, with a number, in the first person, how it ends, how many words. Each is left out when
   * the format's titles don't share it.
   */
  title: strictObject({
    allCaps: z.boolean().optional(), hasNumber: z.boolean().optional(), firstPerson: z.boolean().optional(),
    endsWith: z.enum(['?', '!!']).optional(), words: range.optional(),
  }).refine(atLeastOne, { message: 'needs at least one of allCaps, hasNumber, firstPerson, endsWith, words' }).optional(),
  /**
   * The length a video of the format aims for in this project, in seconds, and the length past which `check` warns
   * (default 1.5 × targetSec). They replace the format's own `targetSec` and `warnPastSec`, so each format's length is
   * set per project: first from the channels of the niche, then from the person's own results. A short's limit never
   * goes past the format's (the longest the platforms take).
   */
  targetSec: z.number().positive().optional(),
  warnPastSec: z.number().positive().optional(),
});
export type Playbook = z.infer<typeof PlaybookSchema>;

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
  /** The format's numbers, which `check` measures a cut against and `predict` scores (see PlaybookSchema). */
  playbook: PlaybookSchema.optional(),
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

/** A format file (or a formula file: the same shape) split into its front matter (parsed) and its rules, or why it can't be. */
export function splitFile(text: string): { front: unknown; rules: string } | string {
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

/**
 * The kind of short a video of this format is: one made from a big video is the format's kind (a teaser), one with no big
 * video behind it stands alone. Null for a format that is no short.
 */
export function shortKind(format: Format, video: Video | null): 'teaser' | 'standalone' | null {
  return format.short ? (video?.from !== undefined ? format.short.kind : 'standalone') : null;
}
