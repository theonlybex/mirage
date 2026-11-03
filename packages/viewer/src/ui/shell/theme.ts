// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useState } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'mirage-theme';

/** The saved theme; dark unless the person chose light (video work is easier on a dark page). */
export function savedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export const applyTheme = (t: Theme): void => {
  document.documentElement.dataset.theme = t;
};

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // Private window or storage off: the choice lasts until the page closes.
      }
      return next;
    });
  }, []);
  return [theme, toggle];
}
