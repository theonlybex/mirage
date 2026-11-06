// SPDX-License-Identifier: MIT
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { Chip } from '../components/Chip.js';
import { Icon } from '../components/Icon.js';
import { hrefFor } from '../route.js';
import { STAGE, toWatch, useVideos } from './videos.js';

/** The project's videos as cards: title, where it is, and how many versions there are to watch. */
export function VideoList() {
  const { videos, error, reload } = useVideos();
  return (
    <main id="main" className="videos" tabIndex={-1}>
      <h2 className="videos__heading">Videos</h2>
      {error && videos === null ? (
        <div className="empty-state" role="alert">
          <Icon name="cloud_off" size={40} />
          <p>{error}</p>
          <Button variant="tonal" icon="refresh" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : videos === null ? (
        <div className="videos__grid" aria-busy="true" aria-label="Loading videos">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton videos__skeleton" />
          ))}
        </div>
      ) : videos.length === 0 ? (
        <div className="empty-state">
          <Icon name="video_library" size={40} />
          <p>No videos yet. Ask Claude in Claude Code to start one, and it shows up here.</p>
        </div>
      ) : (
        <ul className="videos__grid">
          {videos.map((v) => {
            const stage = STAGE[v.stage];
            return (
              <li key={v.number}>
                <Card href={hrefFor({ page: 'video', video: v.number, tab: 'edit' })} className="video-card">
                  <span className="video-card__number">Video {v.number}</span>
                  <span className="video-card__title">{v.title}</span>
                  <span className="video-card__meta">
                    <Chip tone={stage.tone} icon={v.stage === 'final' ? 'check' : undefined}>
                      {stage.label}
                    </Chip>
                    <span className="video-card__count">{toWatch(v.deliveries)}</span>
                  </span>
                  <Icon name="chevron_right" className="video-card__go" />
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
