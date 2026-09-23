/*
** Popup user interface.
**
** The popup owns no state of its own. It renders four storage keys and
** writes two of them:
**
**     settings    { enabled, scope }       read and written
**     language    'auto' or a locale code  read and written
**     lastEvent   { status, code, params, at }   read only (written by the worker)
**     lastRun     { at, reason }                 read only (written by the worker)
**
** Every render function recomputes its part of the page from those values,
** so a storage change from any source, or a language switch, is applied by
** calling the same functions again.
**
** Turning automatic approval on requires accepting a risk confirmation every
** time. Until the user accepts, the switch stays off and nothing is saved.
**
** All browser objects arrive through startPopup() so the view can be tested
** against a fake document. popup.mjs is the only production caller.
*/
import { LOCALES, loadCatalogs, resolveLocale, translator } from './i18n.mjs';

export const STALE_RUN_MS = 75_000;
export const HEARTBEAT_REFRESH_MS = 5_000;
const TONES = { approved: 'ok', connected: 'ok', retrying: 'warn', waiting: 'warn', stopped: 'bad' };

export async function startPopup({ document, chrome, fetch, setInterval, now = Date.now }) {
  const $ = id => document.getElementById(id);
  const enabled = $('enabled');
  const radios = [...document.querySelectorAll('input[name="scope"]')];
  const language = $('language');
  const probeButton = $('probe');
  const confirmDialog = $('confirm');

  const state = { settings: null, lastEvent: null, lastRun: null, preference: 'auto' };
  let catalogs = {};
  let t = translator(catalogs, LOCALES[0]);

  const clock = at => new Date(at).toLocaleTimeString(document.documentElement.lang);
  // An untranslated code is shown raw rather than hidden.
  const codeText = code => (code && t(`code_${code}`)) || code || t('probeFailed');

  function applyLanguage() {
    const locale = resolveLocale(state.preference, chrome.i18n.getMessage('localeCode'));
    t = translator(catalogs, locale);
    document.documentElement.lang = locale.replace('_', '-');
    document.title = t('extName');
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    language.setAttribute('aria-label', t('languageLabel'));
    // Each language is listed under its own name so users can always find theirs.
    const option = (label, value) => Object.assign(document.createElement('option'), { textContent: label, value });
    language.replaceChildren(
      option(t('languageAuto'), 'auto'),
      ...LOCALES.map(code => option(catalogs[code]?.languageName?.message ?? code, code)),
    );
    language.value = state.preference;
    renderSettings();
    renderEvent();
  }

  function showStatus(label, tone, text, at) {
    $('status-title').textContent = label;
    $('dot').className = tone ? `dot ${tone}` : 'dot';
    $('status-detail').textContent = text;
    $('status-time').textContent = at ? clock(at) : '';
  }

  function describe(event) {
    if (event.detail) return event.detail; // recorded before events carried codes
    const p = event.params ?? {};
    if (event.code === 'approved') {
      return `${t(`decision_${p.decision}`) || p.decision} · ${t(`type_${p.type}`) || p.type}`;
    }
    if (event.code === 'connected') return t('connectedDetail', [String(p.pending), String(p.eligible)]);
    return codeText(event.code);
  }

  function renderEvent() {
    const event = state.lastEvent;
    if (!event) return;
    showStatus(t(`kind_${event.status}`) || event.status, TONES[event.status] ?? '', describe(event), event.at);
  }

  function renderHeartbeat() {
    const heartbeat = $('heartbeat');
    const run = state.lastRun;
    if (!enabled.checked || !run) {
      heartbeat.textContent = '';
      return;
    }
    const stale = now() - run.at > STALE_RUN_MS;
    heartbeat.classList.toggle('stale', stale);
    heartbeat.textContent = stale
      ? t('heartbeatStale', [clock(run.at)])
      : t('heartbeatOk', [clock(run.at), t(`reason_${run.reason}`) || run.reason]);
  }

  function renderSettings() {
    const scope = state.settings?.scope ?? 'network';
    enabled.checked = state.settings?.enabled === true;
    for (const radio of radios) radio.checked = radio.value === scope;
    const pill = $('pill');
    pill.textContent = t(enabled.checked ? 'statusOn' : 'statusOff');
    pill.classList.toggle('on', enabled.checked);
    $('warning').classList.toggle('show', scope === 'all');
    renderHeartbeat();
  }

  const selectedScope = () => radios.find(radio => radio.checked)?.value ?? 'network';

  async function saveSettings() {
    state.settings = { enabled: enabled.checked, scope: selectedScope() };
    renderSettings();
    await chrome.storage.local.set({ settings: state.settings });
  }

  function onSwitch() {
    if (enabled.checked && state.settings?.enabled !== true) {
      enabled.checked = false;
      $('confirm-scope').classList.toggle('show', selectedScope() === 'all');
      confirmDialog.returnValue = '';
      confirmDialog.showModal();
      return;
    }
    return saveSettings();
  }

  /* Escape, Cancel and closing the popup all leave returnValue other than 'accept'. */
  async function onConfirmClosed() {
    if (confirmDialog.returnValue !== 'accept') return;
    enabled.checked = true;
    await saveSettings();
  }

  async function changeLanguage() {
    state.preference = language.value;
    applyLanguage();
    await chrome.storage.local.set({ language: state.preference });
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    // Rebuild only what changed: lastRun is written every few seconds, and
    // rebuilding the language menu would close it while the user has it open.
    if (changes.language) {
      state.preference = changes.language.newValue ?? 'auto';
      applyLanguage();
    }
    if (changes.settings) {
      state.settings = changes.settings.newValue ?? null;
      renderSettings();
    }
    if (changes.lastEvent) {
      state.lastEvent = changes.lastEvent.newValue ?? null;
      renderEvent();
    }
    if (changes.lastRun) {
      state.lastRun = changes.lastRun.newValue ?? null;
      renderHeartbeat();
    }
  }

  async function checkConnection() {
    probeButton.disabled = true;
    showStatus(t('probing'), '', t('probingHint'));
    try {
      const result = await chrome.runtime.sendMessage({ type: 'probe' });
      // On success the worker records a 'connected' event, rendered via storage.
      if (!result?.ok) showStatus(t('probeFailed'), 'bad', codeText(result?.code), now());
    } catch {
      showStatus(t('probeFailed'), 'bad', t('probeNoWorker'), now());
    } finally {
      probeButton.disabled = false;
    }
  }

  const [stored, loaded] = await Promise.all([
    chrome.storage.local.get(['settings', 'lastEvent', 'lastRun', 'language']),
    // Without catalogs the popup still renders, with message keys left blank.
    loadCatalogs(path => fetch(chrome.runtime.getURL(path)).then(r => r.json())).catch(() => ({})),
  ]);
  catalogs = loaded;
  state.settings = stored.settings ?? null;
  state.lastEvent = stored.lastEvent ?? null;
  state.lastRun = stored.lastRun ?? null;
  state.preference = stored.language ?? 'auto';
  applyLanguage();

  language.addEventListener('change', changeLanguage);
  enabled.addEventListener('change', onSwitch);
  for (const radio of radios) radio.addEventListener('change', saveSettings);
  confirmDialog.addEventListener('close', onConfirmClosed);
  $('confirm-accept').addEventListener('click', () => confirmDialog.close('accept'));
  $('confirm-cancel').addEventListener('click', () => confirmDialog.close('cancel'));
  chrome.storage.onChanged.addListener(onStorageChanged);
  probeButton.addEventListener('click', checkConnection);
  setInterval(renderHeartbeat, HEARTBEAT_REFRESH_MS);

  return { checkConnection, changeLanguage, saveSettings, onStorageChanged, renderHeartbeat };
}
