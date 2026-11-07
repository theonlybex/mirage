// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MediaTools } from '../media-tools.js';
import { MirageError } from './errors.js';

/** The built-in sound effects, made with FFmpeg's own sources (nothing downloaded). */
export const BUILTIN_SFX: readonly string[] = ['whoosh', 'swoosh-out', 'hit', 'riser', 'pop', 'ding', 'click'];
/** Bumped whenever a recipe changes, so older cached files are never used: they live in `v<version>/`. */
export const SFX_RECIPE_VERSION = 1;

const SR = 48000;
/** Every sound's loudest sample sits here, under the -1 dBFS ceiling. */
const PEAK_DB = -1.5;
/** Silence generated before and after each recipe, so the loudest sample can be moved onto the peak time. */
const PAD_SEC = 0.1;

interface Recipe {
  durationSec: number;
  /** The moment an sfx entry's `at` refers to: the loudest sample is put exactly here. */
  peakSec: number;
  fadeOutSec: number;
  /** A filtergraph making `durationSec` of mono 48 kHz audio, labelled [s]. */
  graph: string;
}

const noise = (color: string, seed: number, d: number) => `anoisesrc=c=${color}:seed=${seed}:r=${SR}:a=0.5:d=${d}`;
const curve = (expr: string, d: number) => `aevalsrc='${expr}':s=${SR}:c=mono:d=${d}`;
/** A band: `times` 2-pole highpasses at `lo` Hz, then `times` 2-pole lowpasses at `hi` Hz. */
const band = (lo: number, hi: number, times = 2) => [...Array(times).fill(`highpass=f=${lo}`), ...Array(times).fill(`lowpass=f=${hi}`)].join(',');

const RECIPES: Record<string, Recipe> = {
  // Pink noise in a 300 Hz–2.4 kHz band, swelling to a point at 0.3 s and falling away (a cubed triangle).
  whoosh: { durationSec: 0.6, peakSec: 0.3, fadeOutSec: 0.03, graph: `${noise('pink', 11, 0.6)},${band(300, 2400)}[n];${curve('pow(max(0,1-abs(t-0.3)/0.3),3)', 0.6)}[e];[n][e]amultiply[s]` },
  // Pink noise in a 500 Hz–4.5 kHz band: a 60 ms rise (t⁴), then a 90 ms exponential tail.
  'swoosh-out': { durationSec: 0.5, peakSec: 0.06, fadeOutSec: 0.05, graph: `${noise('pink', 23, 0.5)},${band(500, 4500)}[n];${curve('if(lt(t,0.06),pow(t/0.06,4),exp(-(t-0.06)/0.09))', 0.5)}[e];[n][e]amultiply[s]` },
  // A sine falling from 90 to 50 Hz (2 ms rise, 160 ms decay) plus a thump of brown noise in 60–250 Hz decaying in 20 ms.
  hit: {
    durationSec: 0.8, peakSec: 0.01, fadeOutSec: 0.05,
    graph: `${curve('sin(2*PI*(50*t+40*0.07*(1-exp(-t/0.07))))*if(lt(t,0.002),pow(sin(PI/2*t/0.002),2),exp(-(t-0.002)/0.16))', 0.8)}[b];${noise('brown', 31, 0.8)},${band(60, 250)}[n];${curve('0.5*if(lt(t,0.003),t/0.003,exp(-(t-0.003)/0.02))', 0.8)}[e];[n][e]amultiply[t];[b][t]amix=inputs=2:normalize=0[s]`,
  },
  // Pink noise (400 Hz–6 kHz) and a sine at about the same level sweeping from 300 Hz to 1.5 kHz, both growing as t³ to 2 s.
  riser: {
    durationSec: 2.02, peakSec: 2.0, fadeOutSec: 0.019,
    graph: `${noise('pink', 47, 2.02)},${band(400, 6000)}[n];${curve('min(1,pow(t/2,3))', 2.02)}[e];[n][e]amultiply[w];${curve(`0.07*min(1,pow(t/2,3))*sin(2*PI*300*2/log(5)*(pow(5,t/2)-1))`, 2.02)}[v];[w][v]amix=inputs=2:normalize=0[s]`,
  },
  // A sine dropping from 700 to 250 Hz in about 15 ms, a 5 ms rise and a 22 ms decay.
  pop: { durationSec: 0.12, peakSec: 0.005, fadeOutSec: 0.02, graph: `${curve('sin(2*PI*(250*t+450*0.015*(1-exp(-t/0.015))))*if(lt(t,0.005),pow(sin(PI/2*t/0.005),2),exp(-(t-0.005)/0.022))', 0.12)}[s]` },
  // A bell: 1046.5, 2093 and 3136 Hz at 1, 1/2 and 1/4, decaying in 450, 300 and 180 ms, after a 3 ms strike.
  ding: { durationSec: 1.5, peakSec: 0.005, fadeOutSec: 0.3, graph: `${curve('pow(sin(PI/2*min(1,t/0.003)),2)*(sin(2*PI*1046.5*t)*exp(-t/0.45)+0.5*sin(2*PI*2093*t)*exp(-t/0.3)+0.25*sin(2*PI*3136*t)*exp(-t/0.18))', 1.5)}[s]` },
  // White noise in a 1.5–5 kHz band, a 6 ms burst: up from 1 ms to 2 ms, then a 1.2 ms exponential decay.
  click: { durationSec: 0.03, peakSec: 0.002, fadeOutSec: 0.005, graph: `${noise('white', 59, 0.03)},${band(1500, 5000)}[n];${curve('if(lt(t,0.001),0,if(lt(t,0.002),(t-0.001)/0.001,exp(-(t-0.002)/0.0012)))', 0.03)}[e];[n][e]amultiply[s]` },
};

/** Where the built-ins are cached: MIRAGE_SFX_DIR, else <plugin data>/sfx, else ~/.cache/mirage/sfx (the CLI outside the plugin). */
export function sfxDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MIRAGE_SFX_DIR) return env.MIRAGE_SFX_DIR;
  if (env.MIRAGE_PLUGIN_DATA) return join(env.MIRAGE_PLUGIN_DATA, 'sfx');
  return join(homedir(), '.cache', 'mirage', 'sfx');
}

/**
 * A built-in sound as a 48 kHz stereo WAV at `<dir>/v<recipe version>/<name>.wav` (`dir` defaults to sfxDir()), made the
 * first time it's asked for. Its loudest sample, at -1.5 dBFS, is at `peakSec` (within 3 ms). Each run writes to its own
 * temporary name and renames it into place, so a killed run leaves nothing that counts and two runs at once both end with a
 * whole file.
 */
export async function builtinSfx(name: string, tools: MediaTools, o: { dir?: string; signal?: AbortSignal } = {}): Promise<{ file: string; peakSec: number; durationSec: number }> {
  const recipe = Object.hasOwn(RECIPES, name) ? RECIPES[name] : undefined;
  if (!recipe) throw new MirageError('BAD_INPUT', `"${name}" isn't a built-in sound`, `Built-in sounds: ${BUILTIN_SFX.join(', ')}.`);
  const result = { peakSec: recipe.peakSec, durationSec: recipe.durationSec };
  const folder = join(o.dir ?? sfxDir(), `v${SFX_RECIPE_VERSION}`);
  const file = join(folder, `${name}.wav`);
  if (existsSync(file)) return { file, ...result };

  await mkdir(folder, { recursive: true });
  const id = randomUUID();
  const raw = join(folder, `${name}.raw-${id}`);
  const part = join(folder, `${name}.wav.tmp-${id}`);
  try {
    const pad = Math.round(PAD_SEC * SR);
    const len = Math.round(recipe.durationSec * SR);
    const total = len + 2 * pad;
    // Pass 1: the recipe, highpassed at 40 Hz and lowpassed at 12 kHz, with silence either side, as raw mono floats.
    const graph = `${recipe.graph};[s]apad=pad_len=${pad},${band(40, 12000)},adelay=delays=${pad}S:all=1,apad=whole_len=${total},atrim=end_sample=${total}[out]`;
    await tools.runFfmpeg(['-filter_complex', graph, '-map', '[out]', '-ac', '1', '-ar', String(SR), '-c:a', 'pcm_f32le', '-f', 'f32le', raw], { signal: o.signal });
    const buf = await readFile(raw);
    const x = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    let loudest = 0;
    let at = 0;
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]!);
      if (a > loudest) [loudest, at] = [a, i];
    }
    if (!(loudest > 0)) throw new Error(`the ${name} recipe made silence`);
    // Pass 2: the window that puts the loudest sample on the peak time, scaled to PEAK_DB, in stereo. It never cuts into the
    // sound's own rise: it starts at least 1 ms before the sound first comes within 46 dB of its peak, so the first millisecond
    // stays over 40 dB under. A sound whose loudest sample comes later than that allows keeps it a little late (the hit's boom
    // builds over a cycle: 2.4 ms). It ends with the recipe's fade out, which starts after the peak, then 1 ms of silence.
    const peakAt = Math.round(recipe.peakSec * SR);
    const ms = SR / 1000;
    let onset = 0;
    while (Math.abs(x[onset]!) < loudest / 200) onset++;
    const start = Math.min(Math.max(Math.min(at - peakAt, onset - ms), 0), total - len);
    const fadeOut = Math.round(recipe.fadeOutSec * SR);
    const gain = 10 ** (PEAK_DB / 20) / loudest;
    const af = [
      `atrim=start_sample=${start}:end_sample=${start + len}`, 'asetpts=PTS-STARTPTS', `volume=${gain}:precision=double`,
      `afade=t=out:ss=${len - ms - fadeOut}:ns=${fadeOut}`, 'pan=stereo|c0=c0|c1=c0',
    ].join(',');
    await tools.runFfmpeg(['-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', raw, '-af', af, '-c:a', 'pcm_s16le', '-f', 'wav', part], { signal: o.signal });
    try {
      await rename(part, file);
    } catch (e) {
      // Another run got there first and the file is in use (Windows refuses to replace an open file): theirs is the same sound.
      if (!existsSync(file)) throw e;
    }
    return { file, ...result };
  } finally {
    await Promise.all([rm(raw, { force: true }), rm(part, { force: true })]);
  }
}
