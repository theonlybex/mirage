// SPDX-License-Identifier: MIT

/**
 * A person's text as it goes into a line to Claude (the viewer's notifications, the SessionStart context): one line, at
 * most `max` characters, and unable to close its own “…” quotes.
 */
export function oneLine(text: string, max = 1000): string {
  const flat = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
