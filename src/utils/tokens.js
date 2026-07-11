/**
 * Lightweight token estimator (F8d). Deliberately NOT a real tokenizer — no
 * dependency, no async chunk — so counts are approximate and must always be
 * displayed with a "≈". Heuristic: LLM tokenizers average ~1.3 tokens per
 * word for English prose, and punctuation/symbols usually tokenize alone.
 * CJK text has no spaces, so CJK characters are counted individually
 * (~1 token each) instead of as words.
 */

// Content-keyed memo. Prompt contents repeat heavily across renders (header
// chip + toolbar total + collapsed rows), so a small bounded cache suffices.
const cache = new Map();
const CACHE_LIMIT = 1000;

/**
 * @param {string} text
 * @returns {number} estimated token count (integer, >= 0)
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s.trim()) return 0;
  const hit = cache.get(s);
  if (hit !== undefined) return hit;

  const words = (s.match(/[A-Za-z0-9_'’-]+/g) || []).length;
  const cjk = (s.match(/[぀-ヿ㐀-鿿豈-﫿]/g) || []).length;
  const specials = (s.match(/[^\w\s぀-ヿ㐀-鿿豈-﫿'’-]/g) || []).length;
  const estimate = Math.ceil(words * 1.3 + cjk + specials);

  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(s, estimate);
  return estimate;
}

/**
 * Compact display form: 1234 -> "1.2k". Counts are estimates, so one decimal
 * of precision above a thousand is plenty.
 * @param {number} count
 * @returns {string}
 */
export function formatTokenCount(count) {
  const n = Number(count) || 0;
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}
