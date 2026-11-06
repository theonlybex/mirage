// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import type { NoteView, VersionView } from '../../view-types.js';
import { del, post as apiPost, withKey, type Post } from '../api.js';
import { Button } from '../components/Button.js';
import { Chip, type ChipTone } from '../components/Chip.js';
import { Icon, type IconName } from '../components/Icon.js';
import { IconButton } from '../components/IconButton.js';
import { versionName } from '../versions/format.js';
import { BoxOutline } from './box.js';
import { timecode } from './timecode.js';

/** Where a note is: not sent yet, sent, or what Claude did with it. */
export function noteStatus(n: NoteView): { label: string; tone: ChipTone; icon?: IconName } {
  const why = (s: string) => (n.reason ? `${s}: ${n.reason}` : s);
  if (n.round === null) return { label: 'Not sent', tone: 'neutral' };
  if (n.status === 'done') return { label: 'Done', tone: 'success', icon: 'check' };
  if (n.status === 'done-differently') return { label: why('Done differently'), tone: 'tertiary', icon: 'alt_route' };
  if (n.status === 'could-not') return { label: why("Couldn't"), tone: 'error', icon: 'block' };
  return { label: 'Sent', tone: 'secondary', icon: 'send' };
}

type NotesListProps = {
  video: number;
  notes: readonly NoteView[];
  versions: readonly VersionView[];
  /** The version in the player: its notes come first. */
  currentVersionId: string | null;
  onSeek: (note: NoteView) => void;
  post?: Post;
  /** Deletes an unsent note. */
  remove?: (video: number, id: string) => Promise<unknown>;
};

const removeOnServer = (video: number, id: string) => del(`/api/notes/${id}?video=${video}`);

/** The notes of this video, by version (the one playing first) and time, with "Send notes (k)" for the unsent ones. */
export function NotesList({ video, notes, versions, currentVersionId, onSeek, post = apiPost, remove = removeOnServer }: NotesListProps) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unsent = notes.filter((n) => n.round === null).length;

  // A new unsent note means the last send is old news.
  useEffect(() => {
    if (unsent > 0) setSent(false);
  }, [unsent]);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await post('/api/notes/send', { video });
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const drop = async (id: string) => {
    setError(null);
    try {
      await remove(video, id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const created = (id: string) => Date.parse(versions.find((v) => v.id === id)?.createdAt ?? '') || 0;
  const groups = [...new Set(notes.map((n) => n.versionId))]
    .sort((a, b) => (a === currentVersionId ? -1 : b === currentVersionId ? 1 : created(b) - created(a)))
    .map((id) => ({ id, version: versions.find((v) => v.id === id) ?? null, notes: notes.filter((n) => n.versionId === id).sort((a, b) => a.t - b.t) }));

  return (
    <section className="notes" aria-labelledby="notes-title">
      <div className="notes__head">
        <h2 id="notes-title" className="notes__title">
          Notes
        </h2>
        <Button variant="filled" icon="send" onClick={() => void send()} disabled={unsent === 0 || busy}>
          {`Send notes (${unsent})`}
        </Button>
      </div>
      <p className="notes__hint" role="status">
        {sent && (
          <>
            Sent to Claude. If nothing happens, type <code>/mirage:notes</code> in Claude Code.
          </>
        )}
      </p>
      {error && (
        <p className="notes__error" role="alert">
          {error}
        </p>
      )}
      {notes.length === 0 ? (
        <div className="empty-state empty-state--small">
          <Icon name="rate_review" size={40} />
          <p>Click the picture to add a note at that moment, or drag to mark a part of it. Notes stay here until you send them.</p>
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.id} className="notes__group">
            {(groups.length > 1 || g.id !== currentVersionId) && <h3 className="notes__group-title">{g.version ? versionName(g.version) : 'An older version'}</h3>}
            <ul className="notes__list">
              {g.notes.map((n) => {
                const s = noteStatus(n);
                return (
                  <li key={n.id} className="note-item" data-status={n.round === null ? 'unsent' : (n.status ?? 'sent')}>
                    <button type="button" className="note-item__main" aria-label={`${timecode(n.t)}: ${n.text}. ${s.label}`} onClick={() => onSeek(n)}>
                      <span className="note-item__thumb">
                        <img src={withKey(n.stillUrl)} alt="" loading="lazy" width={112} height={63} />
                        {n.box && <BoxOutline box={n.box} />}
                      </span>
                      <span className="note-item__body">
                        <span className="note-item__time">{timecode(n.t)}</span>
                        <span className="note-item__text">{n.text}</span>
                        <Chip tone={s.tone} icon={s.icon} className="note-item__status">
                          {s.label}
                        </Chip>
                      </span>
                    </button>
                    {n.round === null && <IconButton className="note-item__delete" icon="delete" aria-label={`Delete the note “${n.text.slice(0, 40)}”`} onClick={() => void drop(n.id)} />}
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
