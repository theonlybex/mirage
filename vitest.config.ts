import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    // CSS is left out of tests, except the token sheet, which the viewer's token test reads (`?raw`).
    css: { include: [/\/ui\/theme\/tokens\.css(\?|$)/] },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
