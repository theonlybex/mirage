import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
  await writeFile(join(dir, 'music', 'library.json'), JSON.stringify({ version: 1, tracks: [{ file: 'beat.wav', mood: 'upbeat', bpm: 120, beatOffset: 0.1, durationSec: 60 }] }));
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
});
