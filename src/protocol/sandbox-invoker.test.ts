/**
 * The worker-thread invoker: fidelity to the live sandbox, containment, and
 * the deadline. Runs on Node's built-in runner:
 *   pnpm tsx --test src/protocol/sandbox-invoker.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildSandboxInvoker, FITNESS_INVOCATION_TIMEOUT_MS, type SandboxInvoker } from './sandbox-invoker.js';
import { evaluate, type CallStub, type InvocationRecording } from './fitness.js';
import { SANDBOX_BUILTIN_NAMES, HANDLER_PROXY_BUILTINS } from '../core/sandbox.js';

const invokers: SandboxInvoker[] = [];
function invoker(opts?: { timeoutMs?: number }): SandboxInvoker {
  const inv = buildSandboxInvoker(opts);
  invokers.push(inv);
  return inv;
}
after(() => { for (const inv of invokers) inv.dispose(); });

const httpReply = { status: 200, statusText: 'OK', headers: {}, body: '[{"id":1},{"id":2}]', ok: true };
const recording: InvocationRecording = {
  method: 'listEvents', argsText: '{"q":"all"}',
  calls: [{ target: 'HttpClient', method: 'get', payloadText: '{"url":"https://example.test/events?q=all"}',
    replyText: JSON.stringify(httpReply) }],
  resultText: '[1,2]', at: 1,
};
const noCalls: CallStub = () => undefined;

/** The dialect an LLM actually writes: a parenthesized handler map, a thin
 *  handler over a private helper reached through `this`, a dep() lookup,
 *  the response checked with `res.ok` and parsed out of the raw body. */
const HOUSE_STYLE = `({
  async listEvents(msg) {
    const http = await this.dep('HttpClient');
    const res = await this.call(http, 'get', { url: 'https://example.test/events?q=' + msg.payload.q });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return this.ids(JSON.parse(res.body));
  },
  ids(rows) { return rows.filter(r => r.id > 0).map(r => r.id); }
})`;

test('end to end in the house dialect, through the real worker', async () => {
  const v = await evaluate({ source: HOUSE_STYLE }, { invocations: [recording] }, invoker());
  assert.equal(v.pass, true, v.summary);
  assert.equal(v.replay.verified, true);
  assert.equal(v.replay.reproduced, 1);
});

test('a bare-brace handler map is accepted too', async () => {
  const bare = `{ async listEvents(msg) { const r = await call('HttpClient', 'get', { url: 'https://example.test/events?q=' + msg.payload.q }); return JSON.parse(r.body).map(x => x.id); } }`;
  const out = await invoker()(bare, 'listEvents', { q: 'all' }, req =>
    req.target === 'HttpClient' ? { replyText: JSON.stringify(httpReply) } : undefined);
  assert.deepEqual(out, [1, 2]);
});

test('the worker builds its builtins from the runtime list, and every name resolves', async () => {
  const probe = `({ names() { return [${SANDBOX_BUILTIN_NAMES.map(n => `typeof ${n}`).join(', ')}]; } })`;
  const types = await invoker()(probe, 'names', {}, noCalls) as string[];
  assert.equal(types.length, SANDBOX_BUILTIN_NAMES.length);
  for (const [i, t] of types.entries()) assert.notEqual(t, 'undefined', `${SANDBOX_BUILTIN_NAMES[i]} missing in the worker`);
});

test('what the live sandbox withholds, the worker withholds', async () => {
  const probe = `({ leak() { return [typeof process, typeof require, typeof fetch, typeof Buffer]; } })`;
  assert.deepEqual(await invoker()(probe, 'leak', {}, noCalls), ['undefined', 'undefined', 'undefined', 'undefined']);
});

test('the proxy carries exactly the members the runtime proxy carries, and user members never shadow them', async () => {
  const probe = `({
    call() { return 'shadowed'; },
    members() { return Object.keys(this).sort(); },
    async check() {
      this.ensure(typeof this.id === 'string', 'id');
      this.invariant(this.data && typeof this.data === 'object', 'data');
      this.data.seen = true; await this.saveData();
      await this.emit('Somewhere', 'looked', {}); this.changed('items'); await this.observe('Somewhere');
      return typeof this.call === 'function' && (await this.call('X', 'y').catch(e => e.message));
    }
  })`;
  const members = await invoker()(probe, 'members', {}, noCalls) as string[];
  for (const m of HANDLER_PROXY_BUILTINS) assert.ok(members.includes(m), `proxy lacks ${m}`);
  assert.ok(members.includes('members') && members.includes('check'));
  const out = await invoker()(probe, 'check', {}, noCalls);
  assert.match(String(out), /unrecorded call -- call\('X', 'y'\)/, 'the user `call` did not shadow the builtin');
});

test('ensure/invariant breaches surface as the runtime names them', async () => {
  await assert.rejects(() => invoker()(`({ f() { this.ensure(false, 'nope'); } })`, 'f', {}, noCalls),
    /ContractViolation \(ensure\): nope/);
});

test('a missing handler is an error, and the wildcard handler is honoured', async () => {
  await assert.rejects(() => invoker()(`({ a() { return 1; } })`, 'b', {}, noCalls), /no handler for 'b'/);
  assert.equal(await invoker()(`({ '*'(msg) { return msg.routing.method; } })`, 'anything', {}, noCalls), 'anything');
});

test('a synchronous spin is killed by the deadline, not waited on', async () => {
  const started = Date.now();
  await assert.rejects(() => invoker({ timeoutMs: 300 })(`({ f() { while (true) {} } })`, 'f', {}, noCalls), /invocation timeout/);
  assert.ok(Date.now() - started < 4000);
});

test('a spin AFTER awaiting a stubbed call is killed as well', async () => {
  const spin = `({ async f() { await call('HttpClient', 'get', { url: 'x' }); while (true) {} } })`;
  await assert.rejects(() => invoker({ timeoutMs: 300 })(spin, 'f', {},
    () => ({ replyText: JSON.stringify(httpReply) })), /invocation timeout/);
});

test('a candidate that legitimately uses timers is judged, not killed', async () => {
  const out = await invoker({ timeoutMs: 3000 })(`({ async f() { await new Promise(r => setTimeout(r, 10)); return 'done'; } })`, 'f', {}, noCalls);
  assert.equal(out, 'done');
});

test('the worker survives one job and answers the next', async () => {
  const inv = invoker();
  assert.equal(await inv(`({ f(msg) { return msg.payload.n * 2; } })`, 'f', { n: 2 }, noCalls), 4);
  assert.equal(await inv(`({ f(msg) { return msg.payload.n * 3; } })`, 'f', { n: 2 }, noCalls), 6);
});

test('the prompt-taught promise target is awaited: the stub sees the resolved name, not [object Promise]', async () => {
  // ObjectCreator's prompt tells generated code to write
  // `await this.call(this.dep('Name'), method, payload)`; dep() resolves to a
  // Promise, so the harness call must await the target before stubbing it.
  const src = `({ async load(msg) { return await this.call(this.dep('Storage'), 'get', { key: msg.payload.key }); } })`;
  const seen: string[] = [];
  const out = await invoker()(src, 'load', { key: 'k1' }, (req) => {
    seen.push(req.target);
    return req.target === 'Storage' ? { replyText: '"value"' } : undefined;
  });
  assert.equal(out, 'value', 'the promise target resolved to Storage and the recorded reply was served');
  assert.deepEqual(seen, ['Storage'], 'the stub saw the resolved name');
});

test('after a timeout the replacement worker answers, and the stale worker never rejects it', async () => {
  const inv = invoker({ timeoutMs: 200 });
  await assert.rejects(() => inv(`({ f() { while (true) {} } })`, 'f', {}, noCalls), /invocation timeout/);
  // The terminated worker's exit handler fires around now; it must touch only
  // its own (already-cleared) pending, never the job the next worker is running.
  assert.equal(await inv(`({ f(msg) { return msg.payload.n + 1; } })`, 'f', { n: 41 }, noCalls), 42);
});

test('the default deadline is the documented one', () => {
  assert.equal(FITNESS_INVOCATION_TIMEOUT_MS, 5000);
});
