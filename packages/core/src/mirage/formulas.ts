// SPDX-License-Identifier: MIT
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strictObject } from '@wordedits/shared';
import { z } from 'zod';
import { formatsDir, PlaybookSchema, splitFile } from './formats.js';
import { describeZodError } from './json-file.js';

const oneLine = z.string().min(1).refine((s) => !/[\r\n]/.test(s), { message: 'must be one line' });

/**
 * The front matter of a formula file (`plugin/formulas/<id>.md`, or `formulas/<id>.md` in a project): a JSON object between
 * two `---` lines, as in a format file. The rest of the file is the formula, in Markdown: what was measured on a channel and
 * the rules that follow from it.
 */
export const FormulaSchema = strictObject({
  /** Equal to the file's name without `.md`. */
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  describe: oneLine,
  /** The ids of the formats it applies to (`build-story`, `short`, `vlog` …); may be empty. */
  formats: z.array(z.string().min(1)),
  /** What it was measured on, and when. */
  source: oneLine,
  /**
   * Only read from a person's `<format>-mine` formula: the playbook numbers their own results gave (see PlaybookSchema).
   * Each key replaces the format's for that project; `check` says which. This is how learning adjusts the playbook while
   * Mirage's own files stay as they are.
   */
  playbook: PlaybookSchema.optional(),
});

export type Formula = z.infer<typeof FormulaSchema> & {
  /** `mirage`: one of the plugin's own, which nobody changes. `yours`: one the person saved in the project's `formulas` folder. */
  origin: 'mirage' | 'yours';
  /** The Markdown after the front matter. */
  body: string;
  /** The file name inside its formulas folder, `episode.md`. */
  file: string;
  /** The file itself. */
  path: string;
};

/** The plugin's own formulas folder, beside its formats folder (see formatsDir): plugin/formulas. */
export function formulasDir(from: string = import.meta.url): string {
  return join(formatsDir(from), '..', 'formulas');
}

/** In a project's formulas folder, the log the mirage:learn skill keeps of every change to the person's formulas: not a formula. */
export const CHANGES_FILE = 'changes.md';

const mdFiles = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
const stem = (file: string) => file.slice(0, -'.md'.length);

/** One formula file read and checked, or why it can't be used. */
function readFormula(dir: string, file: string, origin: Formula['origin']): Formula | string {
  let text: string;
  try {
    text = readFileSync(join(dir, file), 'utf8');
  } catch (e) {
    return `can't be read (${(e as Error).message})`;
  }
  const split = splitFile(text);
  if (typeof split === 'string') return split;
  const parsed = FormulaSchema.safeParse(split.front);
  if (!parsed.success) return describeZodError(parsed.error);
  if (parsed.data.id !== stem(file)) return `id: the id "${parsed.data.id}" must be the file name, "${stem(file)}"`;
  return { ...parsed.data, origin, body: split.rules, file, path: join(dir, file) };
}

/**
 * Mirage's own formulas (every `<id>.md` in `dir`, default the plugin's `formulas` folder), then the person's own from
 * `<projectDir>/formulas/*.md` when a project is given; each group in the order of its file names. A file that can't be
 * used is left out and named in `problems`, as `✖ plugin/formulas/<file>: <why>` or, for the person's,
 * `✖ formulas/<file>: <why>`: one typo never hides the other formulas. Mirage's own are read-only: a project file named
 * like one of them never replaces it; it is left out, with a problem line saying to save it under another name. The
 * project's `formulas/changes.md` is the log of changes to the person's formulas, not a formula: it is passed over. A
 * project without a `formulas` folder simply has none.
 */
export function loadFormulas(dir: string = formulasDir(), projectDir?: string): { formulas: Formula[]; problems: string[] } {
  const formulas: Formula[] = [];
  const problems: string[] = [];
  let own: string[] = [];
  try {
    own = mdFiles(dir);
  } catch {
    problems.push('✖ plugin/formulas: the folder is missing or unreadable');
  }
  for (const file of own) {
    const f = readFormula(dir, file, 'mirage');
    if (typeof f === 'string') problems.push(`✖ plugin/formulas/${file}: ${f}`);
    else formulas.push(f);
  }
  if (projectDir === undefined) return { formulas, problems };
  const theirs = join(projectDir, 'formulas');
  let names: string[];
  try {
    names = mdFiles(theirs).filter((f) => f !== CHANGES_FILE);
  } catch {
    return { formulas, problems };
  }
  for (const file of names) {
    // By file name, so a broken built-in keeps its name too.
    if (own.includes(file)) {
      problems.push(`✖ formulas/${file}: "${stem(file)}" is one of Mirage's own formulas, which can't be changed — save yours under another name`);
      continue;
    }
    const f = readFormula(theirs, file, 'yours');
    if (typeof f === 'string') problems.push(`✖ formulas/${file}: ${f}`);
    else formulas.push(f);
  }
  return { formulas, problems };
}

/** One line of the `formulas` list: id, name, what it is, the formats it is for, what it was measured on, and whose it is. */
export function formulaLine(f: Formula): string {
  return `${f.id} — ${f.name}: ${f.describe} (formats: ${f.formats.join(', ') || 'none'}; measured on: ${f.source}) ${f.origin === 'yours' ? '(yours)' : "(Mirage's, can't be changed)"}`;
}

/** The id of the person's learned formula for a format: `short-mine`. The mirage:learn skill keeps one per format. */
export const mineId = (formatId: string) => `${formatId}-mine`;
