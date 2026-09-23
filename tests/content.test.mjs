import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeTimers, settle } from './helpers/fake-chrome.mjs';

const require = createRequire(import.meta.url);
const SCRIPT = require.resolve('../extension/content.js');
const GLOBALS = ['chrome', 'window', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
const saved = Object.fromEntries(GLOBALS.map(key => [key, globalThis[key]]));

afterEach(() => {
  for (const key of GLOBALS) globalThis[key] = saved[key];
  delete require.cache[SCRIPT];
});

/*
** Load content.js as the browser would: a classic script evaluated with
** chrome and window in scope. send(message, runtime) implements
** chrome.runtime.sendMessage for the test.
*/
function load(send = async () => {}) {
  const timers = fakeTimers();
  const listeners = new Set();
  const sent = [];
  const runtime = {
    id: 'test-extension',
    sendMessage: message => {
      sent.push(message);
      return send(message, runtime);
    },
  };
  const window = {
    addEventListener: (type, fn) => { assert.equal(type, 'message'); listeners.add(fn); },
    removeEventListener: (type, fn) => listeners.delete(fn),
  };
  Object.assign(globalThis, {
    chrome: { runtime }, window,
    setInterval: timers.setInterval, clearInterval: timers.clearTimeout,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  delete require.cache[SCRIPT];
  require(SCRIPT);
  const post = data => { for (const fn of [...listeners]) fn({ source: window, data }); };
  return { timers, listeners, sent, runtime, window, post };
}
const WAKE = { source: 'muse-auto-approve', type: 'wake' };

test('ticks once on load and then on every poll interval', () => {
  const c = load();
  assert.deepEqual(c.sent, [{ type: 'tick', reason: 'poll' }]);
  c.timers.fire(3000);
  c.timers.fire(3000);
  assert.equal(c.sent.length, 3);
});

test('turns page wake messages into one debounced push tick', () => {
  const c = load();
  c.post(WAKE);
  c.post(WAKE);
  assert.equal(c.sent.length, 1, 'nothing is sent before the debounce delay');
  c.timers.fire(100);
  assert.deepEqual(c.sent.at(-1), { type: 'tick', reason: 'push' });
  assert.equal(c.sent.length, 2);
  c.post(WAKE);
  c.timers.fire(100);
  assert.equal(c.sent.length, 3, 'a new burst after the debounce sends again');
});

test('ignores messages from other windows and unrelated messages', () => {
  const c = load();
  const [listener] = c.listeners;
  listener({ source: {}, data: WAKE });
  listener({ source: c.window, data: null });
  listener({ source: c.window, data: { source: 'someone-else', type: 'wake' } });
  listener({ source: c.window, data: { source: 'muse-auto-approve', type: 'other' } });
  c.timers.fire(100);
  assert.equal(c.sent.length, 1);
});

test('an orphaned copy shuts down instead of throwing "Extension context invalidated"', () => {
  const c = load((message, runtime) => {
    delete runtime.id;
    throw new Error('Extension context invalidated.');
  });
  assert.equal(c.sent.length, 1);
  assert.equal(c.listeners.size, 0);
  assert.deepEqual(c.timers.pending(), []);
});

test('shuts down without sending once the extension id is gone', () => {
  const c = load();
  c.post(WAKE);
  delete c.runtime.id;
  c.timers.fire(3000);
  assert.equal(c.sent.length, 1);
  assert.equal(c.listeners.size, 0);
  assert.deepEqual(c.timers.pending(), []);
});

test('a rejected send shuts down only if the extension is gone', async () => {
  let fail = true;
  const c = load(async (message, runtime) => {
    if (fail) throw new Error('Could not establish connection. Receiving end does not exist.');
    delete runtime.id;
    throw new Error('Extension context invalidated.');
  });
  await settle();
  assert.equal(c.listeners.size, 1, 'a worker that is merely asleep is not a reason to stop');
  fail = false;
  c.timers.fire(3000);
  await settle();
  assert.equal(c.listeners.size, 0);
});

test('works without chrome.runtime at all', () => {
  const c = load();
  globalThis.chrome = {};
  c.timers.fire(3000);
  assert.equal(c.listeners.size, 0);
});
