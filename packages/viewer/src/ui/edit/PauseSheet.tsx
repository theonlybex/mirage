// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Progress } from '../../view-types.js';
import { Button } from '../components/Button.js';
import { Icon } from '../components/Icon.js';
import { Sheet } from '../components/Sheet.js';

/** Under this fraction done there is too little to go on for a guess. */
const MIN_FRACTION = 0.02;

/** Seconds left on a command, from how long it has run and how far it is: elapsed × (1 − f) / f; null while f < 0.02. */
export function remainingSeconds(progress: Progress, now: number): number | null {
  const f = progress.fraction;
  const started = Date.parse(progress.startedAt);
  if (!(f >= MIN_FRACTION) || !Number.isFinite(started)) return null;
  const elapsed = Math.max(0, (now - started) / 1000);
  return (elapsed * (1 - f)) / f;
}

/** "finishes in about 3 min", or "finishes soon" while it can't be told. */
export function finishesText(progress: Progress, now: number): string {
  const left = remainingSeconds(progress, now);
  if (left === null) return 'finishes soon';
  return `finishes in about ${Math.max(1, Math.round(left / 60))} min`;
}

export type PauseMode = 'after-step' | 'now';

type PauseSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The running step. */
  label: string;
  progress: Progress;
  now: number;
  onPause: (mode: PauseMode) => void;
};

/** How to pause while a long step runs: let it finish, or stop it now (it can run again later). */
export function PauseSheet({ open, onOpenChange, label, progress, now, onPause }: PauseSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Pause the edit">
      <div className="pause-options">
        <button type="button" className="pause-option" onClick={() => onPause('after-step')}>
          <span className="pause-option__icon" data-tone="primary">
            <Icon name="pause_circle" />
          </span>
          <span className="pause-option__text">
            <span className="pause-option__title">Pause after this step</span>
            <span className="pause-option__support">
              “{label}” {finishesText(progress, now)}
            </span>
          </span>
        </button>
        <button type="button" className="pause-option" onClick={() => onPause('now')}>
          <span className="pause-option__icon" data-tone="secondary">
            <Icon name="pause" />
          </span>
          <span className="pause-option__text">
            <span className="pause-option__title">Pause now</span>
            <span className="pause-option__support">Stops “{label}” now. It can run again later.</span>
          </span>
        </button>
      </div>
      <div className="m3-sheet__actions">
        <Button variant="text" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
      </div>
    </Sheet>
  );
}
