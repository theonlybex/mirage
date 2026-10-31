import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type Transcript, type Word } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import type { MediaTools } from '../media-tools.js';
import { sha256File } from './ingest.js';
import { acquireLock } from './lock.js';
import { loadEpisode, loadVoiceoverTranscripts, saveEpisode } from './render-episode.js';
import { cutOf } from './slots.js';
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

  it('leaves episode.json alone when the fit fails, but keeps the transcript (under its content name) so a re-run is quick', async () => {
    const { project, tools, calls } = await setup({ 'vo.m4a': tx(said('Totally unrelated speech.', 0)) });
    const before = await readFile(join(project, 'episodes', '1', 'episode.json'), 'utf8');
    await expect(fitRecording({ project, episode: 1, recording: join(project, 'vo.m4a'), tools })).rejects.toMatchObject({ code: 'NOTHING_MATCHED' });
    const file = voTranscriptFile(await sha256File(join(project, 'vo.m4a')));
    expect((await readdir(join(project, 'episodes', '1'))).sort()).toEqual(['episode.json', file]);
    expect(await readFile(join(project, 'episodes', '1', 'episode.json'), 'utf8')).toBe(before);
    await expect(fitRecording({ project, episode: 1, recording: join(project, 'vo.m4a'), tools })).rejects.toMatchObject({ code: 'NOTHING_MATCHED' });
    expect(calls).toEqual(['vo.m4a']);
  });

  it('refuses to save over edits made to episode.json while it was transcribing, keeping the transcript for the re-run', async () => {
    const full = tx([...said('Open settings.', 0), ...said('Then toggle dark mode on.', 2), ...said('Pick a nice accent colour.', 4)]);
    const { project, tools, calls } = await setup({ 'vo.m4a': full });
    const epFile = join(project, 'episodes', '1', 'episode.json');
    const slow = {
      ...tools,
      transcribe: async (wav: string) => {
        const ep = JSON.parse(await readFile(epFile, 'utf8'));
        ep.slots[2].line = 'Pick a nicer accent colour.';
        await writeFile(epFile, JSON.stringify(ep));
        return tools.transcribe(wav);
      },
    } as MediaTools;
    await expect(fitRecording({ project, episode: 1, recording: join(project, 'vo.m4a'), tools: slow })).rejects.toMatchObject({ message: 'episode.json changed while vo was running — run vo again' });
    const ep = await loadEpisode(project, 1);
    expect(ep.slots[2].line).toBe('Pick a nicer accent colour.');
    expect(ep.voiceover).toBeNull();
    const again = await fitRecording({ project, episode: 1, recording: join(project, 'vo.m4a'), tools });
    expect(again.reused).toBe(true);
    expect(calls).toEqual(['vo.m4a']);
  });

  it('saves when episode.json was only rewritten meanwhile (reformatted, defaults left out), not changed', async () => {
    const full = tx([...said('Open settings.', 0), ...said('Then toggle dark mode on.', 2), ...said('Pick a nice accent colour.', 4)]);
    const { project, tools } = await setup({ 'vo.m4a': full });
    const epFile = join(project, 'episodes', '1', 'episode.json');
    const rewrite = {
      ...tools,
      transcribe: async (wav: string) => {
        // As if written by hand: one line, no keys whose value is the default.
        const ep = JSON.parse(await readFile(epFile, 'utf8'));
        delete ep.overlays;
        delete ep.music;
        delete ep.items[0].speed;
        delete ep.items[0].hold;
        await writeFile(epFile, JSON.stringify(ep));
        return tools.transcribe(wav);
      },
    } as MediaTools;
    const r = await fitRecording({ project, episode: 1, recording: join(project, 'vo.m4a'), tools: rewrite });
    expect(r.report.lines.map((l) => l.status)).toEqual(['placed', 'placed', 'placed']);
    expect((await loadEpisode(project, 1)).voiceover).not.toBeNull();
  });

  it('says so when the recording is a folder', async () => {
    const { project, tools } = await setup({});
    await expect(fitRecording({ project, episode: 1, recording: join(project, 'episodes'), tools })).rejects.toMatchObject({ code: 'BAD_INPUT', message: `${join(project, 'episodes')} is a folder, not a recording` });
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

describe('fitRecording and recordings saved over', () => {
  it('refuses to add lines from a recording saved over the one earlier lines were cut from, and records each recording\'s sha256', async () => {
    const { project, tools } = await setup({
      first: tx([...said('Open settings.', 0), ...said('Pick a nice accent colour.', 2)]),
      second: tx(said('Then toggle dark mode on.', 0.5)),
    });
    const take = join(project, 'take.m4a');
    await writeFile(take, 'first');
    const first = await fitRecording({ project, episode: 1, recording: take, tools });
    expect(first.episode.voiceover!.recordingSha256).toEqual({ 'take.m4a': await sha256File(take) });
    const before = await readFile(join(project, 'episodes', '1', 'episode.json'), 'utf8');
    await writeFile(take, 'second');
    await expect(fitRecording({ project, episode: 1, recording: take, tools, add: true })).rejects.toMatchObject({
      code: 'BAD_ITEM',
      message: 'take.m4a is not the recording n1, n3 were cut from: it changed since vo fitted them',
      hint: expect.stringContaining('under a new name'),
    });
    expect(await readFile(join(project, 'episodes', '1', 'episode.json'), 'utf8')).toBe(before);
    // Saved under a new name it is added as a second recording.
    await writeFile(take, 'first');
    await writeFile(join(project, 'take-2.m4a'), 'second');
    const added = await fitRecording({ project, episode: 1, recording: join(project, 'take-2.m4a'), tools, add: true });
    expect(Object.keys(added.episode.voiceover!.recordingSha256!).sort()).toEqual(['take-2.m4a', 'take.m4a']);
  });
});

describe('fitRecording with a recording that has no sound', () => {
  it('says a video with no audio track has none, instead of the ffmpeg error', async () => {
    const { project, tools, calls } = await setup({});
    await writeFile(join(project, 'screen.mov'), 'x');
    const silentVideo = {
      ...tools,
      extractWav: async () => {
        throw new Error('Output file #0 does not contain any stream');
      },
      probe: async () => ({ hasAudio: false }),
    } as unknown as MediaTools;
    await expect(fitRecording({ project, episode: 1, recording: join(project, 'screen.mov'), tools: silentVideo })).rejects.toMatchObject({ code: 'BAD_INPUT', message: `${join(project, 'screen.mov')} has no audio track` });
    expect(calls).toEqual([]);
  });
});

describe('fitRecording and the slots', () => {
  it('refuses before transcribing when the cut changed since slots were written', async () => {
    const { project, tools, calls } = await setup({ 'vo.m4a': tx(said('Open settings.', 0)) });
    const ep = await loadEpisode(project, 1);
    await saveEpisode(project, { ...ep, slotsCut: cutOf(ep), items: [{ ...ep.items[0], src: { in: 2, out: 20 } }] });
    await expect(fitRecording({ project, episode: 1, recording: join(project, 'vo.m4a'), tools })).rejects.toMatchObject({
      code: 'BAD_ITEM',
      message: 'The cut changed since slots were written — run slots first',
      hint: expect.stringContaining('pnpm mirage slots <project> 1'),
    });
    expect(calls).toEqual([]);
  });
});

describe('fitRecording and other commands', () => {
  it('refuses while a render of the episode is running, before transcribing anything', async () => {
    const { project, tools, calls } = await setup({ 'vo.m4a': tx(said('Open settings.', 0)) });
    const lock = await acquireLock(join(project, 'episodes', '1'), 'render', 'episode 1');
    try {
      await expect(fitRecording({ project, episode: 1, recording: join(project, 'vo.m4a'), tools })).rejects.toMatchObject({ code: 'BUSY', message: expect.stringContaining('episode 1 is busy: render') });
      expect(calls).toEqual([]);
    } finally {
      await lock.release();
    }
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
