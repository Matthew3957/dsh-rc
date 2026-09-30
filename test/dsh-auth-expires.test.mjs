import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSetCookies } from '../server/dsh-auth.mjs';

test('a cookie with only Expires still expires', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const r = parseSetCookies(['dsh-auth-x=abc; Path=/; Expires=Thu, 01 Jan 2026 01:00:00 GMT; HttpOnly'], now);
  assert.equal(r.cookie, 'dsh-auth-x=abc');
  assert.equal(r.expires, now + 3600 * 1000);
});

test('Max-Age wins over Expires', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const r = parseSetCookies(['a=1; Max-Age=60; Expires=Thu, 01 Jan 2026 05:00:00 GMT'], now);
  assert.equal(r.expires, now + 60 * 1000);
});
