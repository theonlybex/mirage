import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

if (process.platform !== 'darwin') {
  console.log(`build:native: nothing to build on ${process.platform}`);
  process.exit(0);
}
const outDir = 'packages/sidecars/bin/darwin';
await mkdir(outDir, { recursive: true });
execFileSync('swiftc', ['-parse-as-library', '-O', 'native/macos/transcribe.swift', '-o', `${outDir}/wordedits-transcribe`], { stdio: 'inherit' });
console.log(`built ${outDir}/wordedits-transcribe`);
