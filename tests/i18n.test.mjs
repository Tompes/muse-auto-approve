import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LOCALES, loadCatalogs, resolveLocale, translator } from '../extension/lib/i18n.mjs';

const EXTENSION = new URL('../extension/', import.meta.url);
const read = path => fs.readFileSync(new URL(path, EXTENSION), 'utf8');
const locales = fs.readdirSync(new URL('_locales', EXTENSION));
const catalogs = Object.fromEntries(locales.map(l => [l, JSON.parse(read(`_locales/${l}/messages.json`))]));
const en = catalogs.en;
const placeholders = text => (text.match(/\$\d/g) ?? []).sort().join();

describe('catalogs', () => {
  test('every locale has the same keys and placeholders as English, and nothing empty', () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      assert.deepEqual(Object.keys(catalog).sort(), Object.keys(en).sort(), locale);
      for (const key of Object.keys(en)) {
        assert.ok(catalog[key].message.trim(), `${locale}.${key} is empty`);
        assert.equal(placeholders(catalog[key].message), placeholders(en[key].message), `${locale}.${key}`);
      }
    }
  });

  test('keys use only characters chrome.i18n accepts', () => {
    for (const key of Object.keys(en)) assert.match(key, /^[A-Za-z0-9_@]+$/);
  });

  test('the selectable languages are exactly the shipped catalogs', () => {
    assert.deepEqual([...LOCALES].sort(), [...locales].sort());
    for (const [locale, catalog] of Object.entries(catalogs)) assert.equal(catalog.localeCode.message, locale);
    const names = Object.values(catalogs).map(c => c.languageName.message);
    assert.equal(new Set(names).size, names.length);
  });

  test('the manifest, popup and view reference only existing messages', () => {
    const used = [
      ...read('manifest.json').matchAll(/__MSG_(\w+)__/g),
      ...read('popup.html').matchAll(/data-i18n="(\w+)"/g),
      ...read('lib/popup-view.mjs').matchAll(/\bt\('(\w+)'/g),
    ].map(m => m[1]);
    assert.ok(used.length > 20);
    for (const key of used) assert.ok(en[key], `missing message ${key}`);
  });

  test('every code the extension can produce has a translation', () => {
    const sources = read('lib/worker.mjs') + read('lib/page-rpc.mjs');
    const codes = new Set([
      ...[...sources.matchAll(/failure\('(\w+)'\)/g)].map(m => m[1]),
      ...[...sources.matchAll(/code: '(\w+)'/g)].map(m => m[1]),
      ...[...sources.matchAll(/record\('\w+', '(\w+)'/g)].map(m => m[1]),
    ]);
    // Produced only when the worker itself passes invalid input; never user-visible.
    const internal = new Set(['invalid_scope', 'unknown_operation', 'approved', 'connected']);
    assert.ok(codes.size > 10);
    for (const code of codes) if (!internal.has(code)) assert.ok(en[`code_${code}`], `missing code_${code}`);
    for (const status of ['approved', 'connected', 'retrying', 'waiting']) assert.ok(en[`kind_${status}`]);
    for (const reason of ['push', 'poll', 'alarm']) assert.ok(en[`reason_${reason}`]);
    for (const decision of ['allow_always', 'allow_once']) assert.ok(en[`decision_${decision}`]);
  });

  test('every approvable type has a translation', () => {
    const list = read('lib/page-rpc.mjs').match(/APPROVABLE_TYPES = \[([^\]]+)\]/)[1];
    const types = [...list.matchAll(/'(\w+)'/g)].map(m => m[1]);
    assert.equal(types.length, 9);
    for (const type of types) assert.ok(en[`type_${type}`], `missing type_${type}`);
  });
});

describe('resolveLocale', () => {
  test('a manual choice wins over the browser language', () => {
    assert.equal(resolveLocale('en', 'zh_CN'), 'en');
    assert.equal(resolveLocale('zh_CN', 'en'), 'zh_CN');
  });
  test('auto, empty and missing preferences follow the browser', () => {
    for (const preference of ['auto', '', undefined, null]) assert.equal(resolveLocale(preference, 'zh_CN'), 'zh_CN');
  });
  test('anything unsupported falls back to the default locale', () => {
    assert.equal(resolveLocale('fr', 'zh_CN'), 'en');
    assert.equal(resolveLocale('auto', ''), 'en');
    assert.equal(resolveLocale('auto', undefined), 'en');
  });
});

describe('translator', () => {
  const sample = {
    en: { pair: { message: 'A $1 then $2' }, onlyEnglish: { message: 'EN' } },
    zh_CN: { pair: { message: '先 $2 后 $1' } },
  };

  test('substitutes placeholders in the order the translation needs', () => {
    assert.equal(translator(sample, 'zh_CN')('pair', ['x', 'y']), '先 y 后 x');
  });
  test('missing substitutions become empty, like chrome.i18n', () => {
    assert.equal(translator(sample, 'en')('pair', ['x']), 'A x then ');
    assert.equal(translator(sample, 'en')('pair'), 'A  then ');
  });
  test('falls back to English for a missing key, and to empty for an unknown one', () => {
    const t = translator(sample, 'zh_CN');
    assert.equal(t('onlyEnglish'), 'EN');
    assert.equal(t('nowhere'), '');
  });
  test('works with no catalogs at all', () => {
    assert.equal(translator({}, 'zh_CN')('pair'), '');
  });
  test('translates real messages', () => {
    const t = translator(catalogs, 'zh_CN');
    assert.equal(t('heartbeatOk', ['12:00', t('reason_push')]), '最近自动检查 12:00 · 实时推送');
  });
});

test('loadCatalogs fetches every locale by path', async () => {
  const requested = [];
  const result = await loadCatalogs(async path => { requested.push(path); return { path }; });
  assert.deepEqual(requested, LOCALES.map(l => `_locales/${l}/messages.json`));
  assert.deepEqual(Object.keys(result), LOCALES);
});
