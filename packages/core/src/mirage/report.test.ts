// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LogEntry, StepLine, VersionMeta } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { buildReport } from './report.js';

const at = '2026-11-02T03:00:00.000Z';
const done = (label: string, status: 'done' | 'failed' | 'running' | 'denied' = 'done'): StepLine => ({ at, id: label, tool: 't', label, status });
const log = (kind: LogEntry['kind'], text: string): LogEntry => ({ at, kind, text });
const delivery = (k: number, mode: 'rough' | 'guide' | 'final'): VersionMeta => ({
  version: 1, id: `20261102-030000-000-delivery-ab${k}0`, kind: 'delivery', label: 'x', createdAt: at, sessionId: 's1', delivery: k,
  render: { mode, file: 'video.mp4', captions: null }, hasEpisode: true, hasSummary: false,
});

describe('buildReport', () => {
  it('puts the sections in order, with a Next line for a guide', () => {
    const md = buildReport({
      videoTitle: 'Desk lamp',
      steps: [done('Clips catalogued'), done('Timeline checked'), { at, type: 'turn-end' }, done('Guide video rendered')],
      log: [
        log('warning', 'clip c003 is dark'),
        log('question', 'Is the lamp called Lumi?'),
        log('guess', 'Used the slow track'),
        log('concern', 'The intro may be long'),
        log('note-status', 'ignored'),
      ],
      delivered: delivery(2, 'guide'),
    });
    expect(md).toBe([
      '# Desk lamp: V2 ready',
      '',
      '## What I did',
      '',
      '- Clips catalogued',
      '- Timeline checked',
      '- Guide video rendered',
      '',
      "## Things I wasn't sure about",
      '',
      '- The intro may be long',
      '',
      '## Choices I made for you',
      '',
      '- Used the slow track',
      '',
      '## Questions for you',
      '',
      '- Is the lamp called Lumi?',
      '',
      '## Things to check',
      '',
      '- clip c003 is dark',
      '',
      '## Next',
      '',
      "Record the voice-over: open the video in Mirage's viewer, go to Review, and follow the steps there.",
      '',
    ].join('\n'));
  });

  it('de-duplicates done labels and warnings, in order, and leaves out what is not done', () => {
    const md = buildReport({
      videoTitle: 'T',
      steps: [done('Timeline checked'), done('Rendering the rough cut', 'failed'), done('Timeline written'), done('Timeline checked'), done('Working', 'running')],
      log: [log('warning', 'a'), log('warning', 'b'), log('warning', 'a')],
      delivered: null,
      stoppedAt: 'Rendering the rough cut',
    });
    expect(md).toContain('- Timeline checked\n- Timeline written\n\n');
    expect(md.match(/Timeline checked/g)).toHaveLength(1);
    expect(md).not.toContain('- Rendering the rough cut');
    expect(md).toContain('## Things to check\n\n- a\n- b\n');
    expect(md.match(/- a\n/g)).toHaveLength(1);
  });

  it('leaves empty sections out and has no Next line without a guide delivery', () => {
    const md = buildReport({ videoTitle: 'T', steps: [done('Rough cut rendered')], log: [], delivered: delivery(1, 'rough') });
    expect(md).toBe('# T: V1 ready\n\n## What I did\n\n- Rough cut rendered\n');
    for (const h of ["wasn't sure", 'Choices', 'Questions', 'Things to check', 'Next']) expect(md).not.toContain(h);
  });

  it('says where it stopped when nothing was delivered', () => {
    expect(buildReport({ videoTitle: 'T', steps: [], log: [], delivered: null, stoppedAt: 'Rendering the guide video' })).toBe('# T: Stopped at: Rendering the guide video\n');
    // Without stoppedAt, the last step says where.
    expect(buildReport({ videoTitle: 'T', steps: [done('Timeline checked'), done('Rendering the guide video', 'failed'), { at, type: 'turn-end' }], log: [], delivered: null }))
      .toMatch(/^# T: Stopped at: Rendering the guide video\n/);
  });
});
