/**
 * Split `text` into segments around every case-insensitive occurrence of
 * `term`, for rendering search-hit highlights without HTML injection.
 *
 * @param {string} text
 * @param {string} term
 * @returns {{ text: string, hit: boolean }[]} segments in order; a single
 *   non-hit segment when the term is empty or absent.
 */
export function splitByTerm(text, term) {
  const source = String(text ?? '');
  const q = String(term ?? '').toLowerCase();
  if (!q) return [{ text: source, hit: false }];

  const lower = source.toLowerCase();
  const segments = [];
  let i = 0;
  let idx;
  while ((idx = lower.indexOf(q, i)) !== -1) {
    if (idx > i) segments.push({ text: source.slice(i, idx), hit: false });
    segments.push({ text: source.slice(idx, idx + q.length), hit: true });
    i = idx + q.length;
  }
  if (i < source.length || segments.length === 0) {
    segments.push({ text: source.slice(i), hit: false });
  }
  return segments;
}
