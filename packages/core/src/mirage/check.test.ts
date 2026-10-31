import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type Catalog } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { checkEpisode } from './check.js';
import { saveCatalog } from './ingest.js';
import { saveEpisode } from './render-episode.js';
import { fitVoiceover } from './voiceover.js';

async function project(transcript: Catalog['clips'][number]['transcript']) {
  const dir = await mkdtemp(join(tmpdir(), 'we-check-'));
  await writeFile(join(dir, 'talk.mov'), '');
  const clip = {
    id: 'c001', path: join(dir, 'talk.mov'), sha256: 'a'.repeat(64), kind: 'talking' as const, transcript, frames: [], notes: '', moments: [],
    probe: { durationSec: 30, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', colorTransfer: null },
  };
  await saveCatalog(dir, { version: 1, clips: [clip] });
  await mkdir(join(dir, 'music'), { recursive: true });
  await writeFile(join(dir, 'music', 'library.json'), JSON.stringify({ version: 1, tracks: [
    { file: 'beat.wav', mood: 'upbeat', bpm: 120, beatOffset: 0.1, durationSec: 60 },
    { file: 'pad.wav', mood: 'relaxed', bpm: null, beatOffset: null, durationSec: 8 },
  ] }));
  for (const f of ['beat.wav', 'pad.wav']) await writeFile(join(dir, 'music', f), '');
  return { dir, catalog: { version: 1 as const, clips: [clip] } };
}
const base = (extra: object = {}) =>
  EpisodeSchema.parse({
    version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
    items: [{ id: 'a', beat: 'montage', clip: 'c001', src: { in: 0, out: 1.3 }, onBeat: true }, { id: 'b', beat: 'problem', clip: 'c001', src: { in: 5, out: 10 } }],
    music: [{ track: 'beat.wav', start: 0, end: 6 }],
    ...extra,
  });

describe('checkEpisode', () => {
  it('refuses a copied episode whose number is another folder, leaving that episode untouched', async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    await saveEpisode(dir, base());
    const original = await readFile(join(dir, 'episodes', '1', 'episode.json'), 'utf8');
    await mkdir(join(dir, 'episodes', '3'), { recursive: true });
    await writeFile(join(dir, 'episodes', '3', 'episode.json'), original.replace('"title": "t"', '"title": "copy"'));
    await expect(checkEpisode(dir, 3)).rejects.toMatchObject({ message: 'episodes/3/episode.json says it is episode 1' });
    expect(await readFile(join(dir, 'episodes', '1', 'episode.json'), 'utf8')).toBe(original);
  });

  it('snaps montages to the beat and has nothing to warn about for a plain cut', async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    await saveEpisode(dir, base());
    const r = await checkEpisode(dir, 1);
    expect(r.warnings).toEqual([]);
    expect(r.episode.items[0].src.out).not.toBe(1.3);
  });

  it('drops an overlay that beat snapping squeezed to nothing, with a warning, instead of failing on every later check', async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    // a (1.24 s) snaps to 1.0 s: the badge at 1.2–1.25 sat in the removed time.
    await saveEpisode(dir, base({
      items: [{ id: 'a', beat: 'montage', clip: 'c001', src: { in: 0, out: 1.24 }, onBeat: true }, { id: 'b', beat: 'problem', clip: 'c001', src: { in: 5, out: 9 } }],
      overlays: [{ kind: 'badge', text: 'FAILED', start: 1.2, end: 1.25 }, { kind: 'label', text: 'kept', start: 2, end: 3 }],
      music: [{ track: 'beat.wav', start: 0, end: 5 }],
    }));
    const r = await checkEpisode(dir, 1);
    expect(r.warnings).toEqual(['overlay 1 ("FAILED") was inside time that beat snapping removed, so it was dropped — place it again on the times above']);
    expect(r.episode.overlays.map((o) => o.text)).toEqual(['kept']);
    expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
  });

  it('leaves alone an overlay written shorter than one frame that beat snapping never touched', async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    await saveEpisode(dir, base({
      items: [{ id: 'a', beat: 'montage', clip: 'c001', src: { in: 0, out: 1.24 }, onBeat: true }, { id: 'b', beat: 'problem', clip: 'c001', src: { in: 5, out: 9 } }],
      overlays: [{ kind: 'badge', text: 'LIVE', start: 3, end: 3.02 }],
      music: [{ track: 'beat.wav', start: 0, end: 5 }],
    }));
    const r = await checkEpisode(dir, 1);
    expect(r.warnings).toEqual([]);
    expect(r.episode.overlays.map((o) => o.text)).toEqual(['LIVE']);
  });

  it('warns when an item keeps audio from a clip that has no transcript', async () => {
    const { dir } = await project(null);
    await saveEpisode(dir, base({ items: [{ id: 'talk', beat: 'problem', clip: 'c001', src: { in: 0, out: 4 }, audio: 'keep' }] }));
    const r = await checkEpisode(dir, 1);
    expect(r.warnings).toEqual(["item talk keeps audio from c001, which has no transcript — narration slots and captions won't see its speech"]);
  });

  it('does not snap a cut with a voice-over, says so, and warns once the cut no longer matches the fit', async () => {
    const { dir, catalog } = await project({ words: [], segments: [], speech: [] });
    const words = 'This is the line.'.split(' ').map((w, i) => ({ w, start: i * 0.3, end: i * 0.3 + 0.25, conf: 1 }));
    const fitted = fitVoiceover({ episode: base({ slots: [{ id: 'n1', start: 1.5, end: 5, maxWords: 8, line: 'This is the line.' }] }), catalog, recording: 'vo.wav', transcript: { words, segments: [], speech: [] } }).episode;
    await saveEpisode(dir, fitted);
    const clean = await checkEpisode(dir, 1);
    expect(clean.episode.items).toEqual(fitted.items);
    expect(clean.notes).toEqual(['Montages were not snapped to the beat: the voice-over is fitted to this cut.']);
    expect(clean.warnings).toEqual([]);

    await saveEpisode(dir, { ...fitted, items: [fitted.items[0], { ...fitted.items[1], src: { in: 5, out: 9 } }] });
    const changed = await checkEpisode(dir, 1);
    expect(changed.warnings).toEqual(['The cut changed after the voice-over was fitted. Run: pnpm mirage slots <project> <n>, then pnpm mirage vo <project> <n> <recording> (it reuses the saved transcript)']);
    expect(JSON.parse(await readFile(join(dir, 'episodes', '1', 'episode.json'), 'utf8')).items[1].src.out).toBe(9);
  });

  it('does not rewrite episode.json when nothing changed', async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    await saveEpisode(dir, base());
    await checkEpisode(dir, 1);
    const file = join(dir, 'episodes', '1', 'episode.json');
    const old = new Date(Date.now() - 3600_000);
    await utimes(file, old, old);
    await checkEpisode(dir, 1);
    expect((await stat(file)).mtimeMs).toBe(old.getTime());
  });

  it('reads library.json only when the episode has music', async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    await writeFile(join(dir, 'music', 'library.json'), '{ broken');
    await saveEpisode(dir, base({ items: [{ id: 'b', beat: 'problem', clip: 'c001', src: { in: 5, out: 10 } }], music: [] }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
    await saveEpisode(dir, base());
    await expect(checkEpisode(dir, 1)).rejects.toMatchObject({ name: 'JsonFileError', message: expect.stringContaining('music/library.json') });
  });

  it('stops when a cue plays a track that is not in library.json or whose file is gone', async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    await saveEpisode(dir, base({ music: [{ track: 'nope.wav', start: 0, end: 6 }] }));
    await expect(checkEpisode(dir, 1)).rejects.toMatchObject({ code: 'NO_MUSIC_TRACK', message: 'music cue 1: nope.wav is not in music/library.json' });
    await rm(join(dir, 'music', 'beat.wav'));
    await saveEpisode(dir, base());
    await expect(checkEpisode(dir, 1)).rejects.toMatchObject({ code: 'NO_MUSIC_TRACK', message: 'music cue 1: beat.wav is missing from music/', hint: expect.stringContaining('Put beat.wav back') });
  });

  it('warns about overlays and cues past the end, onBeat items left unsnapped, looping cues and the old gainDb default', async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    await saveEpisode(dir, base({
      items: [
        { id: 'a', beat: 'montage', clip: 'c001', src: { in: 0, out: 1.5 }, onBeat: true },
        { id: 'b', beat: 'montage', clip: 'c001', src: { in: 2, out: 3 }, onBeat: true },
        { id: 'c', beat: 'montage', clip: 'c001', src: { in: 5, out: 15 }, onBeat: true },
      ],
      overlays: [{ kind: 'badge', text: 'LATE', start: 20, end: 22 }, { kind: 'label', text: 'Shipped 🚀', start: 1, end: 2 }],
      music: [
        { track: 'beat.wav', start: 0, end: 1.5, gainDb: -18 },
        { track: 'pad.wav', start: 1.5, end: 2.5, offset: 7.5 },
        { track: 'beat.wav', start: 30, end: 31 },
      ],
    }));
    const r = await checkEpisode(dir, 1);
    expect(r.warnings).toEqual([
      'overlay 1 ("LATE") starts at 20.00 s, after the episode ends (12.50 s) — it will never show',
      'overlay 2 ("Shipped 🚀") has emoji, which can\'t be drawn — they are left out',
      'music cue 3 (beat.wav) starts at 30.00 s, after the episode ends (12.50 s) — it will never play',
      'item b is onBeat but pad.wav has no clear beat — left unsnapped',
      'item c is onBeat but no music plays under it — left unsnapped',
      'music cue 2 plays 1.0 s of pad.wav from 7.5 s, but the track is 8.0 s long — it will loop',
      'music cue 1 has gainDb -18, the old default (now -5) — delete gainDb to use the new one',
    ]);
  });

  it('warns when an onBeat item could not reach a beat, saying why for an item that keeps its audio', async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    await saveEpisode(dir, base({
      items: [
        // 0.1 s of footage left; the first beat is 0.5 s away and kept audio cannot be slowed.
        { id: 'a', beat: 'problem', clip: 'c001', src: { in: 29.9, out: 30 }, onBeat: true, audio: 'keep' },
        // Would need slowing below 0.25x.
        { id: 'b', beat: 'montage', clip: 'c001', src: { in: 29.95, out: 30 }, onBeat: true },
      ],
      music: [{ track: 'beat.wav', start: 0, end: 10 }],
    }));
    const r = await checkEpisode(dir, 1);
    expect(r.episode.items.map((i) => [i.speed, i.src.out])).toEqual([[1, 30], [1, 30]]);
    expect(r.warnings).toEqual([
      'item a keeps its live audio, which plays only at normal speed, and c001 has no footage left to reach a beat — left unsnapped',
      'item b could not reach a beat: c001 has too little footage left — left unsnapped',
    ]);
  });
});
