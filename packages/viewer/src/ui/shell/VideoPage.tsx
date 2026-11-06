// SPDX-License-Identifier: MIT
import { useEffect, useState, type ReactNode } from 'react';
import { useEvents } from '../api.js';
import { Chip } from '../components/Chip.js';
import { Icon } from '../components/Icon.js';
import { Spinner } from '../components/Spinner.js';
import { EditTab } from '../edit/EditTab.js';
import { hrefFor, replaceRoute, type Tab } from '../route.js';
import { Report } from '../report/Report.js';
import { ReviewTab } from '../review/ReviewTab.js';
import { VersionsList } from '../versions/VersionsList.js';
import { TopAppBar } from './TopAppBar.js';
import { useVideos } from './videos.js';

const TAB_LABELS: Record<Tab, string> = { edit: 'Edit', review: 'Review', versions: 'Versions', report: 'Report' };

/** One video: its tabs (Report only once there is one) over what the server streams for it. */
export function VideoPage({ video, tab, trailing }: { video: number; tab: Tab; trailing: ReactNode }) {
  const live = useEvents(video);
  const { videos } = useVideos();
  const title = videos?.find((v) => v.number === video)?.title ?? live.timeline?.title ?? `Video ${video}`;
  // The version Review plays, when the person picked one (in Review, or with Play in Versions); null is the newest delivery.
  const [reviewChoice, setReviewChoice] = useState<string | null>(null);
  const watch = (id: string | null) => {
    setReviewChoice(id);
    window.location.hash = hrefFor({ page: 'video', video, tab: 'review' });
  };
  const tabs: Tab[] = live.report !== null ? ['edit', 'review', 'versions', 'report'] : ['edit', 'review', 'versions'];

  useEffect(() => {
    if (tab === 'report' && live.loaded && live.report === null) replaceRoute({ page: 'video', video, tab: 'edit' });
  }, [tab, live.loaded, live.report, video]);

  useEffect(() => {
    document.title = `${title} · Mirage`;
    return () => {
      document.title = 'Mirage';
    };
  }, [title]);

  const status = live.gaveUp ? (
    <Chip tone="error" icon="link_off">
      Link expired
    </Chip>
  ) : !live.connected && live.timeline !== null ? (
    <Chip tone="neutral" leading={<Spinner size={16} />}>
      Reconnecting…
    </Chip>
  ) : null;

  return (
    <>
      <TopAppBar
        back={{ href: hrefFor({ page: 'videos' }), label: 'All videos' }}
        overline={`Video ${video}`}
        title={title}
        trailing={
          <>
            {status}
            {trailing}
          </>
        }
      />
      <nav className="tabs" aria-label="Video sections">
        {tabs.map((t) => (
          <a key={t} className="tabs__tab" href={hrefFor({ page: 'video', video, tab: t })} aria-current={t === tab ? 'page' : undefined}>
            <span className="tabs__label">{TAB_LABELS[t]}</span>
          </a>
        ))}
      </nav>
      <main id="main" className="video-page" tabIndex={-1}>
        {live.gaveUp && live.timeline === null ? (
          <div className="empty-state" role="alert">
            <Icon name="link_off" size={40} />
            <p>This page’s link has expired. Open the newest Mirage link from Claude Code.</p>
          </div>
        ) : tab === 'edit' ? (
          <EditTab video={video} live={live} />
        ) : tab === 'review' ? (
          <ReviewTab video={video} live={live} chosen={reviewChoice} onChoose={setReviewChoice} />
        ) : tab === 'versions' ? (
          live.versions === null ? (
            <div className="versions" aria-busy="true" aria-label="Loading the versions">
              <div className="skeleton" style={{ height: 240 }} />
            </div>
          ) : (
            <VersionsList video={video} versions={live.versions} onPlay={watch} />
          )
        ) : live.report !== null ? (
          <Report report={live.report} onOpenVideo={() => watch(null)} />
        ) : null}
      </main>
    </>
  );
}
