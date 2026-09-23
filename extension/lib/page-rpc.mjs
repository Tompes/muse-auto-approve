/*
** Page-side half of the extension.
**
** museRpc() runs inside the Muse page (the MAIN world) through
** chrome.scripting.executeScript(). Chrome serializes the function source and
** evaluates it in the page, so the function must be fully self-contained:
** it may not reference imports, module-level constants or closures. Every
** helper and constant it needs is declared inside it.
**
** Trust boundary. The page is Muse's own code and holds the signed-in
** connection. This function exposes only three fixed RPC methods:
**
**     egress.approvals          list pending approvals (read-only)
**     egress.approval.decide    submit a decision
**     egress.approval           read back one approval (read-only)
**
** Nothing it returns contains approval payloads, request bodies, gateway
** addresses, exception text or credentials; only ids, types and status codes.
**
** Every exit path returns a plain object: { ok: true, ... } on success or
** { ok: false, code }. It never throws, so the worker does not have to
** distinguish page exceptions from protocol failures.
*/
export async function museRpc(input) {
  const MUSE_ORIGIN = 'https://muse.ai';
  const CHAT_SELECTOR = '[aria-label="Chat messages"]';
  const FIBER_PREFIX = '__reactFiber$';
  const MAX_FIBER_NODES = 30000;
  const WATCH_KEY = Symbol.for('muse-auto-approve.watch');
  const PUSH_EVENTS = ['approvals.snapshot', 'task.status'];
  const APPROVABLE_TYPES = [
    'network', 'connector', 'device', 'browser_action', 'browser_task_confirmation',
    'outgoing_media', 'browser_checkout', 'stripe_link_checkout', 'shopify_checkout',
  ];
  const GRANT_SCOPES = ['destination', 'destination_domain', 'entity', 'connector_all_actions', 'recipient'];

  const failure = code => ({ ok: false, code });

  if (input?.scope !== 'network' && input?.scope !== 'all') return failure('invalid_scope');
  if (location.origin !== MUSE_ORIGIN) return failure('wrong_origin');

  /*
  ** Return the RPC context value of the chat that is on screen, or null.
  **
  ** The page mounts several RPC providers at once, so taking the first one
  ** found could send a decision to the wrong conversation. Instead, start from
  ** the single chat-message container, find its fiber in the current React
  ** tree, and walk up to the nearest provider. A provider that exists but is
  ** not connected also yields null.
  */
  function findRpc() {
    const anchors = document.querySelectorAll(CHAT_SELECTOR);
    if (anchors.length !== 1) return null;
    const element = anchors[0];
    const key = Object.keys(element).find(k => k.startsWith(FIBER_PREFIX));
    let root = key ? element[key] : null;
    if (!root) return null;
    while (root.return) root = root.return;
    const current = root.stateNode?.current;
    if (!current) return null;

    const stack = [current];
    const seen = new Set();
    while (stack.length && seen.size < MAX_FIBER_NODES) {
      const node = stack.pop();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      if (node.stateNode === element) return nearestProvider(node);
      stack.push(node.child, node.sibling);
    }
    return null;
  }
  function nearestProvider(node) {
    for (let parent = node.return; parent; parent = parent.return) {
      const value = parent.memoizedProps?.value;
      if (isProvider(value)) {
        return value.isReady === true && value.connectionState === 'connected' ? value : null;
      }
    }
    return null;
  }
  function isProvider(value) {
    return !!value && typeof value.sendRequest === 'function' &&
      typeof value.ensureLiveConnection === 'function' &&
      typeof value.onEvent === 'function' && !!value.gatewayUrl;
  }
  const targetKey = rpc => JSON.stringify([rpc.gatewayUrl, rpc.vmName ?? null]);

  /*
  ** Keep exactly one push subscription, attached to the current provider.
  ** When the provider changes (another chat, a reconnect) the old
  ** subscription is removed first. The wake message carries no data: the
  ** worker always re-reads and re-validates through RPC before acting.
  */
  function watch(rpc) {
    const previous = globalThis[WATCH_KEY];
    if (previous?.rpc === rpc) return;
    try { previous?.off(); } catch { /* A stale provider may already be torn down. */ }
    const wake = () => globalThis.postMessage({ source: 'muse-auto-approve', type: 'wake' }, MUSE_ORIGIN);
    const offs = PUSH_EVENTS.map(name => rpc.onEvent(name, wake));
    globalThis[WATCH_KEY] = {
      rpc,
      off: () => { for (const off of offs) if (typeof off === 'function') off(); },
    };
  }

  /* Reduce the list response to the fields this extension relies on. */
  function pendingApprovals(response) {
    if (!Array.isArray(response?.pending_approvals)) throw new Error('unsupported_schema');
    return response.pending_approvals.filter(a => a?.status === 'pending').map(a => ({
      id: a.approval_id,
      type: a.payload?.type,
      expires: a.request_expires_at_ms,
      options: Array.isArray(a.decision_options) ? a.decision_options.filter(o => o && typeof o === 'object') : [],
    }));
  }

  /*
  ** Return the decision fields to submit for approval a under the given
  ** scope, or null if it must not be approved automatically.
  **
  ** Prefer the long-term grant the server itself offers, with the server's
  ** own scope; never invent or widen a scope. Otherwise allow once.
  */
  function decisionFor(a, scope) {
    if (typeof a.id !== 'string' || !a.id) return null;
    if (a.expires != null && a.expires <= Date.now()) return null;
    if (scope === 'network' && a.type !== 'network') return null;
    if (!APPROVABLE_TYPES.includes(a.type)) return null;
    const always = a.options.find(o => o.kind === 'allow_always' &&
      o.label?.kind === 'allow_always_scoped' && GRANT_SCOPES.includes(o.label.scope));
    if (always) {
      const grant = always.label.scope;
      return { decision: 'allow_always', always_scope: grant, allow_always_scope: grant };
    }
    if (a.options.some(o => o.kind === 'allow_once')) return { decision: 'allow_once' };
    return null;
  }

  let rpc = null;
  try { rpc = findRpc(); } catch { /* An unexpected page structure is treated as no connection. */ }
  if (!rpc) return failure('rpc_unavailable_or_ambiguous');
  try { watch(rpc); } catch { /* Push is an optimization; polling still works. */ }

  // Capture the transport once: the checks below compare against these
  // values, not against whatever the provider object holds later.
  const target = targetKey(rpc);
  const send = rpc.sendRequest;
  const request = (method, body) => send.call(rpc, method, body, { expectedTargetKey: target });
  const isApproved = (response, id) =>
    response?.approval?.approval_id === id && response.approval.status === 'approved';

  try {
    const pending = pendingApprovals(await request('egress.approvals', {}));
    if (input.operation === 'list') {
      return {
        ok: true,
        pending: pending.map(a => ({ id: a.id, type: a.type, eligible: decisionFor(a, input.scope) !== null })),
      };
    }
    if (input.operation !== 'decide') return failure('unknown_operation');

    const approval = pending.find(a => a.id === input.approvalId);
    if (!approval) return { ok: true, status: 'no_longer_pending' };
    const decision = decisionFor(approval, input.scope);
    if (!decision) return failure('unsupported_decision');

    // The chat may have switched while the list request was in flight.
    const current = findRpc();
    if (!current || targetKey(current) !== target || current.sendRequest !== send) {
      return failure('gateway_changed');
    }
    // A tab that was suspended mid-run must not act on a stale authorization.
    if (!Number.isFinite(input.authorizedUntil) || Date.now() > input.authorizedUntil) {
      return failure('authorization_expired');
    }

    const response = await request('egress.approval.decide', {
      approval_id: approval.id, ...decision, notification_channel: 'ui',
    });
    // A vanished card is not proof of approval: it may have expired or been
    // denied elsewhere. Only an explicit 'approved' status counts.
    if (isApproved(response, approval.id) ||
        isApproved(await request('egress.approval', { approval_id: approval.id }), approval.id)) {
      return { ok: true, status: 'approved', decision: decision.decision };
    }
    return failure('approval_not_confirmed');
  } catch {
    return failure('rpc_failed');
  }
}
