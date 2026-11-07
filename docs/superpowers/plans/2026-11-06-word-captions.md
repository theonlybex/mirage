# Word-by-Word Captions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An episode can burn in Shorts-style "pop" captions (1–3 bold capital words, each appearing as it's said, key words in lime) or "karaoke" captions (the phrase with the spoken word lit), at the bottom or mid-frame, in a bundled font that looks the same on every computer; with no `captions` field an episode renders exactly as today.

**Architecture:** A new optional episode field `captions`. A new pure module `captions.ts` groups the spoken words (from the existing `speechWords`) and turns groups into timed caption lines made of word parts; `buildAss` draws those parts with its existing escaping, in two new styles using the bundled Montserrat ExtraBold. `renderEpisode` picks the burned-in lines by style, keeps `final.srt` as phrase cues, passes `fontsdir` (the plugin's small `plugin/fonts` folder) only when a new style is used, and returns caption warnings.

**Tech Stack:** TypeScript (Node 22, ESM), zod 4, vitest, FFmpeg + libass, pnpm monorepo.

**Spec:** `docs/superpowers/specs/2026-11-06-editing-tools-and-vlog-design.md`, part 1.

## Global Constraints
- With no `captions` field, the ASS events, the `ass=` filter arguments and `final.srt` are exactly as today (the existing tests in `overlays.test.ts` and `render-episode.test.ts` pass unchanged).
- `captions` is `.optional()` in the schema, never `.default(...)`: saving an episode must not add the key to files that don't have it.
- `final.srt` is always phrase cues (today's `groupCaptions`), whatever style is burned in.
- Cross-platform: the font is bundled (OFL), found relative to the code on every OS; no system font is assumed for the new styles.
- `fontsdir` points only at the plugin's own `fonts` folder, never at a system font folder (the comment in `render-episode.ts` about libass loading every font stays true).
- The guide cut keeps showing narration prompts and no captions, as today.
- Commits with `git commit -s`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; nothing pushed.

Exact values (from the spec, with my numbers where the spec says "about"):
- Styles: `phrase` (default), `pop`, `karaoke`, `chosen`, `off`. `chosen` and `off` burn in no automatic captions.
- Positions: `bottom` (default), `middle`.
- Pop groups: at most 3 words and 16 characters (spaces included), broken also at a sentence end or a gap over 0.6 s. Text in capitals. Each word appears at its own start (the first word of a group 0.1 s early); a group shows at least 0.5 s and never past the next group's start.
- Pop-in of the newest word: `{\fscx115\fscy115\t(0,120,\fscx100\fscy100)}` before it.
- Highlight colour default `#C6FF3D`; `captions.color` must match `/^#[0-9A-Fa-f]{6}$/`. Key words drawn in that colour at 112% (`\fscx112\fscy112`). At most one key word per pop group (the first).
- `highlight` entries: a string (every time that word is said) or `{ word, at }` (only the saying of that word whose start is nearest output time `at`). Words compare with `normalizeWord` from `autoedit/takes.ts`. In `karaoke` the colour marks the current word and `highlight` is ignored.
- Karaoke groups: as phrase captions (38 characters, same breaks); the word being said is drawn in the highlight colour, from its start until the next word's start (the first from the cue's start, the last until the cue's end).
- Font: Montserrat ExtraBold (OFL 1.1) from the Montserrat project (github.com/JulietaUla/Montserrat, static TTF). Pop style: size `px(84)`, white, black outline `px(7)`, BorderStyle 1, bold off (the face is already heavy). Karaoke style: size `px(64)`, white, black outline `px(5)`, BorderStyle 1.
- Position: `bottom` = alignment 2 with today's MarginV for phrase (`px(90)`) and `px(120)` for pop/karaoke; `middle` = alignment 2 with MarginV `round(height * 0.38)` for every style.
- Warnings (printed with ⚠ by `cut` and `render`):
  - `captions.highlight "<word>" is never said in this video — check the spelling or remove it`
  - `captions.highlight only works with the "pop" style — it does nothing with "<style>"`

## Review Focus
- **An episode without `captions` saved and re-read:** the file gains no `captions` key and renders byte-identically to before. Pinned in Task 1 (schema round trip) and Task 2 (ASS and filter args unchanged).
- **Words with no letters, emoji-only words, CJK text, and words the transcript times overlapping:** pop/karaoke never emit an empty part, an inverted event, or an event overlapping the next group. Pinned in Task 1.
- **A highlight word said several times with `{ word, at }` at a time between two sayings:** only the nearest one lights up. Pinned in Task 1.
- **The font file missing from the plugin folder** (a broken install): render fails with a clear `MirageError` naming the folder, instead of libass silently falling back to another font. Pinned in Task 2.
- **A rough cut (`cut`) of a vertical video:** pop captions show at the preview size too (sizes scale with the frame, `middle` uses the preview height). Pinned in Task 2.

---

### Task 1: The `captions` field and the caption lines

**Files:**
- Modify: `packages/shared/src/schemas/episode.ts` (add `CaptionsSchema`, `EpisodeSchema.captions` optional; export `Captions` type)
- Create: `packages/core/src/mirage/captions.ts`
- Modify: `packages/core/src/mirage/overlays.ts` (`groupCaptions` built on `groupWords`, no behaviour change)
- Test: `packages/core/src/mirage/captions.test.ts`, `packages/shared/src/schemas/episode.test.ts`

**Interfaces:**
- Produces (shared): `CaptionsSchema = strictObject({ style: enum(['phrase','pop','karaoke','chosen','off']).default('phrase'), position: enum(['bottom','middle']).default('bottom'), highlight: array(union([string().min(1), strictObject({ word: string().min(1), at: number().min(0) })])).default([]), color: string().regex(/^#[0-9A-Fa-f]{6}$/).optional() })`; `type Captions`.
- Produces (core, `captions.ts`):
  - `interface CaptionPart { text: string; key?: boolean; pop?: boolean; lit?: boolean }`
  - `interface CaptionLine { start: number; end: number; parts: CaptionPart[] }`
  - `groupWords(words: Word[], o: { maxChars: number; maxWords?: number; maxGap: number }): { text: string; start: number; end: number }[][]` — today's grouping loop from `groupCaptions`, plus `maxWords`.
  - `keyWords(words: Word[], highlight: Captions['highlight']): Set<number>` — indexes into `words` that are key.
  - `popLines(words: Word[], o: { durationSec: number; highlight: Captions['highlight'] }): CaptionLine[]`
  - `karaokeLines(words: Word[], o: { durationSec: number }): CaptionLine[]`
  - `captionWarnings(words: Word[], captions: Captions | undefined): string[]`
  - `HIGHLIGHT_COLOR = '#C6FF3D'`
- `groupCaptions` keeps its signature and output.

- [ ] **Step 1: Write the failing tests** (`captions.test.ts`, with the `w(text, start, end)` helper style of `overlays.test.ts`):

```ts
it('pops 1–3 words at a time, each appearing at its own start, the first 0.1 s early', () => {
  const lines = popLines([w('so', 1, 1.2), w('he', 1.3, 1.4), w('quietly', 1.5, 1.9), w('pours', 2.0, 2.3)], { durationSec: 5, highlight: [] });
  expect(lines.map((l) => [l.start, l.end, l.parts.map((p) => p.text).join(' ')])).toEqual([
    [0.9, 1.3, 'SO'], [1.3, 1.5, 'SO HE'], [1.5, 1.9, 'SO HE QUIETLY'], [1.9, 2.4, 'POURS'],
  ]);
  // "SO HE QUIETLY" is 13 chars; adding POURS would pass 16. A group ends at its last word's end, at least 0.5 s after
  // it starts, but never after the next group starts (POURS starts 0.1 s early, at 1.9). The new word of each line has
  // pop: true.
});
it('breaks pop groups at a sentence end and at a gap over 0.6 s', () => { /* "awful." then next word → new group; 0.7 s gap → new group */ });
it('lights the first key word of a group only, every time a string highlight is said', () => { /* key: true on "GULP" in two groups */ });
it('lights only the saying nearest `at` for { word, at }', () => {
  // "money" at 2.0 and 6.0, { word: 'money', at: 4.5 } → only the one at 6.0 is key
});
it('karaoke shows the phrase with the word being said lit', () => {
  // cue "Drink this and you get magic!" → one line per word, lit moves along; first from cue start, last to cue end
});
it('never emits empty parts, inverted lines, or lines past the next group', () => { /* emoji-only word, overlapping times, a word with no letters */ });
it('warns about highlight words never said, and highlight outside pop', () => {
  expect(captionWarnings(words, { style: 'pop', position: 'bottom', highlight: ['gulp', 'yuck'] })).toEqual(['captions.highlight "yuck" is never said in this video — check the spelling or remove it']);
  expect(captionWarnings(words, { style: 'karaoke', position: 'bottom', highlight: ['gulp'] })).toEqual(['captions.highlight only works with the "pop" style — it does nothing with "karaoke"']);
  expect(captionWarnings(words, undefined)).toEqual([]);
});
```

`episode.test.ts`: an episode without `captions` parses with `captions` undefined and stringifies without the key; `{ style: 'pop' }` parses with `position: 'bottom'`, `highlight: []`; `color: 'lime'` and an unknown key are refused.

- [ ] **Step 2: Run them to see them fail** — `pnpm vitest run packages/core/src/mirage/captions.test.ts packages/shared/src/schemas/episode.test.ts`. Expected: FAIL (module and field missing).

- [ ] **Step 3: Implement** the schema field and `captions.ts`; move the grouping loop of `groupCaptions` into `groupWords` (phrase uses `maxChars 38, maxGap 0.6`, no `maxWords`) so `overlays.test.ts` stays green. Text is tidied as today (`tidy`); pop text is `toUpperCase()`d. Durations follow the exact values above; times rounded to ms like the rest of the file.

- [ ] **Step 4: Run** the focused tests plus `pnpm vitest run packages/core/src/mirage/overlays.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(captions): pop and karaoke caption lines`.

### Task 2: Draw them, in the bundled font

**Files:**
- Create: `plugin/fonts/Montserrat-ExtraBold.ttf`, `plugin/fonts/OFL.txt`, `plugin/fonts/README.md` (source URL, version/commit, sha256)
- Create: `packages/core/src/mirage/fonts.ts`
- Modify: `packages/core/src/mirage/overlays.ts` (`buildAss`: new styles, `captionLines`, position, colour)
- Modify: `packages/core/src/mirage/render-episode.ts` (pick lines by style, `fontsdir`, warnings for rough and final)
- Modify: `plugin/THIRD_PARTY_NOTICES.txt` and `scripts/build-plugin.ts` if it writes the notices (Montserrat, OFL 1.1, with the licence text)
- Test: `packages/core/src/mirage/overlays.test.ts`, `packages/core/src/mirage/render-episode.test.ts`, `scripts/build-plugin.test.ts` (notices list the font)

**Interfaces:**
- Consumes: Task 1's `Captions`, `CaptionLine`, `popLines`, `karaokeLines`, `captionWarnings`, `HIGHLIGHT_COLOR`.
- Produces:
  - `CAPTION_FONT = 'Montserrat ExtraBold'` (the name libass matches — verify it in Step 4's log) and `bundledFontsDir(from?: string): string` in `fonts.ts`: the first existing of `<dir of from>/../fonts` (the bundle: `plugin/dist/engine.mjs`) and the repo's `plugin/fonts` found from the source file; throws `MirageError('BAD_ITEM', 'Mirage's caption font is missing from <folder>', 'Reinstall the Mirage plugin.')` when neither has `Montserrat-ExtraBold.ttf`.
  - `buildAss(o)` gains optional `captionLines?: { style: 'pop' | 'karaoke'; lines: CaptionLine[] }`, `position?: 'bottom' | 'middle'`, `highlightColor?: string`. Styles `Pop` and `Karaoke` are declared only when `captionLines` is given (so ASS without `captions` is unchanged). Parts are drawn with the existing `draw()`; `key`/`lit` parts get `{\c<colour>}` (and `\fscx112\fscy112` for key) and reset after; `pop` parts get the pop-in tag.
  - `RenderResult.warnings` includes `captionWarnings(...)` in rough and final modes.

- [ ] **Step 1: Write the failing tests:**
  - `overlays.test.ts`: `buildAss` with no `captionLines` and no `position` returns exactly today's string for the existing inputs (snapshot one existing case as a literal); with pop lines, declares a `Pop` style in `Montserrat ExtraBold` and writes `Dialogue: 2,…,Pop,,0,0,0,,SO HE {\fscx115\fscy115\t(0,120,\fscx100\fscy100)}QUIETLY`; a key part is `{\c&H003DFFC6&\fscx112\fscy112}GULP{\r}`; `position: 'middle'` on a 1080×1920 frame gives the caption style MarginV `730`; a custom colour `#FF0000` gives `&H000000FF&`.
  - `render-episode.test.ts` (real ffmpeg, the existing `renderEpisode (real ffmpeg)` block): a 1080×1920 episode from `fixtures/speech-retake.mp4` with `audio: 'keep'` and `captions: { style: 'pop', position: 'middle', highlight: ['say'] }` renders `final.mp4`; the run's ffmpeg log at `-v verbose` (or `-loglevel verbose` via the tools' extra args, whichever the existing tests use to read stderr) names `Montserrat-ExtraBold.ttf` (libass's `fontselect` line); `final.srt` equals the phrase cues of the same words. The same episode without `captions` produces the same `ass=` argument as today (no `fontsdir`).
  - `fonts.ts`: `bundledFontsDir` on a temp layout finds `dist/../fonts`; with no font file throws the message above.
  - `build-plugin.test.ts`: `THIRD_PARTY_NOTICES.txt` contains `Montserrat` and `SIL Open Font License`.
- [ ] **Step 2: Run them to see them fail** — `pnpm vitest run packages/core/src/mirage/overlays.test.ts packages/core/src/mirage/render-episode.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Add the font.** Download the static `Montserrat-ExtraBold.ttf` and `OFL.txt` from the Montserrat project's GitHub release or repository (a tagged version), into `plugin/fonts/`; write `README.md` with the exact URL, version and `shasum -a 256` of the TTF.
- [ ] **Step 4: Implement** `fonts.ts`, the `buildAss` additions and the render wiring: phrase style → today's `Caption` events (with `position` applied when set); pop/karaoke → `captionLines`; chosen/off → no caption events; `toSrt(groupCaptions(...))` always. Pass `fontsdir=<bundledFontsDir()>` to `episodeFinalArgs` only when `captionLines` is given (quote/escape the path for the filter the way `assFile` is handled; it may contain spaces). Check libass's verbose log shows the TTF chosen; if the family name differs, set `CAPTION_FONT` to what matches.
- [ ] **Step 5: Run** `pnpm build:plugin && pnpm test && pnpm typecheck`. Expected: all pass.
- [ ] **Step 6: Commit** — `feat(captions): draw pop and karaoke captions in a bundled font`.

### Task 3: The edit skill, and a real look

**Files:**
- Modify: `plugin/skills/edit/SKILL.md` (field list, vertical-video bullet, rules), `plugin/skills/notes/SKILL.md` only if it lists episode fields
- Test: `scripts/skills.test.ts` (one assertion that the edit skill names `captions` and its styles)

**Interfaces:**
- Consumes: the field from Task 1 and the warnings from Task 2.

- [ ] **Step 1: Write the failing test** in `skills.test.ts`: the edit skill contains `"captions"`, each of `phrase`, `pop`, `karaoke`, `chosen`, `off`, and the sentence `For every new short or vertical video, write "captions": { "style": "pop", "position": "middle" } into episode.json.`
- [ ] **Step 2: Run it to see it fail** — `pnpm vitest run scripts/skills.test.ts`.
- [ ] **Step 3: Update the edit skill.** In "The fields you can write": a `captions` bullet (`style`, `position`, `highlight` as words or `{ word, at }`, `color`). In the vertical-videos bullet: the sentence above. Rules (from the spec): pop for Shorts and vertical videos, karaoke or phrase for long videos, chosen for vlogs; at most one key word per caption, only words that carry the joke or the stakes; pass on the two new ⚠ warnings in plain words. Keep every existing rule line word for word (the test checks them).
- [ ] **Step 4: Run** `pnpm test` (the skills test and the dist-fresh test).
- [ ] **Step 5: Real look.** Render a scratch copy (in a temp folder, never the person's project) of a vertical episode with pop + highlight + middle, and one with karaoke at the bottom, from `fixtures/speech-retake.mp4`; extract frames at three word times each (`ffmpeg -ss <t> -i final.mp4 -frames:v 1 f.png`), look at them, and put the paths and what they show in the report: words in capitals, the newest word popping, the key word in lime, captions at about 60% down for middle, nothing cut off at the frame's sides.
- [ ] **Step 6: Commit** — `docs(edit): word-by-word captions in the edit skill`.
