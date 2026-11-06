// SPDX-License-Identifier: MIT
import type { CSSProperties } from 'react';

/** A part of the picture, as fractions of its width and height (0..1). */
export type Box = { x: number; y: number; w: number; h: number };

/** A box drawn over a picture, in percentages of it. */
export function BoxOutline({ box, className = 'note-box' }: { box: Box; className?: string }) {
  const style: CSSProperties = { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` };
  return <span className={className} style={style} aria-hidden="true" />;
}
