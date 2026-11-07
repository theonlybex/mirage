// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bundledFontsDir, CAPTION_FONT, CAPTION_FONT_FILE } from './fonts.js';

describe('bundledFontsDir', () => {
  it('finds the fonts folder next to the bundle (plugin/dist/engine.mjs → plugin/fonts)', async () => {
    const plugin = await mkdtemp(join(tmpdir(), 'we fonts '));
    await mkdir(join(plugin, 'dist'), { recursive: true });
    await mkdir(join(plugin, 'fonts'), { recursive: true });
    await writeFile(join(plugin, 'fonts', CAPTION_FONT_FILE), 'x');
    expect(bundledFontsDir(pathToFileURL(join(plugin, 'dist', 'engine.mjs')).href)).toBe(join(plugin, 'fonts'));
    // A file path works as well as a file URL.
    expect(bundledFontsDir(join(plugin, 'dist', 'engine.mjs'))).toBe(join(plugin, 'fonts'));
  });

  it('finds the repository\'s plugin/fonts from the source file', () => {
    const dir = bundledFontsDir();
    expect(existsSync(join(dir, CAPTION_FONT_FILE))).toBe(true);
    expect(dir.endsWith(join('plugin', 'fonts'))).toBe(true);
    expect(CAPTION_FONT).toBe('Montserrat ExtraBold');
  });

  it('stops with BAD_ITEM naming the folder when the font is missing (a broken install)', async () => {
    const plugin = await mkdtemp(join(tmpdir(), 'we nofont '));
    await mkdir(join(plugin, 'dist'), { recursive: true });
    await mkdir(join(plugin, 'fonts'), { recursive: true });
    expect(() => bundledFontsDir(join(plugin, 'dist', 'engine.mjs'))).toThrow(
      expect.objectContaining({ code: 'BAD_ITEM', message: `Mirage's caption font is missing from ${join(plugin, 'fonts')}`, hint: 'Reinstall the Mirage plugin.' }),
    );
  });
});
