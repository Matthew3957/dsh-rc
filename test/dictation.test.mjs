import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import * as prices from '../public/prices.js';

// Dictation is entirely in the browser: the Web Speech API transcribes speech and
// the composer is filled locally, with no request to dsh. This harness runs the
// real public/app.js in a vm over a small DOM stub (as statusline.test.mjs does)
// and injects a fake SpeechRecognition, so the shipped detection and wiring are
// exercised rather than a copy of them.

const APP = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const INDEX = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function stubEl(selector) {
  const handlers = new Map();
  const classes = new Set();
  const el = {
    nodeType: 1,
    selector,
    hidden: false,
    value: '',
    textContent: '',
    className: '',
    childNodes: [],
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    clientWidth: 0,
    classList: {
      toggle(c, on) { (on === undefined ? !classes.has(c) : on) ? classes.add(c) : classes.delete(c); },
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); },
    removeEventListener() {},
    fire(type, e) { for (const fn of handlers.get(type) || []) fn(e || {}); },
    setAttribute(name, value) { el[name] = value; },
    getAttribute: (name) => el[name],
    removeAttribute() {},
    append(...kids) { el.childNodes.push(...kids); },
    appendChild(kid) { el.childNodes.push(kid); return kid; },
    replaceChildren(...kids) { el.childNodes = kids; },
    replaceWith() {},
    remove() {},
    focus() {},
    click() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getContext: () => ({}),
    toBlob() {},
  };
  return el;
}

// A stand-in for SpeechRecognition. Every run is kept so a test can drive its
// events, and start()/abort() record what the app asked of the browser.
function fakeSpeech() {
  const runs = [];
  function FakeRec() {
    this.started = false;
    this.aborted = false;
    this.continuous = false;
    this.interimResults = false;
    this.lang = '';
    runs.push(this);
  }
  FakeRec.prototype.start = function start() { this.started = true; };
  FakeRec.prototype.stop = function stop() { this.stopped = true; };
  FakeRec.prototype.abort = function abort() { this.aborted = true; };
  return { FakeRec, runs };
}

const result = (text, final) => ({ isFinal: final, 0: { transcript: text } });

function harness({ speech, webkitSpeech } = {}) {
  const els = new Map();
  const document = {
    visibilityState: 'visible',
    documentElement: { style: { setProperty() {} } },
    addEventListener() {},
    createElement: (tag) => { const el = stubEl('<' + tag + '>'); el.tagName = tag.toUpperCase(); return el; },
    querySelector(sel) {
      if (!els.has(sel)) els.set(sel, stubEl(sel));
      return els.get(sel);
    },
    querySelectorAll: () => [],
  };
  const window = {
    dshPrices: prices,
    addEventListener() {},
    innerHeight: 800,
    matchMedia: () => ({ matches: false }),
    scrollTo() {},
  };
  if (speech) window.SpeechRecognition = speech;
  if (webkitSpeech) window.webkitSpeechRecognition = webkitSpeech;
  const context = {
    window,
    document,
    navigator: {},
    location: { hash: '', protocol: 'http:', host: 'localhost', pathname: '/' },
    history: { pushState() {} },
    WebSocket: function WebSocketStub() { return { close() {}, send() {}, readyState: 1 }; },
    requestAnimationFrame: (cb) => { cb(); return 0; },
    cancelAnimationFrame() {},
    matchMedia: window.matchMedia,
    crypto: { randomUUID: () => 'rpc' },
    // Boot stays quiet: a real host.describe answer keeps the "not reachable"
    // toast out of the way of the dictation toasts these tests read.
    fetch: async () => ({ ok: true, json: async () => ({ result: { ok: true, value: {} } }) }),
    console,
    // Toast hide timers must not hold the test process open after the asserts.
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); if (id.unref) id.unref(); return id; },
    clearTimeout,
    setInterval,
    clearInterval,
  };
  context.globalThis = context;
  vm.createContext(context);
  const epilogue = '\n;globalThis.__t = { S, dictation, dictationSupported, dictateValue, dictateStart, dictateStop };';
  vm.runInContext(APP + epilogue, context, { filename: 'public/app.js' });
  const t = context.__t;
  t.el = (sel) => document.querySelector(sel);
  t.mic = () => document.querySelector('#micBtn');
  t.input = () => document.querySelector('#input');
  return t;
}

test('the composer carries a hidden mic button revealed only by app.js', () => {
  // Static markup starts hidden, so a browser without the API never flashes one
  // and a page whose script fails to load has no dead control.
  assert.match(INDEX, /id="micBtn"[^>]*\bhidden\b/);
});

test('a browser without the API gets no mic button', () => {
  const t = harness();
  assert.equal(t.dictationSupported, false);
  assert.equal(t.mic().hidden, true);
  t.mic().fire('click');
  assert.equal(t.dictation.listening, false);
});

test('webkitSpeechRecognition alone is enough (Safari)', () => {
  const { FakeRec } = fakeSpeech();
  const t = harness({ webkitSpeech: FakeRec });
  assert.equal(t.dictationSupported, true);
  assert.equal(t.mic().hidden, false);
});

test('tapping the mic starts one run and taps again stop it', () => {
  const { FakeRec, runs } = fakeSpeech();
  const t = harness({ speech: FakeRec });
  assert.equal(t.mic().hidden, false);
  assert.equal(t.mic().getAttribute('aria-pressed'), 'false');

  t.mic().fire('click');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].started, true);
  assert.equal(runs[0].continuous, true);
  assert.equal(runs[0].interimResults, true);
  assert.equal(t.dictation.listening, true);
  assert.equal(t.mic().getAttribute('aria-pressed'), 'true');
  assert.equal(t.mic().getAttribute('aria-label'), 'Stop dictation');

  t.mic().fire('click');
  assert.equal(t.dictation.listening, false);
  assert.equal(t.mic().getAttribute('aria-pressed'), 'false');
  assert.equal(t.mic().getAttribute('aria-label'), 'Dictate');
  assert.equal(runs[0].aborted, true);
});

test('dictated words are added to what was already typed', () => {
  const { FakeRec, runs } = fakeSpeech();
  const t = harness({ speech: FakeRec });
  t.input().value = 'note:';
  t.dictateStart();

  runs[0].onresult({ resultIndex: 0, results: [result('send the build ', false)] });
  assert.equal(t.input().value, 'note: send the build ');

  runs[0].onresult({ resultIndex: 0, results: [result('send the build log', true)] });
  assert.equal(t.input().value, 'note: send the build log');
});

test('dictateValue spaces a base text and speech, and never doubles a space', () => {
  const t = harness();
  const d = t.dictation;
  d.base = ''; d.final = 'hi'; d.interim = '';
  assert.equal(t.dictateValue(), 'hi');
  d.base = 'note'; d.final = ''; d.interim = '';
  assert.equal(t.dictateValue(), 'note');
  d.base = 'note'; d.final = 'hi'; d.interim = '';
  assert.equal(t.dictateValue(), 'note hi');
  d.base = 'note '; d.final = 'hi'; d.interim = '';
  assert.equal(t.dictateValue(), 'note hi');
  d.base = 'note'; d.final = 'hi'; d.interim = ' there';
  assert.equal(t.dictateValue(), 'note hi there');
});

test('a finalized result is counted once across result events', () => {
  const { FakeRec, runs } = fakeSpeech();
  const t = harness({ speech: FakeRec });
  t.dictateStart();
  runs[0].onresult({ resultIndex: 0, results: [result('one ', true)] });
  runs[0].onresult({ resultIndex: 1, results: [result('one ', true), result('two', false)] });
  assert.equal(t.input().value, 'one two');
  runs[0].onresult({ resultIndex: 1, results: [result('one ', true), result('two', true)] });
  assert.equal(t.input().value, 'one two');
});

test('stopping folds the still-unconfirmed words into the composer', () => {
  const { FakeRec, runs } = fakeSpeech();
  const t = harness({ speech: FakeRec });
  t.dictateStart();
  runs[0].onresult({ resultIndex: 0, results: [result('half a th', false)] });
  t.dictateStop();
  assert.equal(t.input().value, 'half a th');
  assert.equal(t.dictation.listening, false);
  assert.equal(runs[0].aborted, true);
});

test('a run ended at a pause is restarted so dictation keeps going', () => {
  const { FakeRec, runs } = fakeSpeech();
  const t = harness({ speech: FakeRec });
  t.dictateStart();
  runs[0].onresult({ resultIndex: 0, results: [result('hello', true)] });
  runs[0].onend();
  assert.equal(runs.length, 2);
  assert.equal(runs[1].started, true);
  assert.equal(t.dictation.listening, true);
  assert.equal(t.input().value, 'hello');
});

test('a service that keeps ending with nothing heard gives up', () => {
  const { FakeRec, runs } = fakeSpeech();
  const t = harness({ speech: FakeRec });
  t.dictateStart();
  runs[0].onend();
  runs[1].onend();
  runs[2].onend();
  assert.equal(t.dictation.listening, false);
  assert.match(t.el('#toast').textContent, /Dictation stopped/);
});

test('a refused microphone stops the session and says so', () => {
  const { FakeRec, runs } = fakeSpeech();
  const t = harness({ speech: FakeRec });
  t.dictateStart();
  runs[0].onerror({ error: 'not-allowed' });
  assert.equal(t.dictation.listening, false);
  assert.equal(runs[0].aborted, true);
  assert.match(t.el('#toast').textContent, /microphone/i);
});

test('an automatic no-speech end is not an error and starts again', () => {
  const { FakeRec, runs } = fakeSpeech();
  const t = harness({ speech: FakeRec });
  t.dictateStart();
  runs[0].onerror({ error: 'no-speech' });
  assert.equal(t.dictation.listening, true);
  runs[0].onend();
  assert.equal(runs.length, 2);
  assert.equal(t.dictation.listening, true);
});
