import type { Catalog, Episode, Overlay, Slot, Transcript, VoiceLine, Word } from '@wordedits/shared';
import { isFiller } from '../autoedit/takes.js';
import { layoutTimeline } from './timeline.js';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const EPS = 1e-6;

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export function keptSegments(line: VoiceLine): { in: number; out: number; offset: number }[] {
  const cuts = [...line.cuts].sort((a, b) => a[0] - b[0]);
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

/** Every spoken (non-filler) word on the output timeline: live audio of kept real-time items, plus the fitted voice-over. */
export function speechWords(ep: Episode, catalog: Catalog, vo: Transcript | null): Word[] {
  const fps = ep.output.fps;
  const out: Word[] = [];
  for (const l of layoutTimeline(ep)) {
    const { item } = l;
    if (item.audio !== 'keep' || item.speed !== 1) continue;
    const words = catalog.clips.find((c) => c.id === item.clip)?.transcript?.words ?? [];
    const srcEnd = item.src.in + l.srcFrames / fps;
    for (const w of words) {
      if (w.start < item.src.in - EPS || w.start >= srcEnd || isFiller(w)) continue;
      out.push({ ...w, start: r3(l.start + w.start - item.src.in), end: r3(l.start + Math.min(w.end, srcEnd) - item.src.in) });
    }
  }
  if (vo && ep.voiceover) {
    for (const line of ep.voiceover.lines) {
      const segs = keptSegments(line);
      for (const w of vo.words) {
        if (isFiller(w)) continue;
        const seg = segs.find((g) => w.start >= g.in - EPS && w.start < g.out);
        if (!seg) continue;
        out.push({ ...w, start: r3(line.at + seg.offset + w.start - seg.in), end: r3(line.at + seg.offset + Math.min(w.end, seg.out) - seg.in) });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const SENTENCE_END = /[.?!]["'”’)\]]*$/;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const tidy = (t: string) => t.replace(EMOJI, '').replace(/\s+([.,!?;:])/g, '$1').trim();

export function groupCaptions(words: Word[], o: { durationSec: number; maxChars?: number; maxGap?: number; lead?: number; minDur?: number }): Cue[] {
  const maxChars = o.maxChars ?? 38;
  const maxGap = o.maxGap ?? 0.6;
  const lead = o.lead ?? 0.15;
  const minDur = o.minDur ?? 0.8;
  const groups: { text: string; start: number; end: number }[][] = [];
  let cur: { text: string; start: number; end: number }[] = [];
  for (const word of words) {
    const text = tidy(word.w);
    if (!text) continue;
    const last = cur[cur.length - 1];
    const joined = [...cur.map((x) => x.text), text].join(' ');
    if (last && (joined.length > maxChars || word.start - last.end > maxGap || SENTENCE_END.test(last.text))) {
      groups.push(cur);
      cur = [];
    }
    cur.push({ text, start: word.start, end: word.end });
  }
  if (cur.length) groups.push(cur);

  const cues = groups.map((g) => ({ start: r3(Math.max(0, g[0].start - lead)), end: g[g.length - 1].end, text: tidy(g.map((x) => x.text).join(' ')) }));
  for (let i = 0; i < cues.length; i++) {
    if (i > 0) cues[i].start = Math.max(cues[i].start, cues[i - 1].end);
    const limit = i + 1 < cues.length ? cues[i + 1].start : o.durationSec;
    cues[i].end = r3(Math.max(cues[i].end, Math.min(cues[i].start + minDur, limit)));
  }
  return cues;
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

function defaultFont(): string {
  if (process.platform === 'darwin') return 'Helvetica Neue';
  if (process.platform === 'win32') return 'Segoe UI';
  return 'DejaVu Sans';
}

// ASS colours are &HAABBGGRR (alpha 00 = opaque).
const WHITE = '&H00FFFFFF';
const BLACK = '&H00000000';
const BOX = '&H4D000000';

export function buildAss(o: { width: number; height: number; font?: string; captions: Cue[]; overlays: Overlay[]; prompts: Slot[] }): string {
  const k = Math.min(o.width, o.height) / 1080;
  const px = (n: number) => Math.max(1, Math.round(n * k));
  const font = o.font ?? defaultFont();
  const side = Math.round(o.width * 0.05);
  // Name, Fontsize, Primary, Outline, Back, Bold, BorderStyle, Outline, Alignment, MarginV
  const styles: [string, number, string, string, string, number, number, number, number, number][] = [
    ['Caption', px(64), WHITE, BOX, BOX, -1, 3, px(18), 2, px(90)],
    ['Callout', px(150), WHITE, BLACK, BLACK, -1, 1, px(6), 5, 0],
    ['BadgeFail', px(48), WHITE, '&H002A2AE0', '&H002A2AE0', -1, 3, px(14), 9, px(60)],
    ['BadgePass', px(48), WHITE, '&H004EAA2E', '&H004EAA2E', -1, 3, px(14), 9, px(60)],
    ['BadgeLive', px(48), WHITE, '&H00E37100', '&H00E37100', -1, 3, px(14), 9, px(60)],
    ['BadgeNeutral', px(48), WHITE, '&H00333333', '&H00333333', -1, 3, px(14), 9, px(60)],
    ['Counter', px(40), WHITE, BOX, BOX, -1, 3, px(12), 7, px(60)],
    ['Label', px(48), WHITE, BOX, BOX, -1, 3, px(14), 1, px(220)],
    ['Chapter', px(96), WHITE, BLACK, BLACK, -1, 1, px(4), 5, 0],
    ['Before', px(56), WHITE, BOX, BOX, -1, 3, px(14), 8, px(60)],
    ['Prompt', px(54), '&H0000D7FF', BOX, BOX, -1, 3, px(16), 8, px(150)],
    ['PromptNext', px(44), '&H00B4B4B4', BOX, BOX, 0, 3, px(14), 8, px(150)],
  ];
  const styleLines = styles.map(
    ([name, size, primary, outline, back, bold, border, outw, align, mv]) =>
      `Style: ${name},${font},${size},${primary},${primary},${outline},${back},${bold},0,0,0,100,100,0,0,${border},${outw},0,${align},${side},${side},${mv},1`,
  );

  const events: string[] = [];
  const ev = (layer: number, start: number, end: number, style: string, text: string) =>
    events.push(`Dialogue: ${layer},${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`);

  for (const c of o.captions) ev(2, c.start, c.end, 'Caption', assText(c.text));
  for (const ov of o.overlays) {
    const text = assText(ov.text);
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
    }
  }
  for (const p of o.prompts) {
    if (!p.line.trim()) continue;
    ev(6, Math.max(0, p.start - 1.5), p.start, 'PromptNext', `Next: ${assText(p.line)}`);
    ev(6, p.start, p.end, 'Prompt', assText(p.line));
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
