/*
** In-memory stand-ins for the chrome.* APIs used by the extension.
**
** Only the behavior the extension depends on is modeled. storage.local.set
** fires onChanged listeners like Chrome does. Every mutating call is logged
** so tests can assert on side effects.
*/
const clone = value => (value === undefined ? undefined : structuredClone(value));

function event() {
  const listeners = [];
  return {
    listeners,
    addListener: fn => listeners.push(fn),
    emit: (...args) => listeners.map(fn => fn(...args)),
  };
}

/*
** page(args, details) plays the role of museRpc inside the tab: it receives
** the args passed to executeScript and returns the injection result (or
** throws/never resolves to simulate failures).
*/
export function fakeChrome({ store = {}, tabs = [], page = () => ({ ok: true, pending: [] }), messages = {} } = {}) {
  const data = clone(store);
  const log = { scripts: [], injected: [], updates: [], reloads: [], alarms: [], sent: [] };
  const alarms = {};
  const onChanged = event();

  const chrome = {
    runtime: {
      id: 'test-extension',
      onMessage: event(),
      onInstalled: event(),
      getURL: path => `chrome-extension://test/${path}`,
      sendMessage: async message => {
        log.sent.push(message);
        return chrome.runtime.reply?.(message);
      },
    },
    storage: {
      onChanged,
      local: {
        get: async keys => {
          const result = {};
          for (const key of [keys].flat()) if (key in data) result[key] = clone(data[key]);
          return result;
        },
        set: async patch => {
          const changes = {};
          for (const [key, value] of Object.entries(patch)) {
            changes[key] = { oldValue: clone(data[key]), newValue: clone(value) };
            data[key] = clone(value);
          }
          onChanged.emit(changes, 'local');
        },
      },
    },
    tabs: {
      get: async id => {
        const tab = tabs.find(t => t.id === id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return clone(tab);
      },
      query: async () => clone(tabs),
      update: async (id, props) => {
        log.updates.push({ id, ...props });
        const tab = tabs.find(t => t.id === id);
        if (tab?.failUpdate) throw new Error('update failed');
      },
      reload: async id => {
        log.reloads.push(id);
        if (tabs.find(t => t.id === id)?.failReload) throw new Error('reload failed');
      },
    },
    scripting: {
      executeScript: async details => {
        if (details.files) {
          log.injected.push(details.target.tabId);
          if (tabs.find(t => t.id === details.target.tabId)?.failInject) throw new Error('inject failed');
          return [];
        }
        const args = clone(details.args[0]);
        log.scripts.push(args);
        return page(args, details);
      },
    },
    alarms: {
      onAlarm: event(),
      get: async name => clone(alarms[name]),
      create: (name, info) => {
        alarms[name] = { name, ...info };
        log.alarms.push(name);
      },
    },
    i18n: {
      getMessage: key => messages[key] ?? '',
    },
  };
  return { chrome, data, log, alarms };
}

/*
** Deterministic timers and clock. Nothing fires until the test calls
** fire() or flush().
*/
export function fakeTimers(start = 1_000_000) {
  let current = start;
  let nextId = 1;
  const pending = new Map();
  return {
    now: () => current,
    advance: ms => { current += ms; },
    setTimeout: (fn, ms = 0) => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout: id => { pending.delete(id); },
    setInterval: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { fn, ms, repeat: true });
      return id;
    },
    pending: () => [...pending.values()],
    /* Run every pending timer whose delay equals ms (or all when omitted). */
    fire(ms) {
      for (const [id, timer] of [...pending]) {
        if (ms !== undefined && timer.ms !== ms) continue;
        if (!timer.repeat) pending.delete(id);
        timer.fn();
      }
    },
  };
}

/* Let queued promise callbacks run. */
export const settle = () => new Promise(resolve => setImmediate(resolve));
