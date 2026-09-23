# Muse approval protocol notes

These notes describe the parts of Muse's private web-client protocol that the extension relies on. They were derived from the JavaScript bundles Muse serves publicly to every visitor and from observing the extension's own read-only calls. Nothing here is an official or stable API: bundle names, method names and fields can change with any Muse deployment.

No cookies, sign-in tickets, device keys or encryption material were extracted, and the extension does not need any.

## Transport

The Muse web client talks to a per-user gateway over an encrypted WebSocket (`Noise_XX_25519_AESGCM_SHA256`, protobuf framing, VM attestation). In the page, a React context provider (`HatchRpcProvider`) wraps that channel and exposes:

| Field | Meaning |
| --- | --- |
| `sendRequest(method, body, options)` | Send an RPC request; returns a promise of the decoded reply. |
| `onEvent(name, handler)` | Subscribe to a server push; returns an unsubscribe function. |
| `isReady`, `connectionState` | `true` and `'connected'` when requests can be sent. |
| `gatewayUrl`, `vmName` | Identify the target. `JSON.stringify([gatewayUrl, vmName])` is the target key. |
| `ensureLiveConnection()` | Reconnect if needed. |

`options.expectedTargetKey` makes the client reject a request if the connection has meanwhile switched to another target. The extension passes it on every call.

A page can mount several providers at once (one per open conversation), so the extension locates the provider that encloses the chat-message container on screen rather than taking the first one it finds.

Reimplementing this transport outside the browser would require the sign-in ticket flow, device and VM trust, the Noise handshake and frame codec. The extension deliberately does not do this; it only reuses the page's existing, already-authenticated provider.

## Methods

### `egress.approvals` (read-only)

```js
sendRequest('egress.approvals', {}, { expectedTargetKey })
```

The reply contains `pending_approvals`, `recent_approvals`, `next_cursor`, `schema_version` and `emitted_at_ms` (plus older `pending`/`recent` aliases). Each pending approval has:

| Field | Example |
| --- | --- |
| `approval_id` | opaque string |
| `status` | `'pending'` |
| `request_expires_at_ms` | epoch milliseconds, may be absent |
| `payload.type` | `'network'`, `'connector'`, `'device'`, `'browser_action'`, `'browser_task_confirmation'`, `'outgoing_media'`, `'browser_checkout'`, `'stripe_link_checkout'`, `'shopify_checkout'` |
| `decision_options` | the choices the server offers, see below |

A typical network request offers:

```json
[
  { "kind": "allow_once", "label": { "kind": "allow_once" } },
  { "kind": "allow_always", "label": { "kind": "allow_always_scoped", "scope": "destination" } },
  { "kind": "deny", "label": { "kind": "deny" } }
]
```

### `egress.approval.decide`

```js
sendRequest('egress.approval.decide', {
  approval_id,
  decision: 'allow_always',          // or 'allow_once'
  always_scope: 'destination',       // only with allow_always
  allow_always_scope: 'destination', // only with allow_always
  notification_channel: 'ui',
}, { expectedTargetKey })
```

The reply's `approval` object carries the resulting `status`. The web client also accepts optional `reason` and `expires_at_ms`; the extension never sets them. The scope is always copied from the option the server offered, never chosen by the extension.

### `egress.approval` (read-only)

```js
sendRequest('egress.approval', { approval_id }, { expectedTargetKey })
```

Returns one approval. The extension uses it to confirm a decision when the `decide` reply is inconclusive, and treats only `status === 'approved'` for the same id as success. A request that merely disappeared from the pending list may have expired or been denied, so it is never counted as approved.

## Push events

The web client's approvals view subscribes to:

| Event | Meaning |
| --- | --- |
| `approvals.snapshot` | A full snapshot of the approvals list after any change. |
| `task.status`, `agent.status`, `activity.updated` | Hints that approval state may have changed. |

The extension subscribes to `approvals.snapshot` and `task.status` and uses them only as a signal to re-query; the event payloads are not read.

## Not used

The bundles also reference RPCs that change global permission policy. Their semantics were not verified, and the extension does not call them.
