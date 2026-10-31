import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { TranscriptSchema, type Episode, type Transcript } from '@wordedits/shared';
import type { MediaTools } from '../media-tools.js';
import { readJsonFile, writeJsonFile } from '../project-store.js';
import { MirageError } from './errors.js';
import { loadCatalog, sha256File } from './ingest.js';
import { episodeDir, loadEpisode, saveEpisode } from './render-episode.js';
import { cutChanged, cutChangedError, fitVoiceover, missingSlots, type FitReport } from './voiceover.js';

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
  const ep = await loadEpisode(project, n);
  // Fail before the (slow) transcription when the fit would refuse anyway.
  if (!ep.slots.some((s) => s.line.trim())) {
    throw new MirageError('NOTHING_MATCHED', 'No narration lines are written yet', `Run pnpm mirage slots <project> ${n} and write the lines first.`);
  }
  let only: string[] | undefined;
  if (o.add) {
    if (cutChanged(ep)) throw cutChangedError();
    const written = new Set(ep.slots.filter((s) => s.line.trim()).map((s) => s.id));
    for (const id of o.slots ?? []) if (!written.has(id)) throw new MirageError('BAD_ITEM', `slot ${id} has no written line`, 'List slots that have a line (see pnpm mirage slots).');
    only = o.slots?.length ? o.slots : missingSlots(ep);
    if (only.length === 0) {
      throw new MirageError('NOTHING_MATCHED', 'Every written line already has a voice-over', 'Pass --slots n2,n3 to re-record particular lines, or run vo without --add to replace the whole voice-over.');
    }
  }

  const dir = episodeDir(project, n);
  const file = voTranscriptFile(await sha256File(rec));
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
      await o.tools.extractWav(rec, wav);
      transcript = await o.tools.transcribe(wav);
    } finally {
      await rm(wav, { force: true });
    }
  }

  const rel = relative(project, rec);
  const recording = rel.startsWith('..') || isAbsolute(rel) ? rec : rel;
  const fit = fitVoiceover({ episode: ep, catalog: await loadCatalog(project), recording, transcript, only });
  const vo = fit.episode.voiceover!;
  const episode: Episode = { ...fit.episode, voiceover: { ...vo, transcripts: { ...vo.transcripts, [recording]: file } } };
  // Only after a successful fit: a failed fit must never leave a new transcript beside the old lines.
  if (!reused) await writeJsonFile(join(dir, file), TranscriptSchema, transcript, `episodes/${n}/${file}`);
  await saveEpisode(project, episode, n);
  return { episode, report: fit.report, reused };
}
