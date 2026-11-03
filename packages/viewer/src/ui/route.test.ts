// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { hrefFor, parseRoute } from './route.js';

describe('parseRoute', () => {
  it('reads the video list and the tabs of a video', () => {
    expect(parseRoute('')).toEqual({ page: 'videos' });
    expect(parseRoute('#/')).toEqual({ page: 'videos' });
    expect(parseRoute('#/v/3/edit')).toEqual({ page: 'video', video: 3, tab: 'edit' });
    expect(parseRoute('#/v/12/versions')).toEqual({ page: 'video', video: 12, tab: 'versions' });
    expect(parseRoute('#/v/2')).toEqual({ page: 'video', video: 2, tab: 'edit' });
    expect(parseRoute('#/v/2/nope')).toEqual({ page: 'video', video: 2, tab: 'edit' });
    expect(parseRoute('#/v/0/edit')).toEqual({ page: 'videos' });
    expect(parseRoute('#/elsewhere')).toEqual({ page: 'videos' });
  });

  it('round-trips through hrefFor', () => {
    for (const h of ['#/', '#/v/1/edit', '#/v/4/report']) expect(hrefFor(parseRoute(h))).toBe(h);
  });
});
