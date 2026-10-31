# Fast-Track Auto-Edit CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm edit take.mp4 --script script.md` turns a raw talking-head take into a YouTube-ready MP4: retakes, restart cues, ums and long pauses cut, captions burned in plus an `.srt`, optional music ducked under the voice, with a report of every cut.

**Architecture:** A Swift helper (Apple SpeechAnalyzer) transcribes with word timings. Pure functions in `packages/core/src/autoedit/` split sentences, detect retakes, plan cuts into the existing EDL format, and build captions on the output timeline. Rendering moves from one giant ffmpeg command to chunks of ≤30 segments rendered to near-lossless intermediates, then one final pass for captions, audio chain, music and encode. A thin CLI wires it together.

**Tech Stack:** Node 24, TypeScript 7, zod 4, vitest 5, execa 9, ffmpeg-static 6.0 (libass, sidechaincompress, amix, alimiter present), Swift 6 / Speech framework on macOS 26.5.

**Spec:** `docs/superpowers/specs/2026-09-28-wordedits-design.md` — §7 (format profile numbers), §9 (errors), §10 (testing), and **§13 (this deliverable's scope and decisions)**.

## Global Constraints

- Node `>=22`; ESM only; `strict: true`. Every JSON file is validated with zod on read and write.
- `packages/core` must not statically import `@wordedits/sidecars` or `electron`; it reaches sidecars only through `MediaTools` (dynamic import inside `realMediaTools()` is the one allowed reference).
- Sidecars are spawned with argument arrays, never shell strings; every call has a timeout and captured stderr; failures are structured errors with `code` and `hint`.
- Fillers removed: exactly `um umm uh uhh uhm er erm ah ahh hmm mm mhm` (normalised, case-insensitive). Nothing else is treated as a filler.
- Pace presets (spec §7, §13): `natural` maxPause 0.5 s / keepPause 0.4 s; `fast` 0.35 / 0.25; `extra-fast` 0.25 / 0.15. keepPause is the *total* pause left when a pause is cut, split evenly before and after.
- Captions: one line, at most `edl.captions.maxChars` (38) characters, bold sans-serif, white on a 70 % black box, bottom-centre; shown 0.15 s before the first word; minimum 0.8 s on screen; never overlapping.
- Audio: voice `highpass=f=90` → `loudnorm` to −14 LUFS, TP −1; music (when given) normalised to voice − 22 dB, ducked by `sidechaincompress` keyed on the voice, mixed, limited at −1 dBFS.
- Render: at most 30 segments per ffmpeg process; intermediates `libx264 -crf 12 -preset veryfast` + PCM in `.mov`; final encode keeps all YouTube-spec args from sub-project 1 (`encodeArgs`). Duration tolerance stays `max(0.1, 1/fps)` s.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A long real take (10+ minutes, 150–300 segments)** must render: each ffmpeg process sees at most 30 inputs. Pinned in Task 5 (40-segment real render → 2 chunks, duration within tolerance).
2. **A take whose transcript has no sentence-ending punctuation** must not drop everything as one giant "retake", and captions must still split. Pinned in Task 2 (no-punctuation input → zero retakes) and Task 4 (long unpunctuated run splits by `maxChars`).
3. **File names with spaces, quotes and non-ASCII** (`my take 'one' ✨.mp4`, a music file in such a folder) must work: captions and the chunk list are referenced by relative names from the work dir, never embedded paths. Pinned in Task 5 (captioned render in a quoted directory) and Task 6 (pipeline on a quoted file name).
4. **Portrait phone video (1080×1920)** keeps its orientation, and caption size follows the short side, not the height. Pinned in Task 4 (`toAss` at 1080×1920 → `Fontsize` 64) and Task 6 (output dimensions copied from the source, rounded to even).
5. **A silent or wordless take** gives `NO_SPEECH` with a hint, and a music file without audio gives `BAD_MUSIC`, never a crash. Pinned in Task 6.

---

### Task 1: On-device transcription sidecar

**Files:**
- Create: `native/macos/transcribe.swift`, `scripts/build-native.ts`, `scripts/make-speech-fixture.ts`, `packages/sidecars/src/transcribe.ts`, `packages/sidecars/src/transcribe.test.ts`
- Create (generated, committed): `fixtures/speech-retake.mp4`
- Modify: `packages/sidecars/src/run.ts` (add `runPath`, `cwd`, `notFoundHint`), `packages/sidecars/src/run.test.ts`, `packages/sidecars/src/ffmpeg.ts` (add `cwd` to `FfmpegOptions`, add `extractWav`), `packages/sidecars/src/index.ts`, `packages/core/src/media-tools.ts`, `packages/core/src/render.test.ts` (stubs gain the two new `MediaTools` members), `package.json`, `.gitignore`, `fixtures/README.md`

**Interfaces:**
- Produces (sidecars): `runPath(name: string, bin: string, args: string[], opts?: RunOptions): Promise<RunResult>`; `RunOptions` gains `cwd?: string` and `notFoundHint?: string`; `FfmpegOptions` gains `cwd?: string`; `extractWav(src: string, out: string, opts?: { timeoutMs?: number }): Promise<void>`; `transcriberPath(): string`; `transcribeAudio(audioPath: string, opts?: { locale?: string; timeoutMs?: number }): Promise<Transcript>`; `sentenceSegments(words: Word[]): Transcript['segments']`; `speechRanges(words: Word[], maxGapSec?: number): [number, number][]`.
- Produces (core): `MediaTools` gains `extractWav(src: string, out: string): Promise<void>` and `transcribe(audioPath: string, opts?: { locale?: string }): Promise<Transcript>`; `FfmpegRunOptions` gains `cwd?: string`.

- [ ] **Step 1: Write the Swift helper**

`native/macos/transcribe.swift`:
```swift
// wordedits-transcribe <audio-file> [--locale en-US]
// Prints {"words":[{"w","start","end","conf"}]} to stdout. Errors go to stderr, exit 1.
import AVFoundation
import Foundation
import Speech

@main struct Transcribe {
  static func main() async {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let path = args.first, !path.hasPrefix("--") else {
      FileHandle.standardError.write("usage: wordedits-transcribe <audio-file> [--locale en-US]\n".data(using: .utf8)!)
      exit(2)
    }
    var localeId = "en-US"
    if let i = args.firstIndex(of: "--locale"), i + 1 < args.count { localeId = args[i + 1] }
    do {
      try await run(url: URL(fileURLWithPath: path), locale: Locale(identifier: localeId))
    } catch {
      FileHandle.standardError.write("transcription failed: \(error.localizedDescription)\n".data(using: .utf8)!)
      exit(1)
    }
  }

  static func run(url: URL, locale: Locale) async throws {
    let transcriber = SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      reportingOptions: [],
      attributeOptions: [.audioTimeRange, .transcriptionConfidence])
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      FileHandle.standardError.write("installing speech model for \(locale.identifier)...\n".data(using: .utf8)!)
      try await request.downloadAndInstall()
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let file = try AVAudioFile(forReading: url)
    let collector = Task { () -> [[String: Any]] in
      var words: [[String: Any]] = []
      for try await result in transcriber.results {
        for run in result.text.runs {
          guard let range = run.audioTimeRange else { continue }
          words.append([
            "w": String(result.text[run.range].characters),
            "start": range.start.seconds,
            "end": range.end.seconds,
            "conf": run.transcriptionConfidence ?? 1.0,
          ])
        }
      }
      return words
    }
    if let last = try await analyzer.analyzeSequence(from: file) {
      try await analyzer.finalizeAndFinish(through: last)
    } else {
      await analyzer.cancelAndFinishNow()
    }
    let words = try await collector.value
    let data = try JSONSerialization.data(withJSONObject: ["words": words])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  }
}
```

`scripts/build-native.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

if (process.platform !== 'darwin') {
  console.log(`build:native: nothing to build on ${process.platform}`);
  process.exit(0);
}
const outDir = 'packages/sidecars/bin/darwin';
await mkdir(outDir, { recursive: true });
execFileSync('swiftc', ['-parse-as-library', '-O', 'native/macos/transcribe.swift', '-o', `${outDir}/wordedits-transcribe`], { stdio: 'inherit' });
console.log(`built ${outDir}/wordedits-transcribe`);
```

Add to root `package.json` scripts: `"build:native": "tsx scripts/build-native.ts"`, `"fixtures:speech": "tsx scripts/make-speech-fixture.ts"`, `"edit": "tsx scripts/edit.ts"`. Append to `.gitignore`: `packages/sidecars/bin/`.

Run: `pnpm build:native && packages/sidecars/bin/darwin/wordedits-transcribe; echo "exit $?"`
Expected: `built packages/sidecars/bin/darwin/wordedits-transcribe`, then the usage line and `exit 2`.

- [ ] **Step 2: Generate the speech fixture**

`scripts/make-speech-fixture.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { run } from '@wordedits/sidecars';

if (process.platform !== 'darwin') {
  console.error('fixtures:speech needs macOS (uses the say command)');
  process.exit(1);
}
const text =
  'Welcome to WordEdits. Um, this is scene one, the hook. Uh, let me say that again. ' +
  'This is scene one, the hook. [[slnc 1500]] Now scene two explains how the app cuts your take.';
await mkdir('fixtures/tmp', { recursive: true });
execFileSync('say', ['-v', 'Samantha', '-o', 'fixtures/tmp/speech.aiff', text]);
await run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
  '-i', 'fixtures/tmp/speech.aiff',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-shortest', '-movflags', '+faststart',
  'fixtures/speech-retake.mp4',
]);
await rm('fixtures/tmp/speech.aiff', { force: true });
console.log('wrote fixtures/speech-retake.mp4');
```

Append a row to the table in `fixtures/README.md`:
```
| speech-retake.mp4 | 640x360 @30 fps pattern + macOS "Samantha" voice reading a script with an "um", an "uh", a restart cue ("let me say that again"), a repeated sentence and a 1.5 s pause. Regenerate with `pnpm fixtures:speech` (macOS only). |
```

Run: `pnpm fixtures:speech && ls -la fixtures/speech-retake.mp4`
Expected: file exists, under 1 MB, roughly 12–14 s long.

- [ ] **Step 3: Write failing tests for runPath/cwd and the transcriber**

Append to `packages/sidecars/src/run.test.ts` (inside the existing file, new `describe`):
```ts
describe('run with cwd', () => {
  it('resolves relative paths against cwd', async () => {
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', 'tone-6s.mp4', '-f', 'null', '-'], { cwd: 'fixtures' });
    expect(stderr).not.toContain('No such file');
  });
});

describe('runPath', () => {
  it('reports a missing binary as NOT_FOUND with the given hint', async () => {
    await expect(runPath('thing', '/definitely/not/here/thing', [], { notFoundHint: 'build it first' })).rejects.toMatchObject({
      name: 'SidecarError', tool: 'thing', code: 'NOT_FOUND', hint: 'build it first',
    });
  });
});
```
(add `runPath` to the import from `./run.js`).

`packages/sidecars/src/transcribe.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Word } from '@wordedits/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractWav } from './ffmpeg.js';
import { probe } from './ffprobe.js';
import { sentenceSegments, speechRanges, transcribeAudio, transcriberPath } from './transcribe.js';

const w = (text: string, start: number, end: number): Word => ({ w: text, start, end, conf: 1 });

describe('sentenceSegments', () => {
  it('splits on sentence-ending punctuation and keeps a trailing unpunctuated run', () => {
    const segs = sentenceSegments([w('Hi', 0, 0.2), w('there.', 0.2, 0.5), w('Who', 1, 1.2), w('are', 1.2, 1.3), w('you?', 1.3, 1.6), w('Bye', 2, 2.3)]);
    expect(segs).toEqual([
      { start: 0, end: 0.5, text: 'Hi there.' },
      { start: 1, end: 1.6, text: 'Who are you?' },
      { start: 2, end: 2.3, text: 'Bye' },
    ]);
  });
});

describe('speechRanges', () => {
  it('merges words separated by less than 0.3 s', () => {
    expect(speechRanges([w('a', 0, 0.2), w('b', 0.4, 0.6), w('c', 1.5, 1.8)])).toEqual([[0, 0.6], [1.5, 1.8]]);
  });
  it('returns [] for no words', () => {
    expect(speechRanges([])).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'darwin')('transcribeAudio (macOS)', () => {
  beforeAll(() => {
    if (!existsSync(transcriberPath())) execFileSync('pnpm', ['build:native'], { stdio: 'inherit' });
  }, 300_000);

  it('returns timed words, keeps fillers, and finds the pause', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we tx '));
    const wav = join(dir, 'audio.wav');
    await extractWav('fixtures/speech-retake.mp4', wav);
    const t = await transcribeAudio(wav);
    const tokens = t.words.map((x) => x.w.toLowerCase().replace(/[^\p{L}']/gu, ''));
    expect(tokens).toContain('welcome');
    expect(tokens).toContain('hook');
    expect(tokens.some((x) => ['um', 'uh', 'ah', 'er'].includes(x))).toBe(true);
    for (let i = 1; i < t.words.length; i++) expect(t.words[i].start).toBeGreaterThanOrEqual(t.words[i - 1].start);
    expect(t.words.every((x) => x.w === x.w.trim() && x.w.length > 0)).toBe(true);
    const duration = (await probe('fixtures/speech-retake.mp4')).durationSec;
    expect(t.words.at(-1)!.end).toBeLessThanOrEqual(duration + 0.05);
    expect(t.segments.length).toBeGreaterThanOrEqual(4);
    expect(t.speech.length).toBeGreaterThanOrEqual(2);
  }, 300_000);
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm vitest run packages/sidecars/src/run.test.ts packages/sidecars/src/transcribe.test.ts`
Expected: FAIL — `runPath` is not exported; `./transcribe.js` not found.

- [ ] **Step 5: Implement runPath and cwd in run.ts**

Replace the `RunOptions` interface and the `run` function in `packages/sidecars/src/run.ts` with:
```ts
export interface RunOptions {
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
  /** Working directory for the child process. */
  cwd?: string;
  /** Hint used when the binary cannot be started at all. */
  notFoundHint?: string;
}

export async function run(tool: Tool, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return runPath(tool, await locate(tool), args, { notFoundHint: installHint(tool), ...opts });
}

/** Runs a binary at a known path. `name` is used in errors. */
export async function runPath(name: string, bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  const child = execa(bin, args, { timeout, reject: false, all: false, stripFinalNewline: false, cwd: opts.cwd });

  let splitter: LineSplitter | undefined;
  if (opts.onStdoutLine && child.stdout) {
    splitter = createLineSplitter(opts.onStdoutLine);
    child.stdout.on('data', (chunk: Buffer) => {
      splitter!.feed(chunk.toString('utf8'));
    });
  }

  const res = await child;
  splitter?.flush();
  const stderr = String(res.stderr ?? '');
  if (res.timedOut) {
    throw new SidecarError(name, 'TIMEOUT', `${name} exceeded ${timeout} ms`, 'The file may be very long or the machine is busy. Try again.', stderr);
  }
  if (res.exitCode === undefined && res.signal) {
    throw new SidecarError(name, 'EXIT', `${name} was stopped by ${res.signal}`, lastMeaningfulLine(stderr), stderr);
  }
  if (res.exitCode === undefined) {
    // The process never ran (ENOENT, EACCES, ENOEXEC: missing, not executable, or not a binary).
    throw new SidecarError(name, 'NOT_FOUND', `${name} could not be started`, opts.notFoundHint ?? 'The program could not be started.', String(res.stderr || res.originalMessage || ''));
  }
  if (res.exitCode !== 0) {
    throw new SidecarError(name, 'EXIT', `${name} exited with code ${res.exitCode}`, lastMeaningfulLine(stderr), stderr);
  }
  return { stdout: String(res.stdout ?? ''), stderr };
}
```
`SidecarError`'s first parameter is currently typed as the tool name string; if it is typed as `Tool`, widen it to `string` in `errors.ts`.

- [ ] **Step 6: Add cwd and extractWav to ffmpeg.ts**

In `packages/sidecars/src/ffmpeg.ts`: add `cwd?: string;` to `FfmpegOptions`, pass `cwd: opts.cwd` in the `run('ffmpeg', …, { … })` options inside `runFfmpeg`, and add:
```ts
/** 16 kHz mono 16-bit WAV, the input the transcriber expects. */
export async function extractWav(src: string, out: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out,
  ], { timeoutMs: opts.timeoutMs ?? 10 * 60_000 });
}
```

- [ ] **Step 7: Write transcribe.ts**

`packages/sidecars/src/transcribe.ts`:
```ts
import { access, constants } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TranscriptSchema, type Transcript, type Word } from '@wordedits/shared';
import { SidecarError } from './errors.js';
import { runPath } from './run.js';

const NAME = 'wordedits-transcribe';
const SENTENCE_END = /[.?!]["'”’)\]]*$/;

export function transcriberPath(): string {
  return fileURLToPath(new URL(`../bin/darwin/${NAME}`, import.meta.url));
}

export function sentenceSegments(words: Word[]): Transcript['segments'] {
  const out: Transcript['segments'] = [];
  let from = 0;
  words.forEach((word, i) => {
    if (SENTENCE_END.test(word.w) || i === words.length - 1) {
      const slice = words.slice(from, i + 1);
      out.push({ start: slice[0].start, end: slice[slice.length - 1].end, text: slice.map((x) => x.w).join(' ') });
      from = i + 1;
    }
  });
  return out;
}

export function speechRanges(words: Word[], maxGapSec = 0.3): [number, number][] {
  const out: [number, number][] = [];
  for (const word of words) {
    const last = out[out.length - 1];
    if (last && word.start - last[1] < maxGapSec) last[1] = Math.max(last[1], word.end);
    else out.push([word.start, word.end]);
  }
  return out;
}

interface RawWord {
  w?: unknown;
  start?: unknown;
  end?: unknown;
  conf?: unknown;
}

export async function transcribeAudio(audioPath: string, opts: { locale?: string; timeoutMs?: number } = {}): Promise<Transcript> {
  if (process.platform !== 'darwin') {
    throw new SidecarError(NAME, 'NOT_FOUND', 'On-device transcription is only available on macOS for now', 'Use a Mac with macOS 26 or later.');
  }
  const bin = transcriberPath();
  try {
    await access(bin, constants.X_OK);
  } catch {
    throw new SidecarError(NAME, 'NOT_FOUND', 'The transcriber has not been built', 'Run: pnpm build:native');
  }
  const { stdout } = await runPath(NAME, bin, [audioPath, '--locale', opts.locale ?? 'en-US'], {
    timeoutMs: opts.timeoutMs ?? 30 * 60_000,
    notFoundHint: 'Run: pnpm build:native',
  });

  let raw: { words?: RawWord[] };
  try {
    raw = JSON.parse(stdout) as { words?: RawWord[] };
  } catch {
    throw new SidecarError(NAME, 'PARSE', 'The transcriber returned invalid JSON', 'Try again; if it persists, rebuild with pnpm build:native.', stdout);
  }
  const words: Word[] = (raw.words ?? [])
    .map((r) => {
      const start = Math.max(0, Number(r.start) || 0);
      const end = Math.max(start, Number(r.end) || start);
      const conf = Math.min(1, Math.max(0, Number(r.conf ?? 1)));
      return { w: String(r.w ?? '').trim(), start, end, conf };
    })
    .filter((x) => x.w.length > 0)
    .sort((a, b) => a.start - b.start);

  return TranscriptSchema.parse({ words, segments: sentenceSegments(words), speech: speechRanges(words) });
}
```

Add to `packages/sidecars/src/index.ts`:
```ts
export { runPath } from './run.js';
export { extractWav } from './ffmpeg.js';
export { transcribeAudio, transcriberPath, sentenceSegments, speechRanges } from './transcribe.js';
```

- [ ] **Step 8: Extend MediaTools**

In `packages/core/src/media-tools.ts`: add `import type { ProbeInfo, Transcript } from '@wordedits/shared';`, add `cwd?: string;` to `FfmpegRunOptions`, add to `MediaTools`:
```ts
  extractWav(src: string, out: string): Promise<void>;
  transcribe(audioPath: string, opts?: { locale?: string }): Promise<Transcript>;
```
and to the object returned by `realMediaTools()`:
```ts
    extractWav: (src, out) => s.extractWav(src, out),
    transcribe: (audio, opts) => s.transcribeAudio(audio, opts),
```
Every stub `MediaTools` object in `packages/core/src/render.test.ts` gains:
```ts
  extractWav: async () => { throw new Error('not used'); },
  transcribe: async () => { throw new Error('not used'); },
```

- [ ] **Step 9: Run tests and typecheck**

Run: `pnpm vitest run packages/sidecars && pnpm test && pnpm typecheck`
Expected: all green on macOS (transcribe test runs; it may print "installing speech model" once).

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat(sidecars): on-device transcription via Apple SpeechAnalyzer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Sentences, fillers and retake detection

**Files:**
- Create: `packages/core/src/autoedit/takes.ts`, `packages/core/src/autoedit/takes.test.ts`, `packages/core/src/autoedit/index.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Word` from `@wordedits/shared`.
- Produces: `FILLERS: Set<string>`; `normalizeWord(w: string): string`; `isFiller(w: Word): boolean`; `interface Sentence { index: number; from: number; to: number; text: string; start: number; end: number }` (`from`/`to` are inclusive word indices); `splitSentences(words: Word[]): Sentence[]`; `sentenceTokens(s: Sentence, words: Word[]): string[]`; `textTokens(text: string): string[]`; `similarity(a: string[], b: string[]): number`; `splitScript(text: string): string[]`; `interface RetakeDecision { sentence: number; reason: string }`; `detectRetakes(sentences: Sentence[], words: Word[], opts?: { scriptText?: string; lookahead?: number; threshold?: number }): RetakeDecision[]` (sorted by sentence index).

- [ ] **Step 1: Write the failing test**

`packages/core/src/autoedit/takes.test.ts`:
```ts
import type { Word } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { detectRetakes, isFiller, normalizeWord, similarity, splitScript, splitSentences } from './takes.js';

/** Words from text, 0.3 s each, back to back. */
function words(text: string): Word[] {
  return text.split(/\s+/).filter(Boolean).map((w, i) => ({ w, start: i * 0.3, end: i * 0.3 + 0.25, conf: 1 }));
}
const dropped = (text: string, scriptText?: string) => {
  const ws = words(text);
  return detectRetakes(splitSentences(ws), ws, { scriptText }).map((d) => d.sentence);
};

describe('normalizeWord / isFiller', () => {
  it('lowercases and strips punctuation and accents', () => {
    expect(normalizeWord('  Café,')).toBe('cafe');
    expect(normalizeWord("Don't!")).toBe("don't");
  });
  it('recognises hesitation sounds only', () => {
    expect(isFiller({ w: 'Um,', start: 0, end: 1, conf: 1 })).toBe(true);
    expect(isFiller({ w: 'Ah.', start: 0, end: 1, conf: 1 })).toBe(true);
    expect(isFiller({ w: 'like', start: 0, end: 1, conf: 1 })).toBe(false);
  });
});

describe('splitSentences', () => {
  it('splits on . ? ! and keeps word index ranges', () => {
    const s = splitSentences(words('Hello there. How are you? Fine'));
    expect(s.map((x) => [x.from, x.to, x.text])).toEqual([[0, 1, 'Hello there.'], [2, 4, 'How are you?'], [5, 5, 'Fine']]);
    expect(s[1].start).toBeCloseTo(0.6);
    expect(s[1].end).toBeCloseTo(1.45);
  });
});

describe('similarity', () => {
  it('is LCS over the longer length', () => {
    expect(similarity(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
    expect(similarity(['a', 'x', 'c'], ['a', 'b', 'c'])).toBeCloseTo(2 / 3);
    expect(similarity([], ['a'])).toBe(0);
  });
});

describe('detectRetakes', () => {
  it('drops a restart cue and the earlier take of a repeated sentence', () => {
    expect(
      dropped('Welcome to WordEdits. Um, this is scene one, the hook. Uh, let me say that again. This is scene one, the hook. Now scene two explains how the app cuts your take.'),
    ).toEqual([1, 2]);
  });

  it('keeps parallel but different sentences', () => {
    expect(dropped('Step one is to open the app. Step two is to open the folder.')).toEqual([]);
  });

  it('drops a false start that the next sentence completes', () => {
    expect(dropped('So the main. So the main idea is speed.')).toEqual([0]);
  });

  it('drops a sentence made only of fillers', () => {
    expect(dropped('Hello there. Um. Uh. Next point.')).toEqual([1, 2]);
  });

  it('does not treat a whole unpunctuated take as retakes', () => {
    expect(dropped('so today we are going to talk about privacy and why it matters for every single user of the app')).toEqual([]);
  });

  it('uses the script to catch a retake beyond the lookahead', () => {
    const t = 'Our app is really fast. Wait. Okay. Hold on. Our app is really fast.';
    expect(dropped(t)).toEqual([]);
    expect(dropped(t, 'Our app is really fast.')).toEqual([0]);
  });

  it('gives each decision a readable reason', () => {
    const ws = words('So the main. So the main idea is speed.');
    const [d] = detectRetakes(splitSentences(ws), ws);
    expect(d.reason).toContain('So the main idea is speed.');
  });
});

describe('splitScript', () => {
  it('ignores markdown headings and splits sentences', () => {
    expect(splitScript('# Hook\nFirst line. Second line?\n\n## Body\nThird')).toEqual(['First line.', 'Second line?', 'Third']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/autoedit/takes.test.ts`
Expected: FAIL — cannot find module `./takes.js`.

- [ ] **Step 3: Implement takes.ts**

`packages/core/src/autoedit/takes.ts`:
```ts
import type { Word } from '@wordedits/shared';

export const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'ahh', 'hmm', 'mm', 'mhm']);

export function normalizeWord(w: string): string {
  return w
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9']/g, '')
    .replace(/^'+|'+$/g, '');
}

export const isFiller = (w: Word): boolean => FILLERS.has(normalizeWord(w.w));

export interface Sentence {
  index: number;
  /** First word index, inclusive. */
  from: number;
  /** Last word index, inclusive. */
  to: number;
  text: string;
  start: number;
  end: number;
}

const SENTENCE_END = /[.?!]["'”’)\]]*$/;

export function splitSentences(words: Word[]): Sentence[] {
  const out: Sentence[] = [];
  let from = 0;
  words.forEach((word, i) => {
    if (SENTENCE_END.test(word.w.trim()) || i === words.length - 1) {
      const slice = words.slice(from, i + 1);
      out.push({
        index: out.length,
        from,
        to: i,
        text: slice.map((x) => x.w.trim()).join(' '),
        start: slice[0].start,
        end: slice[slice.length - 1].end,
      });
      from = i + 1;
    }
  });
  return out;
}

export function sentenceTokens(s: Sentence, words: Word[]): string[] {
  return words.slice(s.from, s.to + 1).filter((w) => !isFiller(w)).map((w) => normalizeWord(w.w)).filter(Boolean);
}

export function textTokens(text: string): string[] {
  return text.split(/\s+/).map(normalizeWord).filter((t) => t && !FILLERS.has(t));
}

/** Longest-common-subsequence length divided by the longer sequence's length. */
export function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (const x of a) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = x === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length] / Math.max(a.length, b.length);
}

export function splitScript(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const RESTART_CUES = [
  /\b(let me|lemme|i'll|i will|i'm gonna|im gonna) (say|try|do|start|read)( that| this| it)? (again|over)\b/,
  /\bscratch that\b/,
  /\bstart(ing)? over\b/,
  /\bone more time\b/,
  /\btake (two|three|four|2|3|4)\b/,
];
/** Cue phrases inside longer sentences are content, not cues. */
const MAX_CUE_TOKENS = 8;

export interface RetakeDecision {
  sentence: number;
  reason: string;
}

export interface RetakeOptions {
  scriptText?: string;
  /** How many following sentences to compare against (cue sentences do not count). */
  lookahead?: number;
  /** Similarity at or above which two sentences are takes of the same line. */
  threshold?: number;
}

export function detectRetakes(sentences: Sentence[], words: Word[], opts: RetakeOptions = {}): RetakeDecision[] {
  const lookahead = opts.lookahead ?? 3;
  const threshold = opts.threshold ?? 0.8;
  const tokens = sentences.map((s) => sentenceTokens(s, words));
  const dropped = new Map<number, string>();
  const cue = new Set<number>();

  tokens.forEach((t, i) => {
    if (t.length === 0) {
      dropped.set(i, `filler only: "${sentences[i].text}"`);
    } else if (t.length <= MAX_CUE_TOKENS && RESTART_CUES.some((r) => r.test(t.join(' ')))) {
      dropped.set(i, `restart cue: "${sentences[i].text}"`);
      cue.add(i);
    }
  });

  for (let i = 0; i < sentences.length; i++) {
    if (dropped.has(i)) continue;
    let compared = 0;
    for (let j = i + 1; j < sentences.length && compared < lookahead; j++) {
      if (cue.has(j)) continue;
      compared++;
      const a = tokens[i];
      const b = tokens[j];
      const falseStart = a.length >= 2 && a.length < b.length && b.slice(0, a.length).join(' ') === a.join(' ');
      if (falseStart || similarity(a, b) >= threshold) {
        dropped.set(i, `retake: kept the later take "${sentences[j].text}"`);
        break;
      }
    }
  }

  if (opts.scriptText) {
    const script = splitScript(opts.scriptText).map(textTokens);
    const lastTakeOf = new Map<number, number>();
    tokens.forEach((t, i) => {
      if (dropped.has(i)) return;
      let best = -1;
      let bestScore = 0;
      script.forEach((line, k) => {
        const score = similarity(t, line);
        if (score > bestScore) {
          bestScore = score;
          best = k;
        }
      });
      if (best < 0 || bestScore < 0.6) return;
      const previous = lastTakeOf.get(best);
      if (previous !== undefined) {
        dropped.set(previous, `retake of script line ${best + 1}: kept the later take "${sentences[i].text}"`);
      }
      lastTakeOf.set(best, i);
    });
  }

  return [...dropped.entries()].sort((a, b) => a[0] - b[0]).map(([sentence, reason]) => ({ sentence, reason }));
}
```

`packages/core/src/autoedit/index.ts`:
```ts
export * from './takes.js';
```
Add to `packages/core/src/index.ts`: `export * from './autoedit/index.js';`

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/core/src/autoedit/takes.test.ts`
Expected: all pass.

- [ ] **Step 5: Full suite, typecheck, commit**

Run: `pnpm test && pnpm typecheck`

```bash
git add -A && git commit -m "feat(core): sentence splitting, filler and retake detection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Cut planner and report

**Files:**
- Create: `packages/core/src/autoedit/errors.ts`, `packages/core/src/autoedit/plan.ts`, `packages/core/src/autoedit/plan.test.ts`
- Modify: `packages/core/src/autoedit/index.ts`

**Interfaces:**
- Consumes: `Transcript`, `Word`, `Edl`, `EdlSchema` (shared); `edlDuration` (core); `isFiller`, `Sentence`, `RetakeDecision` (Task 2).
- Produces: `class AutoEditError extends Error { code: 'NO_SPEECH' | 'NOTHING_KEPT' | 'BAD_MUSIC'; hint: string }`; `type Pace = 'natural' | 'fast' | 'extra-fast'`; `PACE: Record<Pace, { maxPause: number; keepPause: number }>`; `interface Cut { start: number; end: number; reason: string }`; `interface PlanInput { transcript: Transcript; sentences: Sentence[]; retakes: RetakeDecision[]; pace: Pace; sourceDurationSec: number; output: { width: number; height: number; fps: number } }`; `interface PlanResult { edl: Edl; cuts: Cut[]; keptWords: Word[]; sourceDurationSec: number; editedDurationSec: number }`; `planCuts(input: PlanInput): PlanResult`; `formatReport(result: PlanResult, opts?: { title?: string }): string`; `formatTime(sec: number): string` (`m:ss`, or `h:mm:ss` from one hour).

- [ ] **Step 1: Write the failing test**

`packages/core/src/autoedit/plan.test.ts`:
```ts
import { EdlSchema, type Transcript, type Word } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { formatReport, formatTime, planCuts, type Pace } from './plan.js';
import { splitSentences, type RetakeDecision } from './takes.js';

const w = (text: string, start: number, end: number): Word => ({ w: text, start, end, conf: 1 });
const tx = (words: Word[]): Transcript => ({ words, segments: [], speech: [] });
const output = { width: 1920, height: 1080, fps: 30 };

function plan(words: Word[], opts: { pace?: Pace; retakes?: RetakeDecision[]; duration?: number } = {}) {
  return planCuts({
    transcript: tx(words),
    sentences: splitSentences(words),
    retakes: opts.retakes ?? [],
    pace: opts.pace ?? 'natural',
    sourceDurationSec: opts.duration ?? 10,
    output,
  });
}

describe('planCuts', () => {
  it('shortens a long pause to keepPause, split evenly', () => {
    const r = plan([w('Hello.', 0, 0.5), w('World.', 2.0, 2.5)]);
    expect(r.cuts).toEqual([{ start: 0.7, end: 1.8, reason: 'pause 1.5s' }]);
    expect(r.edl.scenes[0].src.in).toBe(0);
    expect(r.edl.scenes.at(-1)!.src.out).toBeCloseTo(2.8);
    expect(r.editedDurationSec).toBeCloseTo(2.8 - 1.1, 1);
  });

  it('leaves a pause shorter than maxPause alone', () => {
    expect(plan([w('Hello', 0, 0.5), w('world.', 0.9, 1.3)]).cuts).toEqual([]);
  });

  it('cuts a filler without keeping any of its audio', () => {
    const r = plan([w('Hi', 0, 0.3), w('um', 0.5, 0.9), w('there.', 1.1, 1.4)]);
    expect(r.cuts).toEqual([{ start: 0.5, end: 0.9, reason: 'filler "um"' }]);
    expect(r.keptWords.map((x) => x.w)).toEqual(['Hi', 'there.']);
  });

  it('cuts every word of a dropped sentence', () => {
    const words = [w('One.', 0, 0.4), w('Bad', 0.6, 0.9), w('take.', 0.9, 1.3), w('Two.', 1.5, 1.9)];
    const r = plan(words, { retakes: [{ sentence: 1, reason: 'retake: x' }] });
    expect(r.cuts).toHaveLength(1);
    expect(r.cuts[0].start).toBeLessThanOrEqual(0.6);
    expect(r.cuts[0].end).toBeGreaterThanOrEqual(1.3);
    expect(r.cuts[0].reason).toBe('retake: x');
  });

  it('trims silence before the first and after the last kept word', () => {
    const r = plan([w('Hi.', 3, 3.4)], { duration: 10 });
    expect(r.edl.scenes[0].src.in).toBeCloseTo(2.9);
    expect(r.edl.scenes[0].src.out).toBeCloseTo(3.7);
  });

  it('cuts more at a faster pace', () => {
    const words = [w('A.', 0, 0.4), w('B.', 1.0, 1.4), w('C.', 2.0, 2.4)];
    expect(plan(words, { pace: 'fast' }).editedDurationSec).toBeLessThan(plan(words, { pace: 'natural' }).editedDurationSec);
  });

  it('returns a valid EDL whose scenes follow sentences', () => {
    const r = plan([w('One.', 0, 0.4), w('Two.', 2, 2.4), w('Three.', 4, 4.4)]);
    expect(() => EdlSchema.parse(r.edl)).not.toThrow();
    expect(r.edl.scenes.map((s) => s.id)).toEqual(['s0', 's1', 's2']);
    expect(r.edl.output).toEqual(output);
  });

  it('throws NOTHING_KEPT when every word is cut', () => {
    expect(() => plan([w('Um.', 0, 0.4)])).toThrow(expect.objectContaining({ code: 'NOTHING_KEPT' }));
  });
});

describe('formatReport', () => {
  it('summarises durations and lists cuts by kind', () => {
    const words = [w('Hi', 0, 0.3), w('um', 0.5, 0.9), w('there.', 1.1, 1.4), w('Bye.', 3.5, 3.9)];
    const md = formatReport(plan(words), { title: 'my take' });
    expect(md).toContain('# my take');
    expect(md).toContain('0:10 → 0:02');
    expect(md).toContain('Fillers removed: 1');
    expect(md).toContain('Pauses shortened: 1');
    expect(md).toContain('0:00.5');
  });
});

describe('formatTime', () => {
  it('formats minutes and hours', () => {
    expect(formatTime(5)).toBe('0:05');
    expect(formatTime(125.4)).toBe('2:05');
    expect(formatTime(3725)).toBe('1:02:05');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/autoedit/plan.test.ts`
Expected: FAIL — cannot find module `./plan.js`.

- [ ] **Step 3: Implement errors.ts and plan.ts**

`packages/core/src/autoedit/errors.ts`:
```ts
export class AutoEditError extends Error {
  override name = 'AutoEditError';
  constructor(
    public code: 'NO_SPEECH' | 'NOTHING_KEPT' | 'BAD_MUSIC',
    message: string,
    public hint: string,
  ) {
    super(message);
  }
}
```

`packages/core/src/autoedit/plan.ts`:
```ts
import { EdlSchema, type Edl, type Transcript, type Word } from '@wordedits/shared';
import { edlDuration } from '../edl-compiler.js';
import { AutoEditError } from './errors.js';
import { isFiller, type RetakeDecision, type Sentence } from './takes.js';

export type Pace = 'natural' | 'fast' | 'extra-fast';

/** Spec §7/§13: pauses longer than maxPause are shortened to keepPause in total. */
export const PACE: Record<Pace, { maxPause: number; keepPause: number }> = {
  natural: { maxPause: 0.5, keepPause: 0.4 },
  fast: { maxPause: 0.35, keepPause: 0.25 },
  'extra-fast': { maxPause: 0.25, keepPause: 0.15 },
};

const LEAD_SEC = 0.1;
const TAIL_SEC = 0.3;

export interface Cut {
  start: number;
  end: number;
  reason: string;
}

export interface PlanInput {
  transcript: Transcript;
  sentences: Sentence[];
  retakes: RetakeDecision[];
  pace: Pace;
  sourceDurationSec: number;
  output: { width: number; height: number; fps: number };
}

export interface PlanResult {
  edl: Edl;
  cuts: Cut[];
  keptWords: Word[];
  sourceDurationSec: number;
  editedDurationSec: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function planCuts(input: PlanInput): PlanResult {
  const { words } = input.transcript;
  const { maxPause, keepPause } = PACE[input.pace];
  const half = keepPause / 2;
  const fps = input.output.fps;
  const minCut = 1 / fps;

  const removeReason = new Map<number, string>();
  for (const r of input.retakes) {
    const s = input.sentences[r.sentence];
    for (let i = s.from; i <= s.to; i++) removeReason.set(i, r.reason);
  }
  words.forEach((word, i) => {
    if (!removeReason.has(i) && isFiller(word)) removeReason.set(i, `filler "${word.w.trim().replace(/[^\p{L}']/gu, '')}"`);
  });

  const kept = words.map((word, i) => ({ word, i })).filter((x) => !removeReason.has(x.i));
  if (kept.length === 0) {
    throw new AutoEditError('NOTHING_KEPT', 'Every word in the take would be cut', 'Check that the right file was chosen, or try without --script.');
  }

  const cuts: Cut[] = [];
  const push = (start: number, end: number, reason: string) => {
    if (end - start >= minCut) cuts.push({ start: round3(start), end: round3(end), reason });
  };
  for (let k = 1; k < kept.length; k++) {
    const prev = kept[k - 1];
    const next = kept[k];
    const gapStart = prev.word.end;
    const gapEnd = next.word.start;
    if (next.i - prev.i > 1) {
      const first = words[prev.i + 1];
      const last = words[next.i - 1];
      const before = Math.max(0, Math.min(half, first.start - gapStart));
      const after = Math.max(0, Math.min(half, gapEnd - last.end));
      const reasons = [...new Set(words.slice(prev.i + 1, next.i).map((_, j) => removeReason.get(prev.i + 1 + j)!))];
      push(gapStart + before, gapEnd - after, reasons.join('; '));
    } else if (gapEnd - gapStart > maxPause) {
      push(gapStart + half, gapEnd - half, `pause ${(gapEnd - gapStart).toFixed(1)}s`);
    }
  }

  const inPoint = round3(Math.max(0, kept[0].word.start - LEAD_SEC));
  const outPoint = round3(Math.min(input.sourceDurationSec, kept[kept.length - 1].word.end + TAIL_SEC));

  // Kept intervals = [inPoint, outPoint] minus cuts; drop slivers under two frames.
  const intervals: { start: number; end: number }[] = [];
  let cursor = inPoint;
  for (const c of cuts) {
    if (c.start > cursor) intervals.push({ start: cursor, end: Math.min(c.start, outPoint) });
    cursor = Math.max(cursor, c.end);
  }
  if (outPoint > cursor) intervals.push({ start: cursor, end: outPoint });
  const solid = intervals.filter((iv) => iv.end - iv.start >= 2 / fps);

  // One scene per sentence: an interval belongs to the sentence of its first kept word.
  const sentenceOf = (t: number) => {
    const firstWord = kept.find((x) => x.word.end > t + 1e-6) ?? kept[kept.length - 1];
    return input.sentences.find((s) => firstWord.i >= s.from && firstWord.i <= s.to)?.index ?? 0;
  };
  const groups: { sentence: number; ivs: { start: number; end: number }[] }[] = [];
  for (const iv of solid) {
    const sentence = sentenceOf(iv.start);
    const last = groups[groups.length - 1];
    if (last && last.sentence === sentence) last.ivs.push(iv);
    else groups.push({ sentence, ivs: [iv] });
  }

  const edl = EdlSchema.parse({
    version: 1,
    output: input.output,
    scenes: groups.map((g) => ({
      id: `s${g.sentence}`,
      src: { in: g.ivs[0].start, out: g.ivs[g.ivs.length - 1].end },
      cuts: g.ivs.slice(1).map((iv, j) => [g.ivs[j].end, iv.start]),
    })),
  });

  return {
    edl,
    cuts,
    keptWords: kept.map((x) => x.word),
    sourceDurationSec: input.sourceDurationSec,
    editedDurationSec: edlDuration(edl, fps),
  };
}

export function formatTime(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const at = (sec: number) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`;

export function formatReport(result: PlanResult, opts: { title?: string } = {}): string {
  const fillers = result.cuts.filter((c) => c.reason.startsWith('filler'));
  const pauses = result.cuts.filter((c) => c.reason.startsWith('pause'));
  const takes = result.cuts.filter((c) => !c.reason.startsWith('filler') && !c.reason.startsWith('pause'));
  const saved = result.sourceDurationSec - result.editedDurationSec;
  const lines = [
    `# ${opts.title ?? 'Edit report'}`,
    '',
    `${formatTime(result.sourceDurationSec)} → ${formatTime(result.editedDurationSec)} (${saved.toFixed(1)} s removed, ${result.cuts.length} cuts)`,
    '',
    `## Retakes and restarts removed: ${takes.length}`,
    ...takes.map((c) => `- ${at(c.start)}–${at(c.end)} ${c.reason}`),
    '',
    `## Fillers removed: ${fillers.length}`,
    ...fillers.map((c) => `- ${at(c.start)} ${c.reason}`),
    '',
    `## Pauses shortened: ${pauses.length}`,
    ...pauses.map((c) => `- ${at(c.start)} ${c.reason}`),
    '',
    '## What stays in',
    '',
    result.keptWords.map((x) => x.w).join(' '),
    '',
  ];
  return lines.join('\n');
}
```

Add to `packages/core/src/autoedit/index.ts`:
```ts
export * from './errors.js';
export * from './plan.js';
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/core/src/autoedit/plan.test.ts`
Expected: all pass. If the report test's `'0:00.5'` does not match because `at()` pads differently, fix `at()` (not the test): `at(0.5)` must render as `0:00.5`.

- [ ] **Step 5: Full suite, typecheck, commit**

Run: `pnpm test && pnpm typecheck`

```bash
git add -A && git commit -m "feat(core): plan pause, filler and retake cuts into an EDL with a report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Captions on the output timeline

**Files:**
- Create: `packages/core/src/autoedit/captions.ts`, `packages/core/src/autoedit/captions.test.ts`
- Modify: `packages/core/src/autoedit/index.ts`

**Interfaces:**
- Consumes: `Edl`, `Word` (shared); `edlSegments` (core).
- Produces: `interface TimeMap { span(start: number, end: number): { start: number; end: number } | null; durationSec: number }`; `timelineMap(edl: Edl, fps: number): TimeMap`; `interface Cue { start: number; end: number; text: string }`; `buildCaptions(words: Word[], map: TimeMap, opts?: { maxChars?: number; maxGap?: number; lead?: number; minDur?: number }): Cue[]`; `toSrt(cues: Cue[]): string`; `toAss(cues: Cue[], opts: { width: number; height: number; font?: string }): string`; `defaultCaptionFont(platform?: NodeJS.Platform): string`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/autoedit/captions.test.ts`:
```ts
import { EdlSchema, type Word } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { buildCaptions, defaultCaptionFont, timelineMap, toAss, toSrt } from './captions.js';

const w = (text: string, start: number, end: number): Word => ({ w: text, start, end, conf: 1 });
const edl = EdlSchema.parse({
  version: 1,
  output: { width: 1920, height: 1080, fps: 30 },
  scenes: [{ id: 's0', src: { in: 0, out: 6 }, cuts: [[2, 4]] }],
});

describe('timelineMap', () => {
  const map = timelineMap(edl, 30);
  it('maps source times through cuts', () => {
    expect(map.durationSec).toBeCloseTo(4);
    expect(map.span(1, 1.5)).toEqual({ start: 1, end: 1.5 });
    expect(map.span(4.5, 5)).toEqual({ start: 2.5, end: 3 });
  });
  it('returns null for words inside a cut and clamps ends that run into one', () => {
    expect(map.span(2.5, 3)).toBeNull();
    expect(map.span(1.8, 2.3)).toEqual({ start: 1.8, end: 2 });
  });
});

describe('buildCaptions', () => {
  const map = timelineMap(edl, 30);
  it('groups words into one-line cues at sentence ends, skipping cut words', () => {
    const cues = buildCaptions([w('Hello', 0.5, 0.8), w('there.', 0.8, 1.2), w('gone', 2.5, 3), w('Next', 4.2, 4.5), w('bit.', 4.5, 4.9)], map);
    expect(cues.map((c) => c.text)).toEqual(['Hello there.', 'Next bit.']);
    expect(cues[0].start).toBeCloseTo(0.35);
    expect(cues[1].start).toBeGreaterThanOrEqual(cues[0].end);
  });
  it('splits a long unpunctuated run by maxChars', () => {
    const ws = 'so today we are going to talk about privacy and why it matters for every single user'.split(' ').map((t, i) => w(t, i * 0.1, i * 0.1 + 0.08));
    const cues = buildCaptions(ws, map, { maxChars: 20 });
    expect(cues.length).toBeGreaterThan(3);
    expect(cues.every((c) => c.text.length <= 20)).toBe(true);
  });
  it('enforces a minimum duration without overlapping the next cue', () => {
    const cues = buildCaptions([w('Hi.', 0.5, 0.6), w('Yo.', 0.9, 1.0)], map);
    expect(cues[0].end).toBeLessThanOrEqual(cues[1].start);
    expect(cues[1].end - cues[1].start).toBeGreaterThanOrEqual(0.8 - 1e-9);
  });
  it('strips emoji', () => {
    expect(buildCaptions([w('Nice ✨.', 0.5, 0.9)], map)[0].text).toBe('Nice.');
  });
});

describe('toSrt', () => {
  it('writes numbered cues with comma milliseconds', () => {
    expect(toSrt([{ start: 0.05, end: 1.3, text: 'Hello there.' }, { start: 61.5, end: 62, text: 'Bye.' }])).toBe(
      '1\n00:00:00,050 --> 00:00:01,300\nHello there.\n\n2\n00:01:01,500 --> 00:01:02,000\nBye.\n',
    );
  });
});

describe('toAss', () => {
  it('writes a styled script sized to the frame', () => {
    const ass = toAss([{ start: 0.05, end: 1.3, text: 'Hello {there}' }], { width: 1920, height: 1080, font: 'Helvetica Neue' });
    expect(ass).toContain('PlayResX: 1920');
    expect(ass).toContain('PlayResY: 1080');
    expect(ass).toContain('Style: Default,Helvetica Neue,64,');
    expect(ass).toContain('Dialogue: 0,0:00:00.05,0:00:01.30,Default,,0,0,0,,Hello (there)');
  });
  it('sizes text from the short side so portrait video is not oversized', () => {
    expect(toAss([], { width: 1080, height: 1920, font: 'X' })).toContain('Style: Default,X,64,');
  });
  it('picks a platform font', () => {
    expect(defaultCaptionFont('darwin')).toBe('Helvetica Neue');
    expect(defaultCaptionFont('win32')).toBe('Segoe UI');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/autoedit/captions.test.ts`
Expected: FAIL — cannot find module `./captions.js`.

- [ ] **Step 3: Implement captions.ts**

`packages/core/src/autoedit/captions.ts`:
```ts
import type { Edl, Word } from '@wordedits/shared';
import { edlSegments } from '../edl-compiler.js';

export interface TimeMap {
  /** Output-time span of a source span, or null if its start was cut. Ends running into a cut are clamped. */
  span(start: number, end: number): { start: number; end: number } | null;
  durationSec: number;
}

const EPS = 1e-6;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function timelineMap(edl: Edl, fps: number): TimeMap {
  let out = 0;
  const table = edlSegments(edl, fps).map((s) => {
    const row = { srcStart: s.start, srcEnd: s.start + s.frames / fps, outStart: out };
    out += s.frames / fps;
    return row;
  });
  return {
    durationSec: out,
    span(start, end) {
      const row = table.find((r) => start >= r.srcStart - EPS && start < r.srcEnd - EPS);
      if (!row) return null;
      return {
        start: r3(row.outStart + Math.max(0, start - row.srcStart)),
        end: r3(row.outStart + (Math.min(end, row.srcEnd) - row.srcStart)),
      };
    },
  };
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export interface CaptionOptions {
  maxChars?: number;
  /** Start a new cue after a gap this long in output time. */
  maxGap?: number;
  /** Show each cue this long before its first word. */
  lead?: number;
  minDur?: number;
}

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const SENTENCE_END = /[.?!]["'”’)\]]*$/;

export function buildCaptions(words: Word[], map: TimeMap, opts: CaptionOptions = {}): Cue[] {
  const maxChars = opts.maxChars ?? 38;
  const maxGap = opts.maxGap ?? 0.6;
  const lead = opts.lead ?? 0.15;
  const minDur = opts.minDur ?? 0.8;

  const groups: { text: string; start: number; end: number }[][] = [];
  let cur: { text: string; start: number; end: number }[] = [];
  const flush = () => {
    if (cur.length) groups.push(cur);
    cur = [];
  };
  for (const word of words) {
    const text = word.w.replace(EMOJI, '').replace(/\s+([.,!?;:])/g, '$1').trim();
    if (!text) continue;
    const span = map.span(word.start, word.end);
    if (!span) continue;
    const last = cur[cur.length - 1];
    const joined = [...cur.map((x) => x.text), text].join(' ');
    if (last && (joined.length > maxChars || span.start - last.end > maxGap || SENTENCE_END.test(last.text))) flush();
    cur.push({ text, ...span });
  }
  flush();

  const cues: Cue[] = groups.map((g) => ({
    start: r3(Math.max(0, g[0].start - lead)),
    end: g[g.length - 1].end,
    text: g.map((x) => x.text).join(' ').replace(/\s+([.,!?;:])/g, '$1'),
  }));
  for (let i = 0; i < cues.length; i++) {
    if (i > 0) cues[i].start = Math.max(cues[i].start, cues[i - 1].end);
    const limit = i + 1 < cues.length ? cues[i + 1].start - lead : map.durationSec;
    cues[i].end = r3(Math.min(Math.max(cues[i].end, cues[i].start + minDur), Math.max(cues[i].end, limit)));
  }
  return cues;
}

function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

function assTime(sec: number): string {
  const cs = Math.round(sec * 100);
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

const assText = (t: string) => t.replace(/\\/g, '/').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, '\\N');

export function defaultCaptionFont(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'Helvetica Neue';
  if (platform === 'win32') return 'Segoe UI';
  return 'DejaVu Sans';
}

/** Spec §7: bold sans-serif, white on a 70 % black box, bottom-centre inside title-safe. */
export function toAss(cues: Cue[], opts: { width: number; height: number; font?: string }): string {
  const short = Math.min(opts.width, opts.height);
  const k = short / 1080;
  const size = Math.round(64 * k);
  const box = Math.round(18 * k);
  const marginV = Math.round(90 * k);
  const marginLR = Math.round(opts.width * 0.0625);
  const font = opts.font ?? defaultCaptionFont();
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${opts.width}`,
    `PlayResY: ${opts.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font},${size},&H00FFFFFF,&H00FFFFFF,&H4D000000,&H4D000000,-1,0,0,0,100,100,0,0,3,${box},0,2,${marginLR},${marginLR},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${assText(c.text)}`),
    '',
  ].join('\n');
}
```

Add to `packages/core/src/autoedit/index.ts`: `export * from './captions.js';`

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/core/src/autoedit/captions.test.ts`
Expected: all pass. If the minimum-duration test fails because the clamp lets a cue end inside the next cue's lead, adjust the clamp in `buildCaptions` (not the test): a cue never ends after the next cue's start.

- [ ] **Step 5: Full suite, typecheck, commit**

Run: `pnpm test && pnpm typecheck`

```bash
git add -A && git commit -m "feat(core): phrase captions on the output timeline with SRT and ASS writers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Chunked render with captions and music

**Files:**
- Create: `packages/core/src/render-plan.ts`, `packages/core/src/render-plan.test.ts`
- Modify: `packages/core/src/edl-compiler.ts` (export `ffNum`, extract `segmentChains` and `encodeArgs`, used by `buildFilterGraph`/`compileEdl` with identical output), `packages/core/src/render.ts`, `packages/core/src/render.test.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `edlSegments`, `EdlSegment`, `resolveFps`, `edlDuration`, `bitrateFor`, `EdlError` (compiler); `MediaTools` with `runFfmpeg(args, { cwd })` (Task 1).
- Produces (compiler): `ffNum(n: number): string`; `segmentChains(segs: EdlSegment[], o: { width: number; height: number; fps: number }): { chains: string[]; labels: string }`; `encodeArgs(o: { mode: 'preview' | 'final'; encoder: Encoder; width: number; height: number; fps: number }): string[]` (codec, pix_fmt, colour tags, audio codec, `-ar 48000 -ac 2`, `+faststart`).
- Produces (render-plan): `CHUNK_SEGMENTS = 30`; `chunkSegments(segs: EdlSegment[], size?: number): EdlSegment[][]`; `chunkArgs(segs: EdlSegment[], o: { input: string; output: string; width: number; height: number; fps: number }): string[]`; `interface FinalOptions { chunkList: string; output: string; encoder: Encoder; mode: 'preview' | 'final'; width: number; height: number; fps: number; durationSec: number; loudnessLufs: number; captionsFile?: string; fontsDir?: string; music?: { path: string; gainDb: number } }`; `finalArgs(o: FinalOptions): string[]`.
- Produces (render): `RenderOptions` gains `outputPath?: string`, `captionsAss?: string` (file content), `music?: { path: string; gainDb?: number }`; `renderEdl` renders in chunks; when neither captions nor music is given the default file name is unchanged (`<mode>-<edlHash>.mp4`), otherwise the hash also covers the captions text and music path.

- [ ] **Step 1: Refactor the compiler without changing its output**

In `packages/core/src/edl-compiler.ts`:
- rename the private `num` to an exported `ffNum` (same body) and update its uses;
- add
```ts
export function segmentChains(segs: EdlSegment[], o: { width: number; height: number; fps: number }): { chains: string[]; labels: string } {
  const chains: string[] = [];
  const labels: string[] = [];
  segs.forEach((seg, k) => {
    const S = seg.scene.zoom.scale;
    const { x: ax, y: ay } = seg.scene.zoom.anchor;
    const crop =
      S > 1 + EPS
        ? `crop=trunc(iw/${ffNum(S)}/2)*2:trunc(ih/${ffNum(S)}/2)*2:(iw-iw/${ffNum(S)})*${ffNum(ax)}:(ih-ih/${ffNum(S)})*${ffNum(ay)},`
        : '';
    chains.push(
      `[${k}:v]setpts=PTS-STARTPTS,${crop}scale=${o.width}:${o.height}:flags=bicubic,setsar=1,fps=${ffNum(o.fps)},` +
        `tpad=stop=-1:stop_mode=clone,trim=end_frame=${ffNum(seg.frames)},setpts=PTS-STARTPTS[v${k}]`,
    );
    chains.push(`[${k}:a]asetpts=PTS-STARTPTS,apad,atrim=end=${ffNum(seg.frames / o.fps)},asetpts=PTS-STARTPTS[a${k}]`);
    labels.push(`[v${k}][a${k}]`);
  });
  return { chains, labels: labels.join('') };
}

export function encodeArgs(o: { mode: 'preview' | 'final'; encoder: Encoder; width: number; height: number; fps: number }): string[] {
  const video =
    o.mode === 'preview'
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28']
      : ['-c:v', o.encoder.name, ...o.encoder.extraArgs, '-b:v', bitrateFor(o.width, o.height, o.fps), '-g', String(Math.round(o.fps * 2))];
  const audio = o.mode === 'preview' ? ['-c:a', 'aac', '-b:a', '128k'] : ['-c:a', 'aac', '-b:a', '384k'];
  return [
    ...video,
    '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    ...audio, '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
  ];
}
```
- make `buildFilterGraph` use `segmentChains` and `compileEdl` use `encodeArgs` (with `width/height` = `edl.output`), so their output is unchanged **except** `tpad=stop=1` becomes `tpad=stop=-1` (unlimited clone; `trim=end_frame` still bounds it — this closes the parked sub-project-1 finding about segments at the end of the source).

Run: `pnpm vitest run packages/core/src/edl-compiler.test.ts -u` and then read the regenerated snapshot: the only change must be `tpad=stop=1` → `tpad=stop=-1`. Update any test string that asserts `tpad=stop=1`.

- [ ] **Step 2: Write the failing render-plan test**

`packages/core/src/render-plan.test.ts`:
```ts
import { EdlSchema } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { edlSegments } from './edl-compiler.js';
import { CHUNK_SEGMENTS, chunkArgs, chunkSegments, finalArgs } from './render-plan.js';

const many = EdlSchema.parse({
  version: 1,
  output: { width: 640, height: 360, fps: 30 },
  scenes: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, src: { in: i * 0.14, out: i * 0.14 + 0.1 } })),
});
const enc = { name: 'libx264' as const, extraArgs: ['-preset', 'medium'] };

describe('chunkSegments', () => {
  it('splits into chunks of at most CHUNK_SEGMENTS', () => {
    const chunks = chunkSegments(edlSegments(many, 30));
    expect(CHUNK_SEGMENTS).toBe(30);
    expect(chunks.map((c) => c.length)).toEqual([30, 10]);
  });
});

describe('chunkArgs', () => {
  it('seeks each segment with a single-threaded decoder and writes PCM into a near-lossless intermediate', () => {
    const segs = edlSegments(many, 30).slice(0, 2);
    const args = chunkArgs(segs, { input: 'in.mp4', output: 'chunk-000.mov', width: 640, height: 360, fps: 30 });
    expect(args.slice(0, 8)).toEqual(['-threads', '1', '-ss', '0', '-t', '0.133333', '-i', 'in.mp4']);
    expect(args.filter((a) => a === '-i')).toHaveLength(2);
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-crf', '12', '-c:a', 'pcm_s16le']));
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('concat=n=2:v=1:a=1[vcat][acat]');
    expect(graph).not.toContain('loudnorm');
    expect(args.at(-1)).toBe('chunk-000.mov');
  });
});

describe('finalArgs', () => {
  const base = { chunkList: 'chunks.txt', output: '/abs/out.mp4', encoder: enc, mode: 'final' as const, width: 1920, height: 1080, fps: 30, durationSec: 12.5, loudnessLufs: -14 };

  it('concatenates chunks, applies the voice chain and encodes to YouTube spec', () => {
    const args = finalArgs(base);
    expect(args.slice(0, 6)).toEqual(['-f', 'concat', '-safe', '0', '-i', 'chunks.txt']);
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('[0:v]null[vout]');
    expect(graph).toContain('[0:a]highpass=f=90,loudnorm=I=-14:TP=-1:LRA=11,aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,asetpts=N/SR/TB[aout]');
    expect(args).toEqual(expect.arrayContaining(['-b:v', '8M', '-c:a', 'aac', '-movflags', '+faststart', '-t', '12.5']));
    expect(args.at(-1)).toBe('/abs/out.mp4');
  });

  it('burns captions by relative file name', () => {
    const graph = finalArgs({ ...base, captionsFile: 'captions.ass', fontsDir: '/System/Library/Fonts' }).find((a) => a.includes('[vout]'))!;
    expect(graph).toContain('[0:v]ass=captions.ass:fontsdir=/System/Library/Fonts[vout]');
  });

  it('loops, normalises, ducks and mixes music under the voice', () => {
    const args = finalArgs({ ...base, music: { path: '/m/song.mp3', gainDb: -22 } });
    expect(args).toEqual(expect.arrayContaining(['-stream_loop', '-1', '-i', '/m/song.mp3']));
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('[voice]asplit=2[vmix][vkey]');
    expect(graph).toContain('[1:a]atrim=duration=12.5,asetpts=PTS-STARTPTS');
    expect(graph).toContain('loudnorm=I=-36:TP=-2:LRA=11');
    expect(graph).toContain('[mus][vkey]sidechaincompress=threshold=0.03:ratio=6:attack=200:release=800[duck]');
    expect(graph).toContain('[vmix][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.891:level=false[aout]');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/render-plan.test.ts`
Expected: FAIL — cannot find module `./render-plan.js`.

- [ ] **Step 4: Implement render-plan.ts**

`packages/core/src/render-plan.ts`:
```ts
import { encodeArgs, ffNum, segmentChains, type EdlSegment } from './edl-compiler.js';
import type { Encoder } from './media-tools.js';

/** Keeps every ffmpeg process far below the Windows command-line cap and the macOS thread limit. */
export const CHUNK_SEGMENTS = 30;

export function chunkSegments(segs: EdlSegment[], size = CHUNK_SEGMENTS): EdlSegment[][] {
  const out: EdlSegment[][] = [];
  for (let i = 0; i < segs.length; i += size) out.push(segs.slice(i, i + size));
  return out;
}

/** Renders up to CHUNK_SEGMENTS segments to a near-lossless intermediate with PCM audio. */
export function chunkArgs(segs: EdlSegment[], o: { input: string; output: string; width: number; height: number; fps: number }): string[] {
  // One extra frame of input so the fps filter never comes up short; one decoder thread per input.
  const inputs = segs.flatMap((s) => ['-threads', '1', '-ss', ffNum(s.start), '-t', ffNum((s.frames + 1) / o.fps), '-i', o.input]);
  const { chains, labels } = segmentChains(segs, o);
  const graph = [...chains, `${labels}concat=n=${segs.length}:v=1:a=1[vcat][acat]`].join(';');
  return [
    ...inputs,
    '-filter_complex', graph,
    '-map', '[vcat]', '-map', '[acat]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-g', String(Math.round(o.fps)),
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    o.output,
  ];
}

export interface FinalOptions {
  /** Concat-demuxer list, relative to the ffmpeg working directory. */
  chunkList: string;
  output: string;
  encoder: Encoder;
  mode: 'preview' | 'final';
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  loudnessLufs: number;
  /** ASS file name relative to the ffmpeg working directory (never a path with special characters). */
  captionsFile?: string;
  fontsDir?: string;
  music?: { path: string; gainDb: number };
}

const VOICE_FORMAT = 'aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo';

export function finalArgs(o: FinalOptions): string[] {
  const inputs = ['-f', 'concat', '-safe', '0', '-i', o.chunkList];
  if (o.music) inputs.push('-stream_loop', '-1', '-i', o.music.path);

  const video = o.captionsFile ? `ass=${o.captionsFile}${o.fontsDir ? `:fontsdir=${o.fontsDir}` : ''}` : 'null';
  const chains = [
    `[0:v]${video}[vout]`,
    `[0:a]highpass=f=90,loudnorm=I=${ffNum(o.loudnessLufs)}:TP=-1:LRA=11,${VOICE_FORMAT},asetpts=N/SR/TB${o.music ? '[voice]' : '[aout]'}`,
  ];
  if (o.music) {
    chains.push(
      '[voice]asplit=2[vmix][vkey]',
      `[1:a]atrim=duration=${ffNum(o.durationSec)},asetpts=PTS-STARTPTS,loudnorm=I=${ffNum(o.loudnessLufs + o.music.gainDb)}:TP=-2:LRA=11,${VOICE_FORMAT}[mus]`,
      '[mus][vkey]sidechaincompress=threshold=0.03:ratio=6:attack=200:release=800[duck]',
      '[vmix][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.891:level=false[aout]',
    );
  }
  return [
    ...inputs,
    '-filter_complex', chains.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    ...encodeArgs(o),
    '-t', ffNum(o.durationSec),
    o.output,
  ];
}
```
Add to `packages/core/src/index.ts`: `export * from './render-plan.js';`

Run: `pnpm vitest run packages/core/src/render-plan.test.ts` — expect pass.

- [ ] **Step 5: Write failing render tests for chunking, captions and music**

Append to `packages/core/src/render.test.ts` (reuse its `tools` from `beforeAll`, imports `mkdtemp`, `tmpdir`, `join`; add `writeFile`, `readdir` from `node:fs/promises` and `run` from `@wordedits/sidecars` to the imports where needed):
```ts
describe('renderEdl in chunks', () => {
  it('renders an EDL with more than CHUNK_SEGMENTS segments within tolerance', async () => {
    const edl40 = EdlSchema.parse({
      version: 1,
      output: { width: 640, height: 360, fps: 30 },
      scenes: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, src: { in: i * 0.14, out: i * 0.14 + 0.1 } })),
    });
    const dir = await mkdtemp(join(tmpdir(), 'we-chunks-'));
    const r = await renderEdl({ edl: edl40, input: 'fixtures/tone-6s.mp4', outputDir: dir, mode: 'preview', tools });
    expect(Math.abs(r.probe.durationSec - r.expectedDurationSec)).toBeLessThanOrEqual(0.1);
    expect((await readdir(dir)).filter((f) => f.includes('.work-') || f.includes('.partial-'))).toEqual([]);
  });

  it('burns captions in a directory with quotes, spaces and non-ASCII characters', async () => {
    const dir = await mkdtemp(join(tmpdir(), "we caps 'q' ✨ "));
    const src = join(dir, 'black.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
    const simple = EdlSchema.parse({ version: 1, output: { width: 640, height: 360, fps: 30 }, scenes: [{ id: 's0', src: { in: 0, out: 3 } }] });
    const ass = toAss([{ start: 0, end: 3, text: 'CAPTION TEST' }], { width: 640, height: 360 });
    const withCaps = await renderEdl({ edl: simple, input: src, outputDir: dir, outputPath: join(dir, "out 'caps'.mp4"), mode: 'final', tools, captionsAss: ass });
    const lum = async (file: string) => {
      const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '1.5', '-i', file, '-frames:v', '1', '-vf', 'crop=iw:ih*0.25:0:ih*0.75,format=gray,scale=1:1', '-f', 'rawvideo', '-']);
      return stdout.charCodeAt(0);
    };
    expect(withCaps.outputPath).toBe(join(dir, "out 'caps'.mp4"));
    expect(await lum(withCaps.outputPath)).toBeGreaterThan(20);
  });

  it('mixes ducked music under the voice at the target loudness', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-music-'));
    const r = await renderEdl({ edl, input: 'fixtures/tone-6s.mp4', outputDir: dir, mode: 'final', tools, music: { path: 'fixtures/tone-6s-2997.mp4' } });
    expect(Math.abs(r.probe.durationSec - r.expectedDurationSec)).toBeLessThanOrEqual(0.1);
    const loud = await tools.measureLoudness(r.outputPath);
    expect(loud.integratedLufs).toBeGreaterThan(-15.5);
    expect(loud.integratedLufs).toBeLessThan(-12.5);
    expect(loud.truePeakDb).toBeLessThanOrEqual(-0.5);
    expect(r.outputPath).not.toBe(join(dir, `final-${edlHash(edl)}.mp4`));
  });
});
```
(import `toAss` from `./autoedit/captions.js`; `stdout` from `run` is a string — reading one byte with `charCodeAt(0)` works because the raw frame is a single gray byte; if execa returns it re-encoded, switch the call to `encoding: 'buffer'` through a small `runFfmpegRaw` helper inside the test instead of changing `run`.)

Existing stub tests in this file assert "the write target was a `.partial-` file" for the ffmpeg-failure path; with chunking the first ffmpeg call writes a chunk. Change that assertion to: the first write target is inside a directory whose name contains `.work-`; after the rejection no `.partial-` file and no `.work-` directory remain in the output directory; a pre-existing output file is untouched. Keep every other assertion.

- [ ] **Step 6: Run to verify they fail**

Run: `pnpm vitest run packages/core/src/render.test.ts`
Expected: the three new tests FAIL (unknown options / single-pass render ignores them).

- [ ] **Step 7: Rewrite renderEdl around chunks**

In `packages/core/src/render.ts`: keep `RenderError`, `edlHash`, `flatten`, `RenderResult`, `durationToleranceSec`; replace `RenderOptions` and `renderEdl` with:
```ts
export interface RenderOptions {
  edl: Edl;
  input: string;
  outputDir: string;
  mode: 'preview' | 'final';
  tools: MediaTools;
  onProgress?: (fraction: number) => void;
  /** Explicit output file; default `<outputDir>/<mode>-<key>.mp4`. */
  outputPath?: string;
  /** ASS caption script to burn in. */
  captionsAss?: string;
  music?: { path: string; gainDb?: number };
}

function renderKey(opts: RenderOptions): string {
  const base = edlHash(opts.edl);
  if (!opts.captionsAss && !opts.music) return base;
  return createHash('sha256')
    .update(JSON.stringify([base, opts.captionsAss ?? '', opts.music ? resolve(opts.music.path) : '', opts.music?.gainDb ?? null]))
    .digest('hex')
    .slice(0, 8);
}

const pad3 = (i: number) => String(i).padStart(3, '0');

export async function renderEdl(opts: RenderOptions): Promise<RenderResult> {
  const { tools } = opts;
  const src = await tools.probe(opts.input);
  if (!src.hasVideo) throw new RenderError('NO_VIDEO', 'The source file has no video stream', 'Choose a video file.');
  if (!src.hasAudio) {
    throw new RenderError('NO_AUDIO', 'The source file has no audio track', 'WordEdits needs your voice to cut the video. Re-export the recording with audio.');
  }

  try {
    const fps = resolveFps(opts.edl, src.fps);
    const segs = edlSegments(opts.edl, fps);
    const expected = segs.reduce((sum, s) => sum + s.frames / fps, 0);
    const [width, height] = opts.mode === 'preview' ? [960, 540] : [opts.edl.output.width, opts.edl.output.height];
    const encoder = opts.mode === 'final' ? await tools.pickEncoder() : { name: 'libx264' as const, extraArgs: [] };
    const outputPath = resolve(opts.outputPath ?? join(opts.outputDir, `${opts.mode}-${renderKey(opts)}.mp4`));
    await mkdir(dirname(outputPath), { recursive: true });
    const id = randomUUID();
    const work = `${outputPath}.work-${id}`;
    // Render beside the target and rename over it only once verified, so a failed
    // re-render never destroys a previous good output.
    const partialPath = `${outputPath}.partial-${id}.mp4`;
    await mkdir(work, { recursive: true });
    const report = (f: number) => opts.onProgress?.(Math.min(1, Math.max(0, f)));

    try {
      const chunks = chunkSegments(segs);
      let done = 0;
      for (const [i, chunk] of chunks.entries()) {
        const dur = chunk.reduce((sum, s) => sum + s.frames / fps, 0);
        await tools.runFfmpeg(chunkArgs(chunk, { input: opts.input, output: join(work, `chunk-${pad3(i)}.mov`), width, height, fps }), {
          expectedDurationSec: dur,
          timeoutMs: Math.max(60_000, dur * 20 * 1000),
          onProgress: (f) => report((0.7 * (done + f * dur)) / expected),
        });
        done += dur;
      }
      await writeFile(join(work, 'chunks.txt'), chunks.map((_, i) => `file 'chunk-${pad3(i)}.mov'`).join('\n') + '\n');
      if (opts.captionsAss) await writeFile(join(work, 'captions.ass'), opts.captionsAss);

      await tools.runFfmpeg(
        finalArgs({
          chunkList: 'chunks.txt',
          output: partialPath,
          encoder,
          mode: opts.mode,
          width,
          height,
          fps,
          durationSec: expected,
          loudnessLufs: opts.edl.audio.loudnessLufs,
          captionsFile: opts.captionsAss ? 'captions.ass' : undefined,
          fontsDir: process.platform === 'darwin' ? '/System/Library/Fonts' : undefined,
          music: opts.music ? { path: resolve(opts.music.path), gainDb: opts.music.gainDb ?? -22 } : undefined,
        }),
        { cwd: work, expectedDurationSec: expected, timeoutMs: Math.max(60_000, expected * 20 * 1000), onProgress: (f) => report(0.7 + 0.3 * f) },
      );
      const probe = await tools.probe(partialPath);
      if (Math.abs(probe.durationSec - expected) > durationToleranceSec(fps)) {
        throw new RenderError('DURATION_MISMATCH', `Rendered ${probe.durationSec}s but expected ${expected}s`, 'The source may be shorter than the EDL assumes. Re-import the file.');
      }
      await rename(partialPath, outputPath);
      report(1);
      return { outputPath, expectedDurationSec: expected, probe };
    } catch (e) {
      // Cleanup must never replace the original error.
      await rm(partialPath, { force: true }).catch(() => {});
      throw e;
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  } catch (e) {
    if (e instanceof EdlError) throw new RenderError('EDL', e.message, e.hint, e);
    throw e;
  }
}
```
Update imports: `import { dirname, join, resolve } from 'node:path'`, add `writeFile` to `node:fs/promises`, `import { EdlError, edlSegments, resolveFps } from './edl-compiler.js'`, `import { chunkArgs, chunkSegments, finalArgs } from './render-plan.js'`. `compileEdl`/`edlDuration` are no longer used by render; leave them exported from the compiler (the review stage may still use single-pass previews).

- [ ] **Step 8: Run render tests, full suite, typecheck**

Run: `pnpm vitest run packages/core/src/render.test.ts && pnpm test && pnpm typecheck`
Expected: all green; the original two-scene final render still measures 4.1 s and −14 ± 1 LUFS. If the music test's loudness falls outside the range, report the measured value and the graph; do not widen the bounds without recording why.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(core): chunked renders with burned-in captions and ducked music

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The `pnpm edit` pipeline and CLI

**Files:**
- Create: `packages/core/src/autoedit/pipeline.ts`, `packages/core/src/autoedit/pipeline.test.ts`, `scripts/edit.ts`
- Modify: `packages/core/src/autoedit/index.ts`, `README.md`

**Interfaces:**
- Consumes: everything above; `readJsonFile`/`writeJsonFile` from `project-store.ts`; `TranscriptSchema`, `EdlSchema`.
- Produces: `interface AutoEditOptions { input: string; scriptText?: string; pace: Pace; music?: string; captions: boolean; outDir?: string; edlPath?: string; locale?: string; onStep?: (message: string) => void; onProgress?: (fraction: number) => void }`; `interface AutoEditResult { outputPath: string; srtPath: string; edlPath: string; reportPath: string; transcriptPath: string; sourceDurationSec: number; editedDurationSec: number; cuts: number }`; `autoEdit(o: AutoEditOptions, tools: MediaTools): Promise<AutoEditResult>`.

Output folder: `<input dir>/<input name>.wordedits/` (or `--out`), containing `<input name>-edited.mp4`, `<input name>.srt`, `edl.json`, `transcript.json`, `transcript.key`, `report.md`. Re-running reuses `transcript.json` while the input's size, mtime and locale are unchanged. `--edl` renders the given EDL instead of planning cuts (for edits made by hand or in chat).

- [ ] **Step 1: Write the failing test**

`packages/core/src/autoedit/pipeline.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { realMediaTools, type MediaTools } from '../media-tools.js';
import { autoEdit } from './pipeline.js';

const mac = process.platform === 'darwin';
const SCRIPT = 'Welcome to WordEdits. This is scene one, the hook. Now scene two explains how the app cuts your take.';

describe.skipIf(!mac)('autoEdit (macOS)', () => {
  let tools: MediaTools;
  beforeAll(async () => {
    tools = await realMediaTools();
    const s = await import('@wordedits/sidecars');
    if (!existsSync(s.transcriberPath())) execFileSync('pnpm', ['build:native'], { stdio: 'inherit' });
  }, 300_000);

  it('cuts the retake, the restart cue, the fillers and the long pause, with captions', async () => {
    const dir = await mkdtemp(join(tmpdir(), "we edit 'q' ✨ "));
    const input = join(dir, "my take 'one'.mp4");
    await copyFile('fixtures/speech-retake.mp4', input);
    const steps: string[] = [];
    const r = await autoEdit({ input, scriptText: SCRIPT, pace: 'natural', captions: true, onStep: (m) => steps.push(m) }, tools);

    expect(r.outputPath).toBe(join(dir, "my take 'one'.wordedits", "my take 'one'-edited.mp4"));
    expect(r.editedDurationSec).toBeLessThan(r.sourceDurationSec - 2);
    const out = await tools.probe(r.outputPath);
    expect(Math.abs(out.durationSec - r.editedDurationSec)).toBeLessThanOrEqual(0.1);
    expect([out.width, out.height]).toEqual([640, 360]);

    const srt = await readFile(r.srtPath, 'utf8');
    expect(srt.match(/hook/gi)).toHaveLength(1);
    expect(srt.toLowerCase()).not.toContain('say that again');
    const report = await readFile(r.reportPath, 'utf8');
    expect(report).toMatch(/restart cue/);
    expect(report).toMatch(/retake/);
    expect(report).toMatch(/Pauses shortened: [1-9]/);
    expect(steps.some((m) => /transcrib/i.test(m))).toBe(true);
  }, 300_000);

  it('reuses the transcript on a second run and renders a hand-edited EDL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-edit-2-'));
    const input = join(dir, 'take.mp4');
    await copyFile('fixtures/speech-retake.mp4', input);
    const first = await autoEdit({ input, pace: 'fast', captions: false }, tools);
    const steps: string[] = [];
    const second = await autoEdit({ input, pace: 'fast', captions: false, edlPath: first.edlPath, onStep: (m) => steps.push(m) }, tools);
    expect(steps.some((m) => /transcrib/i.test(m))).toBe(false);
    expect(second.editedDurationSec).toBeCloseTo(first.editedDurationSec, 1);
  }, 300_000);

  it('reports NO_SPEECH for a silent take', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-silent-'));
    await expect(autoEdit({ input: 'fixtures/silent-6s.mp4', outDir: dir, pace: 'natural', captions: true }, tools)).rejects.toMatchObject({
      code: 'NO_SPEECH',
      hint: expect.stringContaining('microphone'),
    });
  }, 300_000);

  it('reports BAD_MUSIC for a music file without audio', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'we-badmusic-'));
    await expect(
      autoEdit({ input: 'fixtures/speech-retake.mp4', outDir: dir, pace: 'natural', captions: false, music: 'fixtures/noaudio-6s.mp4' }, tools),
    ).rejects.toMatchObject({ code: 'BAD_MUSIC' });
  }, 300_000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/autoedit/pipeline.test.ts`
Expected: FAIL — cannot find module `./pipeline.js`.

- [ ] **Step 3: Implement pipeline.ts**

`packages/core/src/autoedit/pipeline.ts`:
```ts
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { EdlSchema, TranscriptSchema, type Edl, type Transcript } from '@wordedits/shared';
import { edlDuration } from '../edl-compiler.js';
import type { MediaTools } from '../media-tools.js';
import { readJsonFile, writeJsonFile } from '../project-store.js';
import { RenderError, renderEdl } from '../render.js';
import { buildCaptions, timelineMap, toAss, toSrt } from './captions.js';
import { AutoEditError } from './errors.js';
import { formatReport, planCuts, type Pace } from './plan.js';
import { detectRetakes, isFiller, splitSentences } from './takes.js';

export interface AutoEditOptions {
  input: string;
  scriptText?: string;
  pace: Pace;
  music?: string;
  captions: boolean;
  outDir?: string;
  /** Render this EDL instead of planning cuts (edits made by hand or in chat). */
  edlPath?: string;
  locale?: string;
  onStep?: (message: string) => void;
  onProgress?: (fraction: number) => void;
}

export interface AutoEditResult {
  outputPath: string;
  srtPath: string;
  edlPath: string;
  reportPath: string;
  transcriptPath: string;
  sourceDurationSec: number;
  editedDurationSec: number;
  cuts: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function autoEdit(o: AutoEditOptions, tools: MediaTools): Promise<AutoEditResult> {
  const step = (m: string) => o.onStep?.(m);
  const input = resolve(o.input);
  const name = basename(input, extname(input));
  const dir = resolve(o.outDir ?? join(dirname(input), `${name}.wordedits`));
  await mkdir(dir, { recursive: true });

  const src = await tools.probe(input);
  if (!src.hasVideo) throw new RenderError('NO_VIDEO', 'The file has no video stream', 'Choose a video file.');
  if (!src.hasAudio) throw new RenderError('NO_AUDIO', 'The file has no audio track', 'WordEdits needs your voice to cut the video. Re-export the recording with audio.');

  let music: string | undefined;
  if (o.music) {
    music = resolve(o.music);
    const m = await tools.probe(music).catch(() => null);
    if (!m?.hasAudio) throw new AutoEditError('BAD_MUSIC', `The music file has no audio: ${o.music}`, 'Choose an audio file such as .mp3, .m4a or .wav.');
  }

  // Transcript, cached while the input is unchanged.
  const locale = o.locale ?? 'en-US';
  const st = await stat(input);
  const key = `${st.size}-${Math.round(st.mtimeMs)}-${locale}`;
  const transcriptPath = join(dir, 'transcript.json');
  const keyPath = join(dir, 'transcript.key');
  let transcript: Transcript;
  if ((await readText(keyPath)) === key && (await readText(transcriptPath)) !== null) {
    transcript = await readJsonFile(transcriptPath, TranscriptSchema);
  } else {
    step('Transcribing your take (on this Mac)…');
    const wav = join(dir, 'audio.wav');
    await tools.extractWav(input, wav);
    try {
      transcript = await tools.transcribe(wav, { locale });
    } finally {
      await rm(wav, { force: true });
    }
    await writeJsonFile(transcriptPath, TranscriptSchema, transcript);
    await writeFile(keyPath, key);
  }
  if (transcript.words.length === 0) {
    throw new AutoEditError('NO_SPEECH', 'No speech was found in the recording', 'Check that the microphone was on and the right file was chosen.');
  }

  step('Finding retakes, fillers and long pauses…');
  const fps = src.fps > 0 ? src.fps : 30;
  const sentences = splitSentences(transcript.words);
  const retakes = detectRetakes(sentences, transcript.words, { scriptText: o.scriptText });
  const plan = planCuts({
    transcript,
    sentences,
    retakes,
    pace: o.pace,
    sourceDurationSec: src.durationSec,
    output: { width: even(src.width), height: even(src.height), fps },
  });

  let edl: Edl = o.edlPath ? await readJsonFile(resolve(o.edlPath), EdlSchema) : plan.edl;
  edl = { ...edl, audio: { ...edl.audio, music: music ? { track: music, gainDb: edl.audio.music?.gainDb ?? -22, duck: true } : null } };
  const edlPath = join(dir, 'edl.json');
  await writeJsonFile(edlPath, EdlSchema, edl);

  const map = timelineMap(edl, fps);
  const cues = buildCaptions(transcript.words.filter((w) => !isFiller(w)), map, { maxChars: edl.captions.maxChars });
  const srtPath = join(dir, `${name}.srt`);
  await writeFile(srtPath, toSrt(cues));

  const reportPath = join(dir, 'report.md');
  await writeFile(reportPath, o.edlPath ? `# ${name}\n\nRendered from ${o.edlPath} (hand-edited EDL).\n` : formatReport(plan, { title: name }));

  step('Rendering…');
  const result = await renderEdl({
    edl,
    input,
    outputDir: dir,
    outputPath: join(dir, `${name}-edited.mp4`),
    mode: 'final',
    tools,
    captionsAss: o.captions ? toAss(cues, { width: edl.output.width, height: edl.output.height }) : undefined,
    music: music ? { path: music, gainDb: edl.audio.music?.gainDb } : undefined,
    onProgress: o.onProgress,
  });

  return {
    outputPath: result.outputPath,
    srtPath,
    edlPath,
    reportPath,
    transcriptPath,
    sourceDurationSec: src.durationSec,
    editedDurationSec: edlDuration(edl, fps),
    cuts: o.edlPath ? edl.scenes.reduce((n, s) => n + s.cuts.length, edl.scenes.length - 1) : plan.cuts.length,
  };
}
```
Add to `packages/core/src/autoedit/index.ts`: `export * from './pipeline.js';`

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/core/src/autoedit/pipeline.test.ts`
Expected: all pass. If the SRT contains "hook" twice, inspect `report.md` and `transcript.json`: the earlier take must be listed as a retake; fix detection or planning, not the test.

- [ ] **Step 5: Write the CLI**

`scripts/edit.ts`:
```ts
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { autoEdit, formatTime, realMediaTools, type Pace } from '@wordedits/core';

const USAGE = `usage: pnpm edit <take.mp4> [options]

  --script <file>     the script you read (finds retakes more reliably)
  --pace <p>          natural (default) | fast | extra-fast
  --music <file>      background music, ducked under your voice
  --no-captions       do not burn captions in (an .srt is always written)
  --edl <file>        render this edited EDL instead of planning cuts
  --out <dir>         output folder (default: <take>.wordedits next to the take)
  --locale <id>       speech language, default en-US
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    script: { type: 'string' },
    pace: { type: 'string', default: 'natural' },
    music: { type: 'string' },
    'no-captions': { type: 'boolean', default: false },
    edl: { type: 'string' },
    out: { type: 'string' },
    locale: { type: 'string', default: 'en-US' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const input = positionals[0];
const pace = values.pace as Pace;
if (values.help || !input || !['natural', 'fast', 'extra-fast'].includes(pace)) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}

let lastPct = -1;
try {
  const r = await autoEdit(
    {
      input,
      scriptText: values.script ? await readFile(values.script, 'utf8') : undefined,
      pace,
      music: values.music,
      captions: !values['no-captions'],
      edlPath: values.edl,
      outDir: values.out,
      locale: values.locale,
      onStep: (m) => console.log(`• ${m}`),
      onProgress: (f) => {
        const pct = Math.floor(f * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          process.stdout.write(`\r  ${pct}%`);
        }
      },
    },
    await realMediaTools(),
  );
  console.log(`\n✓ ${formatTime(r.sourceDurationSec)} → ${formatTime(r.editedDurationSec)} (${r.cuts} cuts)`);
  console.log(`  video:    ${r.outputPath}`);
  console.log(`  captions: ${r.srtPath}`);
  console.log(`  report:   ${r.reportPath}`);
  console.log(`  edl:      ${r.edlPath}`);
} catch (e) {
  const err = e as { message?: string; hint?: string };
  console.error(`\n✖ ${err.message ?? String(e)}`);
  if (err.hint) console.error(`  ${err.hint}`);
  process.exit(1);
}
```

Try it:
```bash
pnpm edit fixtures/speech-retake.mp4 --out fixtures/tmp/cli-demo
```
Expected: steps printed, progress to 100 %, a summary line like `✓ 0:13 → 0:08 (6 cuts)`, and the four paths. Run `pnpm edit` with no arguments: usage text, exit code 2.

- [ ] **Step 6: Document it in the README**

Add a section after the title paragraph of `README.md`:
````markdown
## Edit a video (macOS 26+)

```bash
pnpm install
pnpm build:native                     # once: builds the on-device transcriber
pnpm edit ~/Movies/take.mp4 --script script.md --music song.mp3
```

You get `take.wordedits/` next to the take: `take-edited.mp4` (ready to upload), `take.srt`, `report.md` (every cut and why), `edl.json` and `transcript.json`.

- `--pace fast` or `--pace extra-fast` for tighter cuts.
- To change an edit, adjust `edl.json` (or ask Claude to) and run `pnpm edit take.mp4 --edl take.wordedits/edl.json`. The transcript is reused, so this only re-renders.
- Only hesitation sounds (um, uh, er, ah, hmm) are removed automatically; retakes are found by repeated sentences, restart phrases like "let me say that again", and your script when given.
````

- [ ] **Step 7: Full suite, typecheck, commit**

Run: `pnpm test && pnpm typecheck`

```bash
git add -A && git commit -m "feat: pnpm edit — auto-edit a take into a captioned, YouTube-ready video

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
