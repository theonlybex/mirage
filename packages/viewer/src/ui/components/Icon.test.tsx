// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Icon } from './Icon.js';
import { ICONS } from './icon-names.js';
import { ICON_PATHS } from './icon-paths.generated.js';

afterEach(cleanup);

describe('Icon', () => {
  it('draws every listed icon as an inline SVG, outlined and filled', () => {
    for (const name of ICONS) {
      const { container, rerender } = render(<Icon name={name} />);
      const svg = container.querySelector('svg');
      expect(svg, name).not.toBeNull();
      expect(svg!.getAttribute('aria-hidden')).toBe('true');
      expect(svg!.getAttribute('viewBox')).toBe('0 -960 960 960');
      const outline = svg!.querySelector('path')?.getAttribute('d') ?? '';
      expect(outline.length, name).toBeGreaterThan(20);
      rerender(<Icon name={name} filled />);
      const fill = container.querySelector('svg path')?.getAttribute('d') ?? '';
      expect(outline, name).toBe(ICON_PATHS[name].outline);
      expect(fill, name).toBe(ICON_PATHS[name].fill);
      cleanup();
    }
  });

  it('takes its size', () => {
    const { container } = render(<Icon name="check" size={18} />);
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('18');
  });
});
