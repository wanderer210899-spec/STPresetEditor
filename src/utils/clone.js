/**
 * Deep-clone to a plain, JSON-safe object — strips Vue reactive proxies so the
 * result is safe for structuredClone/postMessage and for storing detached from
 * the store. null/undefined pass through unchanged.
 */
export function toPlainClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
