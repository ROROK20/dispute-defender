'use client';

import { useCallback, useSyncExternalStore } from 'react';

type NowStore = {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
};

const stores = new Map<number, NowStore>();

function getStore(intervalMs: number): NowStore {
  let store = stores.get(intervalMs);
  if (!store) {
    store = { now: Date.now(), listeners: new Set(), timer: null };
    stores.set(intervalMs, store);
  }
  return store;
}

/**
 * Shared ticking clock. Every component that asks for the same interval
 * shares one timer, so a grid with 50 deadline cells runs one setInterval.
 */
export function useNow(intervalMs = 1000): number {
  const safeInterval = Number.isFinite(intervalMs) && intervalMs >= 16 ? Math.floor(intervalMs) : 1000;
  const store = getStore(safeInterval);

  const subscribe = useCallback(
    (onChange: () => void) => {
      store.listeners.add(onChange);
      if (!store.timer) {
        store.now = Date.now();
        store.timer = setInterval(() => {
          store.now = Date.now();
          store.listeners.forEach((listener) => listener());
        }, safeInterval);
      }
      return () => {
        store.listeners.delete(onChange);
        if (store.listeners.size === 0 && store.timer) {
          clearInterval(store.timer);
          store.timer = null;
        }
      };
    },
    [store, safeInterval],
  );

  const getSnapshot = useCallback(() => store.now, [store]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export default useNow;