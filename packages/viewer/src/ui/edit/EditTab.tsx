// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LiveVideo } from '../api.js';
import { post, useNow } from '../api.js';
import { InterruptedBanner } from './InterruptedBanner.js';
import { LiveTimeline } from './LiveTimeline.js';
import { RunBar } from './RunBar.js';
import { StepList } from './StepList.js';

/** The Edit tab: the edit's controls, a banner if it stopped part-way, the live timeline and the steps beside it. */
export function EditTab({ video, live }: { video: number; live: LiveVideo }) {
  const now = useNow(5000);
  const steps = live.steps ?? [];
  if (live.timeline === null) {
    return (
      <div className="edit" aria-busy="true" aria-label="Loading the edit">
        <div className="skeleton" style={{ height: 72 }} />
        <div className="edit__grid">
          <div className="skeleton" style={{ height: 320 }} />
          <div className="skeleton" style={{ height: 320 }} />
        </div>
      </div>
    );
  }
  return (
    <div className="edit">
      <RunBar video={video} control={live.control} steps={steps} progress={live.progress} versions={live.versions} now={now} post={post} />
      <InterruptedBanner steps={steps} progress={live.progress} versions={live.versions} now={now} paused={live.control?.paused ?? false} onGoBack={(id) => post('/api/restore', { video, id })} />
      <div className="edit__grid">
        <LiveTimeline view={live.timeline} />
        <StepList steps={steps} />
      </div>
    </div>
  );
}
