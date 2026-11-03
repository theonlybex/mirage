// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CSSProperties } from 'react';

/**
 * A Material Symbols Rounded icon by its ligature name (weight 400, grade 0, optical size to match). Outlined by default,
 * filled for selected states. Decorative: the control around it carries the words.
 */
export function Icon({ name, filled = false, size = 24, className }: { name: string; filled?: boolean; size?: 18 | 20 | 24 | 40; className?: string }) {
  const style = { '--icon-size': `${size}px`, '--icon-opsz': Math.max(20, size), '--icon-fill': filled ? 1 : 0 } as CSSProperties;
  return (
    <span className={['m3-icon', className].filter(Boolean).join(' ')} style={style} aria-hidden="true" translate="no">
      {name}
    </span>
  );
}
