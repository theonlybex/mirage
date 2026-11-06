// SPDX-License-Identifier: MIT
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ENTER_MS, EXIT_MS } from '../theme/motion.js';

export type Presence<T> = { key: string; item: T; state: 'entering' | 'exiting' | undefined };

/**
 * `items` with what changed since the last render: a new one is `entering` for ENTER_MS, a removed one stays as
 * `exiting` for EXIT_MS. The first render marks nothing (the page opening is not news). Exiting items come last: the
 * timeline places items by time, so their order in the DOM does not matter.
 */
export function usePresence<T>(items: readonly T[], keyOf: (item: T, index: number) => string): Presence<T>[] {
  const [entering, setEntering] = useState<ReadonlySet<string>>(() => new Set());
  const [exiting, setExiting] = useState<readonly { key: string; item: T }[]>([]);
  const last = useRef<Map<string, T> | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const keys = items.map(keyOf);
  const signature = keys.join('\0');

  // Before paint, so a new item never shows a frame without its entering mark.
  useLayoutEffect(() => {
    const now = new Map(items.map((item, i) => [keys[i]!, item]));
    const before = last.current;
    last.current = now;
    if (!before) return;
    const added = keys.filter((k) => !before.has(k));
    const removed = [...before].filter(([k]) => !now.has(k)).map(([key, item]) => ({ key, item }));
    if (added.length) {
      setEntering((s) => new Set([...s, ...added]));
      const t = setTimeout(() => {
        timers.current.delete(t);
        setEntering((s) => new Set([...s].filter((k) => !added.includes(k))));
      }, ENTER_MS);
      timers.current.add(t);
    }
    // Back before it finished leaving: it is simply present again.
    setExiting((s) => {
      const kept = s.filter((e) => !now.has(e.key) && !removed.some((r) => r.key === e.key));
      return kept.length === s.length && !removed.length ? s : [...kept, ...removed];
    });
    if (removed.length) {
      const gone = new Set(removed.map((r) => r.key));
      const t = setTimeout(() => {
        timers.current.delete(t);
        setExiting((s) => s.filter((e) => !gone.has(e.key)));
      }, EXIT_MS);
      timers.current.add(t);
    }
    // `signature` stands for `items` by their keys; the latest items are read through the closure.
  }, [signature]);

  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const t of all) clearTimeout(t);
    };
  }, []);

  const present = items.map((item, i) => ({ key: keys[i]!, item, state: entering.has(keys[i]!) ? ('entering' as const) : undefined }));
  const live = new Set(keys);
  return [...present, ...exiting.filter((e) => !live.has(e.key)).map((e) => ({ ...e, state: 'exiting' as const }))];
}

/** Keys for things without ids: what they are, plus a count for repeats (the second "calm" is `calm#2`). */
export function keysBy<T>(items: readonly T[], what: (item: T) => string): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = what(item);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}
