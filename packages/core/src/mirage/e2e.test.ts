import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema } from '@wordedits/shared';
import { run } from '@wordedits/sidecars';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realMediaTools, type MediaTools } from '../media-tools.js';
import { ingestClips, loadCatalog } from './ingest.js';
import { analyzeLibrary, loadLibrary, snapToBeats } from './music.js';
import { renderEpisode, saveEpisode } from './render-episode.js';
import { computeSlots } from './slots.js';
import { timelineDuration } from './timeline.js';
import { fitRecording } from './voiceover-files.js';

const LINE = 'Every request took ten seconds, so I rewrote the backend.';

describe.skipIf(process.platform !== 'darwin')('a Mirage episode end to end (macOS)', () => {
  let tools: MediaTools;
  let project: string;
  let passed = false;
  // Keep the project for inspection when the test failed.
  afterAll(async () => {
    if (passed && project) await rm(project, { recursive: true, force: true });
  });
  beforeAll(async () => {
    tools = await realMediaTools();
    const s = await import('@wordedits/sidecars');
    if (!existsSync(s.transcriberPath())) execFileSync('pnpm', ['build:native'], { stdio: 'inherit' });
    project = await mkdtemp(join(tmpdir(), 'mirage e2e '));
    const clips = join(project, 'batch 1');
    await mkdir(clips, { recursive: true });
    await mkdir(join(project, 'music'), { recursive: true });
    const gen = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    execFileSync('say', ['-v', 'Samantha', '-o', join(project, 'talk.aiff'), "I'm building a weather app. The problem is every weather app is slow."]);
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-i', join(project, 'talk.aiff'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(clips, 'a-talk.mov')]);
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(clips, 'b-screen.mp4')]);
    await gen(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=60', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(clips, 'c-long.mp4')]);
    await gen(['-f', 'lavfi', '-i', "aevalsrc='0.6*sin(2*PI*880*t)*exp(-40*mod(t-0.1,0.5))*gte(mod(t-0.1,0.5),0)':s=44100:d=40", join(project, 'music', 'beat.wav')]);
    await ingestClips({ project, clipsDir: clips, tools });
    await analyzeLibrary(join(project, 'music'), tools);
  }, 600_000);

  it('goes from clips to a captioned final episode with a fitted voice-over', async () => {
    const catalog = await loadCatalog(project);
    expect(catalog.clips.map((c) => c.kind)).toEqual(['talking', 'screen', 'screen']);
    const talk = catalog.clips[0];

    let ep = EpisodeSchema.parse({
      version: 2, number: 1, title: 'Weather app, part 1', output: { width: 1280, height: 720, fps: 30 },
      items: [
        { id: 'open', beat: 'cold-open', clip: 'c001', src: { in: 0, out: Math.min(talk.probe.durationSec, 5.5) }, audio: 'keep' },
        { id: 'fail', beat: 'problem', clip: 'c002', src: { in: 0, out: 4 } },
        { id: 'tl', beat: 'montage', clip: 'c003', src: { in: 0, out: 60 }, speed: 20, onBeat: true },
        { id: 'win', beat: 'truth', clip: 'c002', src: { in: 4, out: 8 }, quiet: true },
      ],
      overlays: [{ kind: 'badge', text: 'FAILED', start: 6, end: 9, tone: 'fail' }],
      music: [{ track: 'beat.wav', start: 5.5, end: 12.5 }],
    });
    ep = snapToBeats(ep, catalog, await loadLibrary(join(project, 'music')));
    await saveEpisode(project, ep);

    const rough = await renderEpisode({ project, episode: 1, mode: 'rough', tools });
    expect(Math.abs((await tools.probe(rough.outputPath)).durationSec - timelineDuration(ep))).toBeLessThanOrEqual(0.1);

    const slots = computeSlots(ep, catalog);
    expect(slots.length).toBeGreaterThanOrEqual(1);
    ep = { ...ep, slots: slots.map((s, i) => (i === 0 ? { ...s, line: LINE } : s)) };
    await saveEpisode(project, ep);
    await renderEpisode({ project, episode: 1, mode: 'guide', tools });

    const vo = join(project, 'vo.aiff');
    execFileSync('say', ['-v', 'Samantha', '-o', vo, `${LINE} [[slnc 600]] ${LINE}`]);
    const fitted = await fitRecording({ project, episode: 1, recording: vo, tools });
    expect(fitted.report.lines[0]).toMatchObject({ status: 'placed', takes: 2 });
    expect(fitted.episode.voiceover!.recording).toBe('vo.aiff');

    const final = await renderEpisode({ project, episode: 1, mode: 'final', tools });
    const p = await tools.probe(final.outputPath);
    expect(Math.abs(p.durationSec - timelineDuration(fitted.episode))).toBeLessThanOrEqual(0.1);
    expect([p.width, p.height]).toEqual([1280, 720]);
    const loud = await tools.measureLoudness(final.outputPath);
    expect(loud.integratedLufs).toBeGreaterThan(-16);
    expect(loud.integratedLufs).toBeLessThan(-12);
    const srt = (await readFile(final.srtPath!, 'utf8')).toLowerCase();
    expect(srt).toContain('weather');
    // Voice-over captions use the written line's spelling, whatever the transcriber heard ("back end", "10").
    expect(srt).toContain('backend');
    expect(srt).toContain('ten seconds,');
    passed = true;
  }, 600_000);
});
