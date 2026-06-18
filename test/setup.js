// happy-dom doesn't always wire a working localStorage; Pinia (via
// @vue/devtools-kit) calls localStorage.getItem at import time. Provide a tiny
// in-memory implementation so the stores load.
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const storage = makeStorage();
if (
  typeof globalThis.localStorage === 'undefined' ||
  typeof globalThis.localStorage.getItem !== 'function'
) {
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
}
if (typeof window !== 'undefined' && typeof window.localStorage?.getItem !== 'function') {
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
}
