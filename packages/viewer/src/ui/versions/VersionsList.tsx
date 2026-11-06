// SPDX-License-Identifier: MIT
import { useState } from 'react';
import type { VersionView } from '../../view-types.js';
import { post as apiPost, type Post } from '../api.js';
import { Button } from '../components/Button.js';
import { Dialog, DialogClose } from '../components/Dialog.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Switch } from '../components/Switch.js';
import { newestFirst, versionDate, versionName } from './format.js';

type VersionsListProps = {
  video: number;
  versions: readonly VersionView[];
  /** Plays a version in Review. */
  onPlay: (id: string) => void;
  post?: Post;
};

const ICON: Record<VersionView['kind'], IconName> = { delivery: 'movie', before: 'history', checkpoint: 'check', backup: 'alt_route' };
const SUPPORT: Partial<Record<VersionView['kind'], string>> = {
  before: 'How the video was before an edit started',
  checkpoint: 'A point saved along the way',
  backup: 'What was there before going back',
};
/** Saved by the way, shown only with "Show steps": each step's checkpoint and what was there before each go-back. */
const isStep = (v: VersionView) => v.kind === 'checkpoint' || v.kind === 'backup';

/**
 * Every kept version, newest first: the deliveries (`V<k> · <label> · <date>`) and the "Before this edit" points, plus
 * each step's checkpoint and each go-back's backup behind "Show steps". Each can be played (when it has a video) or gone back to, after a yes.
 */
export function VersionsList({ video, versions, onPlay, post = apiPost }: VersionsListProps) {
  const [showSteps, setShowSteps] = useState(false);
  const [asking, setAsking] = useState<VersionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = newestFirst(versions.filter((v) => showSteps || !isStep(v)));
  const hasSteps = versions.some(isStep);

  const goBack = async (v: VersionView) => {
    setAsking(null);
    setBusy(true);
    setDone(null);
    setError(null);
    try {
      await post('/api/restore', { video, id: v.id });
      setDone(`Went back to “${v.label}”.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="versions" aria-labelledby="versions-title">
      <div className="versions__head">
        <h2 id="versions-title" className="versions__title">
          Versions
        </h2>
        {hasSteps && <Switch checked={showSteps} onChange={setShowSteps} label="Show steps" />}
      </div>
      <p className="versions__status" role="status">
        {done}
      </p>
      {error && (
        <p className="versions__error" role="alert">
          {error}
        </p>
      )}
      {shown.length === 0 ? (
        <div className="empty-state">
          <Icon name="history" size={40} />
          <p>{hasSteps ? 'Only steps so far. Turn on “Show steps” to see them.' : 'No versions yet. Each cut Mirage makes is kept here.'}</p>
        </div>
      ) : (
        <ul className="versions__list">
          {shown.map((v) => (
            <li key={v.id} className="version" data-kind={v.kind}>
              <span className="version__icon">
                <Icon name={ICON[v.kind]} filled={v.kind === 'delivery'} />
              </span>
              <span className="version__text">
                <span className="version__title">
                  {versionName(v)} · <time dateTime={v.createdAt}>{versionDate(v.createdAt)}</time>
                </span>
                {SUPPORT[v.kind] && <span className="version__support">{SUPPORT[v.kind]}</span>}
              </span>
              <span className="version__actions">
                {v.videoUrl && (
                  <Button variant="tonal" icon="play_arrow" aria-label={`Play ${v.delivery ? `V${v.delivery}` : v.label}`} onClick={() => onPlay(v.id)}>
                    Play
                  </Button>
                )}
                <Button variant="text" icon="undo" onClick={() => setAsking(v)} disabled={busy}>
                  Go back to this version
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        role="alertdialog"
        icon={<Icon name="undo" />}
        title={asking ? `Go back to “${asking.label}”?` : ''}
        actions={
          <>
            <DialogClose asChild>
              <Button variant="text" autoFocus>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="text" onClick={() => asking && void goBack(asking)}>
              Go back
            </Button>
          </>
        }
      >
        <p>What's there now is kept as a version too.</p>
      </Dialog>
    </section>
  );
}
