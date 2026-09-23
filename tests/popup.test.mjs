import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeChrome, fakeTimers } from './helpers/fake-chrome.mjs';
import { fakeDocument } from './helpers/fake-dom.mjs';
import { startPopup, STALE_RUN_MS, HEARTBEAT_REFRESH_MS } from '../extension/lib/popup-view.mjs';

const EXTENSION = new URL('../extension/', import.meta.url);
const catalog = locale => JSON.parse(fs.readFileSync(new URL(`_locales/${locale}/messages.json`, EXTENSION), 'utf8'));
const EN = catalog('en');
const ZH = catalog('zh_CN');

/* Serve extension files the way fetch(chrome.runtime.getURL(path)) would. */
async function extensionFetch(url) {
  const path = url.replace('chrome-extension://test/', '');
  return { json: async () => JSON.parse(fs.readFileSync(new URL(path, EXTENSION), 'utf8')) };
}

async function open({ store = {}, browserLocale = 'en', fetch = extensionFetch, reply } = {}) {
  const fake = fakeChrome({ store, messages: { localeCode: browserLocale } });
  if (reply) fake.chrome.runtime.reply = reply;
  const timers = fakeTimers(10_000_000);
  const document = fakeDocument(new URL('popup.html', EXTENSION));
  const view = await startPopup({
    document, chrome: fake.chrome, fetch, setInterval: timers.setInterval, now: timers.now,
  });
  const $ = id => document.getElementById(id);
  const text = id => $(id).textContent;
  const radios = document.querySelectorAll('input[name="scope"]');
  return { ...fake, timers, document, view, $, text, radios };
}

/* Turn automatic approval on the way a user does: flip the switch, accept the risk. */
async function turnOn(p) {
  p.$('enabled').checked = true;
  await p.$('enabled').dispatch('change');
  await p.$('confirm-accept').dispatch('click');
}

describe('language', () => {
  test('auto follows the browser language', async () => {
    const p = await open({ browserLocale: 'zh_CN' });
    assert.equal(p.document.documentElement.lang, 'zh-CN');
    assert.equal(p.document.title, ZH.extName.message);
    assert.equal(p.text('pill'), ZH.statusOff.message);
    assert.equal(p.$('language').value, 'auto');
  });

  test('an unsupported browser language falls back to English', async () => {
    const p = await open({ browserLocale: '' });
    assert.equal(p.document.documentElement.lang, 'en');
  });

  test('fills every data-i18n element from the catalog', async () => {
    const p = await open();
    const translated = p.document.elements.filter(el => el.dataset.i18n);
    assert.ok(translated.length > 15);
    for (const el of translated) assert.equal(el.textContent, EN[el.dataset.i18n].message, el.dataset.i18n);
  });

  test('offers auto plus every language under its own name', async () => {
    const p = await open({ browserLocale: 'zh_CN' });
    const options = p.$('language').children.map(o => [o.value, o.textContent]);
    assert.deepEqual(options, [['auto', ZH.languageAuto.message], ['en', 'English'], ['zh_CN', '简体中文']]);
    assert.equal(p.$('language').getAttribute('aria-label'), ZH.languageLabel.message);
  });

  test('a manual choice overrides the browser language and is saved', async () => {
    const p = await open({ browserLocale: 'zh_CN' });
    p.$('language').value = 'en';
    await p.$('language').dispatch('change');
    assert.equal(p.text('pill'), EN.statusOff.message);
    assert.equal(p.data.language, 'en');
  });

  test('a saved choice is applied on open', async () => {
    const p = await open({ browserLocale: 'en', store: { language: 'zh_CN' } });
    assert.equal(p.text('pill'), ZH.statusOff.message);
    assert.equal(p.$('language').value, 'zh_CN');
  });

  test('still opens when the catalogs cannot be loaded', async () => {
    const p = await open({ fetch: async () => { throw new Error('offline'); } });
    assert.equal(p.text('pill'), '');
    assert.deepEqual(p.$('language').children.map(o => o.textContent), ['', 'en', 'zh_CN']);
  });
});

describe('settings', () => {
  test('renders the stored switch and scope', async () => {
    const p = await open({ store: { settings: { enabled: true, scope: 'all' } } });
    assert.equal(p.$('enabled').checked, true);
    assert.deepEqual(p.radios.map(r => r.checked), [false, true]);
    assert.equal(p.text('pill'), EN.statusOn.message);
    assert.ok(p.$('pill').classList.contains('on'));
    assert.ok(p.$('warning').classList.contains('show'));
  });

  test('defaults to off and network only', async () => {
    const p = await open();
    assert.equal(p.$('enabled').checked, false);
    assert.deepEqual(p.radios.map(r => r.checked), [true, false]);
    assert.ok(!p.$('warning').classList.contains('show'));
  });

  test('saves the switch and scope when either changes', async () => {
    const p = await open();
    await turnOn(p);
    assert.deepEqual(p.data.settings, { enabled: true, scope: 'network' });
    p.radios[0].checked = false;
    p.radios[1].checked = true;
    await p.radios[1].dispatch('change');
    assert.deepEqual(p.data.settings, { enabled: true, scope: 'all' });
    assert.ok(p.$('warning').classList.contains('show'));
  });

  test('falls back to network when no scope is selected', async () => {
    const p = await open();
    for (const radio of p.radios) radio.checked = false;
    await turnOn(p);
    assert.equal(p.data.settings.scope, 'network');
  });

  test('turning off saves immediately without asking', async () => {
    const p = await open({ store: { settings: { enabled: true, scope: 'network' } } });
    p.$('enabled').checked = false;
    await p.$('enabled').dispatch('change');
    assert.equal(p.$('confirm').open, false);
    assert.deepEqual(p.data.settings, { enabled: false, scope: 'network' });
  });
});

describe('risk confirmation', () => {
  const flip = async p => {
    p.$('enabled').checked = true;
    await p.$('enabled').dispatch('change');
  };

  test('turning on asks first and keeps the switch off until accepted', async () => {
    const p = await open();
    await flip(p);
    assert.equal(p.$('confirm').open, true);
    assert.equal(p.$('enabled').checked, false);
    assert.equal(p.data.settings, undefined);
    assert.equal(p.text('confirm-title'), EN.confirmTitle.message);
  });

  test('accepting turns it on and saves', async () => {
    const p = await open();
    await flip(p);
    await p.$('confirm-accept').dispatch('click');
    assert.equal(p.$('confirm').open, false);
    assert.equal(p.$('enabled').checked, true);
    assert.deepEqual(p.data.settings, { enabled: true, scope: 'network' });
    assert.equal(p.text('pill'), EN.statusOn.message);
  });

  test('cancelling, or closing with Escape, leaves it off and saves nothing', async () => {
    for (const dismiss of [p => p.$('confirm-cancel').dispatch('click'), p => p.$('confirm').close()]) {
      const p = await open();
      await flip(p);
      await dismiss(p);
      assert.equal(p.$('confirm').open, false);
      assert.equal(p.$('enabled').checked, false);
      assert.equal(p.data.settings, undefined);
    }
  });

  test('asks again every time, even after a previous acceptance', async () => {
    const p = await open();
    await turnOn(p);
    p.$('enabled').checked = false;
    await p.$('enabled').dispatch('change');
    await flip(p);
    assert.equal(p.$('confirm').open, true);
    assert.equal(p.$('enabled').checked, false);
  });

  test('warns about checkout only when the broad scope is selected', async () => {
    const network = await open();
    await flip(network);
    assert.ok(!network.$('confirm-scope').classList.contains('show'));

    const all = await open({ store: { settings: { enabled: false, scope: 'all' } } });
    await flip(all);
    assert.ok(all.$('confirm-scope').classList.contains('show'));
    await all.$('confirm-accept').dispatch('click');
    assert.deepEqual(all.data.settings, { enabled: true, scope: 'all' });
  });

  test('changing the scope while on does not ask', async () => {
    const p = await open({ store: { settings: { enabled: true, scope: 'network' } } });
    p.radios[0].checked = false;
    p.radios[1].checked = true;
    await p.radios[1].dispatch('change');
    assert.equal(p.$('confirm').open, false);
    assert.deepEqual(p.data.settings, { enabled: true, scope: 'all' });
  });

  test('is translated', async () => {
    const p = await open({ browserLocale: 'zh_CN' });
    await flip(p);
    assert.equal(p.text('confirm-accept'), ZH.confirmAccept.message);
  });
});

describe('status', () => {
  const at = 10_000_000;

  test('shows nothing recorded yet', async () => {
    const p = await open();
    assert.equal(p.text('status-title'), EN.statusNone.message);
    assert.equal(p.text('status-time'), '');
  });

  test('describes an approval with localized decision and type', async () => {
    const event = { status: 'approved', code: 'approved', params: { decision: 'allow_always', type: 'network' }, at };
    const p = await open({ store: { lastEvent: event } });
    assert.equal(p.text('status-title'), EN.kind_approved.message);
    assert.equal(p.text('status-detail'), `${EN.decision_allow_always.message} · ${EN.type_network.message}`);
    assert.equal(p.$('dot').className, 'dot ok');
    assert.notEqual(p.text('status-time'), '');
  });

  test('shows unknown decisions, types, statuses and codes raw instead of hiding them', async () => {
    const params = { decision: 'deny_forever', type: 'teleport' };
    const p = await open({ store: { lastEvent: { status: 'approved', code: 'approved', params, at } } });
    assert.equal(p.text('status-detail'), 'deny_forever · teleport');
    await p.chrome.storage.local.set({ lastEvent: { status: 'exploded', code: 'new_code', at } });
    assert.equal(p.text('status-title'), 'exploded');
    assert.equal(p.text('status-detail'), 'new_code');
    assert.equal(p.$('dot').className, 'dot');
  });

  test('describes a connection check with counts', async () => {
    const params = { pending: 3, eligible: 2 };
    const p = await open({ store: { lastEvent: { status: 'connected', code: 'connected', params, at } } });
    assert.equal(p.text('status-detail'), EN.connectedDetail.message.replace('$1', '3').replace('$2', '2'));
  });

  test('translates failure codes and tones', async () => {
    const p = await open({ store: { lastEvent: { status: 'retrying', code: 'gateway_changed', at } } });
    assert.equal(p.text('status-detail'), EN.code_gateway_changed.message);
    assert.equal(p.$('dot').className, 'dot warn');
  });

  test('an event without a code or params falls back to a generic failure', async () => {
    const p = await open({ store: { lastEvent: { status: 'stopped', at } } });
    assert.equal(p.text('status-detail'), EN.probeFailed.message);
    assert.equal(p.$('dot').className, 'dot bad');
  });

  test('events recorded before codes existed keep their text', async () => {
    const legacy = { status: 'approved', detail: '静默 allow_always · network', at };
    const p = await open({ store: { lastEvent: legacy } });
    assert.equal(p.text('status-detail'), '静默 allow_always · network');
  });

  test('re-renders when the worker records a new event', async () => {
    const p = await open();
    await p.chrome.storage.local.set({ lastEvent: { status: 'waiting', code: 'tab_reloading', at } });
    assert.equal(p.text('status-detail'), EN.code_tab_reloading.message);
  });
});

describe('heartbeat', () => {
  const on = { settings: { enabled: true, scope: 'network' } };

  test('shows the last automatic check and its trigger', async () => {
    const p = await open({ store: { ...on, lastRun: { at: 10_000_000 - 2000, reason: 'push' } } });
    assert.match(p.text('heartbeat'), new RegExp(EN.reason_push.message));
    assert.ok(!p.$('heartbeat').classList.contains('stale'));
  });

  test('warns when automatic checks stopped', async () => {
    const p = await open({ store: { ...on, lastRun: { at: 10_000_000 - STALE_RUN_MS - 1, reason: 'poll' } } });
    assert.ok(p.$('heartbeat').classList.contains('stale'));
    assert.match(p.text('heartbeat'), /^⚠/);
  });

  test('refreshes on a timer so a stopped worker becomes visible', async () => {
    const p = await open({ store: { ...on, lastRun: { at: 10_000_000, reason: 'alarm' } } });
    p.timers.advance(STALE_RUN_MS + 1);
    p.timers.fire(HEARTBEAT_REFRESH_MS);
    assert.ok(p.$('heartbeat').classList.contains('stale'));
  });

  test('shows an unknown trigger raw', async () => {
    const p = await open({ store: { ...on, lastRun: { at: 10_000_000, reason: 'carrier_pigeon' } } });
    assert.match(p.text('heartbeat'), /carrier_pigeon/);
  });

  test('is hidden while disabled or before the first run', async () => {
    assert.equal((await open({ store: { lastRun: { at: 10_000_000, reason: 'poll' } } })).text('heartbeat'), '');
    assert.equal((await open({ store: on })).text('heartbeat'), '');
  });
});

describe('storage changes', () => {
  test('apply settings, runs, language and cleared values from any source', async () => {
    const p = await open();
    await p.chrome.storage.local.set({ settings: { enabled: true, scope: 'network' } });
    assert.equal(p.$('enabled').checked, true);
    await p.chrome.storage.local.set({ lastRun: { at: 10_000_000, reason: 'poll' } });
    assert.notEqual(p.text('heartbeat'), '');
    await p.chrome.storage.local.set({ language: 'zh_CN' });
    assert.equal(p.text('pill'), ZH.statusOn.message);

    p.view.onStorageChanged({ language: {}, settings: {}, lastEvent: {}, lastRun: {} }, 'local');
    assert.equal(p.$('language').value, 'auto');
    assert.equal(p.$('enabled').checked, false);
    assert.equal(p.text('heartbeat'), '');
  });

  test('ignore other storage areas', async () => {
    const p = await open();
    p.view.onStorageChanged({ settings: { newValue: { enabled: true } } }, 'sync');
    assert.equal(p.$('enabled').checked, false);
  });

  test('a heartbeat update does not rebuild the language menu', async () => {
    const p = await open();
    const before = p.$('language').children;
    await p.chrome.storage.local.set({ lastRun: { at: 10_000_000, reason: 'poll' } });
    assert.equal(p.$('language').children, before);
  });
});

describe('connection check', () => {
  test('disables the button while checking and leaves success to the worker event', async () => {
    let during;
    const p = await open({ reply: () => { during = p.$('probe').disabled; return { ok: true }; } });
    await p.$('probe').dispatch('click');
    assert.equal(during, true);
    assert.equal(p.$('probe').disabled, false);
    assert.deepEqual(p.log.sent, [{ type: 'probe' }]);
    assert.equal(p.text('status-title'), EN.probing.message);
  });

  test('explains a failure code', async () => {
    const p = await open({ reply: () => ({ ok: false, code: 'no_muse_tab' }) });
    await p.$('probe').dispatch('click');
    assert.equal(p.text('status-title'), EN.probeFailed.message);
    assert.equal(p.text('status-detail'), EN.code_no_muse_tab.message);
  });

  test('handles a missing reply', async () => {
    const p = await open({ reply: () => undefined });
    await p.$('probe').dispatch('click');
    assert.equal(p.text('status-detail'), EN.probeFailed.message);
  });

  test('explains an unreachable worker', async () => {
    const p = await open({ reply: () => { throw new Error('Receiving end does not exist.'); } });
    await p.$('probe').dispatch('click');
    assert.equal(p.text('status-detail'), EN.probeNoWorker.message);
    assert.equal(p.$('probe').disabled, false);
  });
});
