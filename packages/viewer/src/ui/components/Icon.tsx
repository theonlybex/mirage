// SPDX-License-Identifier: AGPL-3.0-or-later
import { ICON_PATHS } from './icon-paths.generated.js';
import type { IconName } from './icon-names.js';

export type { IconName };

/**
 * A Material Symbols Rounded icon (weight 400) drawn inline from the paths built into the page: outlined by default,
 * filled for selected states. Decorative: the control around it carries the words. Colour is the text colour.
 */
export function Icon({ name, filled = false, size = 24, className }: { name: IconName; filled?: boolean; size?: 16 | 18 | 20 | 24 | 40; className?: string }) {
  const paths = ICON_PATHS[name];
  return (
    <svg
      className={['m3-icon', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 -960 960 960"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      <path d={filled ? paths.fill : paths.outline} />
    </svg>
  );
}
