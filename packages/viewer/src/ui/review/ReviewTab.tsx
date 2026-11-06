// SPDX-License-Identifier: MIT
import { useEffect, useId, useState } from 'react';
import type { NoteView, VersionView } from '../../view-types.js';
import type { LiveVideo } from '../api.js';
import { Button } from '../components/Button.js';
import { Icon } from '../components/Icon.js';
import { newestFirst, versionDate, versionName } from '../versions/format.js';
import { NotesList } from './NotesList.js';
import { Player } from './Player.js';
import { VoiceoverDrop } from './VoiceoverDrop.js';

/** The versions that can be watched, newest first. */
export const watchable = (versions: readonly VersionView[] | null): VersionView[] => newestFirst((versions ?? []).filter((v) => v.videoUrl));

/** What Review plays: the chosen version while it can be watched, else the newest delivery, else the newest video. */
export function reviewVersion(versions: readonly VersionView[] | null, chosen: string | null): VersionView | null {
  const list = watchable(versions);
  return list.find((v) => v.id === chosen) ?? list.find((v) => v.kind === 'delivery') ?? list[0] ?? null;
}

type ReviewTabProps = {
  video: number;
  live: LiveVideo;
  /** The version the person picked (here or with Play in Versions), or null for the newest delivery. */
  chosen: string | null;
  onChoose: (id: string) => void;
};

/** Review: a version picker over the player, notes on the picture, the notes list and, on a guide cut, the voice-over drop. */
export function ReviewTab({ video, live, chosen, onChoose }: ReviewTabProps) {
  const pickerId = useId();
  const [seek, setSeek] = useState<{ versionId: string; t: number; nonce: number } | null>(null);
  const currentId = reviewVersion(live.versions, chosen)?.id ?? null;
  // A seek belongs to the version it was made for: once another version plays it is spent, so coming back starts fresh.
  useEffect(() => {
    if (seek && seek.versionId !== currentId) setSeek(null);
  }, [currentId]);
  if (live.versions === null) {
    return (
      <div className="review" aria-busy="true" aria-label="Loading the review">
        <div className="review__grid">
          <div className="skeleton review__skeleton" />
          <div className="skeleton" style={{ height: 320 }} />
        </div>
      </div>
    );
  }
  const list = watchable(live.versions);
  const current = reviewVersion(live.versions, chosen);
  if (!current) {
    return (
      <div className="empty-state">
        <Icon name="smart_display" size={40} />
        <p>Nothing to watch yet. The video shows up here once Mirage has made the first cut.</p>
      </div>
    );
  }
  const notes = live.notes ?? [];
  const goToNote = (n: NoteView) => {
    if (n.versionId !== current.id && list.some((v) => v.id === n.versionId)) onChoose(n.versionId);
    setSeek({ versionId: n.versionId, t: n.t, nonce: Date.now() });
  };
  const newestDelivery = list.find((v) => v.kind === 'delivery');

  return (
    <div className="review">
      <div className="review__grid">
        <div className="review__main">
          <div className="review__picker">
            <label className="version-picker" htmlFor={pickerId}>
              <span className="version-picker__label">Version</span>
              <select id={pickerId} className="version-picker__select" value={current.id} onChange={(e) => onChoose(e.currentTarget.value)}>
                {list.map((v) => (
                  <option key={v.id} value={v.id}>
                    {versionName(v)} · {versionDate(v.createdAt)}
                  </option>
                ))}
              </select>
              <Icon name="keyboard_arrow_down" className="version-picker__arrow" />
            </label>
            {newestDelivery && current.id !== newestDelivery.id && (
              <Button variant="text" onClick={() => onChoose(newestDelivery.id)}>
                Watch the newest
              </Button>
            )}
          </div>
          <Player
            key={current.id}
            video={video}
            version={current}
            notes={notes.filter((n) => n.versionId === current.id)}
            seek={seek && seek.versionId === current.id ? seek : null}
          />
          {current.render?.mode === 'guide' && <VoiceoverDrop video={video} />}
        </div>
        <NotesList video={video} notes={notes} versions={live.versions} currentVersionId={current.id} onSeek={goToNote} />
      </div>
    </div>
  );
}
