/*
** Extension service worker logic: decides when to query and approve.
**
** A "run" lists the pending approvals of one Muse tab and submits every
** eligible one. Runs are triggered by three sources, from fastest to most
** robust:
**
**     push    the page received an approval event (see page-rpc.mjs)
**     poll    the content script's 3-second timer (throttled in background tabs)
**     alarm   a 30-second chrome.alarms scan of every Muse tab
**
** Invariants:
**
**   1. Only the user changes settings.enabled. Nothing here writes it.
**   2. At most one run is in progress. A trigger that arrives during a run
**      schedules exactly one follow-up run instead of being dropped.
**   3. Settings are re-read immediately before every submission, so turning
**      the switch off stops a batch between two approvals.
**   4. An approval whose submission failed or could not be confirmed is not
**      submitted again for RETRY_MS.
**   5. Stored events hold message codes and parameters, never display text;
**      the popup renders them in the user's language.
**
** All browser APIs arrive through createWorker() so the logic can be tested
** without a browser. background.mjs is the only production caller.
*/
import { museRpc } from './page-rpc.mjs';

export const MUSE_ORIGIN = 'https://muse.ai';
export const RETRY_MS = 60_000;
export const MAX_PER_RUN = 20;
export const CALL_TIMEOUT_MS = 15_000;
export const AUTHORIZATION_MS = 5_000;
export const SCAN_ALARM = 'scan';
export const SCAN_PERIOD_MINUTES = 0.5;

const MUSE_TABS = `${MUSE_ORIGIN}/*`;
const DEFAULT_SETTINGS = Object.freeze({ enabled: false, scope: 'network' });

export function isMuse(url) {
  try {
    return new URL(url).origin === MUSE_ORIGIN;
  } catch {
    return false;
  }
}

export function createWorker(chrome, {
  now = Date.now,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
} = {}) {
  let busy = false;
  let followUpTab = null;
  const cooldown = new Map(); // approval id -> time before which it is skipped

  async function settings() {
    return (await chrome.storage.local.get('settings')).settings ?? DEFAULT_SETTINGS;
  }
  function record(status, code, params) {
    return chrome.storage.local.set({ lastEvent: { status, code, params, at: now() } });
  }

  /* Run museRpc(args) in the tab's page. Rejects on timeout or script failure. */
  async function execute(tabId, args) {
    const tab = await chrome.tabs.get(tabId);
    if (!isMuse(tab.url)) return { ok: false, code: 'wrong_origin' };
    // The page call cannot be cancelled, but a call that never settles must
    // not keep the worker busy forever.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), CALL_TIMEOUT_MS);
    });
    try {
      const [injection] = await Promise.race([
        chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: museRpc, args: [args] }),
        timeout,
      ]);
      return injection?.result ?? { ok: false, code: 'no_result' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function approveOne(tabId, approval, scope) {
    let result;
    try {
      result = await execute(tabId, {
        operation: 'decide', approvalId: approval.id, scope, authorizedUntil: now() + AUTHORIZATION_MS,
      });
    } catch {
      result = { ok: false, code: 'interrupted' };
    }
    if (!result.ok) {
      cooldown.set(approval.id, now() + RETRY_MS);
      await record('retrying', result.code);
    } else if (result.status === 'approved') {
      await record('approved', 'approved', { decision: result.decision, type: approval.type });
    }
    return result;
  }

  function coolingDown(id) {
    const until = cooldown.get(id);
    if (until === undefined) return false;
    if (until > now()) return true;
    cooldown.delete(id);
    return false;
  }

  /*
  ** One run against one tab. With probe set, only list and report the
  ** connection state (the popup's read-only check); this works even while
  ** automatic processing is off.
  */
  async function run(tabId, { probe = false, reason = 'poll' } = {}) {
    if (busy) {
      if (!probe) followUpTab = tabId;
      return { ok: false, code: 'busy' };
    }
    busy = true;
    const result = await runOnce(tabId, probe, reason);
    busy = false;
    if (followUpTab !== null) {
      const next = followUpTab;
      followUpTab = null;
      setTimeout(() => run(next, { reason: 'push' }), 0);
    }
    return result;
  }

  /* The body of run(). Never rejects: callers reply with its result. */
  async function runOnce(tabId, probe, reason) {
    try {
      const initial = await settings();
      if (!probe && !initial.enabled) return { ok: true, status: 'disabled' };
      if (!probe) await chrome.storage.local.set({ lastRun: { at: now(), reason } });

      const list = await execute(tabId, { operation: 'list', scope: initial.scope });
      if (!list.ok) {
        await record('waiting', list.code);
        return list;
      }
      if (probe) {
        const eligible = list.pending.filter(a => a.eligible).length;
        await record('connected', 'connected', { pending: list.pending.length, eligible });
        return { ok: true };
      }

      const queue = list.pending.filter(a => a.eligible && !coolingDown(a.id)).slice(0, MAX_PER_RUN);
      let approved = 0;
      for (const approval of queue) {
        const latest = await settings();
        if (!latest.enabled || latest.scope !== initial.scope) return { ok: true, status: 'disabled', approved };
        if ((await approveOne(tabId, approval, latest.scope)).status === 'approved') approved++;
      }
      return { ok: true, status: queue.length ? 'processed' : 'idle', approved };
    } catch {
      // Storage itself may be what failed, so recording is best effort.
      await record('retrying', 'interrupted').catch(() => {});
      return { ok: false, code: 'interrupted' };
    }
  }

  /* Read-only check from the popup: prefer the visible Muse tab, then any other. */
  async function probe() {
    const tabs = (await chrome.tabs.query({ url: MUSE_TABS }))
      .filter(tab => isMuse(tab.url))
      .sort((a, b) => Number(b.active) - Number(a.active));
    if (!tabs.length) return { ok: false, code: 'no_muse_tab' };
    let result;
    for (const tab of tabs) {
      result = await run(tab.id, { probe: true });
      if (result.ok) break;
    }
    return result;
  }

  /*
  ** The alarm-driven fallback. It does not depend on the content script, so
  ** it also covers tabs whose script was orphaned by an extension reload.
  **
  ** While enabled, Muse tabs are marked not auto-discardable so Chrome's
  ** memory saver does not unload the page that holds the connection. If every
  ** Muse tab is already unloaded, the most recently used one is reloaded.
  */
  async function scan() {
    const { enabled } = await settings();
    const tabs = (await chrome.tabs.query({ url: MUSE_TABS })).filter(tab => isMuse(tab.url));
    for (const tab of tabs) {
      if (tab.autoDiscardable === enabled) {
        chrome.tabs.update(tab.id, { autoDiscardable: !enabled }).catch(() => {});
      }
    }
    if (!enabled) return;
    const live = tabs.filter(tab => !tab.discarded);
    if (!live.length && tabs.length) {
      const [latest] = tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
      await record('waiting', 'tab_reloading');
      await chrome.tabs.reload(latest.id).catch(() => {});
      return;
    }
    for (const tab of live) await run(tab.id, { reason: 'alarm' });
  }

  function onMessage(message, sender, reply) {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === 'tick' && sender.tab && isMuse(sender.tab.url)) {
      run(sender.tab.id, { reason: message.reason === 'push' ? 'push' : 'poll' }).then(reply);
      return true;
    }
    if (message?.type === 'probe' && !sender.tab) {
      probe().then(reply);
      return true;
    }
    return false;
  }

  /*
  ** Reloading the extension orphans the content scripts in open tabs. Attach
  ** fresh ones. Skipped for browser updates, where the old scripts still work.
  */
  async function onInstalled({ reason }) {
    if (reason !== 'install' && reason !== 'update') return;
    for (const tab of await chrome.tabs.query({ url: MUSE_TABS })) {
      if (tab.discarded) continue;
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
    }
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes.settings) return;
    if (changes.settings.newValue?.enabled !== changes.settings.oldValue?.enabled) scan();
  }

  /*
  ** Register every listener synchronously: an MV3 worker that is woken by an
  ** event only receives it if the listener exists before the first await.
  */
  function start() {
    chrome.runtime.onMessage.addListener(onMessage);
    chrome.runtime.onInstalled.addListener(onInstalled);
    chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === SCAN_ALARM) scan(); });
    chrome.storage.onChanged.addListener(onStorageChanged);
    // Re-creating an alarm resets its schedule, and the worker restarts often.
    return chrome.alarms.get(SCAN_ALARM).then(alarm => {
      if (!alarm) chrome.alarms.create(SCAN_ALARM, { periodInMinutes: SCAN_PERIOD_MINUTES });
    });
  }

  return { run, probe, scan, start, onMessage, onInstalled };
}
