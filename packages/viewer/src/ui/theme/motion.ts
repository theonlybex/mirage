// SPDX-License-Identifier: MIT
// Material 3 Expressive motion (old spec §15): springs for space and effects, and the cubic curves used without them.

export type Spring = { stiffness: number; damping: number };

/** Spatial springs move and resize things (they may overshoot); effects springs change colour and opacity (they never do). */
export const SPRINGS = {
  spatialDefault: { stiffness: 380, damping: 0.8 },
  spatialFast: { stiffness: 800, damping: 0.6 },
  effectsDefault: { stiffness: 1600, damping: 1 },
  effectsFast: { stiffness: 3800, damping: 1 },
} as const satisfies Record<string, Spring>;

export const EASING = {
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  emphasizedDecelerate: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  emphasizedAccelerate: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
} as const;

/** How long a new item takes to come in, and how long a removed one stays on its way out. */
export const ENTER_MS = 300;
export const EXIT_MS = 200;

const SETTLED = 0.001;

/** Where a unit spring released from 0 towards 1 is after `t` seconds (mass 1). */
function position({ stiffness, damping }: Spring, t: number): number {
  const w0 = Math.sqrt(stiffness);
  if (damping >= 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const wd = w0 * Math.sqrt(1 - damping * damping);
  const a = damping * w0;
  return 1 - Math.exp(-a * t) * (Math.cos(wd * t) + (a / wd) * Math.sin(wd * t));
}

/** The longest the spring can still be more than SETTLED away from 1, from its envelope. */
function settleSeconds({ stiffness, damping }: Spring): number {
  const w0 = Math.sqrt(stiffness);
  const envelope =
    damping >= 1
      ? (t: number) => Math.exp(-w0 * t) * (1 + w0 * t)
      : (t: number) => Math.exp(-damping * w0 * t) * Math.sqrt(1 + (damping * damping) / (1 - damping * damping));
  let t = 0;
  while (envelope(t) > SETTLED && t < 5) t += 0.001;
  return t;
}

/** A spring as a CSS `linear()` easing and the duration it takes to settle. */
export function springEasing(spring: Spring, samples = 48): { easing: string; durationMs: number } {
  const seconds = settleSeconds(spring);
  const points: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const v = i === samples ? 1 : position(spring, (seconds * i) / samples);
    points.push(String(Math.round(v * 1000) / 1000));
  }
  return { easing: `linear(${points.join(', ')})`, durationMs: Math.round(seconds * 1000) };
}

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Puts the real springs on `root` as the `--md-sys-motion-spring-*` tokens (tokens.css has cubic fallbacks), and keeps
 * them in step with the reduced-motion setting: then spatial springs are swapped for effects springs. Returns a stop function.
 */
export function installMotion(root: HTMLElement = document.documentElement): () => void {
  if (typeof CSS === 'undefined' || !CSS.supports?.('transition-timing-function', 'linear(0, 1)')) return () => {};
  const curves = {
    'default-spatial': springEasing(SPRINGS.spatialDefault),
    'fast-spatial': springEasing(SPRINGS.spatialFast),
    'default-effects': springEasing(SPRINGS.effectsDefault),
    'fast-effects': springEasing(SPRINGS.effectsFast),
  };
  const apply = () => {
    const reduced = prefersReducedMotion();
    for (const [name, curve] of Object.entries(curves)) {
      const use = reduced && name.endsWith('-spatial') ? curves[name.replace('-spatial', '-effects') as keyof typeof curves] : curve;
      root.style.setProperty(`--md-sys-motion-spring-${name}`, use.easing);
      root.style.setProperty(`--md-sys-motion-spring-${name}-duration`, `${use.durationMs}ms`);
    }
  };
  apply();
  const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  query?.addEventListener('change', apply);
  return () => query?.removeEventListener('change', apply);
}
