import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { TranscriptSchema, type Episode, type Transcript, type VoiceLine } from '@wordedits/shared';
import type { MediaTools } from '../media-tools.js';
import { readJsonFile, writeJsonFile } from '../project-store.js';
import { MirageError } from './errors.js';
import { loadCatalog, sha256File } from './ingest.js';
import { episodeDir, loadEpisode, lockEpisode, saveEpisode } from './render-episode.js';
import { slotsStale, slotsStaleError } from './slots.js';
import { cutChanged, cutChangedError, fitVoiceover, fittedRecordingSha, hasWords, missingSlots, type FitReport } from './voiceover.js';
import { refineTranscript } from './word-timing.js';

/** A recording's transcript file in the episode folder, named by the recording's content so a re-fit can reuse it. */
export const voTranscriptFile = (sha256: string) => `voiceover.${sha256.slice(0, 16)}.transcript.json`;

/**
 * The `vo` command: transcribes `recording` (or reuses the transcript of the same recording), fits it, then writes the
 * transcript and the episode. With `add`, fits only the missing lines (or `slots`) and keeps the others.
 */
export async function fitRecording(o: {
  project: string;
  episode: number;
  recording: string;
  tools: MediaTools;
  add?: boolean;
  slots?: string[];
  onStep?: (m: string) => void;
}): Promise<{ episode: Episode; report: FitReport; reused: boolean }> {
  const project = resolve(o.project);
  const n = o.episode;
  const rec = resolve(o.recording);
  if (!existsSync(rec)) throw new MirageError('BAD_ITEM', `${rec} does not exist`, 'Pass the path of your voice-over recording.');
  if (statSync(rec).isDirectory()) throw new MirageError('BAD_INPUT', `${rec} is a folder, not a recording`, 'Pass the path of your voice-over recording file.');
  const lock = await lockEpisode(project, n, 'vo');
  try {
    return await fitLocked(o, project, rec);
  } finally {
    await lock.release();
  }
}

async function fitLocked(o: Parameters<typeof fitRecording>[0], project: string, rec: string): Promise<{ episode: Episode; report: FitReport; reused: boolean }> {
  const n = o.episode;
  const ep = await loadEpisode(project, n);
  // Fail before the (slow) transcription when the fit would refuse anyway.
  if (!ep.slots.some((s) => hasWords(s.line))) {
    throw new MirageError('NOTHING_MATCHED', 'No narration lines are written yet', `Run pnpm mirage slots <project> ${n} and write the lines first.`);
  }
  let only: string[] | undefined;
  if (o.add && cutChanged(ep)) throw cutChangedError();
  if (slotsStale(ep)) throw slotsStaleError(n);
  if (o.add) {
    const written = new Set(ep.slots.filter((s) => hasWords(s.line)).map((s) => s.id));
    for (const id of o.slots ?? []) if (!written.has(id)) throw new MirageError('BAD_ITEM', `slot ${id} has no written line`, 'List slots that have a line (see pnpm mirage slots).');
    only = o.slots?.length ? o.slots : missingSlots(ep);
    if (only.length === 0) {
      throw new MirageError('NOTHING_MATCHED', 'Every written line already has a voice-over', 'Pass --slots n2,n3 to re-record particular lines, or run vo without --add to replace the whole voice-over.');
    }
  }

  const dir = episodeDir(project, n);
  const sha = await sha256File(rec);
  const rel = relative(project, rec);
  const recording = rel.startsWith('..') || isAbsolute(rel) ? rec : rel;
  // Lines kept by --add play their own recording: refuse when it is no longer the audio they were cut from.
  if (only) await checkKeptRecordings(project, ep, (l) => !only!.includes(l.slot), recording, sha);
  const file = voTranscriptFile(sha);
  let transcript: Transcript;
  const reused = existsSync(join(dir, file));
  if (reused) {
    o.onStep?.('Reusing the transcript of this recording');
    transcript = await readJsonFile(join(dir, file), TranscriptSchema, `episodes/${n}/${file}`);
  } else {
    o.onStep?.('Transcribing your voice-over…');
    await mkdir(dir, { recursive: true });
    const wav = join(dir, `.vo-${randomUUID()}.wav`);
    try {
      await o.tools.extractWav(rec, wav).catch(async (e: unknown) => {
        // ffmpeg's own words for a video without sound ("does not contain any stream") help nobody.
        const probe = await o.tools.probe(rec).catch(() => null);
        if (probe && !probe.hasAudio) throw new MirageError('BAD_INPUT', `${rec} has no audio track`, 'Pass the recording of your voice-over: a sound file, or a video with sound.');
        throw e;
      });
      transcript = await refineTranscript(await o.tools.transcribe(wav), wav);
    } finally {
      await rm(wav, { force: true });
    }
    // Saved straight away, under the recording's content: a fit that fails (or is refused below) re-runs without
    // transcribing again, and no other recording's lines point at this file.
    await writeJsonFile(join(dir, file), TranscriptSchema, transcript, `episodes/${n}/${file}`);
  }

  const fit = fitVoiceover({ episode: ep, catalog: await loadCatalog(project), recording, transcript, only });
  const vo = fit.episode.voiceover!;
  const placed = new Set(fit.report.lines.filter((l) => l.status === 'placed').map((l) => l.slot));
  if (only) await checkKeptRecordings(project, fit.episode, (l) => !placed.has(l.slot), recording, sha);
  const shas = { ...(only ? ep.voiceover?.recordingSha256 : {}), [recording]: sha };
  const episode: Episode = { ...fit.episode, voiceover: { ...vo, transcripts: { ...vo.transcripts, [recording]: file }, recordingSha256: shas } };
  // Transcribing takes minutes: never save the fit over edits made to episode.json meanwhile.
  if (JSON.stringify(await loadEpisode(project, n)) !== JSON.stringify(ep)) {
    throw new MirageError('BUSY', 'episode.json changed while vo was running — run vo again', 'Your edits are kept, and the transcript is saved, so the re-run is quick.');
  }
  await saveEpisode(project, episode, n);
  return { episode, report: fit.report, reused };
}

/**
 * Refuses when a line that `kept` selects was cut from a recording whose content changed since the fit (for `recording`,
 * the file being fitted now, `sha` is its current hash). A missing recording is left to render to report.
 */
async function checkKeptRecordings(project: string, ep: Episode, kept: (l: VoiceLine) => boolean, recording: string, sha: string): Promise<void> {
  const vo = ep.voiceover;
  if (!vo) return;
  const byRecording = new Map<string, string[]>();
  for (const l of vo.lines.filter(kept)) {
    const r = l.recording ?? vo.recording;
    byRecording.set(r, [...(byRecording.get(r) ?? []), l.slot]);
  }
  for (const [r, slots] of byRecording) {
    const was = fittedRecordingSha(vo, r);
    const abs = resolve(project, r);
    if (!was || (r !== recording && !existsSync(abs))) continue;
    const now = r === recording ? sha : await sha256File(abs);
    if (now.startsWith(was)) continue;
    const them = slots.join(', ');
    if (r === recording) {
      throw new MirageError(
        'BAD_ITEM',
        `${r} is not the recording ${them} were cut from: it changed since vo fitted them`,
        'Save each new take under a new name (like vo-2.m4a) and put the earlier recording back, then run vo --add again. If the earlier recording is gone, run vo without --add on a recording of every line.',
      );
    }
    throw new MirageError('BAD_ITEM', `${r} changed since vo fitted ${them} from it`, `Put back the recording you fitted, or re-record those lines: vo <project> ${ep.number} <new recording> --add --slots ${slots.join(',')}`);
  }
}
