import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appBasePath, classifyLink } from '../public/links.js';

// dsh-rc is one page at / or /m/. A model writes relative file paths in its
// messages; following one in the standalone app would leave the window on a
// URL the server has no page for. These are the rules that refuse it.

test('appBasePath normalizes the serving directory', () => {
  assert.equal(appBasePath('https://d.example/'), '/');
  assert.equal(appBasePath('https://d.example/index.html'), '/');
  assert.equal(appBasePath('https://d.example/m/'), '/m/');
  assert.equal(appBasePath('https://d.example/m/index.html'), '/m/');
  assert.equal(appBasePath('https://d.example/m'), '/m/');
  assert.equal(appBasePath('https://d.example/s/a#s/1'), '/s/a/');
  assert.equal(appBasePath('http://['), '/');
});

test('another origin or a non-http scheme opens normally', () => {
  const base = 'https://d.example/m/';
  assert.equal(classifyLink('https://example.com/doc', base).action, 'external');
  assert.equal(classifyLink('http://d.example:3081/x', base).action, 'external');
  assert.equal(classifyLink('mailto:m@example.com', base).action, 'external');
  assert.equal(classifyLink('tel:+15555550100', base).action, 'external');
});

test('the app page itself, including hash routes, stays in the app', () => {
  assert.equal(classifyLink('/', 'https://d.example/').action, 'page');
  assert.equal(classifyLink('./', 'https://d.example/').action, 'page');
  assert.equal(classifyLink('index.html', 'https://d.example/').action, 'page');
  assert.equal(classifyLink('/m/', 'https://d.example/m/').action, 'page');
  assert.equal(classifyLink('./', 'https://d.example/m/').action, 'page');
  assert.equal(classifyLink('index.html', 'https://d.example/m/').action, 'page');
  assert.equal(classifyLink('#s/abc', 'https://d.example/m/').action, 'page');
  assert.equal(classifyLink('https://d.example/m/#s/abc', 'https://d.example/m/').action, 'page');
});

test('a same-origin path the model wrote is shown, not followed', () => {
  assert.equal(classifyLink('research/notes.md', 'https://d.example/').action, 'path');
  assert.equal(classifyLink('/research/notes.md', 'https://d.example/').action, 'path');
  assert.equal(classifyLink('research/notes.md', 'https://d.example/m/').action, 'path');
  assert.equal(classifyLink('../notes.md', 'https://d.example/m/').action, 'path');
  assert.equal(classifyLink('https://d.example/m/research/notes.md', 'https://d.example/m/').action, 'path');
  // A stylesheet is a same-origin asset, not a page: refuse it too.
  assert.equal(classifyLink('style.css', 'https://d.example/m/').action, 'path');
});

test('nothing usable to navigate to is ignored', () => {
  assert.equal(classifyLink('', 'https://d.example/').action, 'ignore');
  assert.equal(classifyLink('   ', 'https://d.example/').action, 'ignore');
  assert.equal(classifyLink(null, 'https://d.example/').action, 'ignore');
  assert.equal(classifyLink('http://[', 'https://d.example/').action, 'ignore');
});
