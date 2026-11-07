// SPDX-License-Identifier: MIT
import { EpisodeSchema, type Catalog, type Episode, type MusicLibrary } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { snapToBeats } from './music.js';
import type { ClipSource } from './render-episode.js';
import { fadesFor, spills } from './spill.js';
import { layoutTimeline } from './timeline.js';

type Probe = Catalog['clips'][number]['probe'];
const probe = (p: Partial<Probe> = {}): Probe => ({ durationSec: 20, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', colorTransfer: null, ...p });
const catalogOf = (clips: Record<string, Partial<Probe>>): Catalog => ({
  version: 1,
  clips: Object.entries(clips).map(([id, p]) => ({ id, path: `/${id}.mov`, sha256: 'a'.repeat(64), probe: probe(p), kind: 'talking' as const, transcript: null, frames: [], notes: '', moments: [] })),
});
const catalog = catalogOf({ c1: {}, c2: {} });
const ep = (items: object[]): Episode => EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items });
/** A clip item that keeps its own sound. */
const live = (id: string, clip: string, from: number, to: number, extra: object = {}) => ({ id, beat: 'problem', clip, src: { in: from, out: to }, audio: 'keep', ...extra });

describe('spills', () => {
  it('finds nothing, and shortens nothing, in an episode without leadIn or tailOut', () => {
    expect(spills(ep([live('a', 'c1', 2, 4), live('b', 'c2', 5, 7)]), catalog)).toEqual({ spills: [], shortened: [] });
  });

  it('a lead plays the clip before src.in under the end of the shot before; a tail plays it after src.out under the shot after', () => {
    const e = ep([live('a', 'c1', 2, 4, { tailOut: 0.5 }), live('b', 'c2', 5, 7, { leadIn: 1 })]);
    expect(spills(e, catalog)).toEqual({
      spills: [
        { item: 'a', kind: 'tail', clip: 'c1', srcIn: 4, srcOut: 4.5, at: 2, sec: 0.5 },
        { item: 'b', kind: 'lead', clip: 'c2', srcIn: 4, srcOut: 5, at: 1, sec: 1 },
      ],
      shortened: [],
    });
  });

  it('takes the sources the render uses as well as the catalog', () => {
    const e = ep([live('a', 'c1', 2, 4, { tailOut: 0.5 }), live('b', 'c2', 5, 7, { leadIn: 1 })]);
    const sources = new Map<string, ClipSource>([
      ['c1', { path: '/c1.mov', hasAudio: true, durationSec: 20 }],
      ['c2', { path: '/c2.mov', hasAudio: true, durationSec: 20 }],
    ]);
    expect(spills(e, sources)).toEqual(spills(e, catalog));
  });

  it("a lead on the first shot or a tail on the last has nothing to overlap: it's the first or last shot", () => {
    const e = ep([live('a', 'c1', 2, 4, { leadIn: 1 }), live('b', 'c2', 5, 7, { tailOut: 1 })]);
    expect(spills(e, catalog)).toEqual({
      spills: [],
      shortened: [
        { item: 'a', field: 'leadIn', asked: 1, got: 0, reason: "it's the first shot" },
        { item: 'b', field: 'tailOut', asked: 1, got: 0, reason: "it's the last shot" },
      ],
    });
  });

  it('is shortened to the sound the clip has before and after the shot', () => {
    const e = ep([live('x', 'c2', 10, 13), live('a', 'c1', 0.4, 18.5, { leadIn: 1, tailOut: 2.5 }), live('y', 'c2', 10, 13)]);
    const r = spills(e, catalog);
    expect(r.shortened).toEqual([
      { item: 'a', field: 'leadIn', asked: 1, got: 0.4, reason: 'c1 has only 0.40 s of sound before the shot' },
      { item: 'a', field: 'tailOut', asked: 2.5, got: 1.5, reason: 'c1 has only 1.50 s of sound after the shot' },
    ]);
    expect(r.spills.map((s) => [s.kind, s.srcIn, s.srcOut, s.sec])).toEqual([['lead', 0, 0.4, 0.4], ['tail', 18.5, 20, 1.5]]);
  });

  it('a shot that starts at the very start of its clip has no sound before it: shortened to 0', () => {
    const e = ep([live('x', 'c2', 10, 13), live('a', 'c1', 0, 2, { leadIn: 0.5 })]);
    expect(spills(e, catalog)).toEqual({ spills: [], shortened: [{ item: 'a', field: 'leadIn', asked: 0.5, got: 0, reason: 'c1 has only 0.00 s of sound before the shot' }] });
  });

  it('is shortened to the length of the shot it plays under', () => {
    const e = ep([live('x', 'c2', 10, 10.5), live('a', 'c1', 5, 8, { leadIn: 1, tailOut: 1.5 }), { id: 'y', beat: 'title', card: { style: 'bold', text: 'Hi', sec: 0.8 } }]);
    const r = spills(e, catalog);
    expect(r.shortened).toEqual([
      { item: 'a', field: 'leadIn', asked: 1, got: 0.5, reason: 'the shot before it is only 0.50 s long' },
      { item: 'a', field: 'tailOut', asked: 1.5, got: 0.8, reason: 'the shot after it is only 0.80 s long' },
    ]);
    expect(r.spills.map((s) => [s.kind, s.at, s.sec])).toEqual([['lead', 0, 0.5], ['tail', 3.5, 0.8]]);
  });

  it('ignores a leadIn or tailOut of 0, and items that do not keep their own sound', () => {
    const silent = catalogOf({ c1: {}, c2: { hasAudio: false } });
    const e = ep([
      live('a', 'c1', 2, 4, { tailOut: 0 }),
      { ...live('b', 'c1', 5, 7, { leadIn: 1, tailOut: 1 }), audio: 'mute' },
      live('c', 'c1', 5, 7, { leadIn: 1, speed: 2 }),
      live('d', 'c2', 5, 7, { leadIn: 1 }),
      live('e', 'c1', 8, 9, { leadIn: 0 }),
    ]);
    expect(spills(e, silent)).toEqual({ spills: [], shortened: [] });
  });

  describe('the sound range of the clip itself (Review Focus)', () => {
    it('a clip whose picture starts late has its sound from 0: the lead uses the sound before the picture', () => {
      // The video stream starts at 2 s; the sound runs from 0. A shot at 2.5 s has 2.5 s of sound before it, not 0.5 s.
      const late = catalogOf({ c1: { videoStartSec: 2 }, c2: {} });
      const e = ep([live('x', 'c2', 10, 13), live('a', 'c1', 2.5, 5, { leadIn: 2 })]);
      expect(spills(e, late)).toEqual({ spills: [{ item: 'a', kind: 'lead', clip: 'c1', srcIn: 0.5, srcOut: 2.5, at: 1, sec: 2 }], shortened: [] });
      const e2 = ep([live('x', 'c2', 10, 13), live('a', 'c1', 2, 5, { leadIn: 3 })]);
      expect(spills(e2, late).shortened).toEqual([{ item: 'a', field: 'leadIn', asked: 3, got: 2, reason: 'c1 has only 2.00 s of sound before the shot' }]);
    });

    it("a clip whose sound runs on past its picture: the tail uses the sound's own end", () => {
      const past = catalogOf({ c1: { durationSec: 10, videoDurationSec: 8 }, c2: {} });
      const e = ep([live('a', 'c1', 6, 8, { tailOut: 1.5 }), live('y', 'c2', 10, 13)]);
      expect(spills(e, past)).toEqual({ spills: [{ item: 'a', kind: 'tail', clip: 'c1', srcIn: 8, srcOut: 9.5, at: 2, sec: 1.5 }], shortened: [] });
      const e2 = ep([live('a', 'c1', 6, 8, { tailOut: 3 }), live('y', 'c2', 10, 13)]);
      expect(spills(e2, past).shortened).toEqual([{ item: 'a', field: 'tailOut', asked: 3, got: 2, reason: 'c1 has only 2.00 s of sound after the shot' }]);
    });

    it("the tail starts where the shot's sound is cut (its last frame), as the render cuts it", () => {
      // 1.01 s of source at 30 fps is 30 frames: the shot's sound ends at 3 s, and the tail plays from there.
      const e = ep([live('a', 'c1', 2, 3.01, { tailOut: 0.5 }), live('y', 'c2', 10, 13)]);
      expect(spills(e, catalog).spills).toEqual([{ item: 'a', kind: 'tail', clip: 'c1', srcIn: 3, srcOut: 3.5, at: 1, sec: 0.5 }]);
    });
  });

  describe('worked out from the final layout (Review Focus)', () => {
    it('a neighbour shortened by beat snapping shortens the lead under it', () => {
      const lib: MusicLibrary = { version: 1, tracks: [{ file: 'beat.wav', mood: 'upbeat', licence: '', bpm: 120, beatOffset: 0.1, durationSec: 60 }] };
      const e0 = EpisodeSchema.parse({
        version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
        items: [{ id: 'a', beat: 'montage', clip: 'c2', src: { in: 0, out: 1.24 }, onBeat: true }, live('b', 'c1', 5, 9, { leadIn: 1.2 })],
        music: [{ track: 'beat.wav', start: 0, end: 5 }],
      });
      // Before snapping, a is 1.24 s long: the whole lead fits under it.
      expect(spills(e0, catalog).shortened).toEqual([]);
      const snapped = snapToBeats(e0, catalog, lib);
      expect(layoutTimeline(snapped)[0].end).toBeCloseTo(1, 6);
      expect(spills(snapped, catalog).shortened).toEqual([{ item: 'b', field: 'leadIn', asked: 1.2, got: 1, reason: 'the shot before it is only 1.00 s long' }]);
    });

    it("a neighbour's hold (voice-over fitting) lengthens what can play under it", () => {
      const e = ep([live('x', 'c2', 10, 11, { hold: 0.5 }), live('a', 'c1', 5, 8, { leadIn: 1.4 })]);
      expect(spills(e, catalog)).toEqual({ spills: [{ item: 'a', kind: 'lead', clip: 'c1', srcIn: 3.6, srcOut: 5, at: 0.1, sec: 1.4 }], shortened: [] });
    });

    it("a held shot's tail starts after its held frames, from the source where its sound stopped", () => {
      const e = ep([live('a', 'c1', 2, 4, { hold: 1, tailOut: 0.5 }), live('y', 'c2', 10, 13)]);
      expect(spills(e, catalog).spills).toEqual([{ item: 'a', kind: 'tail', clip: 'c1', srcIn: 4, srcOut: 4.5, at: 3, sec: 0.5 }]);
    });

    it('uses the layout it is given', () => {
      const e = ep([live('a', 'c1', 2, 4, { tailOut: 0.5 }), live('y', 'c2', 10, 13)]);
      expect(spills(e, catalog, layoutTimeline(e))).toEqual(spills(e, catalog));
    });
  });
});

describe('fadesFor', () => {
  const muted = (id: string, from: number, to: number, extra: object = {}) => ({ id, beat: 'problem', clip: 'c2', src: { in: from, out: to }, ...extra });
  const fades = (e: Episode) => {
    const laid = layoutTimeline(e);
    return fadesFor(laid, spills(e, catalog, laid).spills);
  };

  it('nothing to fade without spills', () => {
    expect(fades(ep([live('a', 'c1', 2, 4), live('b', 'c2', 5, 7)]))).toEqual({ items: new Map(), spills: [] });
  });

  it("a lead fades in over its length while the shot before's own sound fades out over the lead's length, at its end", () => {
    expect(fades(ep([live('a', 'c1', 2, 4), live('b', 'c2', 5, 7, { leadIn: 0.6 })]))).toEqual({
      items: new Map([['a', { fadeOut: { t: 'out', st: 1.4, sec: 0.6 } }]]),
      spills: [{ t: 'in', st: 0, sec: 0.6 }],
    });
  });

  it("a tail fades out over its length while the shot after's own sound fades in over the tail's length, at its start", () => {
    expect(fades(ep([live('a', 'c1', 2, 4, { tailOut: 0.7 }), live('b', 'c2', 5, 7)]))).toEqual({
      items: new Map([['b', { fadeIn: { t: 'in', st: 0, sec: 0.7 } }]]),
      spills: [{ t: 'out', st: 0, sec: 0.7 }],
    });
  });

  it('a lead and the tail of the shot before at one cut: one crossfade over the whole window, cut − lead to cut + tail', () => {
    // The window is 1.6 – 2.7 s (1.1 s). a's own sound fades out from 1.6 s and its tail carries the same fade on from
    // 0.4 s into it; b's lead fades in from 1.6 s and b's own sound carries it on, 0.4 s into it at its start.
    expect(fades(ep([live('a', 'c1', 2, 4, { tailOut: 0.7 }), live('b', 'c2', 5, 7, { leadIn: 0.4 })]))).toEqual({
      items: new Map([['a', { fadeOut: { t: 'out', st: 1.6, sec: 1.1 } }], ['b', { fadeIn: { t: 'in', st: -0.4, sec: 1.1 } }]]),
      spills: [{ t: 'out', st: -0.4, sec: 1.1 }, { t: 'in', st: 0, sec: 1.1 }],
    });
  });

  it('a shot between two spills fades in and out', () => {
    const e = ep([live('a', 'c1', 2, 4, { tailOut: 0.5 }), live('b', 'c2', 5, 7), live('c', 'c1', 10, 12, { leadIn: 0.3 })]);
    expect(fades(e).items).toEqual(new Map([['b', { fadeIn: { t: 'in', st: 0, sec: 0.5 }, fadeOut: { t: 'out', st: 1.7, sec: 0.3 } }]]));
  });

  it('a shot whose own lead and tail each meet a spill: each cut crossfades once, on its own', () => {
    const e = ep([live('a', 'c1', 2, 4, { tailOut: 0.5 }), live('b', 'c2', 5, 7, { leadIn: 0.5, tailOut: 0.25 }), live('c', 'c1', 10, 12, { leadIn: 0.25 })]);
    expect(fades(e)).toEqual({
      items: new Map([
        ['a', { fadeOut: { t: 'out', st: 1.5, sec: 1 } }],
        ['b', { fadeIn: { t: 'in', st: -0.5, sec: 1 }, fadeOut: { t: 'out', st: 1.75, sec: 0.5 } }],
        ['c', { fadeIn: { t: 'in', st: -0.25, sec: 0.5 } }],
      ]),
      spills: [{ t: 'out', st: -0.5, sec: 1 }, { t: 'in', st: 0, sec: 1 }, { t: 'out', st: -0.25, sec: 0.5 }, { t: 'in', st: 0, sec: 0.5 }],
    });
  });

  it('a muted, sped-up or card neighbour has no sound to fade: only the spill fades', () => {
    const card = { id: 'k', beat: 'title', card: { style: 'bold', text: 'Hi', sec: 2 } };
    for (const n of [muted('n', 10, 12), live('n', 'c2', 10, 14, { speed: 2 }), card]) {
      expect(fades(ep([n, live('b', 'c1', 5, 7, { leadIn: 0.5, tailOut: 0.5 }), n === card ? { ...card, id: 'k2' } : { ...n, id: 'n2' }]))).toEqual({
        items: new Map(),
        spills: [{ t: 'in', st: 0, sec: 0.5 }, { t: 'out', st: 0, sec: 0.5 }],
      });
    }
  });
});
