// SPDX-License-Identifier: MIT
// `episodes/<n>/prediction.json`: the forecast `predict` made of a cut, kept so `learn` can hold it against what
// happened once the video is posted. This file is only the record and how it is read back; `predict` (predict.ts)
// makes it, and `learn` (learn.ts) reads it.
import { join } from 'node:path';
import { strictObject } from '@wordedits/shared';
import { z } from 'zod';
import { readJsonFile } from './json-file.js';
import { episodeDir } from './render-episode.js';

/** The three steps YouTube judges a video in (`formulas { id: "youtube" }`), as `predict` scores them. */
export const STEPS = ['chosen', 'stayed', 'satisfied'] as const;
export type Step = (typeof STEPS)[number];
/** Each step as the forecast names it, and the question it answers. */
export const STEP_TEXT: Record<Step, [name: string, question: string]> = {
  chosen: ['Chosen', 'will they choose to watch'],
  stayed: ['Stayed', 'will they keep watching'],
  satisfied: ['Satisfied', 'will they be glad they watched'],
};

/** Where a cut sits against the project's own posted videos of its format. */
export const BANDS = ['below', 'around', 'above'] as const;
export type Band = (typeof BANDS)[number];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PredictionSchema = strictObject({
  version: z.literal(1),
  video: z.number().int().positive(),
  /** The day the forecast was made (YYYY-MM-DD). */
  at: day,
  format: z.string().min(1),
  /** What was there to read: the final render, only a rough cut, or a timeline nothing was rendered from yet. The numbers are the timeline's either way. */
  cut: z.enum(['final', 'rough', 'timeline']),
  lengthSec: z.number().positive(),
  steps: z.array(strictObject({
    step: z.enum(STEPS),
    /** Out of 10; null when no rule of the step could be measured. */
    score: z.number().int().min(0).max(10).nullable(),
    /** Every rule of the step, with the weight it has in the score; one that was not measured is left out of the score. */
    rules: z.array(strictObject({ rule: z.string().min(1), status: z.enum(['met', 'missed', 'unmeasured']), weight: z.number().positive() })),
  })),
  /** The step with the lowest score; null when every measured step has 10, or none could be measured. */
  weakest: z.enum(STEPS).nullable(),
  /** Up to five moments behind the scores, the weakest step's first: where, and the one change to make. */
  moments: z.array(strictObject({ step: z.enum(STEPS), rule: z.string().min(1), where: z.string().min(1), change: z.string().min(1) })).max(5),
  /** Against the format's posted videos; null when too few are posted to compare (the forecast is against the playbook only). */
  band: z.enum(BANDS).nullable(),
  /** How many posted videos of the format had results when the forecast was made. */
  postedVideos: z.number().int().min(0),
  /** Each of the cut's numbers held against the middle of the better and of the weaker half of the posted videos. */
  features: z.array(strictObject({ feature: z.string().min(1), value: z.number(), better: z.number(), weaker: z.number(), sits: z.enum(['better', 'between', 'weaker']) })),
  /**
   * Only for a short: the cut held against the rules each platform itself states (its formula file), as far as a cut
   * shows them. No platform publishes weights, so there is no score per platform: each rule is met, missed or not measured.
   */
  platforms: z.array(strictObject({
    platform: z.enum(['youtube', 'instagram', 'tiktok']),
    rules: z.array(strictObject({ rule: z.string().min(1), status: z.enum(['met', 'missed', 'unmeasured']), text: z.string().min(1) })),
  })).optional(),
});
export type Prediction = z.infer<typeof PredictionSchema>;

export const predictionFile = (project: string, n: number) => join(episodeDir(project, n), 'prediction.json');

/** The forecast kept for video `n`; null when `predict` never ran for it. A file that was edited and broke throws, naming the key. */
export async function readPrediction(project: string, n: number): Promise<Prediction | null> {
  try {
    return await readJsonFile(predictionFile(project, n), PredictionSchema, `episodes/${n}/prediction.json`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** The scores of a forecast in one phrase: `chosen 8/10 · stayed 6/10 · satisfied not scored`. */
export function scoresText(p: Prediction): string {
  return p.steps.map((s) => `${s.step} ${s.score === null ? 'not scored' : `${s.score}/10`}`).join(' · ');
}

/** What a forecast said, as `learn` repeats it: the band when it gave one, else that it was against the playbook only; then the scores. */
export function forecastText(p: Prediction): string {
  const scores = `${scoresText(p)}${p.weakest ? `; weakest: ${p.weakest}` : ''}`;
  return p.band ? `predicted ${p.band} your usual for ${p.format} (${scores})` : `predicted against the playbook only (${scores})`;
}
