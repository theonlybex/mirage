// SPDX-License-Identifier: MIT
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fallbackViewerArgs } from './fallback-viewer.js';

const here = join('/plugin', 'dist');
const all = () => true;

describe('fallbackViewerArgs', () => {
  it("is the monitor's viewer command with --fallback, and the plugin data folder when given", () => {
    expect(fallbackViewerArgs({ here, project: '/p', env: { MIRAGE_PLUGIN_DATA: '/data' }, exists: all })).toEqual([
      join(here, 'viewer.mjs'), '--project', '/p', '--ui', join(here, 'viewer-ui'), '--data', '/data', '--fallback',
    ]);
    expect(fallbackViewerArgs({ here, project: '/p', env: {}, exists: all })).toEqual([join(here, 'viewer.mjs'), '--project', '/p', '--ui', join(here, 'viewer-ui'), '--fallback']);
  });
  it('is null without a built viewer beside the engine, or when turned off', () => {
    expect(fallbackViewerArgs({ here, project: '/p', env: {}, exists: (p) => !p.endsWith('viewer-ui') })).toBeNull();
    expect(fallbackViewerArgs({ here, project: '/p', env: { MIRAGE_FALLBACK_VIEWER: '0' }, exists: all })).toBeNull();
  });
});
