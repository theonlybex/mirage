// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';
import { Button } from '../components/Button.js';

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'paragraph'; text: string };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;

/**
 * The little Markdown a report uses: `#` headings, `-`/`*`/`+` and `1.` lists (an indented line continues an item)
 * and paragraphs (lines joined with spaces). Everything else is text: nothing becomes HTML.
 */
export function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: Extract<Block, { kind: 'list' }> | null = null;
  const flush = () => {
    if (para.length) blocks.push({ kind: 'paragraph', text: para.join(' ') });
    para = [];
    list = null;
  };
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: 'heading', level: h[1]!.length, text: h[2]! });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      const ordered = numbered !== null;
      const open = list as Extract<Block, { kind: 'list' }> | null;
      if (!open || open.ordered !== ordered) {
        flush();
        list = { kind: 'list', ordered, items: [] };
        blocks.push(list);
      }
      list!.items.push(item[1]!.trim());
      continue;
    }
    const open = list as Extract<Block, { kind: 'list' }> | null;
    if (open && /^\s/.test(line)) {
      open.items[open.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (open) list = null;
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/** `code` spans as <code>; the rest as plain text. */
function inline(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((p, i) => (p.length > 2 && p.startsWith('`') && p.endsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p));
}

/** The morning report, formatted, with "Open the video" to watch what it is about. */
export function Report({ report, onOpenVideo }: { report: string; onOpenVideo: () => void }) {
  const blocks = parseMarkdown(report);
  const first = blocks[0]?.kind === 'heading' && blocks[0].level === 1 ? blocks[0] : null;
  const rest = first ? blocks.slice(1) : blocks;
  return (
    <article className="report" aria-labelledby={first ? 'report-title' : undefined}>
      <header className="report__head">
        {first && (
          <h1 id="report-title" className="report__title">
            {inline(first.text)}
          </h1>
        )}
        <Button variant="filled" size="medium" icon="smart_display" onClick={onOpenVideo}>
          Open the video
        </Button>
      </header>
      {rest.map((b, i) => {
        if (b.kind === 'heading') {
          const Tag = (`h${Math.min(6, Math.max(2, b.level))}`) as 'h2';
          return (
            <Tag key={i} className="report__heading">
              {inline(b.text)}
            </Tag>
          );
        }
        if (b.kind === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul';
          return (
            <Tag key={i} className="report__list">
              {b.items.map((t, j) => (
                <li key={j}>{inline(t)}</li>
              ))}
            </Tag>
          );
        }
        return (
          <p key={i} className="report__paragraph">
            {inline(b.text)}
          </p>
        );
      })}
    </article>
  );
}
