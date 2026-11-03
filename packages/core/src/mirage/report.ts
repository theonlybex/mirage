// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LogEntry, StepLine, VersionMeta } from '@wordedits/shared';

const NEXT_AFTER_GUIDE = "Record the voice-over: open the video in Mirage's viewer, go to Review, and follow the steps there.";

const unique = (xs: string[]) => [...new Set(xs)];

/** The label of the last step line (turn ends skipped), or null when there is none. */
function lastLabel(steps: StepLine[]): string | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if ('label' in s) return s.label;
  }
  return null;
}

/**
 * The morning report of one video, in Markdown: the title says which version is ready (or where the run stopped), then
 * what was done, the concerns, guesses, questions and warnings from the session log, and for a guide cut what to do next.
 * Empty sections are left out.
 */
export function buildReport(o: { videoTitle: string; steps: StepLine[]; log: LogEntry[]; delivered: VersionMeta | null; stoppedAt?: string }): string {
  const ready = o.delivered && o.delivered.delivery !== null ? `V${o.delivered.delivery} ready` : null;
  const parts = [`# ${o.videoTitle}: ${ready ?? `Stopped at: ${o.stoppedAt ?? lastLabel(o.steps) ?? 'the start'}`}`];
  const section = (heading: string, items: string[]) => {
    if (items.length) parts.push(`## ${heading}\n\n${items.map((t) => `- ${t}`).join('\n')}`);
  };
  const ofKind = (kind: LogEntry['kind']) => o.log.filter((e) => e.kind === kind).map((e) => e.text);
  section('What I did', unique(o.steps.flatMap((s) => ('status' in s && s.status === 'done' ? [s.label] : []))));
  section("Things I wasn't sure about", ofKind('concern'));
  section('Choices I made for you', ofKind('guess'));
  section('Questions for you', ofKind('question'));
  section('Things to check', unique(ofKind('warning')));
  if (o.delivered?.render?.mode === 'guide') parts.push(`## Next\n\n${NEXT_AFTER_GUIDE}`);
  return parts.join('\n\n') + '\n';
}
