import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { EdlSchema } from '@wordedits/shared';
import { realMediaTools, renderEdl } from '@wordedits/core';

const [edlPath, input, mode = 'preview'] = process.argv.slice(2);
if (!edlPath || !input || (mode !== 'preview' && mode !== 'final')) {
  console.error('usage: pnpm render <edl.json> <input.mp4> [preview|final]');
  process.exit(2);
}

const edl = EdlSchema.parse(JSON.parse(await readFile(edlPath, 'utf8')));
const tools = await realMediaTools();
let last = -1;
const r = await renderEdl({
  edl, input: resolve(input), outputDir: resolve(dirname(edlPath), 'renders'), mode, tools,
  onProgress: (f) => {
    const pct = Math.floor(f * 100);
    if (pct !== last) { last = pct; process.stdout.write(`\r${pct}%`); }
  },
});
console.log(`\nwrote ${r.outputPath} (${r.probe.durationSec}s, ${r.probe.width}x${r.probe.height}@${r.probe.fps})`);
