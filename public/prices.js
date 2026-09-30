// Estimated API prices for the models dsh routes to, in USD per million tokens.
//
// dsh reports tokens, never dollars, so the status line multiplies these in and
// labels the result "est.". Two rules keep that honest:
//   - model ids match by longest prefix, so a re-priced member of a family
//     (claude-opus-5-5 beside claude-opus-5) is never served the family price;
//   - an id no row matches prices as nothing at all, so it reads "cost n/a"
//     rather than a fabricated number.
// The figures are transcribed from the vendors' own pricing pages (see the
// README). They go stale, so any prefix can be overridden from the Prices sheet.

export const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];

export const DEFAULT_PRICES = {
  // Anthropic Claude: standard (non-batch) rates and 5-minute cache writes.
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // Sonnet 5 and Sonnet 5.5 carry identical rates, so one prefix covers both.
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // DeepSeek publishes cache-hit and cache-miss input rates and bills no separate
  // cache-write fee, so writes are priced at zero. These are the PEAK rates;
  // off-peak (nights and weekends UTC) is half, so the estimate is an upper bound.
  'deepseek-flash': { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  'deepseek-v4-pro': { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
};

/**
 * The row whose prefix matches longest, or null when nothing matches.
 * @param table - price rows keyed by model-id prefix; missing rows are ignored.
 * @param modelId - provider model id.
 * @returns the matching row, not copied.
 */
function bestMatch(table, modelId) {
  if (!table) return null;
  let bestKey = null;
  for (const key of Object.keys(table)) {
    if (!key || !modelId.startsWith(key)) continue;
    if (bestKey === null || key.length > bestKey.length) bestKey = key;
  }
  return bestKey === null ? null : table[bestKey];
}

/**
 * Prices for one model id, in USD per million tokens.
 * An override wins outright, however specific the shipped default is: what you
 * typed into the Prices sheet is what you get. Within either table the longest
 * prefix wins.
 * @param modelId - provider model id, or undefined before a route is known.
 * @param overrides - rows from the Prices sheet, or undefined.
 * @returns the price row, or null when the model is unknown.
 */
export function priceFor(modelId, overrides) {
  if (typeof modelId !== 'string' || modelId === '') return null;
  const override = bestMatch(overrides, modelId);
  if (override !== null) return override;
  return bestMatch(DEFAULT_PRICES, modelId);
}

/**
 * Estimated cost of one usage sample.
 * @param usage - dsh tokenUsage buckets (`uncachedInputTokens`, `outputTokens`,
 *   `cacheReadTokens`, `cacheWriteTokens`); absent buckets count as zero.
 * @param prices - a row from {@link priceFor}, or null for an unpriced model.
 * @returns USD, or null when the model has no price row.
 */
export function costOf(usage, prices) {
  if (!prices || !usage) return null;
  const tokens = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);
  const usd = tokens(usage.uncachedInputTokens) * prices.input
    + tokens(usage.outputTokens) * prices.output
    + tokens(usage.cacheReadTokens) * prices.cacheRead
    + tokens(usage.cacheWriteTokens) * prices.cacheWrite;
  return usd / 1e6;
}

/**
 * Read the saved override rows, or {} when there are none to read.
 * @returns parsed rows; a browser that refuses storage yields {}.
 */
export function loadPriceOverrides() {
  try {
    const raw = globalThis.localStorage.getItem('dshm.prices');
    if (!raw) return {};
    return parsePriceOverrides(raw);
  } catch {
    return {};
  }
}

/**
 * Persist override rows, or clear them when given none.
 * @param overrides - rows keyed by model-id prefix; {} clears the override.
 * @returns true when the write reached storage.
 */
export function savePriceOverrides(overrides) {
  try {
    const rows = overrides && Object.keys(overrides).length ? JSON.stringify(overrides) : '';
    if (rows) globalThis.localStorage.setItem('dshm.prices', rows);
    else globalThis.localStorage.removeItem('dshm.prices');
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate and normalize the Prices sheet's text.
 * @param text - JSON object of prefix -> {input, output, cacheRead, cacheWrite},
 *   or empty text for no overrides.
 * @returns normalized rows carrying exactly {@link PRICE_FIELDS}.
 * @throws Error naming the offending prefix or field.
 */
export function parsePriceOverrides(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return {};
  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch (e) {
    throw new Error('not valid JSON (' + e.message + ')');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected an object keyed by model id');
  const out = {};
  for (const [key, row] of Object.entries(raw)) {
    if (!key.trim()) throw new Error('a model id is empty');
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${key}: expected an object`);
    const fields = {};
    for (const field of PRICE_FIELDS) {
      const value = row[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${key}: ${field} must be a non-negative price per million tokens`);
      fields[field] = value;
    }
    out[key.trim()] = fields;
  }
  return out;
}

// app.js is a classic script and cannot import this module, so hand it the
// functions. Absent in Node, where the tests import the file directly.
if (typeof window !== 'undefined') {
  window.dshPrices = { DEFAULT_PRICES, PRICE_FIELDS, priceFor, costOf, loadPriceOverrides, savePriceOverrides, parsePriceOverrides };
}
