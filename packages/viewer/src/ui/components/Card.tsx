// SPDX-License-Identifier: MIT
import type { HTMLAttributes, ReactNode } from 'react';

type CardProps = HTMLAttributes<HTMLElement> & {
  variant?: 'filled' | 'outlined';
  /** Makes the whole card a link (with a state layer and focus ring). */
  href?: string;
  children: ReactNode;
};

/** An M3 card: radius 12; filled cards sit on surface-container-high. */
export function Card({ variant = 'filled', href, className, children, ...rest }: CardProps) {
  const cls = ['m3-card', className].filter(Boolean).join(' ');
  if (href !== undefined) {
    return (
      <a {...rest} href={href} className={cls} data-variant={variant} data-interactive="true">
        {children}
      </a>
    );
  }
  return (
    <div {...rest} className={cls} data-variant={variant}>
      {children}
    </div>
  );
}
