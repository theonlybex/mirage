// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMarkdown, Report } from './Report.js';

afterEach(cleanup);

const REPORT = `# First video: V2 ready

## What I did

- Clips catalogued
- Rough cut rendered

## Questions for you

1. Keep the <b>cold open</b>?
2. Shorter montage?

A paragraph
over two lines.

## Next

Record the voice-over: open the video in Mirage's viewer.
`;

describe('parseMarkdown', () => {
  it('reads headings, bullet and numbered lists and paragraphs', () => {
    expect(parseMarkdown(REPORT)).toEqual([
      { kind: 'heading', level: 1, text: 'First video: V2 ready' },
      { kind: 'heading', level: 2, text: 'What I did' },
      { kind: 'list', ordered: false, items: ['Clips catalogued', 'Rough cut rendered'] },
      { kind: 'heading', level: 2, text: 'Questions for you' },
      { kind: 'list', ordered: true, items: ['Keep the <b>cold open</b>?', 'Shorter montage?'] },
      { kind: 'paragraph', text: 'A paragraph over two lines.' },
      { kind: 'heading', level: 2, text: 'Next' },
      { kind: 'paragraph', text: "Record the voice-over: open the video in Mirage's viewer." },
    ]);
  });
});

describe('Report', () => {
  it('renders the report as headings, lists and paragraphs, never as HTML', () => {
    const onOpen = vi.fn();
    const { container } = render(<Report report={REPORT} onOpenVideo={onOpen} />);
    expect(screen.getByRole('heading', { level: 1, name: 'First video: V2 ready' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['What I did', 'Questions for you', 'Next']);
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('Keep the <b>cold open</b>?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open the video' }));
    expect(onOpen).toHaveBeenCalled();
  });
});
