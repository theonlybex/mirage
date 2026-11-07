import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, isCard, type Catalog, type ClipItem, type TimelineItem } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { realMediaTools } from '../media-tools.js';
import { checkEpisode } from './check.js';
import { saveCatalog } from './ingest.js';
import { saveEpisode } from './render-episode.js';
import { cutOf } from './slots.js';
import { fitVoiceover, holdAt } from './voiceover.js';

/** The item as a clip item (a card here is a mistake in the test). */
const clip = (i: TimelineItem): ClipItem => {
  if (isCard(i)) throw new Error(`item ${i.id} is a card`);
  return i;
};

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
    expect(clip(r.episode.items[0]).src.out).not.toBe(1.3);
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

    await saveEpisode(dir, { ...fitted, slots: [{ ...fitted.slots[0], line: 'This is the new line.' }] });
    expect((await checkEpisode(dir, 1)).warnings).toEqual(["n1's line changed since vo — re-record it with vo --add --slots n1"]);

    // After a re-cut the slots are renumbered and lines move: only the cut-change advice applies (vo --add would refuse).
    await saveEpisode(dir, { ...fitted, items: [fitted.items[0], { ...fitted.items[1], src: { in: 5, out: 9 } }], slots: [{ ...fitted.slots[0], id: 'n2' }] });
    const changed = await checkEpisode(dir, 1);
    expect(changed.warnings).toEqual(['The cut changed after the voice-over was fitted. Run: pnpm mirage slots <project> <n>, then pnpm mirage vo <project> <n> <recording> (it reuses the saved transcript)']);
    expect(JSON.parse(await readFile(join(dir, 'episodes', '1', 'episode.json'), 'utf8')).items[1].src.out).toBe(9);
  });

  it('warns when the cut changed since slots were written and lines are waiting for a voice-over', async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    const items = [{ id: 'b', beat: 'problem', clip: 'c001', src: { in: 5, out: 10 } }];
    const ep = base({ items, music: [], slots: [{ id: 'n1', start: 1, end: 4, maxWords: 8, line: 'A line.' }] });
    await saveEpisode(dir, { ...ep, slotsCut: cutOf(ep) });
    expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
    await saveEpisode(dir, { ...ep, slotsCut: cutOf(ep), items: [{ ...ep.items[0], src: { in: 5, out: 9 } }] });
    expect((await checkEpisode(dir, 1)).warnings).toEqual(['The cut changed since slots were written — run: pnpm mirage slots <project> 1, and check the lines it carried over']);
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

  it('warns when a move ends after the shot, or starts after it', async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    await saveEpisode(dir, base({
      items: [
        { id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 4 }, move: { zoom: 1.2, end: 6 } },
        { id: 'b', beat: 'problem', clip: 'c001', src: { in: 5, out: 8 }, hold: 1, move: { zoom: 1.2, start: 3.5 } },
        { id: 'c', beat: 'problem', clip: 'c001', src: { in: 9, out: 12 }, move: { zoom: 1.2, start: 3 } },
        { id: 'd', beat: 'problem', clip: 'c001', src: { in: 13, out: 16 }, move: { zoom: 1.2, start: 1, end: 4 } },
        { id: 'e', beat: 'problem', clip: 'c001', src: { in: 17, out: 20 }, move: { zoom: 1.2 } },
      ],
      music: [],
    }));
    const r = await checkEpisode(dir, 1);
    expect(r.warnings).toEqual([
      "item a's move ends at 6.00 s, after the shot ends (4.00 s) — it stops at the end of the shot",
      "item c's move starts at 3.00 s, after the shot ends (3.00 s) — it never plays",
      "item d's move ends at 4.00 s, after the shot ends (3.00 s) — it stops at the end of the shot",
    ]);
  });

  it('warns that a move starting within half a frame of the shot end never plays, and not one that starts on its last frame', async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    await saveEpisode(dir, base({
      items: [
        { id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 3 }, move: { zoom: 1.2, start: 2.99 } },
        { id: 'b', beat: 'problem', clip: 'c001', src: { in: 5, out: 8 }, move: { zoom: 1.2, start: 2.98 } },
      ],
      music: [],
    }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual(["item a's move starts at 2.99 s, after the shot ends (3.00 s) — it never plays"]);
  });

  it('gives no warning for a moving shot voice-over fitting split, and the person\'s own warning once', async () => {
    const { dir, catalog } = await project({ words: [], segments: [], speech: [] });
    const split = (move: object) =>
      holdAt(base({ items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 6 }, move }, { id: 'b', beat: 'problem', clip: 'c001', src: { in: 7, out: 9 } }], music: [] }), catalog, 3, 1);
    for (const move of [{ zoom: 1.2, start: 1, end: 6 }, { zoom: 1.2, start: 4, end: 6 }, { zoom: 1.2, start: 5.98 }, { zoom: 1.2 }]) {
      await saveEpisode(dir, split(move));
      expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
    }
    await saveEpisode(dir, split({ zoom: 1.2, end: 8 }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual(["item a's move ends at 8.00 s, after the shot ends (6.00 s) — it stops at the end of the shot"]);
    await saveEpisode(dir, split({ zoom: 1.2, start: 6 }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual(["item a's move starts at 6.00 s, after the shot ends (6.00 s) — it never plays"]);
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
    expect(r.episode.items.map((i) => [clip(i).speed, clip(i).src.out])).toEqual([[1, 30], [1, 30]]);
    expect(r.warnings).toEqual([
      'item a keeps its live audio, which plays only at normal speed, and c001 has no footage left to reach a beat — left unsnapped',
      'item b could not reach a beat: c001 has too little footage left — left unsnapped',
    ]);
  });

  describe('sound effects and dips', () => {
    const plain = [{ id: 'b', beat: 'problem', clip: 'c001', src: { in: 5, out: 10 } }];
    const BUILTINS = 'Built-in sounds: whoosh, swoosh-out, hit, riser, pop, ding, click. Or put the file in the project\'s sfx folder.';

    it("stops on a sound that isn't a built-in or a file in sfx/", async () => {
      const { dir } = await project({ words: [], segments: [], speech: [] });
      for (const sound of ['airhorn', 'sfx/gone.wav', '../talk.mov']) {
        await saveEpisode(dir, base({ items: plain, music: [], sfx: [{ sound: 'hit', at: 1 }, { sound, at: 2 }] }));
        await expect(checkEpisode(dir, 1)).rejects.toMatchObject({ name: 'MirageError', message: `sfx 2: "${sound}" isn't a built-in sound or a file in sfx/`, hint: BUILTINS });
      }
    });

    it("stops on a file in sfx/ that FFmpeg can't read, and takes a silent one", async () => {
      const { dir } = await project({ words: [], segments: [], speech: [] });
      await mkdir(join(dir, 'sfx'));
      await writeFile(join(dir, 'sfx', 'boom.wav'), 'not a wave file');
      await saveEpisode(dir, base({ items: plain, music: [], sfx: [{ sound: 'boom', at: 1 }] }));
      const tools = await realMediaTools();
      await expect(checkEpisode(dir, 1, tools)).rejects.toMatchObject({ name: 'MirageError', message: "sfx 1: sfx/boom.wav isn't audio Mirage can read", hint: 'Use a WAV, MP3, M4A, AIFF, FLAC or OGG file.' });
      // Without FFmpeg at hand the file is only looked for (the render reads it).
      expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
      const { run } = await import('@wordedits/sidecars');
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '0.5', join(dir, 'sfx', 'boom.wav')]);
      expect((await checkEpisode(dir, 1, tools)).warnings).toEqual([]);
    });

    it('does not warn about a sound effect exactly at the episode end (a riser into the last frame), only past it', async () => {
      const { dir } = await project({ words: [], segments: [], speech: [] });
      const items = [{ id: 'b', beat: 'problem', clip: 'c001', src: { in: 0, out: 30 } }, { id: 'c', beat: 'problem', clip: 'c001', src: { in: 0, out: 30 } }, { id: 'd', beat: 'problem', clip: 'c001', src: { in: 0, out: 10 } }];
      await saveEpisode(dir, base({ items, sfx: [{ sound: 'riser', at: 70 }] }));
      expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
      await saveEpisode(dir, base({ items, sfx: [{ sound: 'riser', at: 70.01 }] }));
      expect((await checkEpisode(dir, 1)).warnings).toEqual(['sfx 1 (riser) is at 70.01 s, after the episode ends (70.00 s) — it will never play']);
    });

    it('warns about a sound effect after the end, too many in a minute, and a dip outside its cue', async () => {
      const { dir } = await project({ words: [], segments: [], speech: [] });
      const busy = [0.5, 8, 15, 22, 30, 38, 45, 59].map((at) => ({ sound: 'pop', at }));
      await saveEpisode(dir, base({
        items: [{ id: 'b', beat: 'problem', clip: 'c001', src: { in: 0, out: 30 } }, { id: 'c', beat: 'problem', clip: 'c001', src: { in: 0, out: 30 } }, { id: 'd', beat: 'problem', clip: 'c001', src: { in: 0, out: 10 } }],
        music: [{ track: 'pad.wav', start: 0, end: 6, dips: [{ start: 2, end: 2.5 }, { start: 7, end: 7.5 }, { start: 5.8, end: 6.4 }] }],
        sfx: [...busy, { sound: 'whoosh', at: 99 }],
      }));
      // The whoosh never plays, so it isn't counted; the dip at 5.8–6.4 s is partly inside its cue.
      expect((await checkEpisode(dir, 1)).warnings).toEqual([
        'sfx 9 (whoosh) is at 99.00 s, after the episode ends (70.00 s) — it will never play',
        '8 sound effects within one minute (from 0.5 s) — sound effects on almost every cut cheapen the video; keep the ones that land a joke or a reveal',
        'music cue 1 has a dip at 7.00–7.50 s outside the cue (0.00–6.00 s) — it does nothing',
      ]);
    });

    it('counts sound effects in the busiest minute, and over the whole video when it is shorter', async () => {
      const { dir } = await project({ words: [], segments: [], speech: [] });
      const at = (ts: number[]) => ts.map((t) => ({ sound: 'click', at: t }));
      const items = [{ id: 'b', beat: 'problem', clip: 'c001', src: { in: 0, out: 30 } }, { id: 'c', beat: 'problem', clip: 'c001', src: { in: 0, out: 30 } }, { id: 'd', beat: 'problem', clip: 'c001', src: { in: 0, out: 30 } }];
      // Six a minute is fine; seven spread over 61 s never sit in one minute.
      await saveEpisode(dir, base({ items, music: [], sfx: at([1, 2, 3, 4, 5, 6]) }));
      expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
      await saveEpisode(dir, base({ items, music: [], sfx: at([0, 10, 20, 30, 40, 50, 61]) }));
      expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
      // From 0 s a minute holds 7; the busiest, from 25 s, holds 8 (in any order in the file).
      await saveEpisode(dir, base({ items, music: [], sfx: at([0, 25, 81, 30, 41, 42, 43, 50, 70]) }));
      expect((await checkEpisode(dir, 1)).warnings).toEqual(['8 sound effects within one minute (from 25.0 s) — sound effects on almost every cut cheapen the video; keep the ones that land a joke or a reveal']);
      await saveEpisode(dir, base({ items: plain, music: [], sfx: at([0, 0.5, 1, 1.5, 2, 2.5, 3]) }));
      expect((await checkEpisode(dir, 1)).warnings).toEqual(['7 sound effects within one minute (from 0.0 s) — sound effects on almost every cut cheapen the video; keep the ones that land a joke or a reveal']);
    });

    it('moves sound effects and dips with the picture when it snaps a montage to the beat', async () => {
      const { dir } = await project({ words: [], segments: [], speech: [] });
      await saveEpisode(dir, base({ sfx: [{ sound: 'hit', at: 0.5 }, { sound: 'hit', at: 3 }], music: [{ track: 'beat.wav', start: 0, end: 6, dips: [{ start: 3, end: 3.5 }] }] }));
      const r = await checkEpisode(dir, 1);
      const delta = clip(r.episode.items[0]).src.out - 1.3;
      expect(Math.abs(delta)).toBeGreaterThan(0.01);
      const [hit1, hit2] = r.episode.sfx!;
      expect(hit1!.at).toBe(0.5);
      expect(hit2!.at).toBeCloseTo(3 + delta, 6);
      const [dip] = r.episode.music[0].dips!;
      expect(dip!.start).toBeCloseTo(3 + delta, 6);
      expect(dip!.end).toBeCloseTo(3.5 + delta, 6);
      expect(r.warnings).toEqual([]);
    });
  });
});

describe('checkEpisode with cards', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
  const withCard = (c: object) =>
    EpisodeSchema.parse({
      version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
      items: [{ id: 'k', beat: 'title', card: { style: 'image', sec: 2, ...c } }, { id: 'b', beat: 'problem', clip: 'c001', src: { in: 5, out: 10 } }],
    });
  const hint = "Put the picture in the project folder, or change the card's image.";

  it('passes text cards and an image card whose picture is a PNG or JPEG (told by its content), saving the file unchanged', async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    await mkdir(join(dir, 'pics'));
    await writeFile(join(dir, 'pics', 'a.png'), PNG);
    await writeFile(join(dir, 'pics', 'photo.jpeg.bin'), JPEG);
    for (const image of ['pics/a.png', 'pics/photo.jpeg.bin']) {
      await saveEpisode(dir, withCard({ image }));
      const before = await readFile(join(dir, 'episodes', '1', 'episode.json'), 'utf8');
      const r = await checkEpisode(dir, 1);
      expect(r.warnings).toEqual([]);
      expect(await readFile(join(dir, 'episodes', '1', 'episode.json'), 'utf8')).toBe(before);
    }
    await saveEpisode(dir, EpisodeSchema.parse({ ...withCard({ image: 'pics/a.png' }), items: [{ id: 'k', beat: 'title', card: { style: 'mono', sec: 2, text: 'one\ntwo' } }] }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
  });

  it('✖ when an image card’s picture is missing', async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    await saveEpisode(dir, withCard({ image: 'pics/gone.png' }));
    await expect(checkEpisode(dir, 1)).rejects.toMatchObject({ message: 'item k: card image pics/gone.png is missing', hint });
    await mkdir(join(dir, 'pics', 'dir.png'), { recursive: true });
    await saveEpisode(dir, withCard({ image: 'pics/dir.png' }));
    await expect(checkEpisode(dir, 1)).rejects.toMatchObject({ message: 'item k: card image pics/dir.png is missing', hint });
  });

  it("✖ when an image card's picture isn't a PNG or JPEG, whatever its name says", async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    await writeFile(join(dir, 'fake.png'), 'GIF89a not really');
    await writeFile(join(dir, 'empty.jpg'), '');
    for (const image of ['fake.png', 'empty.jpg']) {
      await saveEpisode(dir, withCard({ image }));
      await expect(checkEpisode(dir, 1)).rejects.toMatchObject({ message: `item k: card image ${image} isn't a PNG or JPEG`, hint });
    }
  });
});
