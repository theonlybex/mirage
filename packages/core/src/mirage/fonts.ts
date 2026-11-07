// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MirageError } from './errors.js';

/** The family name libass matches the bundled caption font by (its fontselect log line names it). */
export const CAPTION_FONT = 'Montserrat ExtraBold';
/** The caption font's file in the plugin's `fonts/files` folder. */
export const CAPTION_FONT_FILE = 'Montserrat-ExtraBold.ttf';
/** The family name libass matches the bundled monospace (mono cards) by: `fontselect: (JetBrains Mono, 400, 0) -> JetBrainsMono-Regular`. */
export const MONO_FONT = 'JetBrains Mono';
/** The monospace's file in the plugin's `fonts/files` folder. */
export const MONO_FONT_FILE = 'JetBrainsMono-Regular.ttf';

/** This module as source or as its package build: packages/core/src/mirage or packages/core/dist/mirage. */
const SOURCE_LAYOUT = /[\\/]packages[\\/]core[\\/](?:src|dist)[\\/]mirage$/;

/**
 * The plugin's own font folder (`fonts/files`: font files only, since libass tries to open every file in it as a font;
 * the licence and readme are in `fonts/`), found from the code that runs: `from` (a file URL or path, default this
 * module) is either this source file (packages/core/src/mirage/fonts.ts, or its build in packages/core/dist/mirage →
 * the repository's plugin/fonts/files) or the bundle (plugin/dist/engine.mjs → plugin/fonts/files). Each layout has one
 * folder, so a bundle never looks outside its own plugin. When a font (the captions' or the cards' monospace) is not
 * there, a broken install, it says so rather than letting libass pick another font.
 */
export function bundledFontsDir(from: string = import.meta.url): string {
  const here = dirname(from.startsWith('file:') ? fileURLToPath(from) : resolve(from));
  const dir = SOURCE_LAYOUT.test(here) ? resolve(here, '..', '..', '..', '..', 'plugin', 'fonts', 'files') : resolve(here, '..', 'fonts', 'files');
  if (!existsSync(join(dir, CAPTION_FONT_FILE))) throw new MirageError('BAD_ITEM', `Mirage's caption font is missing from ${dir}`, 'Reinstall the Mirage plugin.');
  if (!existsSync(join(dir, MONO_FONT_FILE))) throw new MirageError('BAD_ITEM', `Mirage's card font is missing from ${dir}`, 'Reinstall the Mirage plugin.');
  return dir;
}
