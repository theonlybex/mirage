import { isCard, type CardItem, type Catalog, type Episode, type Overlay, type Slot, type Transcript, type VoiceLine, type Word } from '@wordedits/shared';
import { isFiller, normalizeWord } from '../autoedit/takes.js';
import { HIGHLIGHT_COLOR, type CaptionLine, type CaptionPart } from './captions.js';
import { CAPTION_FONT, MONO_FONT } from './fonts.js';
import { spills, type Spill } from './spill.js';
import { layoutTimeline, type LaidItem } from './timeline.js';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const EPS = 1e-6;

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export function keptSegments(line: VoiceLine): { in: number; out: number; offset: number }[] {
  // Clamp each cut to the line so a cut outside it can never extend a kept segment.
  const clamp = (t: number) => Math.min(line.src.out, Math.max(line.src.in, t));
  const cuts = line.cuts
    .map(([a, b]) => [clamp(Math.min(a, b)), clamp(Math.max(a, b))] as const)
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const out: { in: number; out: number; offset: number }[] = [];
  let cursor = line.src.in;
  let offset = 0;
  for (const [a, b] of cuts) {
    if (a > cursor) {
      out.push({ in: cursor, out: a, offset });
      offset += a - cursor;
    }
    cursor = Math.max(cursor, b);
  }
  if (line.src.out > cursor) out.push({ in: cursor, out: line.src.out, offset });
  return out.map((s) => ({ in: r3(s.in), out: r3(s.out), offset: r3(s.offset) }));
}

/**
 * Re-spells transcribed words (already on the output timeline) with the written line: tokens are aligned by LCS on
 * normalized words. Matches take the written spelling with the spoken timing; a differing run between matches becomes
 * the written run spread over the spoken run's time (unless it is much longer than the spoken run: then the spoken words
 * stay); extra spoken words stay; written words never spoken are dropped.
 */
export function alignWritten(spoken: Word[], text: string): Word[] {
  const written: string[] = [];
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    // Punctuation-only tokens ("—") ride on the word before them.
    if (!normalizeWord(tok) && written.length) written[written.length - 1] += ` ${tok}`;
    else written.push(tok);
  }
  const a = spoken.map((x) => normalizeWord(x.w));
  const b = written.map(normalizeWord);
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] && a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] && a[i] === b[j]) pairs.push([i++, j++]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const out: Word[] = [];
  const gap = (i0: number, i1: number, j0: number, j1: number) => {
    if (i1 <= i0) return; // written words never spoken
    // Extra spoken words; or a written run much longer than what was spoken there (the take stops short of the line):
    // the spoken words stay as transcribed, so a caption never shows words the audio doesn't have.
    if (j1 <= j0 || j1 - j0 > i1 - i0 + 1) {
      out.push(...spoken.slice(i0, i1));
      return;
    }
    const t0 = spoken[i0].start;
    const step = (spoken[i1 - 1].end - t0) / (j1 - j0);
    for (let j = j0; j < j1; j++) out.push({ w: written[j], start: r3(t0 + (j - j0) * step), end: r3(t0 + (j - j0 + 1) * step), conf: 1 });
  };
  let i = 0;
  let j = 0;
  for (const [pi, pj] of pairs) {
    gap(i, pi, j, pj);
    out.push({ ...spoken[pi], w: written[pj] });
    i = pi + 1;
    j = pj + 1;
  }
  gap(i, n, j, m);
  return out;
}

/** Voice-over transcripts: one for every line, or one per recording path. */
export type VoTranscripts = Transcript | Map<string, Transcript>;

/**
 * Every spoken (non-filler) word on the output timeline: live audio of kept real-time items, the words their leads and
 * tails carry outside their shots (spills), plus the fitted voice-over.
 */
export function speechWords(ep: Episode, catalog: Catalog, vo: VoTranscripts | null): Word[] {
  const fps = ep.output.fps;
  const out: Word[] = [];
  const laid = layoutTimeline(ep);
  for (const l of laid) {
    const { item } = l;
    // A card has no speech.
    if (isCard(item) || item.audio !== 'keep' || item.speed !== 1) continue;
    const words = catalog.clips.find((c) => c.id === item.clip)?.transcript?.words ?? [];
    const srcEnd = item.src.in + l.srcFrames / fps;
    for (const w of words) {
      if (w.start < item.src.in - EPS || w.start >= srcEnd || isFiller(w)) continue;
      out.push({ ...w, start: r3(l.start + w.start - item.src.in), end: r3(l.start + Math.min(w.end, srcEnd) - item.src.in) });
    }
  }
  for (const { words } of spilledWords(ep, catalog, laid)) out.push(...words);
  if (vo && ep.voiceover) {
    for (const line of ep.voiceover.lines) {
      const tx = vo instanceof Map ? vo.get(line.recording ?? ep.voiceover.recording) : vo;
      if (!tx) continue;
      const segs = keptSegments(line);
      const spoken: Word[] = [];
      for (const w of tx.words) {
        if (isFiller(w)) continue;
        // A word belongs to the kept segment holding its midpoint: filler cuts are padded, so a
        // neighbouring word's start can fall a few ms inside a cut while the word itself is kept.
        const mid = (w.start + Math.max(w.start, w.end)) / 2;
        const seg = segs.find((g) => mid >= g.in - EPS && mid < g.out);
        if (!seg) continue;
        const start = Math.max(w.start, seg.in);
        spoken.push({ ...w, start: r3(line.at + seg.offset + start - seg.in), end: r3(line.at + seg.offset + Math.min(w.end, seg.out) - seg.in) });
      }
      out.push(...(line.text?.trim() ? alignWritten(spoken, line.text) : spoken));
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Each usable lead and tail (spills) with the spoken (non-filler) words it carries, on the output timeline: a word
 * belongs to a lead or a tail when it starts inside it, as a word belongs to its shot.
 */
export function spilledWords(ep: Episode, catalog: Catalog, laid: LaidItem[] = layoutTimeline(ep)): { spill: Spill; words: Word[] }[] {
  return spills(ep, catalog, laid).spills.map((s) => {
    const said = catalog.clips.find((c) => c.id === s.clip)?.transcript?.words ?? [];
    const words = said
      .filter((w) => w.start >= s.srcIn - EPS && w.start < s.srcOut && !isFiller(w))
      .map((w) => ({ ...w, start: r3(s.at + w.start - s.srcIn), end: r3(s.at + Math.min(w.end, s.srcOut) - s.srcIn) }));
    return { spill: s, words };
  });
}

const SENTENCE_END = /[.?!]["'”’)\]]*$/;
/**
 * Colour emoji: characters shown as emoji by default (🚀 ✅ ⌚, flags, skin tones), pictographs from U+1F000 on, and
 * every part of a ZWJ sequence (👩‍💻 ❤️‍🔥). Symbols that are text by default (© ® ™ ⚠ ▶ ✔ ↔) are not: the fonts draw them.
 */
const PICTO = String.raw`[\p{Emoji_Presentation}]|(?=\p{Extended_Pictographic})[\u{1F000}-\u{1FAFF}]|\p{Extended_Pictographic}(?=\u{FE0F}?\u{200D})|(?<=\u{200D})\p{Extended_Pictographic}`;
/** Emoji plus the invisible parts of emoji sequences: variation selector 16, ZWJ, the keycap mark and tag characters. */
const EMOJI = new RegExp(`${PICTO}|[\\u{FE0F}\\u{200D}\\u{20E3}\\u{E0020}-\\u{E007F}]`, 'gu');
/** libass draws no emoji (colour glyphs): they come out as empty boxes, so captions and overlays leave them out. */
export const undrawable = (text: string) => new RegExp(PICTO, 'u').test(text);
/** Runs of Chinese/Japanese text. macOS's fallback for Han is a font libass can't open, so they get an explicit one. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303F\uFF00-\uFFEF]+/gu;
/** A word as shown in a caption: emoji gone, no space before punctuation. */
export const tidy = (t: string) => t.replace(EMOJI, '').replace(/\s+([.,!?;:])/g, '$1').trim();

export interface GroupedWord {
  text: string;
  start: number;
  end: number;
  /** Index of the word in the list given to `groupWords`. */
  index: number;
}

const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * Groups words into caption phrases: a group ends at a sentence end, a gap over `maxGap`, or when `maxChars`/`maxWords`
 * would pass. `wordsOnly` leaves out words with no letter or digit ("—", "..."), which would be a caption of their own.
 */
export function groupWords(words: Word[], o: { maxChars: number; maxWords?: number; maxGap: number; wordsOnly?: boolean }): GroupedWord[][] {
  const groups: GroupedWord[][] = [];
  let cur: GroupedWord[] = [];
  for (const [index, word] of words.entries()) {
    const text = tidy(word.w);
    if (!text || (o.wordsOnly && !HAS_WORD.test(text))) continue;
    const last = cur[cur.length - 1];
    const joined = [...cur.map((x) => x.text), text].join(' ');
    if (last && (joined.length > o.maxChars || (o.maxWords !== undefined && cur.length >= o.maxWords) || word.start - last.end > o.maxGap || SENTENCE_END.test(last.text))) {
      groups.push(cur);
      cur = [];
    }
    cur.push({ text, start: word.start, end: word.end, index });
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** When each group shows: a little before its first word, at least `minDur`, never past the next group, never overlapping the one before. */
export function groupSpans<T extends { start: number; end: number }>(groups: T[][], o: { durationSec: number; lead: number; minDur: number }): { start: number; end: number; group: T[] }[] {
  const raw = groups.map((g) => ({ start: r3(Math.max(0, g[0].start - o.lead)), end: g[g.length - 1].end, group: g }));
  const spans: { start: number; end: number; group: T[] }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const prev = spans[spans.length - 1];
    const start = prev ? Math.max(raw[i].start, prev.end) : raw[i].start;
    const limit = i + 1 < raw.length ? raw[i + 1].start : o.durationSec;
    const end = r3(Math.max(raw[i].end, Math.min(start + o.minDur, limit)));
    // Overlapping words can push a group's start past its end: drop it rather than emit an inverted span.
    if (end <= start + EPS) continue;
    spans.push({ start, end, group: raw[i].group });
  }
  return spans;
}

export function groupCaptions(words: Word[], o: { durationSec: number; maxChars?: number; maxGap?: number; lead?: number; minDur?: number }): Cue[] {
  const groups = groupWords(words, { maxChars: o.maxChars ?? 38, maxGap: o.maxGap ?? 0.6 });
  return groupSpans(groups, { durationSec: o.durationSec, lead: o.lead ?? 0.15, minDur: o.minDur ?? 0.8 }).map((s) => ({
    start: s.start,
    end: s.end,
    text: tidy(s.group.map((x) => x.text).join(' ')),
  }));
}

function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor((ms % 3_600_000) / 60_000))}:${p(Math.floor((ms % 60_000) / 1000))},${p(ms % 1000, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

function assTime(sec: number): string {
  const cs = Math.round(sec * 100);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(cs / 360_000)}:${p(Math.floor((cs % 360_000) / 6000))}:${p(Math.floor((cs % 6000) / 100))}.${p(cs % 100)}`;
}

const assText = (t: string) => t.replace(/\\/g, '/').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, '\\N');

function defaultCjkFont(): string | null {
  return process.platform === 'darwin' ? 'Hiragino Sans GB' : null;
}

function defaultFont(): string {
  if (process.platform === 'darwin') return 'Helvetica Neue';
  if (process.platform === 'win32') return 'Segoe UI';
  return 'DejaVu Sans';
}

// ASS colours are &HAABBGGRR (alpha 00 = opaque).
const WHITE = '&H00FFFFFF';
const BLACK = '&H00000000';
const BOX = '&H4D000000';
/** The yellow of name labels, chosen subtitles and time tags (#FFD400), as an ASS style colour. */
const YELLOW = '&H0000D4FF';

/** '#RRGGBB' as an ASS override colour (&H00BBGGRR&). */
const assColor = (hex: string) => `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`.toUpperCase();
/** The newest word of a pop caption grows in from 115%. */
const POP_IN = (scale: number) => `\\fscx${Math.round(scale * 1.15)}\\fscy${Math.round(scale * 1.15)}\\t(0,120,\\fscx${scale}\\fscy${scale})`;

/** Pixel sizes are written for a 1080-px short side and scale with the frame's short side (never below 1 px). */
const scaler = (width: number, height: number) => {
  const k = Math.min(width, height) / 1080;
  return (n: number) => Math.max(1, Math.round(n * k));
};

/**
 * Where a subtitle style puts its text, in pixels of the frame: font size, BorderStyle (3 = an opaque box, whose padding
 * is the outline width), outline width, numpad Alignment (1–3 bottom, 4–6 middle, 7–9 top; left, centre, right),
 * MarginV, and the left and right margin.
 */
export interface StyleGeometry {
  size: number;
  border: 1 | 3;
  outline: number;
  align: number;
  marginV: number;
  margin: number;
}

/**
 * The geometry of every style `buildAss` writes, for a width×height frame with captions at `position` (default bottom).
 * `check` finds what the Shorts and Reels buttons cover from the same numbers.
 */
export function styleGeometry(width: number, height: number, position?: 'bottom' | 'middle') {
  const px = scaler(width, height);
  const side = Math.round(width * 0.05);
  // Middle: the captions' bottom edge a little below the centre, for every caption style.
  const captionMv = (bottom: number) => (position === 'middle' ? Math.round(height * 0.38) : bottom);
  const s = (size: number, border: 1 | 3, outline: number, align: number, marginV: number, margin = side): StyleGeometry => ({ size, border, outline, align, marginV, margin });
  return {
    Caption: s(px(64), 3, px(18), 2, captionMv(px(90))),
    Callout: s(px(150), 1, px(6), 5, 0),
    /** Every badge tone. */
    Badge: s(px(48), 3, px(14), 9, px(60)),
    Counter: s(px(40), 3, px(12), 7, px(60)),
    Label: s(px(48), 3, px(14), 1, px(220)),
    Chapter: s(px(96), 1, px(4), 5, 0),
    /** Before and after overlays. */
    Before: s(px(56), 3, px(14), 8, px(60)),
    Prompt: s(px(54), 3, px(16), 8, px(150)),
    PromptNext: s(px(44), 3, px(14), 8, px(150)),
    Pop: s(px(84), 1, px(7), 2, captionMv(px(120))),
    Karaoke: s(px(64), 1, px(5), 2, captionMv(px(120))),
    CardMono: s(px(72), 1, 0, 5, 0),
    CardBold: s(px(110), 1, 0, 5, 0, Math.round(width * 0.1)),
    // A name label is a lower third, left-aligned 6% of the width in and 18% of the height up, with margins on both
    // sides so a long line wraps inside the frame; a subtitle sits where captions would; a time tag is a yellow box in
    // the top-left corner.
    Name: s(px(64), 1, px(5), 1, Math.round(height * 0.18), Math.round(width * 0.06)),
    Subtitle: s(px(44), 1, px(4), 2, captionMv(px(80))),
    Timecard: s(px(40), 3, px(14), 7, Math.round(height * 0.05)),
  };
}
export type StyleName = keyof ReturnType<typeof styleGeometry>;

/** The style each overlay kind is drawn in (a badge's tone only changes its colours). */
export const OVERLAY_STYLE: Record<Overlay['kind'], StyleName> = {
  callout: 'Callout', badge: 'Badge', counter: 'Counter', label: 'Label', chapter: 'Chapter', before: 'Before', after: 'Before', name: 'Name', subtitle: 'Subtitle', timecard: 'Timecard',
};

export function buildAss(o: {
  width: number;
  height: number;
  font?: string;
  cjkFont?: string | null;
  /** Phrase captions (the Caption style). */
  captions: Cue[];
  /** Word-by-word captions in the bundled font; their style (Pop or Karaoke) is declared only when given. */
  captionLines?: { style: 'pop' | 'karaoke'; lines: CaptionLine[] };
  /** Where captions sit (default bottom). */
  position?: 'bottom' | 'middle';
  /** Colour of key (pop) and lit (karaoke) words, '#RRGGBB' (default HIGHLIGHT_COLOR). */
  highlightColor?: string;
  overlays: Overlay[];
  prompts: Slot[];
  /** The cards on the timeline (their times, hold included): their text, drawn over the black or the picture of the chunks. */
  cards?: { start: number; end: number; card: CardItem['card'] }[];
}): string {
  const cjk = o.cjkFont === undefined ? defaultCjkFont() : o.cjkFont;
  // Emoji left out; CJK runs switch to a font that has them and back to the style's font (\fn alone).
  const draw = (t: string) => {
    const s = assText(t.replace(EMOJI, '').replace(/ {2,}/g, ' ').trim());
    return cjk ? s.replace(CJK, (run) => `{\\fn${cjk}}${run}{\\fn}`) : s;
  };
  const px = scaler(o.width, o.height);
  const font = o.font ?? defaultFont();
  const g = styleGeometry(o.width, o.height, o.position);
  // Name, Fontsize, Primary, Outline, Back, Bold, BorderStyle, Outline, Alignment, MarginV, Fontname, MarginL and R
  type Row = [string, number, string, string, string, number, number, number, number, number, string, number];
  const row = (name: string, s: StyleGeometry, primary: string, outline: string, back: string, bold: number, face = font): Row =>
    [name, s.size, primary, outline, back, bold, s.border, s.outline, s.align, s.marginV, face, s.margin];
  const styles: Row[] = [
    row('Caption', g.Caption, WHITE, BOX, BOX, -1),
    row('Callout', g.Callout, WHITE, BLACK, BLACK, -1),
    row('BadgeFail', g.Badge, WHITE, '&H002A2AE0', '&H002A2AE0', -1),
    row('BadgePass', g.Badge, WHITE, '&H004EAA2E', '&H004EAA2E', -1),
    row('BadgeLive', g.Badge, WHITE, '&H00E37100', '&H00E37100', -1),
    row('BadgeNeutral', g.Badge, WHITE, '&H00333333', '&H00333333', -1),
    row('Counter', g.Counter, WHITE, BOX, BOX, -1),
    row('Label', g.Label, WHITE, BOX, BOX, -1),
    row('Chapter', g.Chapter, WHITE, BLACK, BLACK, -1),
    row('Before', g.Before, WHITE, BOX, BOX, -1),
    row('Prompt', g.Prompt, '&H0000D7FF', BOX, BOX, -1),
    row('PromptNext', g.PromptNext, '&H00B4B4B4', BOX, BOX, 0),
  ];
  // The bundled face is already heavy: no faux bold on it.
  if (o.captionLines?.style === 'pop') styles.push(row('Pop', g.Pop, WHITE, BLACK, BLACK, 0, CAPTION_FONT));
  if (o.captionLines?.style === 'karaoke') styles.push(row('Karaoke', g.Karaoke, WHITE, BLACK, BLACK, 0, CAPTION_FONT));
  // Cards: centred on the frame. Mono keeps the usual side margins; bold (and a picture's text) wraps inside 80% of the
  // width. Declared only when a card draws text in them.
  const cards = (o.cards ?? []).filter((c) => c.card.text.trim());
  const cardStyle = (c: CardItem['card']) => (c.style === 'mono' ? 'CardMono' : 'CardBold');
  if (cards.some((c) => cardStyle(c.card) === 'CardMono')) styles.push(row('CardMono', g.CardMono, WHITE, BLACK, BLACK, 0, MONO_FONT));
  if (cards.some((c) => cardStyle(c.card) === 'CardBold')) styles.push(row('CardBold', g.CardBold, WHITE, BLACK, BLACK, 0, CAPTION_FONT));
  // Name labels, chosen subtitles and time tags: the bundled face, declared only when an overlay uses them (their
  // geometry: styleGeometry).
  const uses = (kind: Overlay['kind']) => o.overlays.some((ov) => ov.kind === kind);
  if (uses('name')) styles.push(row('Name', g.Name, YELLOW, BLACK, BLACK, 0, CAPTION_FONT));
  if (uses('subtitle')) styles.push(row('Subtitle', g.Subtitle, YELLOW, BLACK, BLACK, 0, CAPTION_FONT));
  if (uses('timecard')) styles.push(row('Timecard', g.Timecard, BLACK, YELLOW, YELLOW, 0, CAPTION_FONT));
  const styleLines = styles.map(
    ([name, size, primary, outline, back, bold, border, outw, align, mv, face, margin]) =>
      `Style: ${name},${face},${size},${primary},${primary},${outline},${back},${bold},0,0,0,100,100,0,0,${border},${outw},0,${align},${margin},${margin},${mv},1`,
  );

  const events: string[] = [];
  const ev = (layer: number, start: number, end: number, style: string, text: string) =>
    events.push(`Dialogue: ${layer},${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`);

  // Under everything else (layer 0): captions, overlays and prompts can draw over a card. Each line as written, drawn
  // as other text is; a picture's text gets a black outline so it reads on any picture.
  for (const { start, end, card } of cards) {
    const text = card.text.trim().split(/\r?\n/).map(draw).join('\\N');
    ev(0, start, end, cardStyle(card), `{\\fad(150,150)${card.style === 'image' ? `\\bord${px(8)}` : ''}}${text}`);
  }
  for (const c of o.captions) ev(2, c.start, c.end, 'Caption', draw(c.text));
  if (o.captionLines) {
    const color = assColor(o.highlightColor ?? HIGHLIGHT_COLOR);
    // A key word is coloured and larger, a lit one coloured; \r goes back to the style for the words after it. A hidden
    // word keeps its size (so the words around it sit where they will) and is drawn fully transparent, outline too.
    const part = (p: CaptionPart, text: string, mode: 'show' | 'hide' | 'pop', last: boolean) => {
      const scale = p.key ? 112 : 100;
      const size = p.key ? `\\fscx${scale}\\fscy${scale}` : '';
      if (mode === 'hide') return `{\\alpha&HFF&${size}}${text}{\\r}`;
      const tags = `${p.key || p.lit ? `\\c${color}` : ''}${mode === 'pop' ? POP_IN(scale) : size}`;
      if (!tags) return text;
      return `{${tags}}${text}${p.key || p.lit || !last ? '{\\r}' : ''}`;
    };
    const style = o.captionLines.style === 'pop' ? 'Pop' : 'Karaoke';
    for (const line of o.captionLines.lines) {
      const parts = line.parts.map((p) => [p, draw(p.text)] as const).filter(([, text]) => text);
      const text = (mode: (p: CaptionPart) => 'show' | 'hide' | 'pop') => parts.map(([p, t], i) => part(p, t, mode(p), i === parts.length - 1)).join(' ');
      if (!parts.length) continue;
      // Growing from 115% widens the newest word, which would re-centre the line and move the words already shown. So it
      // pops in on a layer of its own over the same line drawn invisibly, and holds its place invisibly in the line itself.
      // The settled words sit on layer 1 and the popping copy on layer 2, so the newest word draws over its neighbours
      // (its outline is not covered by theirs). Not layer 3: Counter and Label use it, and libass pushes apart events
      // that overlap on one layer. Karaoke has no popping copy and stays on layer 2 with the phrase captions.
      ev(style === 'Pop' ? 1 : 2, line.start, line.end, style, text((p) => (p.hidden || p.pop ? 'hide' : 'show')));
      if (parts.some(([p]) => p.pop && !p.hidden)) ev(2, line.start, line.end, style, text((p) => (p.pop && !p.hidden ? 'pop' : 'hide')));
    }
  }
  for (const ov of o.overlays) {
    const text = draw(ov.text);
    switch (ov.kind) {
      case 'callout':
        ev(5, ov.start, ov.end, 'Callout', `{\\fad(120,200)\\t(0,150,\\fscx115\\fscy115)\\t(150,300,\\fscx100\\fscy100)}${text}`);
        break;
      case 'badge':
        ev(4, ov.start, ov.end, `Badge${ov.tone[0].toUpperCase()}${ov.tone.slice(1)}`, `{\\fad(100,150)}${text}`);
        break;
      case 'counter':
        ev(3, ov.start, ov.end, 'Counter', text);
        break;
      case 'label':
        ev(3, ov.start, ov.end, 'Label', `{\\fad(150,150)}${text}`);
        break;
      case 'chapter':
        ev(5, ov.start, ov.end, 'Chapter', `{\\fad(300,300)}${text}`);
        break;
      case 'before':
      case 'after':
        ev(4, ov.start, ov.end, 'Before', text);
        break;
      case 'name': {
        // The name, and on the line below it the sub line in white at 40 px (the style's colour and size are the name's).
        const sub = ov.sub ? draw(ov.sub) : '';
        ev(3, ov.start, ov.end, 'Name', `{\\fad(150,150)}${text}${sub ? `\\N{\\fs${px(40)}\\c${assColor('#FFFFFF')}}${sub}` : ''}`);
        break;
      }
      case 'subtitle':
        ev(3, ov.start, ov.end, 'Subtitle', `{\\fad(150,150)}${text}`);
        break;
      case 'timecard':
        ev(3, ov.start, ov.end, 'Timecard', `{\\fad(150,150)}${text}`);
        break;
    }
  }
  for (const p of o.prompts) {
    if (!p.line.trim()) continue;
    ev(6, Math.max(0, p.start - 1.5), p.start, 'PromptNext', `Next: ${draw(p.line)}`);
    ev(6, p.start, p.end, 'Prompt', draw(p.line));
  }

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${o.width}`,
    `PlayResY: ${o.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styleLines,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
