// SPDX-License-Identifier: MIT
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bundledFontsDir, CAPTION_FONT, CAPTION_FONT_FILE, MONO_FONT, MONO_FONT_FILE } from './fonts.js';

/** A fonts folder as the plugin has it: every bundled font file (placeholders). */
const fill = async (dir: string) => {
  for (const f of [CAPTION_FONT_FILE, MONO_FONT_FILE]) await writeFile(join(dir, f), 'x');
};

describe('bundledFontsDir', () => {
  it('finds the font folder next to the bundle (plugin/dist/engine.mjs → plugin/fonts/files)', async () => {
    const plugin = await mkdtemp(join(tmpdir(), 'we fonts '));
    await mkdir(join(plugin, 'dist'), { recursive: true });
    await mkdir(join(plugin, 'fonts', 'files'), { recursive: true });
    await fill(join(plugin, 'fonts', 'files'));
    expect(bundledFontsDir(pathToFileURL(join(plugin, 'dist', 'engine.mjs')).href)).toBe(join(plugin, 'fonts', 'files'));
    // A file path works as well as a file URL.
    expect(bundledFontsDir(join(plugin, 'dist', 'engine.mjs'))).toBe(join(plugin, 'fonts', 'files'));
  });

  it('holds only font files in the folder libass reads (it tries to open every file there as a font)', () => {
    expect(readdirSync(bundledFontsDir()).sort()).toEqual([MONO_FONT_FILE, CAPTION_FONT_FILE]);
  });

  it('finds the repository\'s plugin/fonts/files from the source file', () => {
    const dir = bundledFontsDir();
    expect(existsSync(join(dir, CAPTION_FONT_FILE))).toBe(true);
    expect(dir.endsWith(join('plugin', 'fonts', 'files'))).toBe(true);
    expect(CAPTION_FONT).toBe('Montserrat ExtraBold');
    // The family libass matches the monospace by (its fontselect log line: (JetBrains Mono, 400, 0) -> JetBrainsMono-Regular).
    expect(existsSync(join(dir, MONO_FONT_FILE))).toBe(true);
    expect(MONO_FONT).toBe('JetBrains Mono');
  });

  it('from the bundle, never looks outside its own plugin folder', async () => {
    // An installed plugin: <cache>/a/b/c/plugin/dist/engine.mjs. Four levels up from dist there is a stray plugin/fonts/files.
    const cache = await mkdtemp(join(tmpdir(), 'we cache '));
    const plugin = join(cache, 'a', 'b', 'c', 'plugin');
    await mkdir(join(plugin, 'dist'), { recursive: true });
    await mkdir(join(cache, 'a', 'plugin', 'fonts', 'files'), { recursive: true });
    await writeFile(join(cache, 'a', 'plugin', 'fonts', 'files', CAPTION_FONT_FILE), 'x');
    expect(() => bundledFontsDir(join(plugin, 'dist', 'engine.mjs'))).toThrow(expect.objectContaining({ message: `Mirage's caption font is missing from ${join(plugin, 'fonts', 'files')}` }));
  });

  it('from the source (packages/core/src/mirage or packages/core/dist/mirage), uses the repository\'s plugin/fonts/files', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'we repo '));
    for (const d of ['src', 'dist']) await mkdir(join(repo, 'packages', 'core', d, 'mirage'), { recursive: true });
    // A fonts folder where a bundle would have it is not looked at from the source.
    await mkdir(join(repo, 'packages', 'core', 'src', 'fonts', 'files'), { recursive: true });
    await writeFile(join(repo, 'packages', 'core', 'src', 'fonts', 'files', CAPTION_FONT_FILE), 'x');
    const from = (d: string) => pathToFileURL(join(repo, 'packages', 'core', d, 'mirage', 'fonts.js')).href;
    expect(() => bundledFontsDir(from('src'))).toThrow(expect.objectContaining({ message: `Mirage's caption font is missing from ${join(repo, 'plugin', 'fonts', 'files')}` }));
    await mkdir(join(repo, 'plugin', 'fonts', 'files'), { recursive: true });
    await fill(join(repo, 'plugin', 'fonts', 'files'));
    expect(bundledFontsDir(from('src'))).toBe(join(repo, 'plugin', 'fonts', 'files'));
    expect(bundledFontsDir(from('dist'))).toBe(join(repo, 'plugin', 'fonts', 'files'));
  });

  it('stops with BAD_ITEM naming the folder when the font is missing (a broken install)', async () => {
    const plugin = await mkdtemp(join(tmpdir(), 'we nofont '));
    await mkdir(join(plugin, 'dist'), { recursive: true });
    await mkdir(join(plugin, 'fonts', 'files'), { recursive: true });
    expect(() => bundledFontsDir(join(plugin, 'dist', 'engine.mjs'))).toThrow(
      expect.objectContaining({ code: 'BAD_ITEM', message: `Mirage's caption font is missing from ${join(plugin, 'fonts', 'files')}`, hint: 'Reinstall the Mirage plugin.' }),
    );
  });

  it('stops with BAD_ITEM when the monospace font is missing (a broken install)', async () => {
    const plugin = await mkdtemp(join(tmpdir(), 'we nomono '));
    await mkdir(join(plugin, 'dist'), { recursive: true });
    await mkdir(join(plugin, 'fonts', 'files'), { recursive: true });
    await writeFile(join(plugin, 'fonts', 'files', CAPTION_FONT_FILE), 'x');
    expect(() => bundledFontsDir(join(plugin, 'dist', 'engine.mjs'))).toThrow(
      expect.objectContaining({ code: 'BAD_ITEM', message: `Mirage's card font is missing from ${join(plugin, 'fonts', 'files')}`, hint: 'Reinstall the Mirage plugin.' }),
    );
  });
});
