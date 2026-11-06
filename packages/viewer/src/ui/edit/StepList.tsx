// SPDX-License-Identifier: MIT
import { useLayoutEffect, useRef } from 'react';
import type { StepLine } from '../../view-types.js';
import { Icon } from '../components/Icon.js';
import { Spinner } from '../components/Spinner.js';

type ToolLine = Extract<StepLine, { id: string }>;
export type StepRow = { kind: 'step'; key: string; line: ToolLine } | { kind: 'turn-end'; key: string; at: string };

/**
 * The step lines as rows: a tool call writes a `running` line and then its outcome under the same id, so each id is one
 * row, where it started, showing its newest line. A line without an id is its own row. Newest last.
 */
export function stepRows(steps: readonly StepLine[]): StepRow[] {
  const rows: StepRow[] = [];
  const byId = new Map<string, number>();
  steps.forEach((s, i) => {
    if ('type' in s) {
      rows.push({ kind: 'turn-end', key: `turn-end:${i}`, at: s.at });
      return;
    }
    const at = s.id ? byId.get(s.id) : undefined;
    if (at !== undefined) rows[at] = { kind: 'step', key: rows[at]!.key, line: s };
    else {
      if (s.id) byId.set(s.id, rows.length);
      rows.push({ kind: 'step', key: s.id ? `step:${s.id}` : `line:${i}`, line: s });
    }
  });
  return rows;
}

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

function StatusMark({ status }: { status: ToolLine['status'] }) {
  if (status === 'running') {
    return (
      <span className="step__mark" aria-live="polite">
        <Spinner size={20} />
        <span className="visually-hidden">Running</span>
      </span>
    );
  }
  const icon = ({ done: 'check', failed: 'error', denied: 'pause' } as const)[status];
  const words = { done: 'Done', failed: 'Didn’t work', denied: 'Held back' }[status];
  return (
    <span className="step__mark">
      <Icon name={icon} size={20} filled={status !== 'done'} />
      <span className="visually-hidden">{words}</span>
    </span>
  );
}

/** What Claude has done on this video, step by step, newest last. Follows the newest step unless the person scrolled up. */
export function StepList({ steps }: { steps: readonly StepLine[] }) {
  const rows = stepRows(steps);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = rows.at(-1);
  const lastKey = last ? `${last.key}:${last.kind === 'step' ? last.line.status : ''}` : '';

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lastKey]);

  return (
    <section className="steps" aria-labelledby="steps-title">
      <header className="steps__head">
        <h2 id="steps-title" className="steps__title">
          Steps
        </h2>
        {rows.length > 0 && <span className="steps__count">{rows.filter((r) => r.kind === 'step').length}</span>}
      </header>
      {rows.length === 0 ? (
        <div className="empty-state empty-state--small">
          <Icon name="list" size={24} />
          <p>No steps yet. Each thing Claude does to this video shows up here.</p>
        </div>
      ) : (
        <div
          className="steps__scroll"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          <ol className="steps__list">
            {rows.map((r) =>
              r.kind === 'turn-end' ? (
                <li key={r.key} className="steps__turn" role="separator" aria-label="Claude finished and replied">
                  <span>Claude replied</span>
                </li>
              ) : (
                <li key={r.key} className="step" data-status={r.line.status}>
                  <StatusMark status={r.line.status} />
                  <div className="step__text">
                    <span className="step__label">{r.line.label}</span>
                    {r.line.status === 'failed' && r.line.detail && <span className="step__detail">{r.line.detail}</span>}
                    {r.line.status === 'denied' && <span className="step__detail">Your correction was passed on</span>}
                  </div>
                  <time className="step__time" dateTime={r.line.at}>
                    {clock(r.line.at)}
                  </time>
                </li>
              ),
            )}
          </ol>
        </div>
      )}
    </section>
  );
}
