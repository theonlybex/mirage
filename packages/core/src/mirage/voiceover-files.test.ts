import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type Transcript, type Word } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import type { MediaTools } from '../media-tools.js';
import { sha256File } from './ingest.js';
import { loadEpisode, loadVoiceoverTranscripts, saveEpisode } from './render-episode.js';
import { fitRecording, voTranscriptFile } from './voiceover-files.js';

function said(text: string, t0: number): Word[] {
  return text.split(' ').map((w, i) => ({ w, start: +(t0 + i * 0.3).toFixed(3), end: +(t0 + i * 0.3 + 0.25).toFixed(3), conf: 1 }));
}
const tx = (words: Word[]): Transcript => ({ words, segments: [], speech: [] });
const LINES: [string, number, number, string][] = [['n1', 0, 3, 'Open settings.'], ['n2', 5, 9, 'Then toggle dark mode on.'], ['n3', 10, 13, 'Pick a nice accent colour.']];

/** A project with one 20 s item and three written slots; recordings are small files whose text says what was "read". */
async function setup(recordings: Record<string, Transcript>) {
  const project = await mkdtemp(join(tmpdir(), 'we-vo-'));
  await saveEpisode(project, EpisodeSchema.parse({
    version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 },
    items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 20 } }],
    slots: LINES.map(([id, start, end, line]) => ({ id, start, end, maxWords: 8, line })),
  }));
  for (const name of Object.keys(recordings)) await writeFile(join(project, name), name);
  const calls: string[] = [];
  const tools = {
    extractWav: async (src: string, out: string) => writeFile(out, await readFile(src, 'utf8')),
    transcribe: async (wav: string) => {
      const name = await readFile(wav, 'utf8');
      calls.push(name);
      return recordings[name];
    },
  } as unknown as MediaTools;
  return { project, tools, calls };
}

describe('fitRecording', () => {
  it('transcribes a recording once and reuses its transcript when the same recording is fitted again', async () => {
    const full = tx([...said('Open settings.', 0), ...said('Then toggle dark mode on.', 2), ...said('Pick a nice accent colour.', 4)]);
    const { project, tools, calls } = await setup({ 'vo.m4a': full });
    const first = await fitRecording({ project, episode: 1, recording: join(project, 'vo.m4a'), tools });
    expect(first.reused).toBe(false);
    const file = voTranscriptFile(await sha256File(join(project, 'vo.m4a')));
    expect(file).toMatch(/^voiceover\.[0-9a-f]{16}\.transcript\.json$/);
    expect(existsSync(join(project, 'episodes', '1', file))).toBe(true);
    expect(first.episode.voiceover!.transcripts).toEqual({ 'vo.m4a': file });

    const second = await fitRecording({ project, episode: 1, recording: join(project, 'vo.m4a'), tools });
    expect(second.reused).toBe(true);
    expect(calls).toEqual(['vo.m4a']);
    expect(second.report.lines.map((l) => l.status)).toEqual(['placed', 'placed', 'placed']);
  });

  it('writes no transcript when the fit fails, so it never pairs with the old lines', async () => {
    const { project, tools } = await setup({ 'vo.m4a': tx(said('Totally unrelated speech.', 0)) });
    const before = await readFile(join(project, 'episodes', '1', 'episode.json'), 'utf8');
    await expect(fitRecording({ project, episode: 1, recording: join(project, 'vo.m4a'), tools })).rejects.toMatchObject({ code: 'NOTHING_MATCHED' });
    expect((await readdir(join(project, 'episodes', '1'))).sort()).toEqual(['episode.json']);
    expect(await readFile(join(project, 'episodes', '1', 'episode.json'), 'utf8')).toBe(before);
  });

  it('adds a recording of just the missing lines, keeping the placed ones and both transcripts', async () => {
    const { project, tools } = await setup({
      'vo.m4a': tx([...said('Open settings.', 0), ...said('Pick a nice accent colour.', 2)]),
      'n2.m4a': tx(said('Then toggle dark mode on.', 0.5)),
    });
    const first = await fitRecording({ project, episode: 1, recording: join(project, 'vo.m4a'), tools });
    expect(first.report.lines.map((l) => l.status)).toEqual(['placed', 'missing', 'placed']);
    const second = await fitRecording({ project, episode: 1, recording: join(project, 'n2.m4a'), tools, add: true });
    expect(second.report.lines.map((l) => [l.slot, l.status])).toEqual([['n2', 'placed']]);
    const ep = await loadEpisode(project, 1);
    expect(ep.voiceover!.lines.map((l) => [l.slot, l.recording ?? ep.voiceover!.recording])).toEqual([['n1', 'vo.m4a'], ['n2', 'n2.m4a'], ['n3', 'vo.m4a']]);
    for (const id of ['n1', 'n3']) expect(ep.voiceover!.lines.find((l) => l.slot === id)).toEqual(first.episode.voiceover!.lines.find((l) => l.slot === id));
    const transcripts = await loadVoiceoverTranscripts(project, ep);
    expect([...transcripts.keys()].sort()).toEqual(['n2.m4a', 'vo.m4a']);
    expect(transcripts.get('n2.m4a')!.words[0].w).toBe('Then');

    await expect(fitRecording({ project, episode: 1, recording: join(project, 'n2.m4a'), tools, add: true })).rejects.toMatchObject({ code: 'NOTHING_MATCHED', message: 'Every written line already has a voice-over' });
  });
});

describe('loadVoiceoverTranscripts', () => {
  it('falls back to voiceover.transcript.json for an episode fitted before per-recording transcripts', async () => {
    const project = await mkdtemp(join(tmpdir(), 'we-vo-'));
    const ep = EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 2 } }], voiceover: { recording: 'vo.m4a', lines: [{ slot: 'n1', at: 0, src: { in: 0, out: 1 } }] } });
    await saveEpisode(project, ep);
    await expect(loadVoiceoverTranscripts(project, ep)).rejects.toMatchObject({ code: 'NO_EPISODE', message: 'episodes/1/voiceover.transcript.json is missing' });
    await writeFile(join(project, 'episodes', '1', 'voiceover.transcript.json'), JSON.stringify(tx(said('Hi.', 0))));
    expect((await loadVoiceoverTranscripts(project, ep)).get('vo.m4a')!.words[0].w).toBe('Hi.');
  });
});
