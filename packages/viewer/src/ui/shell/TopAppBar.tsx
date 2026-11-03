// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from 'react';
import { Icon } from '../components/Icon.js';

type TopAppBarProps = {
  title: ReactNode;
  /** A small line above the title (the video's number). */
  overline?: string;
  /** Where the back arrow goes; no arrow without it. */
  back?: { href: string; label: string };
  trailing?: ReactNode;
};

/** An M3 small top app bar: 64 px on surface, title-large, optional back arrow and trailing actions. */
export function TopAppBar({ title, overline, back, trailing }: TopAppBarProps) {
  return (
    <header className="appbar" data-has-back={back ? 'true' : undefined}>
      {back && (
        <a className="m3-icon-button" href={back.href} aria-label={back.label} title={back.label}>
          <Icon name="arrow_back" />
        </a>
      )}
      <div className="appbar__titles">
        {overline && <span className="appbar__overline">{overline}</span>}
        <h1 className="appbar__title">{title}</h1>
      </div>
      <div className="appbar__trailing">{trailing}</div>
    </header>
  );
}
