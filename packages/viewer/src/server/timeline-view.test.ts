// SPDX-License-Identifier: MIT
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mediaPath } from './media.js';
import { buildTimelineView } from './timeline-view.js';
import { catalogJson, episodeJson } from './test-project.js';

const project = "/tmp/we proj 'q' #1 ✨";
const raw = (episode: unknown, catalog: unknown = catalogJson()) => ({
  episode: episode === null ? null : typeof episode === 'string' ? episode : JSON.stringify(episode),
  catalog: catalog === null ? null : typeof catalog === 'string' ? catalog : JSON.stringify(catalog),
});

describe('buildTimelineView', () => {
  it('is empty without an episode.json', () => {
    expect(buildTimelineView(project, raw(null), null)).toEqual({ status: 'empty', title: '', durationSec: 0, items: [], overlays: [], music: [], slots: [], voice: [] });
  });

  it('lays out the items with thumbnails, the lanes and the voice', () => {
    const v = buildTimelineView(project, raw(episodeJson()), null);
    expect(v.status).toBe('ok');
    expect(v.title).toBe('Build story');
    expect(v.durationSec).toBeCloseTo(20);
    expect(v.items).toEqual([
      { id: 'i1', beat: 'cold-open', clip: 'c001', start: 0, end: 10, thumb: mediaPath(join(project, 'frames/c001/f5.jpg')), quiet: false, speed: 1 },
      { id: 'i2', beat: 'montage', clip: 'c001', start: 10, end: 20, thumb: mediaPath(join(project, 'frames/c001/f20.jpg')), quiet: true, speed: 4 },
    ]);
    expect(v.overlays).toEqual([{ kind: 'callout', text: 'It works', tone: 'pass', start: 1, end: 3 }]);
    expect(v.music).toEqual([{ track: 'calm', start: 0, end: 12 }]);
    expect(v.slots).toEqual([{ id: 's1', start: 0, end: 4, line: 'Hello there.', maxWords: 10 }]);
    // at 0.5, plays 6 - 2 = 4 s of the recording, less the 0.5 s cut
    expect(v.voice).toEqual([{ slot: 's1', start: 0.5, end: 4 }]);
  });

  it('shows a card as its text, or its picture\'s file name, with no thumbnail', () => {
    const items = [
      { id: 'k', beat: 'title', card: { style: 'mono', text: '3 days later\n...', sec: 2 } },
      { id: 'i1', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 10 } },
      { id: 'p', beat: 'outro', card: { style: 'image', image: 'pics/the end.jpg', sec: 1.5 }, hold: 0.5 },
    ];
    const v = buildTimelineView(project, raw(episodeJson('Cards', { items })), null);
    expect(v.status).toBe('ok');
    expect(v.durationSec).toBeCloseTo(14);
    expect(v.items).toEqual([
      { id: 'k', beat: 'title', card: { style: 'mono', label: '3 days later' }, start: 0, end: 2, thumb: null, quiet: false, speed: 1 },
      { id: 'i1', beat: 'cold-open', clip: 'c001', start: 2, end: 12, thumb: mediaPath(join(project, 'frames/c001/f5.jpg')), quiet: false, speed: 1 },
      { id: 'p', beat: 'outro', card: { style: 'image', label: 'the end.jpg' }, start: 12, end: 14, thumb: null, quiet: false, speed: 1 },
    ]);
  });

  it('has no thumbnail when the catalog is missing, broken or lacks the clip', () => {
    expect(buildTimelineView(project, raw(episodeJson(), null), null).items.map((i) => i.thumb)).toEqual([null, null]);
    expect(buildTimelineView(project, raw(episodeJson(), '{ nope'), null).items.map((i) => i.thumb)).toEqual([null, null]);
    expect(buildTimelineView(project, raw(episodeJson(), { version: 1, clips: [] }), null).items.map((i) => i.thumb)).toEqual([null, null]);
  });

  it('is "editing" and keeps the previous lists while the file does not parse or fails the schema', () => {
    const good = buildTimelineView(project, raw(episodeJson('Good')), null);
    for (const bad of ['{ "version": 2, "items": [', episodeJson('Bad', { items: [] }), '']) {
      const v = buildTimelineView(project, raw(bad), good);
      expect(v).toEqual({ ...good, status: 'editing' });
    }
    expect(buildTimelineView(project, raw('{ nope'), null)).toEqual({ status: 'editing', title: '', durationSec: 0, items: [], overlays: [], music: [], slots: [], voice: [] });
  });
});
