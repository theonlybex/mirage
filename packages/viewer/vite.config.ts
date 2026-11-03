// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds the viewer page into dist-ui/. The server only serves index.html and assets/, adding the session key to each
// src/href in the page and each url() in a stylesheet, so: everything goes under assets/ (no public/ folder), the
// script is one file (no chunks, no dynamic import()), and the font and icons are bundled (the page may load nothing
// from outside; the icons are inline SVG paths in the script).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** The licences of the bundled font and icons, shipped beside them in assets/licenses/. */
function fontLicences(): Plugin {
  const files: Record<string, string> = {
    'licenses/google-sans-flex-OFL.txt': join(dirname(require.resolve('@fontsource-variable/google-sans-flex/package.json')), 'LICENSE'),
    'licenses/material-symbols-LICENSE.txt': join(dirname(require.resolve('@material-symbols/svg-400/package.json')), 'LICENSE'),
  };
  return {
    name: 'mirage-font-licences',
    apply: 'build',
    generateBundle() {
      for (const [fileName, from] of Object.entries(files)) this.emitFile({ type: 'asset', fileName: `assets/${fileName}`, source: readFileSync(from, 'utf8') });
    },
  };
}

export default defineConfig({
  root: here,
  base: '/',
  publicDir: false,
  plugins: [react(), fontLicences()],
  build: {
    outDir: 'dist-ui',
    emptyOutDir: true,
    assetsDir: 'assets',
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: false,
    sourcemap: false,
    target: 'es2022',
    rolldownOptions: {
      output: { codeSplitting: false },
    },
  },
});
