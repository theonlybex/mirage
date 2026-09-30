import { describe, expect, it } from 'vitest';
import { WORDEDITS_VERSION } from './index.js';

describe('shared', () => {
  it('exports a version', () => {
    expect(WORDEDITS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
