// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guide, note, rough } from './fixtures.js';
import { NotesList, noteStatus } from './NotesList.js';

afterEach(cleanup);

const notes = [
  note({ id: 'n1', t: 4.2, text: 'Too slow here' }),
  note({ id: 'n2', t: 9, text: 'Louder', round: 1 }),
  note({ id: 'n3', t: 12, text: 'Cut the stumble', round: 1, status: 'done' }),
  note({ id: 'n4', t: 15, text: 'Zoom in', round: 1, status: 'done-differently', reason: 'Used a crop instead' }),
  note({ id: 'n5', t: 61, text: 'Swap the music', round: 1, status: 'could-not', reason: 'The track is missing' }),
];

describe('noteStatus', () => {
  it('reads Not sent, Sent, Done, Done differently and Couldn’t from the note', () => {
    expect(notes.map((n) => noteStatus(n).label)).toEqual([
      'Not sent',
      'Sent',
      'Done',
      'Done differently: Used a crop instead',
      "Couldn't: The track is missing",
    ]);
  });
});

describe('NotesList', () => {
  const setup = (list = notes) => {
    const post = vi.fn(async () => ({ sent: 1, round: 2 }));
    const onSeek = vi.fn();
    render(<NotesList video={1} notes={list} versions={[rough, guide]} currentVersionId="d1" onSeek={onSeek} post={post} />);
    return { post, onSeek };
  };

  it('shows each note’s time, text, thumbnail and status chip', () => {
    setup();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(within(items[0]!).getByText('0:04')).toBeTruthy();
    expect(within(items[0]!).getByText('Too slow here')).toBeTruthy();
    expect(within(items[0]!).getByText('Not sent')).toBeTruthy();
    expect(items[0]!.querySelector('img')?.getAttribute('src')).toBe('/media/p/episodes/1/notes/n1.jpg?k=');
    expect(within(items[4]!).getByText('1:01')).toBeTruthy();
    expect(within(items[3]!).getByText('Done differently: Used a crop instead')).toBeTruthy();
    expect(within(items[4]!).getByText("Couldn't: The track is missing")).toBeTruthy();
  });

  it('clicking a note seeks to it', () => {
    const { onSeek } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Zoom in/ }));
    expect(onSeek).toHaveBeenCalledWith(notes[3]);
  });

  it('sends the unsent notes, then says how to nudge Claude', async () => {
    const { post } = setup();
    const send = screen.getByRole('button', { name: 'Send notes (1)' }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await act(async () => void fireEvent.click(send));
    expect(post).toHaveBeenCalledWith('/api/notes/send', { video: 1 });
    const hint = screen.getByRole('status');
    expect(hint.textContent).toBe('Sent to Claude. If nothing happens, type /mirage:notes in Claude Code.');
  });

  it('Send is disabled when there are no unsent notes', () => {
    setup(notes.slice(1));
    expect((screen.getByRole('button', { name: 'Send notes (0)' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says how to add a note when there are none', () => {
    setup([]);
    expect(screen.getByText(/Click the picture to add a note/)).toBeTruthy();
  });
});
