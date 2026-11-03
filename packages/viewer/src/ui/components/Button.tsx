// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ButtonHTMLAttributes, Ref } from 'react';
import { Icon } from './Icon.js';

export type ButtonVariant = 'filled' | 'tonal' | 'outlined' | 'text';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  /** `error` is for destructive actions (Stop), as text buttons in the error colour. */
  tone?: 'default' | 'error';
  /** A leading Material Symbol. */
  icon?: string;
  size?: 'small' | 'medium';
  ref?: Ref<HTMLButtonElement>;
};

/** An M3 Expressive common button: round, morphing slightly squarer while pressed; 48 px touch target at every size. */
export function Button({ variant = 'filled', tone = 'default', icon, size = 'small', className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button {...rest} type={type} className={['m3-button', className].filter(Boolean).join(' ')} data-variant={variant} data-tone={tone} data-size={size}>
      {icon && <Icon name={icon} size={size === 'medium' ? 24 : 20} />}
      <span className="m3-button__label">{children}</span>
    </button>
  );
}
