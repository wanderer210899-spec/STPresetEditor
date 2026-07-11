/**
 * Debounced localStorage wrapper for pinia-plugin-persistedstate.
 *
 * The persist plugin serializes the picked state and calls `setItem` on EVERY
 * store mutation. During typing that means a full `JSON.stringify` + write per
 * keystroke of the whole persisted library (hundreds of KB) — a large slice of
 * the per-keystroke cost. This wrapper coalesces those writes: it keeps the
 * latest value per key in memory and flushes at most once per `delay` ms.
 *
 * Reads return any not-yet-flushed value first so hydration/round-trips stay
 * consistent, and pending writes are flushed synchronously when the tab/webview
 * is hidden or unloaded, so nothing is lost on close.
 */
export function createDebouncedStorage(backing, delay = 400) {
  const store = backing || (typeof window !== 'undefined' ? window.localStorage : null);
  const pending = new Map(); // key -> latest string value, or null = pending remove
  let timer = null;

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!store || pending.size === 0) return;
    for (const [key, value] of pending) {
      try {
        if (value === null) store.removeItem(key);
        else store.setItem(key, value);
      } catch {
        // Quota exceeded / storage disabled — best effort, drop this write.
      }
    }
    pending.clear();
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delay);
  }

  // Persist immediately when the page/panel is backgrounded or closing so a
  // debounced write in flight is never lost.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('visibilitychange', () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
  }

  return {
    getItem(key) {
      if (pending.has(key)) {
        const v = pending.get(key);
        return v === null ? null : v;
      }
      return store ? store.getItem(key) : null;
    },
    setItem(key, value) {
      pending.set(key, value);
      schedule();
    },
    removeItem(key) {
      pending.set(key, null);
      schedule();
    },
    /** Force any pending write to disk now (exposed for tests / explicit saves). */
    flush,
  };
}
