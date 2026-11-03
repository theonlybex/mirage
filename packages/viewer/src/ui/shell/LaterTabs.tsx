// SPDX-License-Identifier: AGPL-3.0-or-later
// Plain first versions of the Review, Versions and Report tabs; the full ones (notes on the picture, going back to a
// version, the formatted report) replace these.
import type { VersionView } from '../../view-types.js';
import { withKey } from '../api.js';
import { Icon } from '../components/Icon.js';

const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export function ReviewTab({ versions }: { versions: readonly VersionView[] }) {
  const watchable = versions.filter((v) => v.videoUrl).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const newest = watchable.find((v) => v.kind === 'delivery') ?? watchable[0];
  if (!newest?.videoUrl) {
    return (
      <div className="empty-state">
        <Icon name="smart_display" size={40} />
        <p>Nothing to watch yet. The video shows up here once Mirage has made the first cut.</p>
      </div>
    );
  }
  return (
    <section className="review" aria-label="Watch">
      <div className="review__frame">
        <video key={newest.id} src={withKey(newest.videoUrl)} controls preload="metadata" playsInline />
      </div>
      <p className="review__caption">
        {newest.label} · {when(newest.createdAt)}
      </p>
    </section>
  );
}

export function VersionsTab({ versions }: { versions: readonly VersionView[] }) {
  const shown = versions.filter((v) => v.kind !== 'checkpoint').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (!shown.length) {
    return (
      <div className="empty-state">
        <Icon name="history" size={40} />
        <p>No versions yet. Each cut Mirage makes is kept here.</p>
      </div>
    );
  }
  return (
    <ul className="versions">
      {shown.map((v) => (
        <li key={v.id} className="versions__item">
          <Icon name={v.kind === 'delivery' ? 'movie' : 'history'} />
          <span className="versions__label">{v.delivery ? `V${v.delivery} · ${v.label}` : v.label}</span>
          <time className="versions__date" dateTime={v.createdAt}>
            {when(v.createdAt)}
          </time>
        </li>
      ))}
    </ul>
  );
}

export function ReportTab({ report }: { report: string }) {
  return <article className="report">{report}</article>;
}
