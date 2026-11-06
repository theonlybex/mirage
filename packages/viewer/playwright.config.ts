// SPDX-License-Identifier: MIT
// The plugin's end-to-end tests (`pnpm --filter @wordedits/viewer test:e2e`): the built plugin/ driven as Claude Code would,
// with the viewer page in Chromium. Not part of `pnpm test`. Run `pnpm build:plugin` first: they use plugin/dist.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  outputDir: './test-results',
  // One at a time: each test runs its own engine, viewer and ffmpeg renders.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 60_000 },
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
});
