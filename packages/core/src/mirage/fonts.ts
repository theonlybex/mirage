// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MirageError } from './errors.js';

/** The family name libass matches the bundled caption font by (its fontselect log line names it). */
export const CAPTION_FONT = 'Montserrat ExtraBold';
/** The caption font's file in the plugin's `fonts/files` folder. */
export const CAPTION_FONT_FILE = 'Montserrat-ExtraBold.ttf';

/**
 * The plugin's own font folder (`fonts/files`: font files only, since libass tries to open every file in it as a font;
 * the licence and readme are in `fonts/`), found from the code that runs: `from` (a file URL or path, default this
 * module) is either the bundle (plugin/dist/engine.mjs → plugin/fonts/files) or this source file
 * (packages/core/src/mirage/fonts.ts, or its build in packages/core/dist/mirage → the repository's plugin/fonts/files).
 * The first that holds the caption font wins; with neither, a broken install, it says which folder lacks it rather than
 * letting libass pick another font.
 */
export function bundledFontsDir(from: string = import.meta.url): string {
  const here = dirname(from.startsWith('file:') ? fileURLToPath(from) : resolve(from));
  const candidates = [resolve(here, '..', 'fonts', 'files'), resolve(here, '..', '..', '..', '..', 'plugin', 'fonts', 'files')];
  const found = candidates.find((d) => existsSync(join(d, CAPTION_FONT_FILE)));
  if (found) return found;
  const folder = candidates.find((d) => existsSync(d)) ?? candidates[0];
  throw new MirageError('BAD_ITEM', `Mirage's caption font is missing from ${folder}`, 'Reinstall the Mirage plugin.');
}
