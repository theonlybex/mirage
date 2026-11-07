# Thumbnails and Titles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a video is cut, Mirage offers candidate thumbnail frames from its strongest moments; Claude picks one (a shocked or laughing face with its cause in frame, no text by default), and Mirage writes a full-quality thumbnail (or a Shorts cover) from the source footage. Claude writes three title options and a description in the video's format style.

**Architecture:** One engine tool `thumbnail { video, at?, text?, focus? }`. Without `at` it picks candidate times (pure function, from catalog moments, the loudest moment of each shot with its own sound, reveal beats, and even spacing) and extracts those frames from the latest render. With `at` it maps the output time to the shot's source frame (or renders a card's frame), crops it to the thumbnail's shape around a focus, sharpens and brightens it slightly, optionally draws up to 4 words in the bundled bold font, and writes `thumbnail.jpg`. Titles and the description are skill text.

**Tech Stack:** TypeScript, zod 4, vitest, FFmpeg (`-ss` frame grab, `scale`, `crop`, `unsharp`, `eq`, `ass` with the bundled Montserrat, `ebur128`).

**Spec:** `docs/superpowers/specs/2026-11-06-editing-tools-and-vlog-design.md`, part 6.

## Global Constraints
- Nothing changes for videos where `thumbnail` isn't called. It writes only inside `episodes/<n>/` (`thumbs/` and `thumbnail.jpg`), never in footage folders.
- Candidates (without `at`):
  - Source: `final.mp4`, else `rough.mp4`; neither → ✖ `video <n> has no cut yet` (hint `Run cut (or render) first.`).
  - Times, in this order, de-duplicated within 1.0 s of an earlier pick, at most 12: (1) each catalog `moment` of a clip, mapped to output time where an item shows that clip time; (2) the loudest 400 ms (EBU R128 momentary) inside each item with `audio: "keep"` at speed 1, measured on the cut's audio; (3) the middle of each item whose beat is `truth`, `headline`, `payoff`, `twist` or `reveal`; (4) even spacing over the video until 12.
  - Files `episodes/<n>/thumbs/cand-<k>.jpg` (k from 1, two digits: `cand-01.jpg`), each at the cut's size; earlier `cand-*.jpg` files are removed first.
  - Reply (exact shape): first line `wrote <count> candidate frames to episodes/<n>/thumbs/ (from <final.mp4|rough.mp4>)`, then one line per frame `cand-<kk>.jpg  <m:ss.s>  <reason>` where reason is `moment: <label>`, `loudest moment of item <id>`, `<beat> beat (item <id>)` or `even spacing`.
- Thumbnail (with `at`, output seconds):
  - Size: 1280×720 when the video is wider than tall, else 1080×1920 (the Shorts/Reels cover).
  - Picture: the source frame of the item showing `at` (its clip at the matching source time, through `speed`; during a hold, the held frame), not a frame from the compressed render; a card item → the card's frame grabbed from the render. Scaled to cover the thumbnail size and cropped around `focus` (`{ x, y }` 0–1 as everywhere in Mirage; default the item's own `focus`; for a card the centre). Then `unsharp=5:5:0.6:5:5:0.0` and `eq=brightness=0.03:saturation=1.08`.
  - `text` (optional): at most 4 words (more → ✖ `thumbnail text is <k> words — keep it to 4 or fewer`), drawn in capitals in the bundled Montserrat ExtraBold, white with a black outline `px(10)`, size `px(150)` scaled by the thumbnail's shorter side (`k = min(W,H)/1080`), centred in the lower third; emoji left out as in other text.
  - Writes `episodes/<n>/thumbnail.jpg` (JPEG quality `-q:v 2`), replacing an earlier one.
  - Reply (exact): `wrote episodes/<n>/thumbnail.jpg (<W>×<H>, from <clip> at <src> s)` or `wrote episodes/<n>/thumbnail.jpg (<W>×<H>, from the card)`; `at` outside the video → ✖ `<at> s is outside the video (0–<D> s)`.
- The tool works on the video's last cut; no lock beyond the episode lock other tools take. It's listed in `TOOL_NAMES`, has a label in hooks policy (`Picking thumbnail frames` / `Thumbnail frames ready`, `Writing the thumbnail` / `Thumbnail written`), and isn't a stage.
- Cross-platform; commits with `git commit -s` ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; nothing pushed.

## Review Focus
- **A moment inside a clip that appears twice in the cut, or inside a sped-up item:** mapped to every output time that shows it (each counts once against the 12), through the item's speed. Pinned in Task 1.
- **A video that is only cards or has no sound:** candidates still come out (beats and even spacing). Pinned in Task 1.
- **`at` inside a held freeze, inside an animated `move`, or on a card:** the held frame; the source frame (not the moved crop — the thumbnail makes its own crop around `focus`); the card's frame. Pinned in Task 2.
- **A 4K or portrait source for a 1280×720 thumbnail, and a landscape source for a 1080×1920 cover:** covers the frame with no black bars. Pinned in Task 2.
- **Paths with spaces and quotes** (project or clip): every FFmpeg call works. Pinned in Task 2.

---

### Task 1: Candidate frames

**Files:**
- Create: `packages/core/src/mirage/thumbnail.ts`
- Modify: `packages/mcp/src/server.ts` (the tool, `TOOL_NAMES`), `packages/hooks/src/policy.ts` (labels), `scripts/mirage.ts` if the CLI has a matching place (optional)
- Test: `thumbnail.test.ts`, `server.test.ts`, `policy.test.ts`

**Interfaces:**
- Produces: `interface ThumbCandidate { t: number; reason: string }`; `thumbCandidates(ep: Episode, catalog: Catalog, loudness: { t: number; lufs: number }[], max?: number): ThumbCandidate[]` (pure); `writeCandidates(project: string, n: number, tools: MediaTools, o?: { signal?: AbortSignal }): Promise<{ source: 'final.mp4' | 'rough.mp4'; frames: (ThumbCandidate & { file: string })[] }>`.

- [ ] **Step 1: Write the failing tests:** `thumbCandidates` order, de-duplication, the 12 cap, the moment mapping (twice in the cut, sped up), beats, even spacing, only cards, no sound; `writeCandidates` real FFmpeg on a fixture cut: files written at the cut's size, old candidates removed, ✖ without a cut; the tool's exact reply.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.** Loudness: one `ebur128` pass over the cut's audio (momentary, `metadata=1` or the log lines), sampled every 100 ms.
- [ ] **Step 4: Run** `pnpm build:plugin && pnpm test && pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(thumbnail): candidate frames from the strongest moments`.

### Task 2: Write the thumbnail

**Files:**
- Modify: `packages/core/src/mirage/thumbnail.ts` (`writeThumbnail`), `packages/mcp/src/server.ts` (the `at`/`text`/`focus` inputs)
- Test: `thumbnail.test.ts`, `server.test.ts`

**Interfaces:**
- Consumes: Task 1's module; `layoutTimeline`, `isCard`, `bundledFontsDir`, `CAPTION_FONT`, the overlays `draw()` escaping (export what's needed rather than copying).
- Produces: `writeThumbnail(project: string, n: number, o: { at: number; text?: string; focus?: { x: number; y: number } }, tools: MediaTools): Promise<{ file: string; width: number; height: number; from: { clip: string; src: number } | 'card' }>`.

- [ ] **Step 1: Write the failing tests:** the source mapping (speed, hold, move, card); size by orientation; focus crop (a marked source frame: the marked corner lands where the focus says); text ≤ 4 words drawn (libass log shows the bundled font; pixels of the outline colour in the lower third), 5 words ✖; `at` outside ✖; every Review Focus case; exact replies.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm build:plugin && pnpm test && pnpm typecheck`.
- [ ] **Step 5: Real look:** write a thumbnail and a cover from the fixture project in the scratchpad (`/private/tmp/claude-501/-Users-becks-Desktop-Mirage-Edits/7b13ead7-490f-40f0-84ff-bcd5decb91ea/scratchpad/thumb-look/`), with and without text; look at them; report.
- [ ] **Step 6: Commit** — `feat(thumbnail): a full-quality thumbnail from the source frame`.

### Task 3: Thumbnails and titles in the skills

**Files:**
- Modify: `plugin/skills/edit/SKILL.md`, `plugin/formats/{vlog,short,build-story}.md` (a packaging section each), `plugin/skills/overnight/SKILL.md` (one line: candidates and a thumbnail are made after the final render, logged for the person to confirm)
- Test: `scripts/skills.test.ts`, `formats.test.ts`

- [ ] **Step 1: Write the failing tests:** the edit skill names `thumbnail` (short and `mcp__plugin_mirage_engine__thumbnail` spelling, per the skills test's rule) and contains `Look at the candidate frames, pick the one where a face shows the strongest reaction with its cause in frame, and write the thumbnail without text unless the person asks for some.`; each format body has a packaging part naming its title style.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Write** (keep every existing skill line word for word):
  - Edit skill, after `render`: call `thumbnail` for candidates, look at them (Read the JPEGs), pick, call `thumbnail { at }`; show it to the person; `thumbnail.jpg` is copied with the finished video by the person's own rule; write 3 title options in `summary.md` in the format's style (never a claim the video doesn't deliver; 3–8 words) and a description (schedule line if any, sponsor code if any, plugs, socials, "People in the video" with handles the person gave, credits and music licences from `music/library.json`) — only facts from the person and the catalog.
  - vlog.md packaging: titles in two styles — classic ALL CAPS 3–8 words ending "!!", hiding who and what, optional tag in brackets; now-style first-person sentence case, no "!!" (examples from the playbook, section 8); thumbnail: no text, no arrows, a wide-open laughing or shocked face with its cause in frame.
  - short.md packaging: the cover (1080×1920) is the hook's strongest frame; the title asks the big video's question, never the answer (already there — keep, add the cover line).
  - build-story.md packaging: points to the edit skill's title rule ("all caps with a number") and adds the thumbnail: the before/after or the reveal, a face if there is one.
- [ ] **Step 4: Run** `pnpm build:plugin && pnpm test`.
- [ ] **Step 5: Commit** — `docs(thumbnail): thumbnails, titles and descriptions in the skills`.
