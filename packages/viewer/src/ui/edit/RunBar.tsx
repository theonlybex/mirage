// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react';
import type { Control, Progress, StepLine, VersionView } from '../../view-types.js';
import { Button } from '../components/Button.js';
import { Chip, type ChipTone } from '../components/Chip.js';
import type { IconName } from '../components/Icon.js';
import { Spinner } from '../components/Spinner.js';
import { WavyProgress } from '../components/WavyProgress.js';
import { CorrectionBox } from './CorrectionBox.js';
import { newestVersion } from './InterruptedBanner.js';
import { finishesText, PauseSheet, type PauseMode } from './PauseSheet.js';
import { StopDialog } from './StopDialog.js';

export type RunState = 'working' | 'pausing' | 'paused' | 'stopping' | 'idle';

type ToolLine = Extract<StepLine, { id: string }>;

/** The newest step line when it is a running step. */
export const runningStep = (steps: readonly StepLine[]): ToolLine | null => {
  const last = steps.at(-1);
  return last && !('type' in last) && last.status === 'running' ? last : null;
};

/**
 * Where the edit is, from control.json and the steps. A turn that hasn't ended is working (Claude may be thinking between
 * steps); paused with a step still running is pausing, until that step ends.
 */
export function runState(control: Control | null, steps: readonly StepLine[]): RunState {
  if (control?.stop) return 'stopping';
  const last = steps.at(-1);
  const inTurn = last !== undefined && !('type' in last);
  if (control?.paused) return runningStep(steps) ? 'pausing' : 'paused';
  return inTurn ? 'working' : 'idle';
}

const STATE: Record<RunState, { label: string; tone: ChipTone; icon?: IconName }> = {
  working: { label: 'Working', tone: 'primary' },
  pausing: { label: 'Pausing', tone: 'secondary', icon: 'pause' },
  paused: { label: 'Paused', tone: 'secondary', icon: 'pause' },
  stopping: { label: 'Stopping', tone: 'error', icon: 'stop' },
  idle: { label: 'Idle', tone: 'neutral', icon: 'bedtime' },
};

const isControl = (x: unknown): x is Control => !!x && typeof x === 'object' && 'version' in x && 'paused' in x && 'updatedAt' in x;
const newer = (a: Control, b: Control | null) => !b || (Date.parse(a.updatedAt) || 0) >= (Date.parse(b.updatedAt) || 0);

type RunBarProps = {
  video: number;
  control: Control | null;
  steps: readonly StepLine[];
  progress: Progress | null;
  versions: readonly VersionView[] | null;
  now: number;
  post: (path: string, body: unknown) => Promise<unknown>;
};

/** The edit's state and its controls: Pause and Stop while working; Resume and a correction while paused. */
export function RunBar({ video, control: streamed, steps, progress, versions, now, post }: RunBarProps) {
  // What the server answered, until the stream catches up with it, so the bar doesn't lag a click.
  const [answered, setAnswered] = useState<Control | null>(null);
  const control = answered && newer(answered, streamed) ? answered : streamed;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [stopping, setStopping] = useState(false);

  // Pause and Stop stay while the turn hasn't ended, even when a step has gone quiet: Claude may still be at it, and the
  // InterruptedBanner is what says the edit may have stopped.
  const running = runningStep(steps);
  const state = runState(control, steps);
  const shown = STATE[state];
  const withProgress = running && progress ? progress : null;

  const send = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const answer = await post('/api/control', { video, ...body });
      if (isControl(answer)) setAnswered(answer);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const pause = (mode: PauseMode) => {
    setSheet(false);
    void send({ pause: mode });
  };
  const onPause = () => (withProgress ? setSheet(true) : pause('after-step'));

  const what =
    state === 'stopping'
      ? 'Going back to the last finished step…'
      : state === 'paused'
        ? 'Paused. Mirage waits until you resume.'
        : state === 'pausing'
          ? running
            ? control?.pauseNow
              ? `Stopping “${running.label}” to pause…`
              : `Pausing after “${running.label}”…`
            : 'Pausing…'
          : state === 'working'
            ? running
              ? running.label
              : 'Thinking about the next step…'
            : 'Nothing is running. Ask Claude in Claude Code to work on this video.';

  const held = state === 'paused' || state === 'pausing';
  // What Stop goes back to (as the Stop hook does): the newer of the newest checkpoint and the newest "before" version.
  const back = newestVersion(versions, ['checkpoint', 'before']);
  const lastFinished = back?.kind === 'checkpoint' ? back.label : null;

  return (
    <section className="runbar" data-state={state} aria-label="Edit controls">
      <div className="runbar__row">
        <Chip tone={shown.tone} icon={shown.icon} leading={state === 'working' ? <Spinner size={16} /> : undefined}>
          {shown.label}
        </Chip>
        <p className="runbar__what">{what}</p>
        <div className="runbar__actions">
          {state === 'working' && (
            <Button variant="tonal" icon="pause" onClick={onPause} disabled={busy}>
              Pause
            </Button>
          )}
          {held && (
            <Button variant="filled" icon="play_arrow" onClick={() => void send({ resume: {} })} disabled={busy}>
              Resume
            </Button>
          )}
          {(state === 'working' || held) && (
            <Button variant="text" tone="error" icon="stop" onClick={() => setStopping(true)} disabled={busy}>
              Stop
            </Button>
          )}
        </div>
      </div>

      {withProgress && state !== 'stopping' && (
        <div className="runbar__progress">
          <WavyProgress value={withProgress.fraction} label={running!.label} />
          <span className="runbar__progress-text">
            {Math.round(withProgress.fraction * 100)}% · {finishesText(withProgress, now)}
          </span>
        </div>
      )}

      {held && <CorrectionBox disabled={busy} onResume={(correction) => send({ resume: { correction } })} />}

      {error && (
        <p className="runbar__error" role="alert">
          {error}
        </p>
      )}

      {withProgress && running && (
        <PauseSheet open={sheet} onOpenChange={setSheet} label={running.label} progress={withProgress} now={now} onPause={pause} />
      )}
      <StopDialog open={stopping} onOpenChange={setStopping} label={lastFinished} onStop={() => void send({ stop: true })} />
    </section>
  );
}
