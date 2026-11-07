# Video Formats (Build Story, Short, Vlog) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every video has a format — build story, short or vlog, with more added later as files — picked from how the person describes the video; the format decides the beats, length target, caption and output defaults, and the editing rules Claude follows, and `check` holds the edit to it.

**Architecture:** Each format is one Markdown file in `plugin/formats/<id>.md`: a JSON front matter block (what the engine checks and the new-video defaults) and a body of rules for Claude. A loader validates them; a new engine tool `formats` lists them and returns one's rules. `video.json` gains `format` (and `from`, `vlog`, `targetSec`); `new_video` takes them; `beat` becomes any lower-case word; `check` warns against the video's format (beats, length, the short's hook/loop/pointer rules, the Shorts/Reels covered areas). The edit skill tells Claude how to pick, announce and follow a format.

**Tech Stack:** TypeScript, zod 4, vitest, pnpm monorepo. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-06-editing-tools-and-vlog-design.md`, part 5.

## Global Constraints
- Existing videos and episodes: unchanged files, unchanged `check` output (a `video.json` without `format` is a build story; every existing beat name stays valid).
- Front matter is a **JSON object** between `---` lines (my call: no YAML library to add; the spec's example is YAML-like, the keys are the same). `FormatSchema` (strict): `id` (`/^[a-z][a-z0-9-]*$/`, equal to the file name), `name`, `describe`, `words: string[]`, `beats: string[]` (non-empty, each a beat word), `targetSec?: number`, `warnPastSec?: number`, `output?: { width, height }` (even), `captions?: Captions` (the existing schema), `short?: { kind: 'teaser' | 'standalone' }` (default kind for shorts). A file that fails validation is reported by `formats` and `check` as ✖ `plugin/formats/<file>: <issue>` and skipped, never crashing the engine.
- Formats folder: the plugin's `plugin/formats/` (bundle: `<dist>/../formats`; source: the repo's `plugin/formats`, as `bundledFontsDir` does), and nowhere else.
- `beat` (items): `string().regex(/^[a-z][a-z0-9-]*$/)` instead of the fixed enum.
- `video.json` (all optional, absent = as today): `format?: string` (a format id; unknown id → `check` ✖ `video.json: unknown format "<id>"` with hint listing the ids), `from?: number` (the big video a short was made from), `vlog?: { name: string; number: number; date: string }`, `targetSec?: number` (overrides the format's).
- `new_video` gains optional `format`, `from`, `vlog`, `targetSec`:
  - `from: n` copies video n's `footage`, `about`, `mention`, `hide` (the caller may still pass `about`/`mention`/`hide` to add to them); `format` defaults to `short` when `from` is given; ✖ when video n doesn't exist.
  - `vlog.number` defaults to one more than the highest `vlog.number` among the project's vlog videos (1 if none).
  - The reply names the format and its beats: `video <n> created (format <id>: <beat> → <beat> → …)`.
- Engine tool `formats { id? }`: without `id`, one line per format `<id> — <name>: <describe> (words: …)`; with `id`, the whole file. Works without a project.
- `status` adds a `Formats: <id>, <id>, …` line.
- `check` warnings (exact; only for videos with a `format`, except the beat one which also runs for build stories but only for beats not in the old enum):
  - `item <id>'s beat "<beat>" isn't one of the <name> format's beats (<b1>, <b2>, …)`
  - `the video is <m:ss>, longer than the <name> format's <m:ss> — cut whole bits rather than thinning laughs` (past `warnPastSec`)
  - short: `a short opens on its hook: item <id> starts with <s> s of silence` (first item, live sound, first speech word after 0.5 s; skipped when the first item has no kept sound), `a short opens on its hook, not a <beat>: item <id>` (first beat `title` or `cold-open`), `a short has no outro: item <id>`, standalone only `a standalone short loops: the last music cue fades out at the end — set its fadeOut to 0`, teaser only `a teaser short ends pointing to the full video: add a pointer beat at the end`.
  - Shorts covered areas (vertical outputs only; Instagram's buttons cover more than YouTube's): bottom 20%, top 10%, right 15% of the frame. `<what> falls where the Shorts and Reels buttons cover it (<area>) — move it` for: overlays by kind using their style's anchor box (top-anchored kinds `badge`, `counter`, `before`, `after`, `timecard` → top; bottom-anchored `label`, `name`, `subtitle` → bottom when their box reaches into the bottom 20%; right-aligned `badge` → right), and `captions.position: 'bottom'`. `<what>` is `overlay <k> ("<text>")` or `captions at the bottom`.
- Cross-platform; commits with `git commit -s` ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; nothing pushed.

## Review Focus
- **A format file with a typo** (invalid JSON, unknown key, an id not matching its file name): one clear ✖ naming the file; the other formats still load; `check` of a video using another format still works. Pinned in Task 1.
- **A video.json from before formats, opened and saved by `new_video`/`check`/`versions`:** no key added. Pinned in Task 1.
- **`new_video { from: 3 }` where video 3 is itself a short:** allowed (a short of a short is odd but harmless); `format` defaults to short; footage copied. Pinned in Task 2.
- **Overlay safe-area check on a 16:9 video:** never warns (vertical only). Pinned in Task 2.
- **A short whose first item is a card:** no silence warning (no kept sound); the beat warning still applies. Pinned in Task 2.

---

### Task 1: Format files, the loader, `formats`, and the open beat word

**Files:**
- Create: `plugin/formats/build-story.md`, `plugin/formats/short.md`, `plugin/formats/vlog.md` (front matter now; bodies in Task 3 — a one-line body is fine here)
- Create: `packages/core/src/mirage/formats.ts`; Modify: `packages/shared/src/schemas/{episode,video}.ts`, `packages/mcp/src/server.ts` (`formats` tool, `TOOL_NAMES`, status line), `packages/hooks/src/policy.ts` (a label; not a stage), `scripts/build-plugin.ts` if the plugin's files need listing
- Test: `formats.test.ts`, `episode.test.ts`, `video.test.ts`, `server.test.ts`

**Interfaces:**
- Produces: `FormatSchema`, `type Format = { …front matter; rules: string; file: string }`; `formatsDir(from?: string): string`; `loadFormats(dir?: string): { formats: Format[]; problems: string[] }`; `formatOf(video: Video | null, formats: Format[]): Format` (build-story when absent).
- Front matter values (exact):
  - build-story: `{"id":"build-story","name":"Build story","describe":"A build told as a story: the stakes, the failures, a montage, the reveal.","words":["build","episode","part","series","project","devlog"],"beats":["cold-open","title","recap","new-toy","problem","montage","twist","truth","outro","blooper"],"output":{"width":1920,"height":1080}}`
  - short: `{"id":"short","name":"Short","describe":"20–45 s vertical video that opens on its hook; made from a big video it's a teaser pointing to it.","words":["short","shorts","reel","reels","tiktok","teaser","clip"],"beats":["hook","tease","pointer","payoff","loop"],"targetSec":45,"warnPastSec":60,"output":{"width":1080,"height":1920},"captions":{"style":"pop","position":"middle"},"short":{"kind":"teaser"}}`
  - vlog: `{"id":"vlog","name":"Vlog","describe":"A day or a week of someone's life told as a few funny bits, ending on the headline bit.","words":["vlog","day in the life","trip","week","hanging out","weekend"],"beats":["cold-open","title-card","premise","bit","headline","sponsor","plugs","tag"],"targetSec":260,"warnPastSec":400,"output":{"width":1920,"height":1080},"captions":{"style":"chosen"}}`

- [ ] **Step 1: Write the failing tests:** the three files load and validate; a broken file (bad JSON / unknown key / id ≠ file name) gives one exact ✖ and the rest load; `formats` without and with `id`; `status` lists formats; `beat: "title-card"` parses, `"Title Card"` doesn't; every old beat still parses; a `video.json` without the new keys round-trips byte-identically; `formatOf` defaults to build-story.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.** The plugin must ship `plugin/formats/` (check how the plugin folder is packaged; the bundle test may need the folder listed).
- [ ] **Step 4: Run** `pnpm build:plugin && pnpm test && pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(formats): format files, the formats tool, any beat word`.

### Task 2: `new_video` with a format, and `check` against it

**Files:**
- Modify: `packages/core/src/mirage/video.ts` (`newVideo` options), `packages/mcp/src/server.ts` (`new_video` input), `scripts/mirage.ts` (the CLI's new-video flags, if it has that command), `packages/core/src/mirage/check.ts` (format warnings)
- Test: `video.test.ts`, `server.test.ts`, `check.test.ts`

**Interfaces:**
- Consumes: `loadFormats`, `formatOf`, `Format` (Task 1).

- [ ] **Step 1: Write the failing tests:** `new_video` with `format: "vlog"` and with `from` (copied answers and footage; `format` defaulting to short; ✖ for a missing video; reply text exact with the beats); vlog numbering (first is 1, next counts up); every exact `check` warning in the Global Constraints, including each Review Focus case; a 16:9 video never gets a covered-area warning; an existing build-story episode gets the same `check` output as before (byte-identical report).
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.** The overlay boxes for the covered-area check come from the same style numbers `buildAss` uses (share the constants; don't duplicate magic numbers).
- [ ] **Step 4: Run** `pnpm build:plugin && pnpm test && pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(formats): new videos in a format, checked against it`.

### Task 3: The format rules and the edit skill

**Files:**
- Modify: `plugin/formats/{build-story,short,vlog}.md` (bodies), `plugin/skills/edit/SKILL.md`, `plugin/skills/overnight/SKILL.md` and `plugin/skills/notes/SKILL.md` only where they describe making a new video
- Test: `scripts/skills.test.ts` (and a formats test that each body names every beat of its front matter)

- [ ] **Step 1: Write the failing tests:** the edit skill contains `Pick the format from the person's own words and the footage, and say which in one line before planning, e.g. "Editing this as a vlog: cold open, title card, premise, bits, headline, plugs, tag."`, names the `formats` tool and `from`; each format body mentions each of its beats; the short body contains `A teaser short never shows the headline's reveal.`
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Write the bodies and the skill** (keep every existing skill line word for word):
  - Edit skill, step 0: call `formats`, pick from the person's words and the footage, say the one line, ask one question when two fit equally; pass `format` to `new_video`; read the format's rules (`formats { id }`) before writing the timeline and follow them; switching formats is a re-cut in the new style. When a big video is finished, offer "a few shorts from this?" with 3–5 moments, each one line with where it cuts off; make each picked one with `new_video { from, format: "short" }`. Pass on each new ✖/⚠ in plain words.
  - build-story.md: points to the edit skill's build-story beats and rules (they stay in the skill, which pins them) and adds nothing new.
  - short.md: from the spec — hook in frame 0 (no title, logo or "hey guys"); teaser (default from a big video): hook → tease (cut right before the payoff) → pointer (1–2 s: a line said on camera, else a `bold` card or overlay "Full video on my channel"); the sentence above; standalone: hook → payoff → loop (the last line or sound leads back into the first shot: a question the hook answers, a sentence the hook finishes, the same motion at both ends); 1080×1920 and pop/middle captions (written into episode.json); 20–45 s; keep text and faces out of the covered areas; the title asks the big video's question, never the answer; `summary.md` says what to set when posting (YouTube "Related video" → the big video; Instagram: a caption line pointing to the full video and the link in the bio; post after the big video is live); the finished short is copied like other finished videos, and the same file is uploaded to Instagram.
  - vlog.md: from the spec and `References/vlogs-playbook.md` (sections 2–8): beats in order with timings (cold open 8–15 s standalone gag; title card 2 s mono `<name>\nVlog #<n>\n<M-D-YY>` from `video.json`'s `vlog`, the date confirmed with the person; premise 30–50 s, sponsor read here or mid-video; bits then the headline, build-up fast at 2 s shots and the reveal held long on one angle with jump cuts; plugs only if there's something to plug; a tag after the cards, never ending on a card or sign-off); cut out on the laugh; speech front-loaded and a music-led back half; one song per bit, dips before punchlines; chosen yellow subtitles, name labels with a joke line, time cards; cut whole bits before thinning laughs; the guardrails (consent, `hide`, no one made to look worse, no glorified injuries).
- [ ] **Step 4: Run** `pnpm build:plugin && pnpm test`.
- [ ] **Step 5: Commit** — `docs(formats): the build story, short and vlog rules, and picking a format`.

### Task 4: Steady the FFmpeg timeout test (housekeeping)

**Files:** `packages/sidecars/src/locate.test.ts`

The test "does not remember a check that timed out" uses a 300 ms injected timeout and fails about one full run in three under load (seen three times while building the earlier parts). Make it independent of load without weakening what it proves: e.g. a fake ffmpeg that blocks until killed with a timeout of 1–2 s, or a fake that writes a marker file per run and the assertion counting runs rather than timing. Run the file 20 times in a loop and the full suite twice; both clean. Commit — `test(ffmpeg): a steady timeout test`.
