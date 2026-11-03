// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from 'react';
import { Icon } from './Icon.js';

export type ChipTone = 'neutral' | 'primary' | 'secondary' | 'tertiary' | 'success' | 'error';

/** A status chip (not a control): 32 px, full radius, an optional leading icon or indicator. */
export function Chip({ tone = 'neutral', icon, leading, children, className }: { tone?: ChipTone; icon?: string; leading?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={['m3-chip', className].filter(Boolean).join(' ')} data-tone={tone}>
      {leading ?? (icon && <Icon name={icon} size={18} filled={tone !== 'neutral'} />)}
      <span className="m3-chip__label">{children}</span>
    </span>
  );
}
