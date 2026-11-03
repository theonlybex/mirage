// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ButtonHTMLAttributes, Ref } from 'react';
import { Icon, type IconName } from './Icon.js';

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: IconName;
  /** Required: an icon alone says nothing to a screen reader. */
  'aria-label': string;
  variant?: 'standard' | 'filled' | 'tonal' | 'outlined';
  ref?: Ref<HTMLButtonElement>;
};

/** An M3 icon button: 40 px round, 48 px touch target, the label also shown as a tooltip. */
export function IconButton({ icon, variant = 'standard', className, type = 'button', title, ...rest }: IconButtonProps) {
  return (
    <button {...rest} type={type} title={title ?? rest['aria-label']} className={['m3-icon-button', className].filter(Boolean).join(' ')} data-variant={variant}>
      <Icon name={icon} filled={variant === 'filled'} />
    </button>
  );
}
