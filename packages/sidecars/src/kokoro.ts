// SPDX-License-Identifier: MIT
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { execa } from 'execa';
import { SidecarError } from './errors.js';

/**
 * Kokoro text-to-speech (https://huggingface.co/hexgrad/Kokoro-82M) through kokoro-js, which runs the ONNX model with
 * onnxruntime-node on macOS, Windows and Linux. Its native binaries can't go into the plugin's bundle, so the packages are
 * installed with npm on first use into Mirage's data folder, and the model is downloaded into the same folder.
 */
export const KOKORO = 'kokoro';
export const KOKORO_PACKAGES = { 'kokoro-js': '1.2.1', '@huggingface/transformers': '3.8.1' } as const;
export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
/** 8-bit quantized: 92 MB, against 326 MB for fp32. */
export const KOKORO_DTYPE = 'q8';
const MODEL_FILE = 'onnx/model_quantized.onnx';
/** What a first use downloads, as measured: npm packages, then the model. */
export const KOKORO_DOWNLOAD = { packagesMb: 170, modelMb: 92 };
export const KOKORO_SAMPLE_RATE = 24000;
export const DEFAULT_VOICE = 'af_heart';

/** The English voices kokoro-js 1.2.1 has (a: American, b: British; f: female, m: male). */
export const KOKORO_VOICES = [
  'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  'bf_emma', 'bf_isabella', 'bf_alice', 'bf_lily', 'bm_george', 'bm_lewis', 'bm_daniel', 'bm_fable',
] as const;

/** Where Kokoro lives: MIRAGE_KOKORO_DIR, else <plugin data>/kokoro, else ~/.cache/mirage/kokoro (the CLI outside the plugin). */
export function kokoroDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MIRAGE_KOKORO_DIR) return env.MIRAGE_KOKORO_DIR;
  if (env.MIRAGE_PLUGIN_DATA) return join(env.MIRAGE_PLUGIN_DATA, 'kokoro');
  return join(homedir(), '.cache', 'mirage', 'kokoro');
}

const modelsDir = (dir: string) => join(dir, 'models');
const modelPath = (dir: string) => join(modelsDir(dir), ...KOKORO_MODEL.split('/'), ...MODEL_FILE.split('/'));
const packagesInstalled = (dir: string) => existsSync(join(dir, 'node_modules', 'kokoro-js', 'package.json')) && existsSync(join(dir, 'node_modules', 'onnxruntime-node', 'package.json'));

/**
 * The npm to install with: the one that ships next to this Node (bin/../lib/node_modules/npm on macOS and Linux,
 * node_modules/npm on Windows), run with this Node, so it works whatever PATH the desktop app has; else npm on PATH.
 */
export function locateNpm(execPath = process.execPath, path = process.env.PATH ?? ''): { file: string; args: string[] } | null {
  const bin = dirname(execPath);
  for (const cli of [join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (existsSync(cli)) return { file: execPath, args: [cli] };
  }
  const names = process.platform === 'win32' ? ['npm.cmd'] : ['npm'];
  for (const d of path.split(delimiter).filter(Boolean)) {
    for (const n of names) if (existsSync(join(d, n))) return { file: join(d, n), args: [] };
  }
  return null;
}

export type TtsState = { state: 'ok' } | { state: 'fetch'; text: string } | { state: 'missing'; text: string };

const sizeText = (dir: string) => {
  const parts = [...(packagesInstalled(dir) ? [] : [`the Kokoro packages (about ${KOKORO_DOWNLOAD.packagesMb} MB)`]), ...(existsSync(modelPath(dir)) ? [] : [`${packagesInstalled(dir) ? 'the Kokoro' : 'its'} voice model (${KOKORO_DOWNLOAD.modelMb} MB)`])];
  return parts.join(' and ');
};

/**
 * Whether AI narration is ready: `ok` when Kokoro and its model are here, `fetch` when speak will download what is missing
 * the first time it runs, `missing` when it can't (no npm to install with).
 */
export function ttsSetup(dir = kokoroDir()): TtsState {
  if (packagesInstalled(dir) && existsSync(modelPath(dir))) return { state: 'ok' };
  if (!packagesInstalled(dir) && !locateNpm()) {
    return { state: 'missing', text: 'npm was not found, so Kokoro (the AI narration voice) can\'t be installed. Install Node.js 22 or later with npm (nodejs.org), then run speak again.' };
  }
  return { state: 'fetch', text: `not downloaded yet — speak downloads ${sizeText(dir)} into ${dir} the first time it runs` };
}

/** Removes the onnxruntime binaries of other platforms (about 170 MB): only this machine's are ever loaded. */
function pruneOtherPlatforms(dir: string): Promise<unknown> {
  const bin = join(dir, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3');
  const removals: Promise<void>[] = [];
  for (const os of existsSync(bin) ? readdirSync(bin) : []) {
    if (os !== process.platform) {
      removals.push(rm(join(bin, os), { recursive: true, force: true }));
      continue;
    }
    for (const arch of readdirSync(join(bin, os))) if (arch !== process.arch) removals.push(rm(join(bin, os, arch), { recursive: true, force: true }));
  }
  return Promise.all(removals);
}

/** Installs the Kokoro packages into `dir` with npm (no install scripts: onnxruntime-node and sharp ship their CPU binaries). */
export async function installKokoro(dir: string, o: { signal?: AbortSignal } = {}): Promise<void> {
  const npm = locateNpm();
  if (!npm) throw new SidecarError(KOKORO, 'NOT_FOUND', 'npm was not found, so Kokoro can\'t be installed', 'Install Node.js 22 or later with npm (nodejs.org), then run speak again.');
  await mkdir(dir, { recursive: true });
  const pkg = { name: 'mirage-kokoro', private: true, description: 'Kokoro text-to-speech for Mirage, installed on first use.', dependencies: KOKORO_PACKAGES, overrides: { '@huggingface/transformers': KOKORO_PACKAGES['@huggingface/transformers'] } };
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  try {
    // npm.cmd (Windows, when npm is only found on PATH) only starts through a shell.
    await execa(npm.file, [...npm.args, 'install', '--no-audit', '--no-fund', '--ignore-scripts', '--omit=dev', '--loglevel=error'], { cwd: dir, cancelSignal: o.signal, timeout: 20 * 60_000, stdin: 'ignore', shell: npm.file.endsWith('.cmd') });
  } catch (e) {
    if (o.signal?.aborted) throw new SidecarError(KOKORO, 'CANCELLED', 'Installing Kokoro was stopped', '');
    const err = e as { stderr?: string; shortMessage?: string; timedOut?: boolean };
    const tail = (err.stderr ?? '').trim().split('\n').slice(-3).join(' ');
    throw new SidecarError(KOKORO, err.timedOut ? 'TIMEOUT' : 'EXIT', `Installing Kokoro with npm failed${tail ? `: ${tail}` : ''}`, 'Check the internet connection and run speak again.', err.stderr ?? '');
  }
  await pruneOtherPlatforms(dir);
}

/** The part of kokoro-js Mirage uses. */
interface KokoroModule {
  KokoroTTS: { from_pretrained(id: string, o: { dtype: string; device: string; progress_callback?: (p: { status: string; file?: string }) => void }): Promise<KokoroModel> };
}
interface KokoroModel {
  generate(text: string, o: { voice: string; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

/** Text to speech: `prepare` gets the voice ready (installs and downloads on first use), `speak` synthesizes one sentence to mono samples. */
export interface Speaker {
  prepare(o: { onStep?: (m: string) => void; signal?: AbortSignal }): Promise<void>;
  speak(text: string, o: { voice: string; speed: number; signal?: AbortSignal }): Promise<{ samples: Float32Array; sampleRate: number }>;
}

/**
 * stdout carries the engine's MCP protocol: while Kokoro runs, console.log and console.info (the phonemizer's WebAssembly
 * prints with them) go to stderr.
 */
async function quietStdout<T>(work: () => Promise<T>): Promise<T> {
  const { log, info } = console;
  console.log = console.info = (...a: unknown[]) => console.error(...a);
  try {
    return await work();
  } finally {
    console.log = log;
    console.info = info;
  }
}

/** Loaded models by folder: loading takes seconds, so it happens once per engine. */
const loaded = new Map<string, Promise<KokoroModel>>();

async function loadModel(dir: string, o: { onStep?: (m: string) => void; signal?: AbortSignal }): Promise<KokoroModel> {
  if (!packagesInstalled(dir)) {
    o.onStep?.(`Installing Kokoro text-to-speech, once: about ${KOKORO_DOWNLOAD.packagesMb} MB of packages into ${dir}`);
    await installKokoro(dir, { signal: o.signal });
  }
  if (!existsSync(modelPath(dir))) o.onStep?.(`Downloading the Kokoro voice model, once: ${KOKORO_DOWNLOAD.modelMb} MB`);
  try {
    const require = createRequire(join(dir, 'package.json'));
    // Both through require from the same folder, so kokoro-js uses this copy of transformers and the cache folder set here.
    const transformers = require('@huggingface/transformers') as { env: { cacheDir: string } };
    transformers.env.cacheDir = modelsDir(dir);
    const { KokoroTTS } = require('kokoro-js') as KokoroModule;
    return await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: KOKORO_DTYPE, device: 'cpu' });
  } catch (e) {
    throw new SidecarError(KOKORO, 'EXIT', `Kokoro could not be loaded: ${e instanceof Error ? e.message : String(e)}`, `Check the internet connection and run speak again. If it keeps failing, delete ${dir} and run speak again.`);
  }
}

/** The Kokoro speaker whose packages and model live in `dir`. */
export function kokoroSpeaker(dir = kokoroDir()): Speaker {
  const model = (o: { onStep?: (m: string) => void; signal?: AbortSignal } = {}) => {
    let m = loaded.get(dir);
    if (!m) {
      m = quietStdout(() => loadModel(dir, o));
      loaded.set(dir, m);
      // A failed install or download is tried again by the next call.
      m.catch(() => loaded.delete(dir));
    }
    return m;
  };
  return {
    prepare: async (o) => {
      await model(o);
    },
    speak: async (text, s) => {
      const tts = await model({ signal: s.signal });
      s.signal?.throwIfAborted();
      const audio = await quietStdout(() => tts.generate(text, { voice: s.voice, speed: s.speed }));
      return { samples: audio.audio, sampleRate: audio.sampling_rate };
    },
  };
}
