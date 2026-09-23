/*
** Content script: wakes the service worker, nothing else.
**
** It never reads the conversation and never touches page controls. It sends
** a 'tick' message every POLL_MS, and immediately (debounced by PUSH_DEBOUNCE_MS)
** when the page-side watcher in lib/page-rpc.mjs posts a wake message. The
** wake message carries no data, so a page that forges one can at most cause
** an extra run, which re-validates everything through RPC.
**
** Content scripts cannot be ES modules, so this is a classic script.
*/
(() => {
  const POLL_MS = 3000;
  const PUSH_DEBOUNCE_MS = 100;
  let pollTimer = null;
  let pushTimer = null;

  // After the extension is reloaded this copy is orphaned: chrome.runtime.id
  // disappears and sendMessage throws synchronously. Stop quietly; the
  // reloaded worker injects a fresh copy.
  function shutdown() {
    clearInterval(pollTimer);
    clearTimeout(pushTimer);
    window.removeEventListener('message', onMessage);
  }

  function tick(reason) {
    if (!chrome.runtime?.id) {
      shutdown();
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: 'tick', reason }).catch(() => {
        if (!chrome.runtime?.id) shutdown();
      });
    } catch {
      shutdown();
    }
  }

  function onMessage(event) {
    if (event.source !== window) return;
    if (event.data?.source !== 'muse-auto-approve' || event.data.type !== 'wake') return;
    if (pushTimer !== null) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      tick('push');
    }, PUSH_DEBOUNCE_MS);
  }

  pollTimer = setInterval(() => tick('poll'), POLL_MS);
  window.addEventListener('message', onMessage);
  tick('poll');
})();
