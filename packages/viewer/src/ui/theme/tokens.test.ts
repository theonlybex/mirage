// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { springEasing, SPRINGS } from './motion.js';
import css from './tokens.css?raw';

/** The declarations of the first rule whose selector list is exactly `selector`. */
function block(selector: string): Record<string, string> {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const rule = rules.find((r) => r[1]!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim() === selector);
  if (!rule) throw new Error(`no rule for ${selector}`);
  return Object.fromEntries([...rule[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

// Old spec §15, "Colour": role → [light, dark].
const ROLES: Record<string, [string, string]> = {
  primary: ['#39608F', '#A3C9FE'],
  'on-primary': ['#FFFFFF', '#00315B'],
  'primary-container': ['#D3E4FF', '#1E4875'],
  'on-primary-container': ['#1E4875', '#D3E4FF'],
  secondary: ['#545F70', '#BBC7DB'],
  'on-secondary': ['#FFFFFF', '#263141'],
  'secondary-container': ['#D7E3F8', '#3C4758'],
  'on-secondary-container': ['#3C4758', '#D7E3F8'],
  tertiary: ['#6C5677', '#D8BDE3'],
  'on-tertiary': ['#FFFFFF', '#3C2947'],
  'tertiary-container': ['#F5D9FF', '#533F5E'],
  'on-tertiary-container': ['#533F5E', '#F5D9FF'],
  error: ['#BA1A1A', '#FFB4AB'],
  'on-error': ['#FFFFFF', '#690005'],
  'error-container': ['#FFDAD6', '#93000A'],
  'on-error-container': ['#93000A', '#FFDAD6'],
  surface: ['#F8F9FF', '#111418'],
  'surface-container-lowest': ['#FFFFFF', '#0C0E13'],
  'surface-container-low': ['#F2F3FA', '#191C20'],
  'surface-container': ['#ECEDF4', '#1D2024'],
  'surface-container-high': ['#E7E8EE', '#272A2F'],
  'surface-container-highest': ['#E1E2E8', '#32353A'],
  'on-surface': ['#191C20', '#E1E2E8'],
  'on-surface-variant': ['#43474E', '#C3C6CF'],
  outline: ['#73777F', '#8D9199'],
  'outline-variant': ['#C3C6CF', '#43474E'],
  'inverse-surface': ['#2E3035', '#E1E2E8'],
  'inverse-on-surface': ['#EFF0F7', '#2E3035'],
  'inverse-primary': ['#A3C9FE', '#39608F'],
};

describe('tokens.css', () => {
  const dark = block(":root, :root[data-theme='dark']");
  const light = block(":root[data-theme='light']");

  it('has every §15 colour role in the dark theme, which is the default', () => {
    for (const [role, [, hex]] of Object.entries(ROLES)) expect(dark[`--md-sys-color-${role}`]?.toUpperCase(), role).toBe(hex);
  });

  it('has every §15 colour role in the light theme', () => {
    for (const [role, [hex]] of Object.entries(ROLES)) expect(light[`--md-sys-color-${role}`]?.toUpperCase(), role).toBe(hex);
  });

  it('defines the same colour tokens in both themes', () => {
    const names = (b: Record<string, string>) => Object.keys(b).filter((k) => k.startsWith('--md-sys-color-') || k.startsWith('--mirage-color-')).sort();
    expect(names(light)).toEqual(names(dark));
  });

  it('has the §15 type scale, shape scale and motion curves', () => {
    const all = block(':root');
    expect(all['--md-sys-typescale-headline-small-size']).toBe('24px');
    expect(all['--md-sys-typescale-headline-small-line-height']).toBe('32px');
    expect(all['--md-sys-typescale-title-medium-weight']).toBe('500');
    expect(all['--md-sys-typescale-label-small-size']).toBe('11px');
    expect(all['--md-sys-typescale-body-large-size']).toBe('16px');
    const shapes = { none: '0px', 'extra-small': '4px', small: '8px', medium: '12px', large: '16px', 'large-increased': '20px', 'extra-large': '28px', 'extra-large-increased': '32px', 'extra-extra-large': '48px', full: '9999px' };
    for (const [name, value] of Object.entries(shapes)) expect(all[`--md-sys-shape-corner-${name}`], name).toBe(value);
    expect(all['--md-sys-motion-easing-standard']).toBe('cubic-bezier(0.2, 0, 0, 1)');
    expect(all['--md-sys-motion-easing-emphasized-decelerate']).toBe('cubic-bezier(0.05, 0.7, 0.1, 1)');
  });
});

describe('springEasing', () => {
  it('settles at 1 and overshoots only when underdamped', () => {
    const points = (e: string) => e.replace(/^linear\(|\)$/g, '').split(',').map((p) => Number.parseFloat(p));
    const spatial = springEasing(SPRINGS.spatialDefault);
    const effects = springEasing(SPRINGS.effectsDefault);
    expect(points(spatial.easing).at(-1)).toBe(1);
    expect(Math.max(...points(spatial.easing))).toBeGreaterThan(1);
    expect(Math.max(...points(effects.easing))).toBeLessThanOrEqual(1);
    expect(spatial.durationMs).toBeGreaterThan(200);
    expect(spatial.durationMs).toBeLessThan(1000);
    expect(springEasing(SPRINGS.effectsFast).durationMs).toBeLessThan(effects.durationMs);
  });
});
