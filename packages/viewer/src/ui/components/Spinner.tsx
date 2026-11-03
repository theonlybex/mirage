// SPDX-License-Identifier: AGPL-3.0-or-later

/** A small M3 circular indeterminate progress indicator. Decorative: say what is happening next to it. */
export function Spinner({ size = 20 }: { size?: 16 | 20 | 24 }) {
  return (
    <svg className="m3-spinner" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle className="m3-spinner__arc" cx="12" cy="12" r="9" fill="none" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
