import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The @path grammar in app.js mirrors dsh-file-reference/grammar. Pull just those
// two pure functions out of the shipped file and run them.
const APP = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const src = APP.slice(APP.indexOf('function activeAtToken'), APP.indexOf('let mentionSeq'));
assert.ok(src.includes('formatFileMention'), 'grammar block found in app.js');
const ctx = vm.createContext({});
vm.runInContext(src + '\n;this.activeAtToken = activeAtToken; this.formatFileMention = formatFileMention;', ctx);
const { activeAtToken, formatFileMention } = ctx;

test('an @ at the start of a word opens a token at the cursor', () => {
  assert.deepEqual({ ...activeAtToken('@', 1) }, { prefix: '@', query: '', quoted: false });
  assert.deepEqual({ ...activeAtToken('look at @src/ap', 15) }, { prefix: '@src/ap', query: 'src/ap', quoted: false });
});

test('an @ inside a word, such as an email address, is not a trigger', () => {
  assert.equal(activeAtToken('mail me@example.com', 19), undefined);
  assert.equal(activeAtToken('@src done', 9), undefined);
});

test('only text before the cursor counts', () => {
  assert.equal(activeAtToken('fix @src/app', 4), undefined);
  assert.equal(activeAtToken('fix @src/app', 8).query, 'src');
});

test('@" opens a quoted token that may hold spaces', () => {
  const t = activeAtToken('see @"my dir/re', 15);
  assert.deepEqual({ ...t }, { prefix: '@"my dir/re', query: 'my dir/re', quoted: true });
});

test('files and directories format as dsh expects', () => {
  assert.equal(formatFileMention({ path: 'src/app.js', kind: 'file' }, false), '@src/app.js');
  assert.equal(formatFileMention({ path: 'src', kind: 'directory' }, false), '@src/');
  assert.equal(formatFileMention({ path: 'my dir/a b.txt', kind: 'file' }, false), '@"my dir/a b.txt"');
  assert.equal(formatFileMention({ path: 'my dir', kind: 'directory' }, false), '@"my dir/');
  assert.equal(formatFileMention({ path: 'a.txt', kind: 'file' }, true), '@"a.txt"');
});

test('paths with quotes or control characters cannot be mentioned', () => {
  assert.equal(formatFileMention({ path: 'a"b', kind: 'file' }, false), undefined);
  assert.equal(formatFileMention({ path: 'a\nb', kind: 'file' }, false), undefined);
});
