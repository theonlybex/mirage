// SPDX-License-Identifier: MIT
// The `predict` tool: an approximate forecast of a cut, made after the render and before the video is posted. It scores
// the cut on the three steps YouTube judges a video in (`formulas { id: "youtube" }`: chosen, stayed, satisfied), names
// the weakest step and the moments behind it with one change each, and, once the format has enough posted videos, says
// where the cut sits against the project's own history. It is a forecast, not a promise: it never prints a view count,
// and it knows only what the playbook measures (it sees no picture and hears no joke). `learn` later holds each forecast
// against what happened and reports how often the band was right.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MediaTools } from '../media-tools.js';
import { coveredWarnings } from './check.js';
import { MirageError } from './errors.js';
import { formatOf, loadFormats } from './formats.js';
import { formulasDir, loadFormulas } from './formulas.js';
import { loadCatalog } from './ingest.js';
import { readJsonFile, writeJsonFile } from './json-file.js';
import { COMPARED, cutFeatures, EvidenceSchema, FEATURE_KEYS, MIN_TO_COMPARE, resultsDir, type Evidence } from './learn.js';
import { measurePlaybook, playbookFor, playbookLine, type PlaybookResult, type PlaybookRule } from './playbook.js';
import { PredictionSchema, predictionFile, STEP_TEXT, STEPS, type Band, type Prediction, type Step } from './prediction.js';
import { episodeDir, loadEpisode } from './render-episode.js';
import { seriesOf } from './series.js';
import { formatTime } from './timeline.js';
import { readVideo } from './video.js';

/**
 * The weighting, fixed and simple on purpose (YouTube publishes no weights; these say only which rule matters more
 * inside its step). A step's score is 10 × the weights of its rules that are met ÷ the weights of its rules that could
 * be measured, rounded. A rule that could not be measured is left out of the score and named. The mirage:edit skill
 * states the same table.
 * - Chosen: the idea on record 3 · the first word in time 3 · the chosen title in the format's shape 3 · opens on the
 *   picture (a short: on its hook) 2 · a thumbnail exists 2 (not for a short: a short has no click, and YouTube says a
 *   custom thumbnail doesn't help one).
 * - Stayed: no empty stretch 3 · where the answer starts 3 · the pace 2 · the words a minute 2.
 * - Satisfied: the answer is in the cut 4 · the ending 3 · the length within its limit 2.
 * The weights are not corrected by results: `learn` reports how often the forecast's band was right instead.
 */
export const WEIGHTS: Record<Step, Partial<Record<PlaybookRule | 'thumbnail', number>>> = {
  chosen: { idea: 3, firstWord: 3, title: 3, opening: 2, thumbnail: 2 },
  stayed: { empty: 3, answerPlace: 3, pace: 2, words: 2 },
  satisfied: { answer: 4, ending: 3, length: 2 },
};

/** A cut is this many more features with the better half than with the weaker (or the reverse), out of those compared, before its band leaves "around". */
const BAND_MARGIN = 1 / 3;
const MOMENTS = 5;

type Scored = Omit<PlaybookResult, 'rule'> & { rule: PlaybookRule | 'thumbnail' };
const plural = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;

/**
 * Where one number sits between the middle of the better half and the middle of the weaker half: within a third of the
 * distance of one of them (or beyond it), it sits with that half; else between.
 */
export function sitsWith(value: number, better: number, weaker: number): 'better' | 'between' | 'weaker' {
  const d = Math.abs(better - weaker);
  const towardsBetter = better > weaker ? value - weaker : weaker - value; // 0 at the weaker middle, d at the better one
  return towardsBetter >= (2 * d) / 3 ? 'better' : towardsBetter <= d / 3 ? 'weaker' : 'between';
}

/** The band of a cut from how its features sit: above when clearly more sit with the better half, below when clearly more sit with the weaker. */
export function bandOf(sits: ('better' | 'between' | 'weaker')[]): Band | null {
  if (!sits.length) return null;
  const net = (sits.filter((s) => s === 'better').length - sits.filter((s) => s === 'weaker').length) / sits.length;
  return net > BAND_MARGIN ? 'above' : net < -BAND_MARGIN ? 'below' : 'around';
}

/**
 * The three places a short goes, each with what its own formula file (`formulas { id }`) says that a cut can be held
 * against. `limitSec` is the length that platform itself states, `openingSec` the opening it names in seconds (YouTube
 * names none), `covered` whether `check`'s covered areas are that platform's (TikTok publishes no fixed margins).
 * Nothing here is a weight: no platform publishes one.
 */
export const PLATFORMS = [
  {
    id: 'youtube', name: 'YouTube Shorts', limitSec: 180, limit: 'YouTube takes Shorts up to 3:00', openingSec: null, covered: true,
    opening: 'YouTube names no number: there is no click, so the opening is the whole pitch',
    unseen: 'viewed vs swiped away, the percentage viewed and likes (YouTube Studio shows them once it is posted)',
  },
  {
    id: 'instagram', name: 'Instagram Reels', limitSec: 180, limit: "Instagram recommends reels of 3:00 or less to people who don't follow the account", openingSec: 3, covered: true,
    opening: 'Instagram says to make the first 3 seconds engaging; whether they are is not something a cut shows',
    unseen: "sends, watch time and likes, whether the sound is on or trending, a watermark of another app in the footage, and whether Instagram counts it as original (the app's insights show the numbers once it is posted)",
  },
  {
    id: 'tiktok', name: 'TikTok', limitSec: 180, limit: 'every TikTok account can post up to 3:00 (some up to 10:00)', openingSec: 3, covered: false,
    opening: 'TikTok, in its advice to advertisers, puts the point in the first 3 seconds; whether it lands is not something a cut shows',
    unseen: "whether viewers finish it (TikTok's strongest stated signal), shares, comments, the sound, the caption and hashtags, and whether TikTok counts it as original (the app's analytics show the numbers once it is posted)",
  },
] as const;

type PlatformRules = NonNullable<Prediction['platforms']>[number];

/** A short's cut against one platform's own rules: its length, its opening, its ending and the covered areas, then what a cut can't show. */
function platformRules(p: (typeof PLATFORMS)[number], cut: { lengthSec: number; firstWordSec: number | null; wordsKnown: boolean; measured: PlaybookResult[]; covered: number }): PlatformRules {
  const rules: PlatformRules['rules'] = [];
  const add = (rule: string, status: PlatformRules['rules'][number]['status'], text: string) => rules.push({ rule, status, text });
  add('length', cut.lengthSec <= p.limitSec + 1e-6 ? 'met' : 'missed', `${formatTime(cut.lengthSec)} long — ${p.limit}`);
  const opening = cut.measured.find((r) => r.rule === 'opening');
  const first = cut.measured.find((r) => r.rule === 'firstWord');
  if (opening?.status === 'missed') add('opening', 'missed', `${opening.text} — ${p.opening}`);
  else if (!cut.wordsKnown) add('opening', 'unmeasured', `the opening: not measured — the cut's words are not known (${p.opening})`);
  else if (cut.firstWordSec === null) add('opening', p.openingSec === null ? (first?.status ?? 'unmeasured') : 'missed', `opens on the picture, and no word is spoken — ${p.opening}`);
  else {
    // YouTube names no number, so its line follows the playbook's own first-word rule; the others name their seconds.
    const ok = p.openingSec === null ? first?.status !== 'missed' : cut.firstWordSec <= p.openingSec + 1e-6;
    add('opening', ok ? 'met' : 'missed', `opens on the picture, its first word at ${cut.firstWordSec.toFixed(1)} s — ${p.opening}`);
  }
  const ending = cut.measured.find((r) => r.rule === 'ending');
  if (ending) add('ending', ending.status, ending.text);
  if (!p.covered) add('covered', 'unmeasured', 'the covered areas: not measured — TikTok publishes no fixed margins (check holds the cut to the Shorts and Reels areas only)');
  else if (cut.covered) add('covered', 'missed', `${cut.covered} caption${cut.covered === 1 ? ' or overlay falls' : 's or overlays fall'} where the app's buttons cover the picture — check names each`);
  else add('covered', 'met', "no caption or overlay falls where the app's buttons cover the picture");
  add('unseen', 'unmeasured', `not measurable from a cut: ${p.unseen}`);
  return { platform: p.id, rules };
}

const CUT_TEXT: Record<Prediction['cut'], string> = {
  final: 'the final render',
  rough: 'the rough cut (there is no final render yet)',
  timeline: 'the timeline (nothing is rendered yet)',
};

/**
 * `predict { video }`: the forecast of video `n`'s cut as its episode.json is now, written to episodes/<n>/prediction.json.
 * It reads the timeline whichever render exists and says which that is; when the newest render is not as long as the
 * timeline, the timeline changed after it, and a ⚠ says so.
 */
export async function predictVideo(
  project: string,
  n: number,
  o: { tools: Pick<MediaTools, 'probe'>; formatsDir?: string; formulasDir?: string; now?: () => Date },
): Promise<string[]> {
  const dir = episodeDir(project, n);
  if (!existsSync(dir)) throw new MirageError('BAD_INPUT', `there is no video ${n}`, 'Run status to see the videos.');
  const video = await readVideo(project, n);
  const format = formatOf(video, loadFormats(o.formatsDir).formats);
  const at = (o.now?.() ?? new Date()).toISOString().slice(0, 10);
  const episode = await loadEpisode(project, n);
  const { playbook, overrides } = playbookFor(format, loadFormulas(o.formulasDir ?? formulasDir(), project).formulas);
  const series = await seriesOf(project, n);
  const measured = await measurePlaybook(project, n, { episode, catalog: await loadCatalog(project), video, format, playbook, overrides });
  const features = await cutFeatures(project, n, video, format, at);

  const cut: Prediction['cut'] = existsSync(join(dir, 'final.mp4')) ? 'final' : existsSync(join(dir, 'rough.mp4')) ? 'rough' : 'timeline';
  // Renders don't record which timeline they were made from: the render's own length is held against the layout's, as posted does.
  let changed: string | null = null;
  if (cut !== 'timeline') {
    const file = `${cut}.mp4`;
    const probe = await o.tools.probe(join(dir, file));
    const rendered = probe.videoDurationSec ?? probe.durationSec;
    if (Math.abs(rendered - features.lengthSec) > 0.1 + 0.005) {
      changed = `⚠ the timeline is ${features.lengthSec.toFixed(1)} s long and ${file} is ${rendered.toFixed(1)} s — the timeline changed after that render, so this forecast is of the timeline, not of the file: render again before posting`;
    }
  }

  const results: Scored[] = [...measured.results];
  // A short has no click to win with a picture; any other video is chosen on its title and thumbnail.
  if (!format.short) {
    results.push(features.thumbnail.exists
      ? { rule: 'thumbnail', status: 'met', text: `a thumbnail is written (episodes/${n}/thumbnail.jpg)` }
      : { rule: 'thumbnail', status: 'missed', text: 'no thumbnail yet — the click is on the title and the thumbnail', moments: [{ where: `episodes/${n}/thumbnail.jpg`, change: 'pick a frame with the thumbnail tool and write the thumbnail' }] });
  }

  const steps = STEPS.map((step) => {
    const rules = results.flatMap((r) => (WEIGHTS[step][r.rule] === undefined ? [] : [{ ...r, weight: WEIGHTS[step][r.rule]! }]));
    const counted = rules.filter((r) => r.status !== 'unmeasured');
    const total = counted.reduce((sum, r) => sum + r.weight, 0);
    const met = counted.filter((r) => r.status === 'met').reduce((sum, r) => sum + r.weight, 0);
    return { step, score: total ? Math.round((10 * met) / total) : null, rules };
  });
  // The lowest score; of two equal ones the earlier step, since nothing after it counts when it fails.
  const scored = steps.filter((s) => s.score !== null && s.score < 10);
  const weakest = scored.length ? scored.reduce((a, b) => (b.score! < a.score! ? b : a)).step : null;
  // The weakest step's misses first, then the other steps' by score; inside a step the heavier rule first.
  const order = [...steps].sort((a, b) => Number(b.step === weakest) - Number(a.step === weakest) || (a.score ?? 10) - (b.score ?? 10));
  const moments = order
    .flatMap((s) => [...s.rules].sort((a, b) => b.weight - a.weight).flatMap((r) => (r.status === 'missed' ? (r.moments ?? []).map((m) => ({ step: s.step, rule: r.rule, ...m })) : [])))
    .slice(0, MOMENTS);

  // The project's own history: the halves `learn` last worked out for this format.
  const evidence: Evidence | null = await readJsonFile(join(resultsDir(project), 'evidence.json'), EvidenceSchema, 'results/evidence.json').catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  });
  const history = evidence?.formats.find((f) => f.format === format.id);
  const postedVideos = history?.videos.length ?? 0;
  const compared: Prediction['features'] = [];
  for (const h of history?.halves?.features ?? []) {
    const value = features[h.feature];
    // A feature the halves don't differ on says nothing about which half the cut sits with.
    if (typeof value !== 'number' || h.better === null || h.weaker === null || h.better === h.weaker) continue;
    compared.push({ feature: h.feature, value, better: h.better, weaker: h.weaker, sits: sitsWith(value, h.better, h.weaker) });
  }
  const band = history?.halves ? bandOf(compared.map((c) => c.sits)) : null;

  // A short goes to three platforms: the same measured cut, held against what each one itself states.
  const platforms = format.short
    ? PLATFORMS.map((p) => platformRules(p, { lengthSec: features.lengthSec, firstWordSec: features.firstWordSec, wordsKnown: features.wordsPerMin !== null, measured: measured.results, covered: coveredWarnings(episode).length }))
    : null;

  const prediction: Prediction = {
    version: 1, video: n, at, format: format.id, cut, lengthSec: features.lengthSec,
    steps: steps.map((s) => ({ step: s.step, score: s.score, rules: s.rules.map((r) => ({ rule: r.rule, status: r.status, weight: r.weight })) })),
    weakest, moments, band, postedVideos, features: compared, ...(platforms ? { platforms } : {}),
  };
  await writeJsonFile(predictionFile(project, n), PredictionSchema, prediction, `episodes/${n}/prediction.json`);

  const yours = overrides.length ? `, with your ${format.id}-mine formula's ${overrides.join(', ')}` : '';
  const lines = [`Forecast for video ${n}${video ? ` “${video.title}”` : ''}${series ? `, series “${series.name}”` : ''} (${format.id}${yours}), from ${CUT_TEXT[cut]}: an approximate reading of the cut against the playbook — not a promise, and not a view count`];
  for (const s of steps) {
    const [name, question] = STEP_TEXT[s.step];
    lines.push(`${name} (${question}): ${s.score === null ? 'not scored — none of its rules could be measured' : `${s.score}/10`}`);
    for (const r of s.rules) lines.push(`  ${playbookLine(r)}`);
  }
  lines.push(weakest ? `Weakest step: ${STEP_TEXT[weakest][0]}` : steps.some((s) => s.score !== null) ? 'No step is weak against the playbook' : 'No step could be scored');
  if (moments.length) {
    lines.push(`Moments to fix, the weakest step's first:`);
    moments.forEach((m, i) => lines.push(`  ${i + 1}. ${m.where}: ${m.change}`));
  }
  if (history?.halves) {
    lines.push(`Against your ${postedVideos} posted ${format.id} videos (the middle of the better half and of the weaker half, from learn):`);
    for (const c of compared) {
      const [label, text] = COMPARED[c.feature as (typeof FEATURE_KEYS)[number]];
      lines.push(`  ${label}: ${text(c.value)} — ${c.sits === 'between' ? 'between the halves' : `with the ${c.sits} half`} (better half ${text(c.better)} · weaker half ${text(c.weaker)})`);
    }
    const count = (side: 'better' | 'between' | 'weaker') => compared.filter((c) => c.sits === side).length;
    lines.push(band
      ? `Band: ${band} your usual for ${format.id} (${count('better')} with the better half, ${count('weaker')} with the weaker, ${count('between')} between) — what goes with better results, not proof of cause`
      : `No band: the better and weaker halves of your posted ${format.id} videos don't differ on any number this cut has`);
  } else {
    const have = postedVideos ? `${plural(postedVideos, `posted ${format.id} video`)} ${postedVideos === 1 ? 'has' : 'have'} results` : `no posted ${format.id} video has results yet`;
    lines.push(`No band: this forecast compares against the playbook only — ${have}, and ${MIN_TO_COMPARE} are needed (${MIN_TO_COMPARE - Math.min(postedVideos, MIN_TO_COMPARE)} more)`);
  }
  if (platforms) {
    lines.push('Per platform, the same cut against what each platform itself says (formulas youtube, instagram and tiktok) — no platform publishes weights, so these are not scores:');
    for (const p of platforms) {
      lines.push(`  ${PLATFORMS.find((x) => x.id === p.platform)!.name}:`);
      for (const r of p.rules) lines.push(`    ${playbookLine(r)}`);
    }
  }
  if (changed) lines.push(changed);
  lines.push(`wrote episodes/${n}/prediction.json`);
  lines.push(moments.length ? 'Fix the weakest moments, run predict again, then post.' : 'Nothing to fix against the playbook.');
  return lines;
}
