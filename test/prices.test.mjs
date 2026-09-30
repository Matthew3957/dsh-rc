import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PRICES,
  PRICE_FIELDS,
  priceFor,
  costOf,
  loadPriceOverrides,
  savePriceOverrides,
  parsePriceOverrides,
} from '../public/prices.js';

// A usage sample with every bucket set, since the four are priced differently.
const usage = {
  uncachedInputTokens: 1200,
  outputTokens: 8400,
  cacheReadTokens: 54000,
  cacheWriteTokens: 9000,
};

function withStorage(store, body) {
  const previous = globalThis.localStorage;
  globalThis.localStorage = store;
  try {
    return body();
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
}

test('priceFor: the longest prefix wins, so a re-priced member beats its family', () => {
  // claude-opus-5 and claude-opus-5-5 share a prefix but not a price ($5/$25 vs
  // $4/$20). A plain first-match lookup would quietly bill 5.5 at the 5 rate.
  assert.deepEqual(priceFor('claude-opus-5-5'), DEFAULT_PRICES['claude-opus-5-5']);
  assert.deepEqual(priceFor('claude-opus-5-20260101'), DEFAULT_PRICES['claude-opus-5']);
  assert.notDeepEqual(priceFor('claude-opus-5-5'), priceFor('claude-opus-5'));
});

test('priceFor: the longest prefix wins regardless of the order rows are listed', () => {
  // Guards the rule itself rather than the shipped table's key order: a
  // first-match lookup passes only while the specific row happens to come first.
  const short = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
  const long = { input: 2, output: 2, cacheRead: 2, cacheWrite: 2 };
  assert.deepEqual(priceFor('claude-opus-6-1', { 'claude-opus-6': short, 'claude-opus-6-1': long }), long);
  assert.deepEqual(priceFor('claude-opus-6-1', { 'claude-opus-6-1': long, 'claude-opus-6': short }), long);
});

test('priceFor: a dated snapshot id resolves to its family row', () => {
  assert.deepEqual(priceFor('claude-sonnet-5-5'), DEFAULT_PRICES['claude-sonnet-5']);
  assert.deepEqual(priceFor('claude-haiku-4-5-20251001'), DEFAULT_PRICES['claude-haiku-4-5']);
  assert.deepEqual(priceFor('deepseek-flash'), DEFAULT_PRICES['deepseek-flash']);
});

test('priceFor: an unknown model is unpriced, not priced at zero', () => {
  for (const id of ['gpt-oss:120b', 'bonsai2', 'gemma4:31b', 'claude-opus-9', '', undefined, null]) {
    assert.equal(priceFor(id), null, `${id} should be unpriced`);
  }
});

test('priceFor: an override wins outright, even against a more specific default', () => {
  const overrides = { 'claude-opus': { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } };
  assert.deepEqual(priceFor('claude-opus-5-5', overrides), overrides['claude-opus']);
  assert.deepEqual(priceFor('claude-sonnet-5-5', overrides), DEFAULT_PRICES['claude-sonnet-5']);
});

test('costOf: the four buckets are priced at their own rates', () => {
  // 1200x2 + 8400x10 + 54000x0.2 + 9000x2.5 = 119700 micro-USD.
  const usd = costOf(usage, priceFor('claude-sonnet-5-5'));
  assert.ok(Math.abs(usd - 0.1197) < 1e-12, `expected 0.1197, got ${usd}`);
});

test('costOf: a whole million of each bucket is the sum of the row', () => {
  const million = { uncachedInputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 };
  const opus = DEFAULT_PRICES['claude-opus-5-5'];
  assert.ok(Math.abs(costOf(million, opus) - (opus.input + opus.output + opus.cacheRead + opus.cacheWrite)) < 1e-9);
  const flash = DEFAULT_PRICES['deepseek-flash'];
  assert.ok(Math.abs(costOf(million, flash) - 1.506) < 1e-9);
});

test('costOf: an unpriced model has no cost, and absent buckets count as zero', () => {
  assert.equal(costOf(usage, null), null);
  assert.equal(costOf(null, DEFAULT_PRICES['deepseek-flash']), null);
  assert.equal(costOf({ outputTokens: 1e6 }, DEFAULT_PRICES['deepseek-flash']), 1.2);
  // Junk in a bucket is ignored rather than poisoning the sum with NaN.
  assert.equal(costOf({ outputTokens: 1e6, cacheReadTokens: undefined }, DEFAULT_PRICES['deepseek-flash']), 1.2);
});

test('every shipped row prices all four buckets as numbers', () => {
  for (const [key, row] of Object.entries(DEFAULT_PRICES)) {
    for (const field of PRICE_FIELDS) {
      assert.equal(typeof row[field], 'number', `${key}.${field}`);
      assert.ok(Number.isFinite(row[field]) && row[field] >= 0, `${key}.${field} is a price`);
    }
  }
});

test('parsePriceOverrides: accepts rows and keeps exactly the four fields', () => {
  const parsed = parsePriceOverrides('{"claude-opus": {"input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite": 5, "note": "x"}}');
  assert.deepEqual(parsed, { 'claude-opus': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } });
  assert.deepEqual(parsePriceOverrides('   '), {});
});

test('parsePriceOverrides: refuses input that would price a model wrongly', () => {
  const bad = [
    ['', '{'],
    ['', '[]'],
    ['', 'null'],
    ['', '{"claude-opus": 5}'],
    ['claude-opus', '{"claude-opus": {"input": 4}}'],
    ['cacheWrite', '{"claude-opus": {"input": 4, "output": 20, "cacheRead": 0.2}}'],
    ['cacheWrite', '{"claude-opus": {"input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite": -1}}'],
    ['cacheWrite', '{"claude-opus": {"input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite": "5"}}'],
  ];
  for (const [needle, text] of bad) {
    assert.throws(() => parsePriceOverrides(text), (e) => {
      assert.ok(e instanceof Error);
      // The message has to name what to fix, or the sheet is a guessing game.
      assert.ok(needle === '' || e.message.includes(needle), `"${e.message}" should mention ${needle}`);
      return true;
    }, text);
  }
});

test('overrides round-trip through storage and feed priceFor', () => {
  const store = new Map();
  const fake = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  withStorage(fake, () => {
    assert.deepEqual(loadPriceOverrides(), {});
    const rows = parsePriceOverrides('{"deepseek-flash": {"input": 9, "output": 9, "cacheRead": 9, "cacheWrite": 9}}');
    assert.equal(savePriceOverrides(rows), true);
    assert.deepEqual(loadPriceOverrides(), rows);
    assert.deepEqual(priceFor('deepseek-flash', loadPriceOverrides()), rows['deepseek-flash']);
    // {} clears the override rather than storing an empty table.
    assert.equal(savePriceOverrides({}), true);
    assert.deepEqual(loadPriceOverrides(), {});
    assert.equal(store.has('dshm.prices'), false);
  });
});

test('storage that throws is survivable: reads yield {} and writes report failure', () => {
  const hostile = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('blocked'); },
  };
  withStorage(hostile, () => {
    assert.deepEqual(loadPriceOverrides(), {});
    assert.equal(savePriceOverrides({ 'claude-opus': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }), false);
  });
});

test('storage holding junk falls back to the shipped table', () => {
  const fake = { getItem: () => 'not json', setItem() {}, removeItem() {} };
  withStorage(fake, () => {
    assert.deepEqual(loadPriceOverrides(), {});
    assert.deepEqual(priceFor('claude-sonnet-5', loadPriceOverrides()), DEFAULT_PRICES['claude-sonnet-5']);
  });
});
