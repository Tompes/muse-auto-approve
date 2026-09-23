import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { museRpc } from '../extension/lib/page-rpc.mjs';

const WATCH_KEY = Symbol.for('muse-auto-approve.watch');
const GATEWAY = 'wss://gateway.invalid/v1/noise';
const FUTURE = () => Date.now() + 60_000;

const approval = (overrides = {}) => ({
  approval_id: 'ap-1',
  status: 'pending',
  request_expires_at_ms: FUTURE(),
  payload: { type: 'network' },
  decision_options: [
    { kind: 'allow_once', label: { kind: 'allow_once' } },
    { kind: 'allow_always', label: { kind: 'allow_always_scoped', scope: 'destination' } },
    { kind: 'deny', label: { kind: 'deny' } },
  ],
  ...overrides,
});

/*
** A connected RPC provider. `responses` maps a method name to its reply
** (a value, or a function of the body). Every request is logged.
*/
function provider({ responses = {}, ...fields } = {}) {
  const calls = [];
  const subscriptions = [];
  const rpc = {
    gatewayUrl: GATEWAY,
    vmName: 'vm-1',
    isReady: true,
    connectionState: 'connected',
    ensureLiveConnection() {},
    onEvent(name, handler) {
      const subscription = { name, handler, active: true };
      subscriptions.push(subscription);
      return () => { subscription.active = false; };
    },
    async sendRequest(method, body, options) {
      calls.push({ method, body, options });
      const reply = responses[method];
      return typeof reply === 'function' ? reply(body) : reply;
    },
    ...fields,
  };
  return { rpc, calls, subscriptions };
}

/*
** Build the React structure museRpc walks: a root fiber whose stateNode
** points at the current tree; inside it, provider fibers wrapping the fiber
** of the chat-message element.
*/
function page(rpc, {
  ancestors = [{ memoizedProps: { value: rpc } }],
  extraAnchors = 0,
  fiberKey = '__reactFiber$abc',
} = {}) {
  const element = {};
  const root = { stateNode: null, child: null, return: null };
  const current = { child: null, sibling: null, return: null };
  root.stateNode = { current };
  let parent = current;
  for (const fields of ancestors) {
    const fiber = { ...fields, return: parent, child: null, sibling: null };
    parent.child = fiber;
    parent = fiber;
  }
  const target = { stateNode: element, return: parent, child: null, sibling: null };
  parent.child = target;
  if (fiberKey) element[fiberKey] = { return: { return: root } };
  const anchors = [element, ...Array.from({ length: extraAnchors }, () => ({}))];
  return { element, root, current, anchors };
}

let posted;
let anchors;
const saved = {};

beforeEach(() => {
  posted = [];
  anchors = [];
  for (const key of ['document', 'location', 'postMessage']) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  }
  globalThis.document = { querySelectorAll: selector => (selector === '[aria-label="Chat messages"]' ? anchors : []) };
  globalThis.location = { origin: 'https://muse.ai' };
  globalThis.postMessage = (data, origin) => posted.push({ data, origin });
  delete globalThis[WATCH_KEY];
});
afterEach(() => {
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  delete globalThis[WATCH_KEY];
});

function mount(options = {}, pageOptions) {
  const p = provider(options);
  anchors = page(p.rpc, pageOptions).anchors;
  return p;
}
const list = (scope = 'network') => museRpc({ operation: 'list', scope });
const decide = (overrides = {}) => museRpc({
  operation: 'decide', approvalId: 'ap-1', scope: 'network', authorizedUntil: Date.now() + 5000, ...overrides,
});

describe('input validation', () => {
  test('rejects unknown scopes and missing input before touching the page', async () => {
    const p = mount();
    for (const input of [undefined, null, {}, { scope: 'everything' }]) {
      assert.deepEqual(await museRpc(input), { ok: false, code: 'invalid_scope' });
    }
    assert.deepEqual(p.calls, []);
  });

  test('refuses to run on any other origin', async () => {
    const p = mount();
    globalThis.location = { origin: 'https://example.com' };
    assert.deepEqual(await list(), { ok: false, code: 'wrong_origin' });
    assert.deepEqual(p.calls, []);
  });

  test('rejects unknown operations after listing', async () => {
    const p = mount({ responses: { 'egress.approvals': { pending_approvals: [] } } });
    const result = await museRpc({ operation: 'drop_tables', scope: 'network' });
    assert.deepEqual(result, { ok: false, code: 'unknown_operation' });
    assert.deepEqual(p.calls.map(c => c.method), ['egress.approvals']);
  });
});

describe('locating the chat provider', () => {
  const unavailable = { ok: false, code: 'rpc_unavailable_or_ambiguous' };

  test('requires exactly one chat container', async () => {
    mount({}, { extraAnchors: 1 });
    assert.deepEqual(await list(), unavailable);
    anchors = [];
    assert.deepEqual(await list(), unavailable);
  });

  test('requires a React fiber on the container', async () => {
    mount({}, { fiberKey: null });
    assert.deepEqual(await list(), unavailable);
    anchors[0].__reactFiber$x = null;
    assert.deepEqual(await list(), unavailable);
  });

  test('requires a mounted root', async () => {
    const p = provider();
    const built = page(p.rpc);
    built.root.stateNode = null;
    anchors = built.anchors;
    assert.deepEqual(await list(), unavailable);
  });

  test('fails when the container is not in the current tree', async () => {
    const p = provider();
    const built = page(p.rpc);
    built.current.child = { child: null, sibling: null };
    anchors = built.anchors;
    assert.deepEqual(await list(), unavailable);
  });

  test('survives cycles in the tree', async () => {
    const p = provider({ responses: { 'egress.approvals': { pending_approvals: [] } } });
    const built = page(p.rpc);
    const loop = { child: null, sibling: null };
    loop.child = loop;
    built.current.child.sibling = loop;
    anchors = built.anchors;
    assert.equal((await list()).ok, true);
  });

  test('gives up on trees larger than the node budget', async () => {
    const p = provider();
    const built = page(p.rpc);
    let node = built.current;
    for (let i = 0; i < 30_001; i++) {
      node.sibling = { child: null, sibling: null };
      node = node.sibling;
    }
    // Put the real subtree after the long sibling chain so the walk never reaches it.
    const real = built.current.child;
    built.current.child = null;
    node.sibling = real;
    anchors = built.anchors;
    assert.deepEqual(await list(), unavailable);
  });

  test('uses the nearest provider, skipping unrelated context values', async () => {
    const near = provider({ responses: { 'egress.approvals': { pending_approvals: [] } } });
    const far = provider({ gatewayUrl: 'wss://other.invalid' });
    anchors = page(near.rpc, {
      ancestors: [
        { memoizedProps: { value: far.rpc } },
        { memoizedProps: { value: near.rpc } },
        { memoizedProps: { value: { sendRequest() {} } } },
        { memoizedProps: null },
      ],
    }).anchors;
    await list();
    assert.equal(near.calls.length, 1);
    assert.equal(far.calls.length, 0);
  });

  test('a provider without a gateway is not a provider', async () => {
    const p = provider({ gatewayUrl: null });
    anchors = page(p.rpc).anchors;
    assert.deepEqual(await list(), unavailable);
  });

  test('refuses a provider that is not connected', async () => {
    for (const fields of [{ isReady: false }, { connectionState: 'reconnecting' }]) {
      const p = mount(fields);
      assert.deepEqual(await list(), unavailable);
      assert.deepEqual(p.calls, []);
    }
  });

  test('an unexpected page structure counts as no connection', async () => {
    mount();
    Object.defineProperty(anchors[0], '__reactFiber$boom', { enumerable: true, get() { throw new Error('boom'); } });
    delete anchors[0].__reactFiber$abc;
    assert.deepEqual(await list(), unavailable);
  });
});

describe('push subscription', () => {
  const responses = { 'egress.approvals': { pending_approvals: [] } };

  test('subscribes once per provider and posts a data-free wake message', async () => {
    const p = mount({ responses });
    await list();
    await list();
    assert.deepEqual(p.subscriptions.map(s => s.name), ['approvals.snapshot', 'task.status']);
    p.subscriptions[0].handler({ pending_approvals: [approval()] });
    assert.deepEqual(posted, [{ data: { source: 'muse-auto-approve', type: 'wake' }, origin: 'https://muse.ai' }]);
  });

  test('moves to a new provider and unsubscribes from the old one', async () => {
    const first = mount({ responses });
    await list();
    const second = mount({ responses });
    await list();
    assert.deepEqual(first.subscriptions.map(s => s.active), [false, false]);
    assert.deepEqual(second.subscriptions.map(s => s.active), [true, true]);
  });

  test('tolerates providers that return no unsubscribe function or fail to unsubscribe', async () => {
    mount({ responses, onEvent: () => undefined });
    await list();
    globalThis[WATCH_KEY].off();
    globalThis[WATCH_KEY].off = () => { throw new Error('already torn down'); };
    const next = mount({ responses });
    await list();
    assert.equal(next.subscriptions.length, 2);
  });

  test('a failing subscription does not block listing', async () => {
    mount({ responses, onEvent: () => { throw new Error('not ready'); } });
    assert.equal((await list()).ok, true);
  });
});

describe('list', () => {
  test('returns only ids, types and eligibility', async () => {
    const pending = [
      approval(),
      approval({ approval_id: 'ap-2', payload: { type: 'connector' } }),
      approval({ approval_id: 'ap-3', status: 'approved' }),
      null,
    ];
    const p = mount({ responses: { 'egress.approvals': { pending_approvals: pending } } });
    assert.deepEqual(await list(), {
      ok: true,
      pending: [
        { id: 'ap-1', type: 'network', eligible: true },
        { id: 'ap-2', type: 'connector', eligible: false },
      ],
    });
    assert.deepEqual(p.calls, [{
      method: 'egress.approvals', body: {}, options: { expectedTargetKey: JSON.stringify([GATEWAY, 'vm-1']) },
    }]);
  });

  test('the all scope accepts every known type but no unknown ones', async () => {
    const types = ['connector', 'device', 'browser_action', 'browser_task_confirmation', 'outgoing_media',
      'browser_checkout', 'stripe_link_checkout', 'shopify_checkout', 'teleport'];
    const pending = types.map(type => approval({ approval_id: type, payload: { type } }));
    mount({ responses: { 'egress.approvals': { pending_approvals: pending } } });
    const result = await list('all');
    assert.deepEqual(result.pending.filter(a => a.eligible).map(a => a.id), types.slice(0, -1));
  });

  test('ineligible: malformed ids, expired requests, missing payloads and missing choices', async () => {
    const pending = [
      approval({ approval_id: 42 }),
      approval({ approval_id: '' }),
      approval({ approval_id: 'expired', request_expires_at_ms: Date.now() - 1 }),
      approval({ approval_id: 'no-payload', payload: undefined }),
      approval({ approval_id: 'deny-only', decision_options: [{ kind: 'deny' }] }),
      approval({ approval_id: 'no-options', decision_options: 'allow' }),
    ];
    mount({ responses: { 'egress.approvals': { pending_approvals: pending } } });
    assert.deepEqual((await list('all')).pending.map(a => a.eligible), [false, false, false, false, false, false]);
  });

  test('a request without an expiry is eligible', async () => {
    mount({ responses: { 'egress.approvals': { pending_approvals: [approval({ request_expires_at_ms: null })] } } });
    assert.equal((await list()).pending[0].eligible, true);
  });

  test('an unexpected response schema fails closed', async () => {
    for (const reply of [undefined, {}, { pending_approvals: 'none' }]) {
      mount({ responses: { 'egress.approvals': reply } });
      assert.deepEqual(await list(), { ok: false, code: 'rpc_failed' });
    }
  });

  test('a provider without a VM name binds to a null VM', async () => {
    const p = mount({ vmName: undefined, responses: { 'egress.approvals': { pending_approvals: [] } } });
    await list();
    assert.equal(p.calls[0].options.expectedTargetKey, JSON.stringify([GATEWAY, null]));
  });
});

describe('decide', () => {
  const approved = { approval: { approval_id: 'ap-1', status: 'approved' } };
  const responses = (overrides = {}) => ({
    'egress.approvals': { pending_approvals: [approval()] },
    'egress.approval.decide': approved,
    ...overrides,
  });

  test('uses the long-term grant offered by the server, with its scope', async () => {
    const p = mount({ responses: responses() });
    assert.deepEqual(await decide(), { ok: true, status: 'approved', decision: 'allow_always' });
    assert.deepEqual(p.calls[1], {
      method: 'egress.approval.decide',
      body: {
        approval_id: 'ap-1', decision: 'allow_always', always_scope: 'destination',
        allow_always_scope: 'destination', notification_channel: 'ui',
      },
      options: { expectedTargetKey: JSON.stringify([GATEWAY, 'vm-1']) },
    });
  });

  test('falls back to allow once without any scope field', async () => {
    const options = [
      null,
      { kind: 'allow_always', label: { kind: 'allow_always_scoped', scope: 'everything' } },
      { kind: 'allow_always', label: null },
      { kind: 'allow_once' },
    ];
    const pending = [approval({ decision_options: options })];
    const p = mount({ responses: responses({ 'egress.approvals': { pending_approvals: pending } }) });
    assert.equal((await decide()).decision, 'allow_once');
    assert.deepEqual(p.calls[1].body, { approval_id: 'ap-1', decision: 'allow_once', notification_channel: 'ui' });
  });

  test('a request that is gone is reported without submitting', async () => {
    const p = mount({ responses: responses({ 'egress.approvals': { pending_approvals: [] } }) });
    assert.deepEqual(await decide(), { ok: true, status: 'no_longer_pending' });
    assert.equal(p.calls.length, 1);
  });

  test('never submits a request outside the scope', async () => {
    const pending = [approval({ payload: { type: 'connector' } })];
    const p = mount({ responses: responses({ 'egress.approvals': { pending_approvals: pending } }) });
    assert.deepEqual(await decide(), { ok: false, code: 'unsupported_decision' });
    assert.equal(p.calls.length, 1);
  });

  test('cancels when the chat switched to another gateway or VM during the list call', async () => {
    for (const change of [
      rpc => { rpc.vmName = 'vm-2'; },
      rpc => { rpc.gatewayUrl = 'wss://other.invalid'; },
      rpc => { rpc.sendRequest = async () => approved; },
      rpc => { rpc.connectionState = 'reconnecting'; },
    ]) {
      const p = provider();
      p.rpc.sendRequest = async (method, body, options) => {
        p.calls.push({ method, body, options });
        change(p.rpc);
        return { pending_approvals: [approval()] };
      };
      anchors = page(p.rpc).anchors;
      assert.deepEqual(await decide(), { ok: false, code: 'gateway_changed' });
      assert.equal(p.calls.length, 1);
    }
  });

  test('refuses a stale or missing authorization', async () => {
    for (const authorizedUntil of [Date.now() - 1, undefined, Number.NaN, Infinity]) {
      const p = mount({ responses: responses() });
      assert.deepEqual(await decide({ authorizedUntil }), { ok: false, code: 'authorization_expired' });
      assert.equal(p.calls.length, 1);
    }
  });

  test('confirms through a read-back when the decide reply is inconclusive', async () => {
    const p = mount({
      responses: responses({
        'egress.approval.decide': {},
        'egress.approval': body => ({ approval: { approval_id: body.approval_id, status: 'approved' } }),
      }),
    });
    assert.deepEqual(await decide(), { ok: true, status: 'approved', decision: 'allow_always' });
    assert.deepEqual(p.calls[2].body, { approval_id: 'ap-1' });
  });

  test('a vanished, expired or foreign result is not success', async () => {
    for (const reply of [
      undefined,
      { approval: { approval_id: 'ap-1', status: 'timed_out' } },
      { approval: { approval_id: 'someone-else', status: 'approved' } },
    ]) {
      mount({ responses: responses({ 'egress.approval.decide': reply, 'egress.approval': reply }) });
      assert.deepEqual(await decide(), { ok: false, code: 'approval_not_confirmed' });
    }
  });

  test('a failing request reports only a code', async () => {
    mount({ responses: responses({ 'egress.approval.decide': () => { throw new Error(`secret ${GATEWAY}`); } }) });
    assert.deepEqual(await decide(), { ok: false, code: 'rpc_failed' });
  });
});

test('is self-contained, so it survives serialization into the page', async () => {
  const p = provider({ responses: { 'egress.approvals': { pending_approvals: [approval()] } } });
  const context = vm.createContext({
    document: { querySelectorAll: () => page(p.rpc).anchors },
    location: { origin: 'https://muse.ai' },
    postMessage() {},
    input: { operation: 'list', scope: 'network' },
  });
  const result = await vm.runInContext(`(${museRpc.toString()})(input)`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: true, pending: [{ id: 'ap-1', type: 'network', eligible: true }],
  });
});
