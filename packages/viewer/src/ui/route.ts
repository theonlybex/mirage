// SPDX-License-Identifier: MIT
// Pages by the address's #fragment, so the session key in the query stays put: `#/` and `#/v/<n>/<tab>`.
import { useSyncExternalStore } from 'react';

export const TABS = ['edit', 'review', 'versions', 'report'] as const;
export type Tab = (typeof TABS)[number];
export type Route = { page: 'videos' } | { page: 'video'; video: number; tab: Tab };

/** The page a #fragment names; anything unknown is the video list. `#/v/3` is that video's Edit tab. */
export function parseRoute(hash: string): Route {
  const m = /^#\/v\/([1-9]\d*)(?:\/([a-z]+))?\/?$/.exec(hash);
  if (!m) return { page: 'videos' };
  const tab = (TABS as readonly string[]).includes(m[2] ?? 'edit') ? ((m[2] ?? 'edit') as Tab) : 'edit';
  return { page: 'video', video: Number(m[1]), tab };
}

export const hrefFor = (r: Route): string => (r.page === 'videos' ? '#/' : `#/v/${r.video}/${r.tab}`);

const subscribe = (on: () => void) => {
  window.addEventListener('hashchange', on);
  return () => window.removeEventListener('hashchange', on);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}

/** Goes to `r` without a new history entry (for corrections like a Report tab that isn't there). */
export function replaceRoute(r: Route): void {
  const url = `${window.location.pathname}${window.location.search}${hrefFor(r)}`;
  window.history.replaceState(null, '', url);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
