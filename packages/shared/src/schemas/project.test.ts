import { describe, expect, it } from 'vitest';
import { ProjectSchema } from './project.js';

describe('ProjectSchema', () => {
  it('parses a new project', () => {
    const p = ProjectSchema.parse({
      id: 'abc123',
      title: 'My Video',
      createdAt: '2026-09-29T10:00:00.000Z',
      stage: 'start',
      format: 'talking-head',
      source: null,
    });
    expect(p.stage).toBe('start');
  });

  it('rejects an unknown stage', () => {
    expect(
      ProjectSchema.safeParse({
        id: 'x', title: 't', createdAt: '2026-09-29T10:00:00.000Z',
        stage: 'timeline', format: 'talking-head', source: null,
      }).success,
    ).toBe(false);
  });
});
