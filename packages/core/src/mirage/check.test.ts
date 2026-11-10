import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, isCard, type Catalog, type ClipItem, type Episode, type TimelineItem } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { realMediaTools } from '../media-tools.js';
import { checkEpisode } from './check.js';
import { formatsDir } from './formats.js';
import { saveCatalog } from './ingest.js';
import { saveEpisode } from './render-episode.js';
import { checkReport } from './reports.js';
import { computeSlots, cutOf } from './slots.js';
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

  it('warns of a subtitle overlay over automatic captions (phrase, pop, karaoke, or none set), not with chosen or off', async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    const overlays = [{ kind: 'subtitle', text: 'So I went back.', start: 1, end: 2 }, { kind: 'name', text: 'Sam', start: 1, end: 2 }];
    const warning = 'subtitle overlay 1 ("So I went back.") shows over the automatic captions — use captions style chosen, or remove it';
    for (const captions of [undefined, { style: 'phrase' }, { style: 'pop' }, { style: 'karaoke', position: 'middle' }]) {
      await saveEpisode(dir, base({ overlays, ...(captions ? { captions } : {}) }));
      expect((await checkEpisode(dir, 1)).warnings, JSON.stringify(captions)).toEqual([warning]);
    }
    for (const style of ['chosen', 'off']) {
      await saveEpisode(dir, base({ overlays, captions: { style } }));
      expect((await checkEpisode(dir, 1)).warnings, style).toEqual([]);
    }
  });

  it("names a name label's sub line that has emoji, as it does the text", async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    await saveEpisode(dir, base({ overlays: [{ kind: 'name', text: 'Sam', sub: 'Founder 🚀', start: 1, end: 2 }, { kind: 'name', text: 'Ana', sub: 'Founder', start: 1, end: 2 }] }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual(['overlay 1 ("Founder 🚀") has emoji, which can\'t be drawn — they are left out']);
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

describe('checkEpisode with leadIn and tailOut', () => {
  const live = (id: string, from: number, to: number, extra: object = {}) => ({ id, beat: 'problem', clip: 'c001', src: { in: from, out: to }, audio: 'keep', ...extra });

  it('warns when a value is shortened, saying why, and when it does nothing', async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    await saveEpisode(dir, base({
      music: [],
      items: [
        live('a', 0.3, 3, { leadIn: 1, tailOut: 0.5 }),
        live('b', 10, 10.4, { audio: 'mute', leadIn: 0.5 }),
        live('c', 0.3, 2, { leadIn: 1 }),
        live('d', 12, 12.5, { audio: 'mute' }),
        live('e', 5, 8, { leadIn: 1, tailOut: 0.2 }),
        live('f', 28, 29.5, { tailOut: 1 }),
        live('h', 20, 24, { speed: 2, tailOut: 1 }),
        live('g', 15, 17, { tailOut: 1 }),
      ],
    }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual([
      "item a's leadIn of 1.00 s is shortened to 0.00 s — it's the first shot",
      "item a's tailOut of 0.50 s is shortened to 0.40 s — the shot after it is only 0.40 s long",
      'item b has leadIn/tailOut but doesn\'t keep its own sound (audio "keep" at speed 1) — it does nothing',
      "item c's leadIn of 1.00 s is shortened to 0.30 s — c001 has only 0.30 s of sound before the shot",
      "item e's leadIn of 1.00 s is shortened to 0.50 s — the shot before it is only 0.50 s long",
      "item f's tailOut of 1.00 s is shortened to 0.50 s — c001 has only 0.50 s of sound after the shot",
      'item h has leadIn/tailOut but doesn\'t keep its own sound (audio "keep" at speed 1) — it does nothing',
      "item g's tailOut of 1.00 s is shortened to 0.00 s — it's the last shot",
    ]);
  });

  it('warns when the clip has no sound', async () => {
    const { dir, catalog } = await project({ words: [], segments: [], speech: [] });
    const silent = { ...catalog.clips[0], probe: { ...catalog.clips[0].probe, hasAudio: false } };
    await saveCatalog(dir, { version: 1, clips: [silent] });
    await saveEpisode(dir, base({ music: [], items: [live('a', 0, 2), live('b', 5, 7, { leadIn: 0.5 })] }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual(['item b has leadIn/tailOut but doesn\'t keep its own sound (audio "keep" at speed 1) — it does nothing']);
  });

  it('a voice-over line over carried-over words: the fit stays fitted, and check says which line and where', async () => {
    // talk's own words, then "Ha!" just after its src.out: a 1.5 s tail carries it under the screen shot at 3.4–3.9 s.
    const said = [{ w: 'Hi', start: 0.5, end: 1 }, { w: 'there.', start: 1.1, end: 2.5 }, { w: 'Ha!', start: 3.4, end: 3.9 }].map((w) => ({ ...w, conf: 1 }));
    const { dir, catalog } = await project({ words: said, segments: [], speech: [] });
    const words = 'This is the line.'.split(' ').map((w, i) => ({ w, start: i * 0.3, end: i * 0.3 + 0.25, conf: 1 }));
    const fit = (slot: { start: number; end: number }) => {
      const cut = base({ music: [], items: [live('talk', 0, 3), live('screen', 10, 16, { audio: 'mute' })], slots: [{ id: 'n1', maxWords: 8, line: 'This is the line.', ...slot }] });
      return fitVoiceover({ episode: cut, catalog, recording: 'vo.wav', transcript: { words, segments: [], speech: [] } }).episode;
    };
    const tailed = (e: Episode) => ({ ...e, items: e.items.map((i) => (i.id === 'talk' ? { ...i, tailOut: 1.5 } : i)) });
    const over = fit({ start: 3, end: 6 });
    await saveEpisode(dir, over);
    expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
    await saveEpisode(dir, tailed(over));
    expect((await checkEpisode(dir, 1)).warnings).toEqual(["voice-over line n1 plays over item talk's carried-over sound (3.40–3.90 s) — shorten the leadIn/tailOut or move the line"]);
  });

  it('a line in the slot Mirage proposes for a cut with a tail is never warned about, though it plays inside the tail', async () => {
    const said = [{ w: 'Hi', start: 0.5, end: 1 }, { w: 'there.', start: 1.1, end: 2.5 }, { w: 'Ha!', start: 3.4, end: 3.9 }].map((w) => ({ ...w, conf: 1 }));
    const { dir, catalog } = await project({ words: said, segments: [], speech: [] });
    const cut = base({ music: [], items: [live('talk', 0, 3, { tailOut: 1.5 }), live('screen', 10, 16, { audio: 'mute' })] });
    const slots = computeSlots(cut, catalog).map((x) => ({ ...x, line: 'This is the line.' }));
    expect(slots.map((x) => [x.id, x.start])).toEqual([['n1', 4.2]]);
    const words = 'This is the line.'.split(' ').map((w, i) => ({ w, start: i * 0.3, end: i * 0.3 + 0.25, conf: 1 }));
    const fitted = fitVoiceover({ episode: { ...cut, slots }, catalog, recording: 'vo.wav', transcript: { words, segments: [], speech: [] } }).episode;
    // Inside the tail's window (3.0–4.5 s), after its last word and the slots' padding.
    expect(fitted.voiceover!.lines[0].at).toBeLessThan(4.5);
    await saveEpisode(dir, fitted);
    expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
  });

  describe('carried-over sound over the next shot\'s own words', () => {
    const word = (w: string, start: number, end: number) => ({ w, start, end, conf: 1 });
    const warned = async (words: ReturnType<typeof word>[], items: object[]) => {
      const { dir } = await project({ words, segments: [], speech: [] });
      await saveEpisode(dir, base({ music: [], items }));
      return (await checkEpisode(dir, 1)).warnings;
    };

    it('a tail into a shot that opens with a line warns, naming the spilled words\' span', async () => {
      // talk ends at 3 s; "Ha!" at 3.4–3.9 s in the source plays 3.4–3.9 s in the tail; the next shot's first line starts at 3.1 s.
      const words = [word('Hi', 0.5, 1), word('Ha!', 3.4, 3.9), word('Next', 10.1, 10.5), word('line.', 10.6, 11)];
      expect(await warned(words, [live('talk', 0, 3, { tailOut: 1 }), live('next', 10, 16)])).toEqual([
        "item talk's carried-over sound (3.40–3.90 s) plays over item next's own words — shorten the leadIn/tailOut, or let the next shot start quieter",
      ]);
    });

    it('a tail into a quiet stretch does not warn', async () => {
      const words = [word('Hi', 0.5, 1), word('Ha!', 3.4, 3.9), word('Later', 23, 23.5)];
      expect(await warned(words, [live('talk', 0, 3, { tailOut: 1 }), live('next', 20, 26)])).toEqual([]);
    });

    it('a tail into the next shot cut from the same take, whose source overlaps, warns', async () => {
      const words = [word('Hi', 0.5, 1), word('Ha!', 3.4, 3.9), word('Ha!', 3.4, 3.9)];
      expect(await warned(words, [live('talk', 0, 3, { tailOut: 1 }), live('again', 3, 8)])).toEqual([
        "item talk's carried-over sound (3.40–3.90 s) plays over item again's own words — shorten the leadIn/tailOut, or let the next shot start quieter",
      ]);
    });

    it('a lead under a shot that ends on a line warns, naming the shot before', async () => {
      // talk's line ends at 2.5 s; the lead plays 9–10 s of the source at 2–3 s, its word at 9.5–9.9 s lands at 2.5–2.9 s.
      const words = [word('Hi', 0.5, 1), word('there.', 1.1, 2.5), word('Door', 9.5, 9.9)];
      expect(await warned(words, [live('talk', 0, 3), live('next', 10, 16, { leadIn: 1 })])).toEqual([
        "item next's carried-over sound (2.50–2.90 s) plays over item talk's own words — shorten the leadIn/tailOut, or let the next shot start quieter",
      ]);
    });

    it('a lead into a quiet stretch does not warn, and no neighbour words means none either', async () => {
      const words = [word('Hi', 0.5, 1), word('Door', 9.5, 9.9)];
      expect(await warned(words, [live('talk', 0, 3), live('next', 10, 16, { leadIn: 1 })])).toEqual([]);
      expect(await warned(words, [live('talk', 0, 3, { tailOut: 1 }), live('screen', 10, 16, { audio: 'mute' })])).toEqual([]);
    });
  });

  it('a leadIn or tailOut of 0 is none: no warning, even where it would do nothing', async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    await saveEpisode(dir, base({ music: [], items: [live('a', 0, 2, { leadIn: 0 }), live('b', 5, 7, { audio: 'mute', leadIn: 0, tailOut: 0 }), live('c', 8, 9, { speed: 2, tailOut: 0 })] }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
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

  // chmod does not stop reading on Windows, nor for root.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)("✖ isn't a PNG or JPEG (not a raw error) when the picture is there but can't be read", async () => {
    const { dir } = await project({ words: [], segments: [], speech: [] });
    await writeFile(join(dir, 'locked.png'), PNG);
    await chmod(join(dir, 'locked.png'), 0o000);
    try {
      await saveEpisode(dir, withCard({ image: 'locked.png' }));
      await expect(checkEpisode(dir, 1)).rejects.toMatchObject({ code: 'BAD_ITEM', message: "item k: card image locked.png isn't a PNG or JPEG", hint });
    } finally {
      await chmod(join(dir, 'locked.png'), 0o644);
    }
  });
});

describe('checkEpisode against the video format', () => {
  const VIDEO = { version: 1, title: 't', about: '', mention: '', hide: '', footage: [], createdAt: '2026-11-06T00:00:00.000Z' };
  const writeVideo = (dir: string, extra: object = {}) => writeFile(join(dir, 'episodes', '1', 'video.json'), JSON.stringify({ ...VIDEO, ...extra }, null, 2) + '\n');
  /** A vertical short: a hook that keeps its sound, a tease, a payoff; pop captions in the middle. */
  const short = (extra: object = {}) =>
    EpisodeSchema.parse({
      version: 2, number: 1, title: 't', output: { width: 1080, height: 1920, fps: 30 },
      items: [
        { id: 'a', beat: 'hook', clip: 'c001', src: { in: 0, out: 4 }, audio: 'keep' },
        { id: 'b', beat: 'tease', clip: 'c001', src: { in: 5, out: 10 } },
        { id: 'c', beat: 'payoff', clip: 'c001', src: { in: 12, out: 14 } },
      ],
      captions: { style: 'pop', position: 'middle' },
      ...extra,
    });
  /** Spoken words of the clip at these source times. */
  const spoken = (...starts: number[]) => ({ words: starts.map((s, i) => ({ w: `w${i}`, start: s, end: s + 0.3, conf: 1 })), segments: [], speech: [] });
  const SHORT_BEATS = '(hook, tease, pointer, payoff, loop)';
  const BUILD_BEATS = '(cold-open, title, recap, new-toy, problem, montage, twist, truth, outro, blooper)';
  const covered = (what: string, area: string) => `${what} falls where the Shorts and Reels buttons cover it (${area}) — leave it out, or use a callout`;
  const coveredCaptions = 'captions at the bottom falls where the Shorts and Reels buttons cover it (bottom 20%) — set captions position middle';
  const shortCaptions = (own: string) => `captions are ${own}, not the Short format's pop/middle`;
  async function formatsFolder(files: Record<string, string>) {
    const dir = await mkdtemp(join(tmpdir(), 'we-formats-'));
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
    return dir;
  }
  const shortFile = async () => readFile(join(formatsDir(), 'short.md'), 'utf8');

  it('gives an existing build-story episode exactly the report it had before formats, video.json or not, vertical or not', async () => {
    const { dir } = await project(spoken(3));
    const ep = base({
      output: { width: 1080, height: 1920, fps: 30 },
      items: [
        { id: 'a', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 1.3 }, onBeat: true, audio: 'keep' },
        { id: 'b', beat: 'problem', clip: 'c001', src: { in: 5, out: 10 } },
        { id: 'z', beat: 'outro', clip: 'c001', src: { in: 12, out: 14 } },
      ],
      overlays: [{ kind: 'badge', text: 'FAILED', start: 2, end: 3 }, { kind: 'label', text: 'later', start: 3, end: 4 }, { kind: 'badge', text: 'LATE', start: 40, end: 41 }],
    });
    await saveEpisode(dir, ep);
    // Everything above the playbook section, which came later and is pinned in its own tests.
    const report = async () => {
      const lines = checkReport(await checkEpisode(dir, 1));
      return lines.slice(0, lines.findIndex((l) => l.startsWith('Playbook (')));
    };
    const before = await report();
    // The report as it was before formats existed (taken from the code at a2c8458).
    expect(before).toEqual([
      '  1  cold-open a            c001  0.00–1.50  ×1  0.00–1.50',
      '  2  problem   b            c001  5.00–10.00  ×1  1.50–6.50',
      '  3  outro     z            c001  12.00–14.00  ×1  6.50–8.50',
      'total 0:09 · 3 items · 3 overlays · 1 music cues',
      '⚠ overlay 3 ("LATE") starts at 40.20 s, after the episode ends (8.50 s) — it will never show',
    ]);
    await writeVideo(dir);
    await saveEpisode(dir, ep);
    expect(await report()).toEqual(before);
  });

  it("warns about a beat that isn't one of the format's, and in a build story only about beats outside the old list", async () => {
    const { dir } = await project(spoken(0.2));
    await saveEpisode(dir, short({ items: [{ id: 'a', beat: 'hook', clip: 'c001', src: { in: 0, out: 4 }, audio: 'keep' }, { id: 'b', beat: 'montage', clip: 'c001', src: { in: 5, out: 10 } }, { id: 'c', beat: 'payoff', clip: 'c001', src: { in: 12, out: 14 } }] }));
    await writeVideo(dir, { format: 'short', from: 1 });
    expect((await checkEpisode(dir, 1)).warnings).toEqual([`item b's beat "montage" isn't one of the Short format's beats ${SHORT_BEATS}`]);
    await saveEpisode(dir, base({ items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 2 } }, { id: 'b', beat: 'bit', clip: 'c001', src: { in: 5, out: 10 } }], music: [] }));
    await writeVideo(dir);
    expect((await checkEpisode(dir, 1)).warnings).toEqual([`item b's beat "bit" isn't one of the Build story format's beats ${BUILD_BEATS}`]);
  });

  it("warns when a short is longer than the 3:00 the platforms take, which a video's own target doesn't move", async () => {
    const { dir } = await project(spoken(0.2));
    const items = (n: number) => [
      { id: 'a', beat: 'hook', clip: 'c001', src: { in: 0, out: 25 }, audio: 'keep' },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, beat: 'tease', clip: 'c001', src: { in: 0, out: 30 } })),
      { id: 'c', beat: 'payoff', clip: 'c001', src: { in: 0, out: n } },
    ];
    await saveEpisode(dir, short({ items: items(10) }));
    await writeVideo(dir, { format: 'short', from: 1 });
    expect((await checkEpisode(dir, 1)).warnings).toEqual(["the video is 3:05, longer than the Short format's 3:00 — cut whole moments"]);
    await saveEpisode(dir, short({ items: items(5) }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual([]); // exactly 3:00
    // The short format favours no length (it has no targetSec), so a video's own target changes nothing: 3:00 is the platforms' limit.
    await saveEpisode(dir, short({ items: items(10) }));
    await writeVideo(dir, { format: 'short', from: 1, targetSec: 400 });
    expect((await checkEpisode(dir, 1)).warnings).toEqual(["the video is 3:05, longer than the Short format's 3:00 — cut whole moments"]);
  });

  it("a long vlog is told to cut whole bits rather than thin its laughs", async () => {
    const { dir } = await project(spoken(0.2));
    const bits = Array.from({ length: 14 }, (_, i) => ({ id: `b${i}`, beat: 'bit', clip: 'c001', src: { in: 0, out: 30 } }));
    await saveEpisode(dir, base({ items: bits, music: [], captions: { style: 'chosen' } }));
    await writeVideo(dir, { format: 'vlog' });
    expect((await checkEpisode(dir, 1)).warnings).toEqual(["the video is 7:00, longer than the Vlog format's 6:40 — cut whole bits rather than thinning laughs"]);
    await writeVideo(dir, { format: 'vlog', targetSec: 280 }); // 400 s × 280 / 260: 7:10
    expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
    await writeVideo(dir, { format: 'vlog', targetSec: 270 }); // 400 s × 270 / 260: 6:55
    expect((await checkEpisode(dir, 1)).warnings).toEqual(["the video is 7:00, longer than this video's 6:55 limit — cut whole bits rather than thinning laughs"]);
  });

  it("warns when the video's size or captions aren't what its format's file says", async () => {
    const { dir } = await project(spoken(0.2));
    await saveEpisode(dir, short({ output: { width: 720, height: 1280, fps: 30 } }));
    await writeVideo(dir, { format: 'short', from: 1 });
    expect((await checkEpisode(dir, 1)).warnings).toEqual(["the video is 720×1280, not the Short format's 1080×1920"]);
    // A different style or position; no captions in episode.json are phrase captions at the bottom.
    for (const [captions, own] of [[{ style: 'karaoke', position: 'middle' }, 'karaoke/middle'], [{ style: 'pop' }, 'pop/bottom'], [undefined, 'phrase/bottom']] as const) {
      await saveEpisode(dir, short({ captions }));
      expect((await checkEpisode(dir, 1)).warnings.slice(0, 1), own).toEqual([shortCaptions(own)]);
    }
    // The vlog's file writes only a style: its position is never compared.
    const bit = [{ id: 'a', beat: 'bit', clip: 'c001', src: { in: 0, out: 3 } }];
    await writeVideo(dir, { format: 'vlog' });
    for (const captions of [{ style: 'chosen' }, { style: 'chosen', position: 'middle' }]) {
      await saveEpisode(dir, base({ items: bit, music: [], captions }));
      expect((await checkEpisode(dir, 1)).warnings, JSON.stringify(captions)).toEqual([]);
    }
    await saveEpisode(dir, base({ items: bit, music: [] }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual(["captions are phrase, not the Vlog format's chosen"]);
    await saveEpisode(dir, base({ items: bit, music: [], output: { width: 1080, height: 1920, fps: 30 }, captions: { style: 'pop', position: 'middle' } }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual(["the video is 1080×1920, not the Vlog format's 1920×1080", "captions are pop, not the Vlog format's chosen"]);
  });

  it('a video.json that is broken is one ✖ with what to do, and the video is checked as a build story', async () => {
    const { dir } = await project(spoken(0.2));
    await saveEpisode(dir, base());
    await writeFile(join(dir, 'episodes', '1', 'video.json'), '{"title": ');
    const r = await checkEpisode(dir, 1);
    expect(r.problems).toEqual([expect.stringMatching(/^✖ episodes\/1\/video\.json: not valid JSON \(.*\)\n {2}Fix that field and run the command again\.$/)]);
    expect(r.warnings).toEqual([]);
  });

  it('measures the first word of a short against the playbook instead of warning: a miss names the opening item', async () => {
    const { dir } = await project(spoken(2, 6));
    const firstWord = async () => {
      const r = await checkEpisode(dir, 1);
      expect(r.warnings).toEqual([]);
      return r.playbook.filter((l) => l.includes('first word') || l.includes('no word'));
    };
    await saveEpisode(dir, short());
    await writeVideo(dir, { format: 'short', from: 1 });
    expect(await firstWord()).toEqual(['  ✗ first word at 2.0 s (the cut opens on item a) — the playbook asks for one within 0.5 s']);
    // No word in the first item at all: the first word is the next item's.
    await saveEpisode(dir, short({ items: [{ id: 'a', beat: 'hook', clip: 'c001', src: { in: 3, out: 4.5 }, audio: 'keep' }, { id: 'c', beat: 'payoff', clip: 'c001', src: { in: 5, out: 9 }, audio: 'keep' }] }));
    expect(await firstWord()).toEqual(['  ✗ first word at 2.5 s (the cut opens on item a) — the playbook asks for one within 0.5 s']);
    // A muted cut has no word at all: a hook that is seen rather than heard is the person's call, so it is a miss, never a warning.
    await saveEpisode(dir, short({ items: [{ id: 'a', beat: 'hook', clip: 'c001', src: { in: 0, out: 4 } }, { id: 'c', beat: 'payoff', clip: 'c001', src: { in: 5, out: 9 } }] }));
    expect(await firstWord()).toEqual(['  ✗ no word is spoken — the playbook asks for one within 0.5 s']);
  });

  it('starts speaking within half a second: the first word is met', async () => {
    const { dir } = await project(spoken(0.5, 3));
    await saveEpisode(dir, short());
    await writeVideo(dir, { format: 'short', from: 1 });
    const r = await checkEpisode(dir, 1);
    expect(r.warnings).toEqual([]);
    expect(r.playbook).toContain('  ✓ first word at 0.5 s — the playbook asks for one within 0.5 s');
  });

  it('a short whose first item is a title card: the beat warnings apply, and say it once', async () => {
    const { dir } = await project(spoken(3));
    await saveEpisode(dir, short({ items: [{ id: 'k', beat: 'title', card: { text: 'MY SHORT', style: 'bold', sec: 2 } }, { id: 'c', beat: 'payoff', clip: 'c001', src: { in: 5, out: 9 }, audio: 'keep' }] }));
    await writeVideo(dir, { format: 'short', from: 1 });
    expect((await checkEpisode(dir, 1)).warnings).toEqual([
      `item k's beat "title" isn't one of the Short format's beats ${SHORT_BEATS}`,
      'a short opens on its hook, not a title: item k',
    ]);
  });

  it('warns when a short opens on a cold open or has an outro', async () => {
    const { dir } = await project(spoken(0.1));
    await saveEpisode(dir, short({
      items: [
        { id: 'a', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 4 }, audio: 'keep' },
        { id: 'c', beat: 'payoff', clip: 'c001', src: { in: 12, out: 14 } },
        { id: 'z', beat: 'outro', clip: 'c001', src: { in: 15, out: 17 } },
      ],
    }));
    await writeVideo(dir, { format: 'short', from: 1 });
    expect((await checkEpisode(dir, 1)).warnings).toEqual([
      `item a's beat "cold-open" isn't one of the Short format's beats ${SHORT_BEATS}`,
      `item z's beat "outro" isn't one of the Short format's beats ${SHORT_BEATS}`,
      'a short opens on its hook, not a cold-open: item a',
      'a short has no outro: item z',
    ]);
  });

  it('a teaser (made from a big video) pays off one small question and needs no pointer; a standalone short loops, so its last cue must not fade out at the end', async () => {
    const { dir } = await project(spoken(0.1));
    const standalone = [{ id: 'a', beat: 'hook', clip: 'c001', src: { in: 0, out: 4 }, audio: 'keep' }, { id: 'b', beat: 'payoff', clip: 'c001', src: { in: 5, out: 9 } }, { id: 'c', beat: 'loop', clip: 'c001', src: { in: 10, out: 12 } }];
    const music = (fadeOut?: number) => [{ track: 'beat.wav', start: 0, end: 4 }, { track: 'beat.wav', start: 4, end: 10, ...(fadeOut === undefined ? {} : { fadeOut }) }];
    // A teaser with no pointer at its end is fine: the platform's own link points to the big video.
    await saveEpisode(dir, short({ music: music() }));
    await writeVideo(dir, { format: 'short', from: 1 });
    expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
    // A pointer is still allowed: a line the person says on camera, after the payoff.
    await saveEpisode(dir, short({ items: [...short().items, { id: 'p', beat: 'pointer', clip: 'c001', src: { in: 15, out: 17 }, audio: 'keep' }] }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
    // A teaser that only teases pays nothing off.
    await saveEpisode(dir, short({ items: [{ id: 'a', beat: 'hook', clip: 'c001', src: { in: 0, out: 4 }, audio: 'keep' }, { id: 'b', beat: 'tease', clip: 'c001', src: { in: 5, out: 10 } }] }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual(['a teaser short answers one small question and leaves the big one open: add a payoff beat']);
    await saveEpisode(dir, short({ items: standalone, music: music() }));
    await writeVideo(dir, { format: 'short' }); // no big video behind it: standalone
    expect((await checkEpisode(dir, 1)).warnings).toEqual(['a standalone short loops: the last music cue fades out at the end — set its fadeOut to 0']);
    await saveEpisode(dir, short({ items: standalone, music: music(0) }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
    // A cue that ends before the video does doesn't fade out at the end.
    await saveEpisode(dir, short({ items: standalone, music: [{ track: 'beat.wav', start: 0, end: 4 }] }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
    // A standalone short with no payoff never pays off its hook.
    await saveEpisode(dir, short({ items: standalone.filter((i) => i.beat !== 'payoff') }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual(['a standalone short pays off its hook: add a payoff beat']);
  });

  it('warns when a short ends on a full-screen card, teaser or standalone, and not when a card sits earlier', async () => {
    const { dir } = await project(spoken(0.1));
    const card = { id: 'k', beat: 'pointer', card: { text: 'Full video on my channel', style: 'bold', sec: 2 } };
    const warning = 'a short never ends on a full-screen card: item k — end on the last shot, with at most an overlay over it';
    await saveEpisode(dir, short({ items: [...short().items, card] }));
    await writeVideo(dir, { format: 'short', from: 1 });
    const r = await checkEpisode(dir, 1);
    expect(r.warnings).toEqual([warning]);
    // The ⚠ says it: the playbook section doesn't say it again.
    expect(r.playbook.join('\n')).not.toContain('full-screen card');
    await writeVideo(dir, { format: 'short' });
    expect((await checkEpisode(dir, 1)).warnings).toEqual([warning]);
    const [a, b, c] = short().items;
    await saveEpisode(dir, short({ items: [a, b, card, c] }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
    // An overlay over the last shot keeps the picture playing: no warning.
    await saveEpisode(dir, short({ overlays: [{ kind: 'callout', text: 'Full video on my channel', start: 9.5, end: 11 }] }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual([]);
  });

  it("warns about overlays and captions where the Shorts and Reels buttons cover a vertical video, from the styles' own boxes", async () => {
    const { dir } = await project(spoken(0.1));
    const overlays = (['badge', 'counter', 'before', 'after', 'timecard', 'label', 'name', 'subtitle', 'callout', 'chapter'] as const).map((kind) => ({ kind, text: kind.toUpperCase(), start: 1, end: 2 }));
    await saveEpisode(dir, short({ overlays, captions: { style: 'chosen', position: 'middle' } }));
    await writeVideo(dir, { format: 'short', from: 1 });
    expect((await checkEpisode(dir, 1)).warnings).toEqual([
      shortCaptions('chosen/middle'),
      covered('overlay badge ("BADGE")', 'top 10%, right 15%'),
      covered('overlay counter ("COUNTER")', 'top 10%'),
      covered('overlay before ("BEFORE")', 'top 10%'),
      covered('overlay after ("AFTER")', 'top 10%'),
      covered('overlay timecard ("TIMECARD")', 'top 10%'),
      covered('overlay label ("LABEL")', 'bottom 20%'),
      covered('overlay name ("NAME")', 'bottom 20%'),
    ]);
    // A subtitle sits where captions do: at the bottom it is covered too.
    await saveEpisode(dir, short({ overlays: [{ kind: 'subtitle', text: 'So I went back.', start: 1, end: 2 }], captions: { style: 'chosen' } }));
    expect((await checkEpisode(dir, 1)).warnings).toEqual([shortCaptions('chosen/bottom'), covered('overlay subtitle ("So I went back.")', 'bottom 20%')]);
    // Automatic captions at the bottom (set, or by default), not in the middle and not when there are none.
    for (const [captions, own] of [[{ style: 'pop', position: 'bottom' }, 'pop/bottom'], [{ style: 'phrase' }, 'phrase/bottom'], [undefined, 'phrase/bottom']] as const) {
      await saveEpisode(dir, short({ captions }));
      expect((await checkEpisode(dir, 1)).warnings, JSON.stringify(captions)).toEqual([shortCaptions(own), coveredCaptions]);
    }
    for (const [captions, own] of [[{ style: 'karaoke', position: 'middle' }, 'karaoke/middle'], [{ style: 'off' }, 'off/bottom']] as const) {
      await saveEpisode(dir, short({ captions }));
      expect((await checkEpisode(dir, 1)).warnings, JSON.stringify(captions)).toEqual([shortCaptions(own)]);
    }
  });

  it('never warns about covered areas on a 16:9 video', async () => {
    const { dir } = await project(spoken(0.1));
    const overlays = (['badge', 'counter', 'timecard', 'label', 'name'] as const).map((kind) => ({ kind, text: kind, start: 1, end: 2 }));
    await saveEpisode(dir, short({ output: { width: 1920, height: 1080, fps: 30 }, overlays, captions: { style: 'pop', position: 'bottom' } }));
    await writeVideo(dir, { format: 'short', from: 1 });
    // Only the size and the captions differ from the short's file; nothing is covered on a landscape frame.
    expect((await checkEpisode(dir, 1)).warnings).toEqual(["the video is 1920×1080, not the Short format's 1080×1920", shortCaptions('pop/bottom')]);
  });

  it('reports an unknown format as ✖ with the ids, and checks the rest as a build story', async () => {
    const { dir } = await project(spoken(0.1));
    await saveEpisode(dir, base({ items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 2 } }, { id: 'b', beat: 'bit', clip: 'c001', src: { in: 5, out: 10 } }], music: [] }));
    await writeVideo(dir, { format: 'reel' });
    const r = await checkEpisode(dir, 1);
    expect(r.problems).toEqual(['✖ video.json: unknown format "reel"\n  The formats are: build-story, short, vlog.']);
    expect(r.warnings).toEqual([`item b's beat "bit" isn't one of the Build story format's beats ${BUILD_BEATS}`]);
    expect(checkReport(r)).toContain('✖ video.json: unknown format "reel"\n  The formats are: build-story, short, vlog.');
  });

  it('a broken or missing build-story.md is one ✖, not a failed check; a broken other format still lets a short be checked', async () => {
    const { dir } = await project(spoken(0.1));
    await saveEpisode(dir, base());
    const broken = await formatsFolder({ 'build-story.md': '---\n{"id":"build-story",}\n---\n', 'short.md': await shortFile() });
    const r = await checkEpisode(dir, 1, undefined, { formatsDir: broken });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/^✖ plugin\/formats\/build-story\.md: front matter is not valid JSON/);
    expect(r.warnings).toEqual([]);
    const missing = await formatsFolder({ 'short.md': await shortFile() });
    expect((await checkEpisode(dir, 1, undefined, { formatsDir: missing })).problems).toEqual(['✖ plugin/formats/build-story.md: the file is missing']);
    expect((await checkEpisode(dir, 1, undefined, { formatsDir: join(missing, 'nowhere') })).problems).toEqual(['✖ plugin/formats: the folder is missing or unreadable']);
    // A short checked while vlog.md has a typo: the ✖ for vlog.md, and the short's own warnings.
    await saveEpisode(dir, short({ items: [{ id: 'a', beat: 'title', clip: 'c001', src: { in: 0, out: 4 }, audio: 'keep' }, { id: 'c', beat: 'payoff', clip: 'c001', src: { in: 5, out: 9 } }] }));
    await writeVideo(dir, { format: 'short', from: 1 });
    const typo = await formatsFolder({ 'build-story.md': await readFile(join(formatsDir(), 'build-story.md'), 'utf8'), 'short.md': await shortFile(), 'vlog.md': '---\n{"id":"vlog","nmae":"Vlog"}\n---\n' });
    const s = await checkEpisode(dir, 1, undefined, { formatsDir: typo });
    expect(s.problems).toEqual([expect.stringMatching(/^✖ plugin\/formats\/vlog\.md: /)]);
    expect(s.warnings).toContain('a short opens on its hook, not a title: item a');
  });
});

describe("checkEpisode against the format's playbook", () => {
  const VIDEO = { version: 1, title: 't', about: '', mention: '', hide: '', footage: [], createdAt: '2026-11-06T00:00:00.000Z' };
  const writeVideo = (dir: string, extra: object = {}) => writeFile(join(dir, 'episodes', '1', 'video.json'), JSON.stringify({ ...VIDEO, ...extra }, null, 2) + '\n');
  const spoken = (...starts: number[]) => ({ words: starts.map((s, i) => ({ w: `w${i}`, start: s, end: s + 0.3, conf: 1 })), segments: [], speech: [] });
  const IDEA = { gap: 'a lamp that should light and is dead', question: 'Will it ever light?' };
  /** A build story of 20.5 s: a spoken cold open, a problem, a 9 s montage, the truth at 18 s (88%), an outro. */
  const story = (extra: object = {}) =>
    EpisodeSchema.parse({
      version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
      items: [
        { id: 'a', beat: 'cold-open', clip: 'c001', src: { in: 0, out: 4 }, audio: 'keep' },
        { id: 'b', beat: 'problem', clip: 'c001', src: { in: 5, out: 10 } },
        { id: 'c', beat: 'montage', clip: 'c001', src: { in: 10, out: 19 } },
        { id: 't', beat: 'truth', clip: 'c001', src: { in: 20, out: 21.5 }, audio: 'keep' },
        { id: 'o', beat: 'outro', clip: 'c001', src: { in: 22, out: 23 } },
      ],
      ...extra,
    });
  /** A vertical short of 6 s in 2 s shots, a word in each: a hook, a tease, a payoff. */
  const short = (extra: object = {}) =>
    EpisodeSchema.parse({
      version: 2, number: 1, title: 't', output: { width: 1080, height: 1920, fps: 30 },
      items: [
        { id: 'h', beat: 'hook', clip: 'c001', src: { in: 0, out: 2 }, audio: 'keep' },
        { id: 'm', beat: 'tease', clip: 'c001', src: { in: 2, out: 4 }, audio: 'keep' },
        { id: 'p', beat: 'payoff', clip: 'c001', src: { in: 4, out: 6 }, audio: 'keep' },
      ],
      captions: { style: 'pop', position: 'middle' },
      ...extra,
    });
  const mine = (dir: string, front: object) => mkdir(join(dir, 'formulas'), { recursive: true }).then(() =>
    writeFile(join(dir, 'formulas', 'short-mine.md'), `---\n${JSON.stringify({ id: 'short-mine', name: 'My shorts', describe: 'What my shorts showed.', formats: ['short'], source: 'my posted videos', ...front })}\n---\nRules.\n`));

  it('prints one line per rule of the build story, met or missed, with the number, the target and where a miss happens', async () => {
    const { dir } = await project(spoken(0.2, 20.5));
    await saveEpisode(dir, story());
    await writeVideo(dir, { idea: IDEA });
    const r = await checkEpisode(dir, 1);
    expect(r.playbook).toEqual([
      'Playbook (build-story):',
      '  ✓ opens on the picture (item a)',
      '  ✓ the idea is on record: gap, question (no doubt, no stake)',
      '  – the title: not measured — no title is chosen yet (titles.chosen in episodes/1/video.json)',
      '  ✗ longest stretch with nothing new 9.0 s, 0:09.0–0:18.0 (item c) — the playbook allows 8 s',
      '  ✗ 6 words a minute — the playbook asks for 145–200; the longest stretch without words is 0:00.5–0:18.5 (item a)',
      '  ✓ the answer (truth, item t) starts 88% of the way through — the playbook asks for 85–93%',
      '  ✓ has its answer: a truth beat (item t)',
      '  ✓ ends on its outro (item o)',
    ]);
    // A miss is neither a warning nor a problem, and the section closes the report.
    expect(r.warnings).toEqual([]);
    expect(r.problems).toEqual([]);
    expect(checkReport(r).slice(-9)).toEqual(r.playbook);
    expect(checkReport(r).join('\n')).not.toMatch(/[⚠✖]/);
  });

  it('silence over changing pictures is not empty: a cut or an overlay starting ends the stretch', async () => {
    const { dir } = await project(spoken(0.2, 20.5));
    const empty = async () => (await checkEpisode(dir, 1)).playbook.find((l) => l.includes('nothing new'));
    // An overlay starting at 14 s splits the 9 s montage into 5 s and 4 s.
    await saveEpisode(dir, story({ overlays: [{ kind: 'label', text: 'Day 2', start: 14, end: 16 }] }));
    expect(await empty()).toBe('  ✓ longest stretch with nothing new 5.0 s — the playbook allows 8 s');
    // The montage cut in two: no stretch is longer than the 5 s problem.
    const [a, b, , t, o] = story().items;
    await saveEpisode(dir, story({ items: [a, b, { id: 'c1', beat: 'montage', clip: 'c001', src: { in: 10, out: 14 } }, { id: 'c2', beat: 'montage', clip: 'c001', src: { in: 14, out: 19 } }, t, o] }));
    expect(await empty()).toBe('  ✓ longest stretch with nothing new 5.0 s — the playbook allows 8 s');
    // Two stretches over the limit: the longest is named, the other counted.
    await saveEpisode(dir, story({ items: [a, { ...b, src: { in: 0, out: 12 } }, ...story().items.slice(2)] }));
    expect(await empty()).toBe('  ✗ longest stretch with nothing new 12.0 s, 0:04.0–0:16.0 (item b), and 1 more — the playbook allows 8 s');
  });

  it('says where the answer starts when it is early or late, and that it is missing', async () => {
    const { dir } = await project(spoken(0.2, 20.5));
    const [a, b, c, t, o] = story().items;
    const answer = async () => (await checkEpisode(dir, 1)).playbook.filter((l) => l.includes('answer'));
    await saveEpisode(dir, story({ items: [a, t, b, c, o] }));
    expect(await answer()).toEqual([
      '  ✗ the answer (truth, item t) starts 20% of the way through, at 0:04.0 — the playbook asks for 85–93%',
      '  ✓ has its answer: a truth beat (item t)',
    ]);
    await saveEpisode(dir, story({ items: [a, b, c, o, { ...b, id: 'z' }, t] }));
    expect(await answer()).toEqual([
      '  ✗ the answer (truth, item t) starts 94% of the way through, at 0:24.0 — the playbook asks for 85–93%',
      '  ✓ has its answer: a truth beat (item t)',
    ]);
    await saveEpisode(dir, story({ items: [a, b, c, o] }));
    expect(await answer()).toEqual(['  ✗ no truth beat in the cut — the playbook asks for the answer on screen']);
  });

  it('says what the idea lacks, where the cut ends, and that it opens on a card', async () => {
    const { dir } = await project(spoken(0.2, 20.5));
    const [a, b, c, t, o] = story().items;
    await saveEpisode(dir, story({ items: [{ id: 'k', beat: 'title', card: { text: 'THE LAMP', style: 'bold', sec: 2 } }, a, b, c, t, o, { ...b, id: 'z' }] }));
    await writeVideo(dir, { idea: { gap: IDEA.gap, stake: '£40' } });
    const lines = (await checkEpisode(dir, 1)).playbook;
    expect(lines).toContain('  ✗ opens on a full-screen card (item k) — the playbook opens on the picture');
    expect(lines).toContain('  ✗ the idea has no question on record — the playbook asks for the gap and the question before cutting');
    expect(lines).toContain('  ✗ ends on problem (item z), not on outro or blooper');
    await writeVideo(dir, {});
    expect((await checkEpisode(dir, 1)).playbook).toContain('  ✗ the idea has no gap and no question on record — the playbook asks for the gap and the question before cutting');
  });

  it('lists a rule it cannot measure as not measured, with the reason, and never guesses', async () => {
    // A kept clip without a transcript: its speech is invisible, so nothing about words is measured. No video.json: no idea to read.
    const { dir } = await project(null);
    await saveEpisode(dir, story());
    const r = await checkEpisode(dir, 1);
    expect(r.playbook).toEqual([
      'Playbook (build-story):',
      '  ✓ opens on the picture (item a)',
      '  – the idea: not measured — the video has no video.json',
      '  – the title: not measured — the video has no video.json',
      '  – longest stretch with nothing new: not measured — item a keeps the sound of c001, which has no transcript',
      '  – words a minute: not measured — item a keeps the sound of c001, which has no transcript',
      '  ✓ the answer (truth, item t) starts 88% of the way through — the playbook asks for 85–93%',
      '  ✓ has its answer: a truth beat (item t)',
      '  ✓ ends on its outro (item o)',
    ]);
  });

  it('counts narration lines that are written but not recorded yet, and says so', async () => {
    const { dir } = await project(spoken(0.2, 20.5));
    const line = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    await saveEpisode(dir, story({ slots: [{ id: 'n1', start: 4, end: 16, maxWords: 30, line }] }));
    const lines = (await checkEpisode(dir, 1)).playbook;
    expect(lines).toContain('  ✗ 94 words a minute (counting the written narration lines, not recorded yet) — the playbook asks for 145–200; the longest stretch without words is 0:00.5–0:04.0 (item a)');
    // The words of the line fill the stretch the bare cut left empty.
    expect(lines).toContain('  ✓ longest stretch with nothing new 3.5 s — the playbook allows 8 s');
  });

  it('a short against its playbook: the first word, no empty stretch, the idea, the pace, the payoff', async () => {
    const { dir } = await project(spoken(0.2, 2.4, 4.4));
    await saveEpisode(dir, short());
    await writeVideo(dir, { format: 'short', idea: { ...IDEA, doubt: 'the shop said no', stake: '£40' } });
    const r = await checkEpisode(dir, 1);
    expect(r.warnings).toEqual([]);
    expect(r.playbook).toEqual([
      'Playbook (short):',
      '  ✓ opens on the picture (item h)',
      '  ✓ first word at 0.2 s — the playbook asks for one within 0.5 s',
      '  ✓ the idea is on record: gap, question, doubt, stake',
      '  – the title: not measured — no title is chosen yet (titles.chosen in episodes/1/video.json)',
      '  ✓ longest stretch with nothing new 1.5 s — the playbook allows 3 s',
      '  ✗ 20.0 cuts a minute — the playbook asks for 29 or more; the longest shot is item h, 2.0 s (0:00.0–0:02.0)',
      '  ✓ the answer (payoff, item p) starts 67% of the way through — the playbook asks for 50–90%',
      '  ✓ has its answer: a payoff beat (item p)',
      '  ✓ ends on the picture, with no outro (item p)',
      '  ✗ ends on payoff (item p), not on a loop beat — a standalone short ends where the restart flows into the hook',
    ]);
  });

  it("a teaser's question is the big video's, and its payoff is a small one that is not placed", async () => {
    const { dir } = await project(spoken(0.2, 2.4, 4.4));
    await saveEpisode(dir, short());
    await writeVideo(dir, { format: 'short', from: 2 });
    await mkdir(join(dir, 'episodes', '2'), { recursive: true });
    await writeFile(join(dir, 'episodes', '2', 'video.json'), JSON.stringify({ ...VIDEO, idea: IDEA }));
    const lines = (await checkEpisode(dir, 1)).playbook;
    expect(lines).toContain("  ✓ the idea is on record: gap, question (no doubt, no stake), the big video's (video 2) where the short has none");
    expect(lines).toContain('  ✓ pays off one small question: a payoff beat (item p)');
    expect(lines.join('\n')).not.toContain('of the way through');
  });

  it("a vlog's pace leaves its held headline out, and it ends on its tag", async () => {
    const { dir } = await project(spoken(0.2));
    const bits = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, beat: 'bit', clip: 'c001', src: { in: i, out: i + 2 }, ...(i === 0 ? { audio: 'keep' } : {}) }));
    const items = [...bits, { id: 'h', beat: 'headline', clip: 'c001', src: { in: 0, out: 20 } }, { id: 'g', beat: 'tag', clip: 'c001', src: { in: 20, out: 24 } }];
    await saveEpisode(dir, base({ items, music: [], captions: { style: 'chosen' } }));
    await writeVideo(dir, { format: 'vlog', idea: IDEA });
    const r = await checkEpisode(dir, 1);
    expect(r.warnings).toEqual([]);
    expect(r.playbook).toEqual([
      'Playbook (vlog):',
      '  ✓ opens on the picture (item b0)',
      '  ✓ the idea is on record: gap, question (no doubt, no stake)',
      '  – the title: not measured — no title is chosen yet (titles.chosen in episodes/1/video.json)',
      '  ✓ longest stretch with nothing new 20.0 s — the playbook allows 20 s',
      '  ✓ 22.5 cuts a minute outside headline — the playbook asks for 15 or more; in bit 25.0 (15 or more)',
      '  ✓ the answer (headline, item h) starts 33% of the way through — the playbook asks for 25–71%',
      '  ✓ has its answer: a headline beat (item h)',
      '  ✓ ends on its tag (item g)',
      '  ✓ 0:36 long — it aims for 4:20 and warns past 6:40',
    ]);
  });

  it("a video past its format's limit is told once, by the ⚠", async () => {
    const { dir } = await project(spoken(0.2));
    const bits = Array.from({ length: 14 }, (_, i) => ({ id: `b${i}`, beat: 'bit', clip: 'c001', src: { in: 0, out: 30 } }));
    await saveEpisode(dir, base({ items: bits, music: [], captions: { style: 'chosen' } }));
    await writeVideo(dir, { format: 'vlog' });
    const r = await checkEpisode(dir, 1);
    expect(r.warnings).toEqual(["the video is 7:00, longer than the Vlog format's 6:40 — cut whole bits rather than thinning laughs"]);
    expect(r.playbook.join('\n')).not.toContain('7:00');
    expect(r.measured!.results.find((x) => x.rule === 'length')).toMatchObject({ status: 'missed', warnings: r.warnings });
  });

  it("the person's own formula for the format replaces the playbook's numbers, key by key, and the section says which", async () => {
    const { dir } = await project(spoken(1.5, 2.4, 4.4));
    await saveEpisode(dir, short());
    await writeVideo(dir, { format: 'short', idea: IDEA });
    expect((await checkEpisode(dir, 1)).playbook.slice(0, 3)).toEqual([
      'Playbook (short):',
      '  ✓ opens on the picture (item h)',
      '  ✗ first word at 1.5 s (the cut opens on item h) — the playbook asks for one within 0.5 s',
    ]);
    await mine(dir, { playbook: { firstWordSec: 2, cutsPerMin: { min: 18 } } });
    const r = await checkEpisode(dir, 1);
    expect(r.playbook).toEqual([
      "Playbook (short, with your short-mine formula's firstWordSec, cutsPerMin):",
      '  ✓ opens on the picture (item h)',
      '  ✓ first word at 1.5 s — the playbook asks for one within 2 s',
      '  ✓ the idea is on record: gap, question (no doubt, no stake)',
      '  – the title: not measured — no title is chosen yet (titles.chosen in episodes/1/video.json)',
      '  ✓ longest stretch with nothing new 1.5 s — the playbook allows 3 s',
      '  ✓ 20.0 cuts a minute — the playbook asks for 18 or more',
      '  ✓ the answer (payoff, item p) starts 67% of the way through — the playbook asks for 50–90%',
      '  ✓ has its answer: a payoff beat (item p)',
      '  ✓ ends on the picture, with no outro (item p)',
      '  ✗ ends on payoff (item p), not on a loop beat — a standalone short ends where the restart flows into the hook',
    ]);
    // A formula without a playbook changes nothing; another format's formula is not read for this one.
    await mine(dir, {});
    expect((await checkEpisode(dir, 1)).playbook[0]).toBe('Playbook (short):');
    // A broken one is one ✖ line, and the format's own numbers hold.
    await mine(dir, { playbook: { firstWordSec: 'soon' } });
    const broken = await checkEpisode(dir, 1);
    expect(broken.problems).toEqual(['✖ formulas/short-mine.md: playbook.firstWordSec: Invalid input: expected number, received string']);
    expect(broken.playbook[0]).toBe('Playbook (short):');
  });
});
