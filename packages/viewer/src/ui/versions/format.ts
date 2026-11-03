// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VersionView } from '../../view-types.js';

/** A version's date and time as the person reads it. */
export const versionDate = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** `V<k> · <label>` for a delivery, else its label. */
export const versionName = (v: Pick<VersionView, 'delivery' | 'label'>): string => (v.delivery ? `V${v.delivery} · ${v.label}` : v.label);

/** Newest first. */
export const newestFirst = <T extends Pick<VersionView, 'createdAt'>>(vs: readonly T[]): T[] => [...vs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
