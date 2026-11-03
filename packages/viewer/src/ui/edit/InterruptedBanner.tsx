// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react';
import type { Progress, StepLine, VersionView } from '../../view-types.js';
import { Button } from '../components/Button.js';
import { Icon } from '../components/Icon.js';

type ToolLine = Extract<StepLine, { id: string }>;

/** No step line and no progress for this long while a step is running: the edit has stopped (Claude Code closed, a crash). */
export const QUIET_MS = 120_000;

const time = (iso: string | undefined) => (iso ? Date.parse(iso) || 0 : 0);

/**
 * The step the edit stopped at, if it did: the newest line is a running step (so no turn ended after it) and nothing has
 * been heard of it for 120 s — no progress update, or none since the step started.
 */
export function interruptedStep(steps: readonly StepLine[], progress: Progress | null, now: number): ToolLine | null {
  const last = steps.at(-1);
  if (!last || 'type' in last || last.status !== 'running') return null;
  const heard = Math.max(time(last.at), time(progress?.updatedAt));
  return now - heard > QUIET_MS ? last : null;
}

/** The newest version of one of `kinds`. */
export function newestVersion(versions: readonly VersionView[] | null, kinds: readonly VersionView['kind'][]): VersionView | null {
  return (versions ?? []).filter((v) => kinds.includes(v.kind)).reduce<VersionView | null>((a, v) => (!a || time(v.createdAt) > time(a.createdAt) ? v : a), null);
}

/** Where "go back to the last finished step" goes: the newest checkpoint, else the newest "before this edit" version. */
export const restorePoint = (versions: readonly VersionView[] | null): VersionView | null =>
  newestVersion(versions, ['checkpoint']) ?? newestVersion(versions, ['before']);

type BannerProps = {
  steps: readonly StepLine[];
  progress: Progress | null;
  versions: readonly VersionView[] | null;
  now: number;
  /** The person has paused the edit: a quiet step is then expected, so no banner. */
  paused?: boolean;
  onGoBack: (versionId: string) => Promise<unknown> | void;
};

/** Says when an edit stopped part-way, and offers to go back to the last finished step or leave things as they are. */
export function InterruptedBanner({ steps, progress, versions, now, paused = false, onGoBack }: BannerProps) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const step = interruptedStep(steps, progress, now);
  const key = step ? `${step.id}@${step.at}` : null;
  if (!step || paused || dismissed === key) return null;
  const point = restorePoint(versions);

  const goBack = async () => {
    if (!point) return;
    setBusy(true);
    setError(null);
    try {
      await onGoBack(point.id);
      setDismissed(key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="banner" role="status" aria-labelledby="banner-text">
      <span className="banner__icon">
        <Icon name="warning" filled />
      </span>
      <div className="banner__body">
        <p id="banner-text" className="banner__text">
          This edit stopped at “{step.label}”.
        </p>
        {error && (
          <p className="banner__error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="banner__actions">
        <Button variant="text" onClick={() => setDismissed(key)}>
          Keep things as they are
        </Button>
        {point && (
          <Button variant="tonal" icon="undo" onClick={goBack} disabled={busy}>
            Go back to the last finished step
          </Button>
        )}
      </div>
    </section>
  );
}
