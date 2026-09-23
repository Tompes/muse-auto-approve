import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome, fakeTimers, settle } from './helpers/fake-chrome.mjs';
import {
  createWorker, isMuse, AUTHORIZATION_MS, CALL_TIMEOUT_MS, MAX_PER_RUN, RETRY_MS, SCAN_ALARM, SCAN_PERIOD_MINUTES,
} from '../extension/lib/worker.mjs';
import { museRpc } from '../extension/lib/page-rpc.mjs';

const MUSE_TAB = { id: 7, url: 'https://muse.ai/thread/a', active: false, autoDiscardable: true };
const ON = { settings: { enabled: true, scope: 'network' } };
const approval = (id, extra = {}) => ({ id, type: 'network', eligible: true, ...extra });
const APPROVED = Object.freeze({ ok: true, status: 'approved', decision: 'allow_once' });

/*
** A page that lists `pending` and answers every decide with `decide(args)`.
** Returns the injection array shape chrome.scripting uses.
*/
function page({ pending = [approval('a')], list, decide = () => APPROVED } = {}) {
  return args => {
    if (args.operation === 'list') return [{ result: list ?? { ok: true, pending } }];
    return [{ result: decide(args) }];
  };
}

function setup({ store = ON, tabs = [MUSE_TAB], pageImpl = page(), ...rest } = {}) {
  const fake = fakeChrome({ store, tabs, page: pageImpl, ...rest });
  const timers = fakeTimers();
  const worker = createWorker(fake.chrome, timers);
  const operations = () => fake.log.scripts.map(s => s.approvalId ?? s.operation);
  return { ...fake, timers, worker, operations };
}

describe('isMuse', () => {
  test('accepts only the Muse origin', () => {
    assert.equal(isMuse('https://muse.ai/thread/x'), true);
    assert.equal(isMuse('https://muse.ai.evil.example/'), false);
    assert.equal(isMuse('http://muse.ai/'), false);
    assert.equal(isMuse('not a url'), false);
    assert.equal(isMuse(undefined), false);
  });
});

describe('run', () => {
  test('does nothing while disabled, including the heartbeat', async () => {
    const w = setup({ store: {} });
    assert.deepEqual(await w.worker.run(7), { ok: true, status: 'disabled' });
    assert.deepEqual(w.log.scripts, []);
    assert.equal(w.data.lastRun, undefined);
  });

  test('approves every eligible request in one run and records the last one', async () => {
    const pending = [approval('a'), approval('b', { type: 'connector', eligible: false }), approval('c')];
    const w = setup({ pageImpl: page({ pending }) });
    const result = await w.worker.run(7, { reason: 'push' });
    assert.deepEqual(result, { ok: true, status: 'processed', approved: 2 });
    assert.deepEqual(w.operations(), ['list', 'a', 'c']);
    assert.deepEqual(w.data.lastRun, { at: w.timers.now(), reason: 'push' });
    assert.deepEqual(w.data.lastEvent, {
      status: 'approved', code: 'approved', params: { decision: 'allow_once', type: 'network' }, at: w.timers.now(),
    });
  });

  test('sends a fresh, short-lived authorization with each decision', async () => {
    const w = setup();
    await w.worker.run(7);
    assert.deepEqual(w.log.scripts[1], {
      operation: 'decide', approvalId: 'a', scope: 'network', authorizedUntil: w.timers.now() + AUTHORIZATION_MS,
    });
    assert.equal(w.log.scripts[0].scope, 'network');
  });

  test('caps the number of submissions per run', async () => {
    const pending = Array.from({ length: MAX_PER_RUN + 5 }, (_, i) => approval(`id${i}`));
    const w = setup({ pageImpl: page({ pending }) });
    assert.equal((await w.worker.run(7)).approved, MAX_PER_RUN);
  });

  test('reports idle when nothing is eligible and defaults the reason to poll', async () => {
    const w = setup({ pageImpl: page({ pending: [approval('a', { eligible: false })] }) });
    assert.deepEqual(await w.worker.run(7), { ok: true, status: 'idle', approved: 0 });
    assert.equal(w.data.lastRun.reason, 'poll');
    assert.equal(w.data.lastEvent, undefined);
  });

  test('a request that vanished before the decision is neither counted nor recorded', async () => {
    const w = setup({ pageImpl: page({ decide: () => ({ ok: true, status: 'no_longer_pending' }) }) });
    assert.equal((await w.worker.run(7)).approved, 0);
    assert.equal(w.data.lastEvent, undefined);
  });

  test('turning the switch off stops the batch before the next submission', async () => {
    const w = setup({
      pageImpl: page({
        pending: [approval('a'), approval('b')],
        decide: () => {
          w.data.settings = { enabled: false, scope: 'network' };
          return APPROVED;
        },
      }),
    });
    assert.deepEqual(await w.worker.run(7), { ok: true, status: 'disabled', approved: 1 });
    assert.deepEqual(w.operations(), ['list', 'a']);
  });

  test('changing the scope mid-batch also stops it', async () => {
    const w = setup({
      pageImpl: page({
        pending: [approval('a'), approval('b')],
        decide: () => {
          w.data.settings = { enabled: true, scope: 'all' };
          return APPROVED;
        },
      }),
    });
    assert.equal((await w.worker.run(7)).status, 'disabled');
    assert.deepEqual(w.operations(), ['list', 'a']);
  });

  test('a list failure is recorded as waiting and never turns the switch off', async () => {
    const w = setup({ pageImpl: page({ list: { ok: false, code: 'rpc_unavailable_or_ambiguous' } }) });
    assert.deepEqual(await w.worker.run(7), { ok: false, code: 'rpc_unavailable_or_ambiguous' });
    assert.equal(w.data.lastEvent.status, 'waiting');
    assert.equal(w.data.lastEvent.code, 'rpc_unavailable_or_ambiguous');
    assert.equal(w.data.settings.enabled, true);
  });

  test('a failed decision cools that request down, then retries it', async () => {
    let fail = true;
    const w = setup({
      pageImpl: page({
        pending: [approval('a'), approval('b')],
        decide: args => (fail && args.approvalId === 'a'
          ? { ok: false, code: 'approval_not_confirmed' }
          : APPROVED),
      }),
    });
    assert.equal((await w.worker.run(7)).approved, 1);
    assert.equal(w.data.settings.enabled, true);

    w.data.lastEvent = null;
    await w.worker.run(7);
    assert.deepEqual(w.operations(), ['list', 'a', 'b', 'list', 'b'], 'a is skipped during cooldown');

    fail = false;
    w.timers.advance(RETRY_MS);
    await w.worker.run(7);
    assert.deepEqual(w.operations().slice(5), ['list', 'a', 'b']);
  });

  test('records the failure code of a decision', async () => {
    const w = setup({ pageImpl: page({ decide: () => ({ ok: false, code: 'gateway_changed' }) }) });
    await w.worker.run(7);
    assert.equal(w.data.lastEvent.status, 'retrying');
    assert.equal(w.data.lastEvent.code, 'gateway_changed');
  });

  test('a decision that throws is recorded as interrupted and cooled down', async () => {
    const w = setup({ pageImpl: page({ decide: () => { throw new Error('Frame was removed'); } }) });
    assert.equal((await w.worker.run(7)).approved, 0);
    assert.deepEqual([w.data.lastEvent.status, w.data.lastEvent.code], ['retrying', 'interrupted']);
    await w.worker.run(7);
    assert.deepEqual(w.operations(), ['list', 'a', 'list']);
  });

  test('a list call that throws is recorded as interrupted', async () => {
    const w = setup({ pageImpl: () => { throw new Error('Cannot access contents of the page'); } });
    assert.deepEqual(await w.worker.run(7), { ok: false, code: 'interrupted' });
    assert.equal(w.data.lastEvent.code, 'interrupted');
  });

  test('never rejects, even when storage fails while recording an error', async () => {
    const w = setup({ pageImpl: () => { throw new Error('page gone'); } });
    const set = w.chrome.storage.local.set;
    w.chrome.storage.local.set = async patch => {
      if (patch.lastEvent) throw new Error('QUOTA_BYTES exceeded');
      return set(patch);
    };
    assert.deepEqual(await w.worker.run(7), { ok: false, code: 'interrupted' });
    assert.equal((await w.worker.run(7)).code, 'interrupted', 'the worker is not left busy');
  });

  test('a page call that never settles times out instead of blocking forever', async () => {
    const w = setup({ pageImpl: () => new Promise(() => {}) });
    const running = w.worker.run(7);
    await settle();
    w.timers.fire(CALL_TIMEOUT_MS);
    assert.deepEqual(await running, { ok: false, code: 'interrupted' });
    const next = w.worker.run(7);
    await settle();
    w.timers.fire(CALL_TIMEOUT_MS);
    assert.equal((await next).code, 'interrupted', 'the worker is not left busy');
  });

  test('a completed page call cancels its timeout', async () => {
    const w = setup();
    await w.worker.run(7);
    assert.deepEqual(w.timers.pending(), []);
  });

  test('refuses tabs that navigated away from Muse', async () => {
    const w = setup({ tabs: [{ id: 7, url: 'https://example.com/' }] });
    assert.deepEqual(await w.worker.run(7), { ok: false, code: 'wrong_origin' });
    assert.deepEqual(w.log.scripts, []);
  });

  test('an empty injection result is reported as no_result', async () => {
    const w = setup({ pageImpl: () => [] });
    assert.deepEqual(await w.worker.run(7), { ok: false, code: 'no_result' });
  });

  test('a trigger during a run schedules exactly one follow-up run', async () => {
    let second, third;
    const w = setup({
      pageImpl: page({
        decide: () => {
          second = w.worker.run(7);
          third = w.worker.run(7);
          return APPROVED;
        },
      }),
    });
    await w.worker.run(7);
    assert.equal((await second).code, 'busy');
    assert.equal((await third).code, 'busy');
    assert.equal(w.timers.pending().length, 1);
    w.timers.fire(0);
    await settle();
    assert.equal(w.data.lastRun.reason, 'push');
    assert.deepEqual(w.operations(), ['list', 'a', 'list', 'a']);
  });

  test('a probe during a run does not schedule a follow-up', async () => {
    let probe;
    const w = setup({
      pageImpl: page({
        decide: () => {
          probe = w.worker.run(7, { probe: true });
          return APPROVED;
        },
      }),
    });
    await w.worker.run(7);
    assert.equal((await probe).code, 'busy');
    assert.deepEqual(w.timers.pending(), []);
  });

  test('probe reports counts even while disabled and never submits', async () => {
    const w = setup({
      store: { settings: { enabled: false, scope: 'all' } },
      pageImpl: page({ pending: [approval('a'), approval('b', { eligible: false })] }),
    });
    assert.deepEqual(await w.worker.run(7, { probe: true }), { ok: true });
    assert.deepEqual(w.operations(), ['list']);
    assert.equal(w.log.scripts[0].scope, 'all');
    assert.deepEqual(w.data.lastEvent.params, { pending: 2, eligible: 1 });
    assert.equal(w.data.lastRun, undefined);
  });
});

describe('probe', () => {
  test('reports when no Muse tab is open', async () => {
    const w = setup({ tabs: [{ id: 1, url: 'https://example.com/' }] });
    assert.deepEqual(await w.worker.probe(), { ok: false, code: 'no_muse_tab' });
  });

  test('prefers the visible Muse tab and falls back to the others', async () => {
    const tabs = [
      { id: 1, url: 'https://muse.ai/a', active: false },
      { id: 2, url: 'https://muse.ai/b', active: true },
      { id: 3, url: 'https://example.com/', active: true },
    ];
    const tried = [];
    const w = setup({
      tabs,
      pageImpl: (args, details) => {
        tried.push(details.target.tabId);
        const connected = details.target.tabId === 1;
        const result = connected ? { ok: true, pending: [] } : { ok: false, code: 'rpc_unavailable_or_ambiguous' };
        return [{ result }];
      },
    });
    assert.deepEqual(await w.worker.probe(), { ok: true });
    assert.deepEqual(tried, [2, 1]);
  });

  test('returns the last failure when every tab fails', async () => {
    const w = setup({ pageImpl: page({ list: { ok: false, code: 'rpc_unavailable_or_ambiguous' } }) });
    assert.deepEqual(await w.worker.probe(), { ok: false, code: 'rpc_unavailable_or_ambiguous' });
  });
});

describe('scan', () => {
  test('while enabled, protects Muse tabs from discarding and runs each live tab', async () => {
    const tabs = [
      { ...MUSE_TAB, id: 1, autoDiscardable: true },
      { ...MUSE_TAB, id: 2, autoDiscardable: false },
      { id: 3, url: 'https://example.com/', autoDiscardable: true },
    ];
    const w = setup({ tabs });
    await w.worker.scan();
    await settle();
    assert.deepEqual(w.log.updates, [{ id: 1, autoDiscardable: false }]);
    assert.equal(w.data.lastRun.reason, 'alarm');
    assert.deepEqual(w.operations(), ['list', 'a', 'list', 'a'], 'tab 1, then tab 2');
  });

  test('while disabled, hands discarding back to Chrome and runs nothing', async () => {
    const w = setup({ store: {}, tabs: [{ ...MUSE_TAB, autoDiscardable: false }] });
    await w.worker.scan();
    await settle();
    assert.deepEqual(w.log.updates, [{ id: 7, autoDiscardable: true }]);
    assert.deepEqual(w.log.scripts, []);
  });

  test('reloads the most recently used tab when every Muse tab was unloaded', async () => {
    const tabs = [
      { id: 1, url: 'https://muse.ai/a', discarded: true, autoDiscardable: false },
      { id: 2, url: 'https://muse.ai/b', discarded: true, autoDiscardable: false, lastAccessed: 50 },
      { id: 3, url: 'https://muse.ai/c', discarded: true, autoDiscardable: false, lastAccessed: 10 },
      { id: 4, url: 'https://muse.ai/d', discarded: true, autoDiscardable: false },
    ];
    const w = setup({ tabs });
    await w.worker.scan();
    assert.deepEqual(w.log.reloads, [2]);
    assert.deepEqual([w.data.lastEvent.status, w.data.lastEvent.code], ['waiting', 'tab_reloading']);
    assert.deepEqual(w.log.scripts, []);
  });

  test('does not reload while any Muse tab is still live', async () => {
    const tabs = [{ id: 1, url: 'https://muse.ai/a', discarded: true }, { id: 2, url: 'https://muse.ai/b' }];
    const w = setup({ tabs });
    await w.worker.scan();
    assert.deepEqual(w.log.reloads, []);
    assert.equal(w.log.scripts[0].operation, 'list');
  });

  test('tolerates tabs that close while being updated or reloaded', async () => {
    const tabs = [
      { id: 1, url: 'https://muse.ai/a', discarded: true, autoDiscardable: true, failUpdate: true, failReload: true },
    ];
    const w = setup({ tabs });
    await w.worker.scan();
    await settle();
    assert.deepEqual(w.log.reloads, [1]);
  });

  test('does nothing without Muse tabs', async () => {
    const w = setup({ tabs: [] });
    await w.worker.scan();
    assert.deepEqual([w.log.updates, w.log.reloads, w.log.scripts], [[], [], []]);
  });
});

describe('onMessage', () => {
  const tabSender = (url = MUSE_TAB.url) => ({ id: 'test-extension', tab: { id: 7, url } });
  const reply = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { fn: resolve, promise };
  };

  test('ignores messages from other extensions', () => {
    const w = setup();
    assert.equal(w.worker.onMessage({ type: 'tick' }, { id: 'other', tab: MUSE_TAB }, () => {}), false);
    assert.deepEqual(w.log.scripts, []);
  });

  test('runs for ticks from Muse tabs and keeps the channel open', async () => {
    const w = setup();
    const r = reply();
    assert.equal(w.worker.onMessage({ type: 'tick', reason: 'push' }, tabSender(), r.fn), true);
    assert.equal((await r.promise).status, 'processed');
    assert.equal(w.data.lastRun.reason, 'push');
  });

  test('treats any other tick reason as poll', async () => {
    const w = setup();
    const r = reply();
    w.worker.onMessage({ type: 'tick', reason: 'forged' }, tabSender(), r.fn);
    await r.promise;
    assert.equal(w.data.lastRun.reason, 'poll');
  });

  test('ignores ticks from other sites and malformed messages', () => {
    const w = setup();
    assert.equal(w.worker.onMessage({ type: 'tick' }, tabSender('https://example.com/'), () => {}), false);
    assert.equal(w.worker.onMessage({ type: 'tick' }, { id: 'test-extension' }, () => {}), false);
    assert.equal(w.worker.onMessage(null, tabSender(), () => {}), false);
    assert.equal(w.worker.onMessage({ type: 'unknown' }, tabSender(), () => {}), false);
  });

  test('answers probes from the popup only', async () => {
    const w = setup();
    const r = reply();
    assert.equal(w.worker.onMessage({ type: 'probe' }, { id: 'test-extension' }, r.fn), true);
    assert.deepEqual(await r.promise, { ok: true });
    assert.equal(w.worker.onMessage({ type: 'probe' }, tabSender(), () => {}), false);
  });
});

describe('onInstalled', () => {
  const tabs = [
    { id: 1, url: 'https://muse.ai/a' },
    { id: 2, url: 'https://muse.ai/b', discarded: true },
    { id: 3, url: 'https://muse.ai/c', failInject: true },
  ];

  for (const reason of ['install', 'update']) {
    test(`re-attaches content scripts on ${reason}`, async () => {
      const w = setup({ tabs });
      await w.worker.onInstalled({ reason });
      await settle();
      assert.deepEqual(w.log.injected, [1, 3]);
    });
  }

  test('leaves working scripts alone on a browser update', async () => {
    const w = setup({ tabs });
    await w.worker.onInstalled({ reason: 'chrome_update' });
    assert.deepEqual(w.log.injected, []);
  });
});

describe('start', () => {
  test('registers every listener synchronously and creates the scan alarm once', async () => {
    const w = setup();
    const started = w.worker.start();
    const { runtime, alarms, storage } = w.chrome;
    assert.deepEqual(
      [runtime.onMessage, runtime.onInstalled, alarms.onAlarm, storage.onChanged].map(e => e.listeners.length),
      [1, 1, 1, 1],
    );
    await started;
    assert.deepEqual(w.alarms[SCAN_ALARM], { name: SCAN_ALARM, periodInMinutes: SCAN_PERIOD_MINUTES });

    await createWorker(w.chrome, w.timers).start();
    assert.deepEqual(w.log.alarms, [SCAN_ALARM], 'an existing alarm keeps its schedule');
  });

  test('the scan alarm triggers a scan; other alarms do not', async () => {
    const w = setup();
    await w.worker.start();
    w.chrome.alarms.onAlarm.emit({ name: 'other' });
    await settle();
    assert.deepEqual(w.log.scripts, []);
    w.chrome.alarms.onAlarm.emit({ name: SCAN_ALARM });
    await settle();
    assert.equal(w.data.lastRun.reason, 'alarm');
  });

  test('toggling the switch scans immediately; other storage changes do not', async () => {
    const w = setup({ store: { settings: { enabled: false, scope: 'network' } } });
    await w.worker.start();
    await w.chrome.storage.local.set({ lastRun: { at: 1, reason: 'poll' } });
    await w.chrome.storage.local.set({ settings: { enabled: false, scope: 'all' } });
    w.chrome.storage.onChanged.emit({ settings: { newValue: { enabled: true } } }, 'sync');
    await settle();
    assert.deepEqual(w.log.updates, []);

    await w.chrome.storage.local.set({ settings: { enabled: true, scope: 'network' } });
    await settle();
    assert.deepEqual(w.log.updates, [{ id: 7, autoDiscardable: false }]);
  });

  test('uses the real clock and timers when none are injected', async () => {
    const fake = fakeChrome({ store: ON, tabs: [MUSE_TAB], page: page() });
    const before = Date.now();
    await createWorker(fake.chrome).run(7);
    assert.ok(fake.data.lastRun.at >= before);
  });
});

test('the worker injects the real page function', async () => {
  const w = setup();
  let func;
  w.chrome.scripting.executeScript = async details => {
    func = details.func;
    return [{ result: { ok: true, pending: [] } }];
  };
  await w.worker.run(7);
  assert.equal(func, museRpc);
});
