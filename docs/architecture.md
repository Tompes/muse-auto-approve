# Architecture

The extension has three execution contexts. Code in one context cannot call code in another directly; they communicate only by the messages shown below.

```
 Muse page (MAIN world)         Content script (isolated world)      Service worker
 ─────────────────────          ───────────────────────────────      ──────────────
 lib/page-rpc.mjs               content.js                           background.mjs
   museRpc(input)                 every 3 s ──── 'tick' ──────────▶    lib/worker.mjs
     finds the chat's RPC         on wake  ──── 'tick' (push) ────▶      run(tab)
     provider, lists and          ◀── window.postMessage('wake') ─┐        │
     decides approvals                                            │        │
     subscribes to pushes ────────────────────────────────────────┘        │
        ▲                                                                  │
        └──────── chrome.scripting.executeScript(museRpc, args) ───────────┘
                                                                    every 30 s: chrome.alarms scan

 Popup: popup.html + popup.mjs → lib/popup-view.mjs, lib/i18n.mjs
   reads and writes chrome.storage.local; sends 'probe' to the worker
```

## Files

| File | Context | Responsibility |
| --- | --- | --- |
| `extension/background.mjs` | worker | Entry point. Calls `createWorker(chrome).start()`. |
| `extension/lib/worker.mjs` | worker | Scheduling, settings, cooldowns, tab management, message handling. |
| `extension/lib/page-rpc.mjs` | page | `museRpc()`: the only code that touches Muse. Serialized into the page, so it must be self-contained. |
| `extension/content.js` | content script | Wakes the worker on a timer and on page push. Reads nothing. Classic script, because content scripts cannot be modules. |
| `extension/popup.mjs` | popup | Entry point. Calls `startPopup(...)`. |
| `extension/lib/popup-view.mjs` | popup | Renders storage, saves settings and language, runs the connection check. |
| `extension/lib/i18n.mjs` | popup | Loads `_locales` catalogs and translates, independent of the browser language. |

Entry points contain no logic. Everything else receives its browser APIs as arguments, so the test suite runs the real code against fakes.

## Storage

| Key | Writer | Shape |
| --- | --- | --- |
| `settings` | popup | `{ enabled: boolean, scope: 'network' \| 'all' }` |
| `language` | popup | `'auto'` or a locale code |
| `lastEvent` | worker | `{ status, code, params?, at }`. Codes and parameters only; the popup renders text. |
| `lastRun` | worker | `{ at, reason: 'push' \| 'poll' \| 'alarm' }` |

## Invariants

These are the properties the code is built to preserve. A change that weakens one needs a very good reason and a test that shows the new behavior.

1. **Only the user turns automatic approval on or off.** The worker never writes `settings.enabled`. Failures are recorded and retried, never "fixed" by switching off. The popup saves `enabled: true` only after the user accepts the risk confirmation, every time.
2. **Settings are read immediately before every submission.** Turning the switch off, or changing the scope, stops a batch between two approvals.
3. **One run at a time.** A trigger during a run schedules exactly one follow-up; triggers are never lost and never pile up.
4. **Only server-offered choices are submitted.** The decision and its scope are copied from `decision_options`. `allow_always` is used only with a scope from a fixed allow-list; otherwise `allow_once`; otherwise nothing.
5. **Submit only to the conversation that was listed.** Every request carries the target key captured when the provider was found; before deciding, the provider is located again and must still have the same target and transport.
6. **Authorizations expire.** Each decision carries `authorizedUntil`, five seconds ahead. A tab that was frozen between the worker's decision and the page's execution refuses it.
7. **Success means an explicit `approved` status.** A vanished approval is not proof of approval.
8. **A failed approval is not resubmitted for 60 seconds.** Other approvals in the same batch are unaffected.
9. **Nothing sensitive leaves the page.** `museRpc` returns ids, types and codes only: no payloads, request bodies, gateway addresses, exception messages or credentials.
10. **`museRpc` and `run` never throw.** Every failure is a `{ ok: false, code }` value that the caller records.

## Testing

The test suite is the specification. `npm test` fails unless line, branch and function coverage of `extension/lib/` and `extension/content.js` are all 100%. Coverage is a floor, not the goal: most tests exist to pin one invariant or one failure mode, and are named after it.

- `tests/helpers/fake-chrome.mjs` models the `chrome.*` APIs in memory, including `storage.onChanged` events, and a deterministic clock and timers.
- `tests/helpers/fake-dom.mjs` builds elements from the real `popup.html`, so the view is tested against the markup that ships.
- `tests/page-rpc.test.mjs` builds React fiber trees by hand and also evaluates `museRpc` from its source text in a fresh VM context, which fails if the function ever depends on something outside itself.
- `tests/i18n.test.mjs` checks that every locale has the same keys and placeholders, and that every code the extension can produce has a translation.
- `tests/project.test.mjs` checks the manifest: versions, referenced files, and the exact permission list.
- `tests/release.test.mjs` covers the ZIP and CRX3 writers in `scripts/lib/`, including a CRX packed by Chrome itself as a fixture.

`npm run check` adds syntax checks, JSON validation and whitespace rules without any dependency.

Not covered by automated tests: real Chrome behavior (service-worker lifetime, tab discarding, background throttling) and Muse itself. Those are verified by hand; see the release checklist in `CONTRIBUTING.md`.
