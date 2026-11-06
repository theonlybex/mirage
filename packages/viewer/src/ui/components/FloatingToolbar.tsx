// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';

/** An M3 Expressive floating toolbar: a pill on surface-container-high with a shadow (the one place shadows are used). */
export function FloatingToolbar({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="toolbar" aria-label={label} className={['m3-floating-toolbar', className].filter(Boolean).join(' ')}>
      {children}
    </div>
  );
}
