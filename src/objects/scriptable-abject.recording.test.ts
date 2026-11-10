/**
 * ScriptableAbject emits one `invocation` event per handled request to the
 * CassetteRecorder it finds through the registry - and nothing when there is
 * no recorder to find.
 *   pnpm tsx --test src/objects/scriptable-abject.recording.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId, AbjectMessage, AbjectManifest } from '../core/types.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { ScriptableAbject, type InvocationEvent } from './scriptable-abject.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'fixture',
      interface: { id: `fixture:${name}`, name, description: 'fixture', methods: [] } } });
  }
  call<T = unknown>(to: AbjectId, method: string, payload: unknown = {}): Promise<T> {
    return this.request<T>(request(this.id, to, method, payload), 5000);
  }
}

/** Stands in for the recorder: keeps every invocation event it is sent. */
class FakeRecorder extends Endpoint {
  received: InvocationEvent[] = [];
  constructor() {
    super('CassetteRecorder');
    this.on('invocation', (m: AbjectMessage) => { this.received.push(m.payload as InvocationEvent); return true; });
  }
}

/** Stands in for HttpClient: answers `get` with a fixed body, `fail` with an error. */
class Echo extends Endpoint {
  constructor() {
    super('Echo');
    this.on('get', (m: AbjectMessage) => ({ ok: true, status: 200, body: JSON.stringify([{ id: 1 }, { id: 2 }]), q: (m.payload as { url: string }).url }));
    this.on('step', async (m: AbjectMessage) => {
      const { tag, step, delayMs } = m.payload as { tag: string; step: number; delayMs: number };
      await new Promise(r => setTimeout(r, delayMs));
      return { tag, step };
    });
    this.on('fail', () => { throw new Error('upstream refused'); });
  }
}

const manifest: AbjectManifest = { name: 'Calendar', version: '1', description: 'user object',
  interface: { id: 'user:calendar', name: 'Calendar', description: 'user object', methods: [
    { name: 'listEvents', description: '', parameters: [] },
    { name: 'interleave', description: '', parameters: [] },
    { name: 'boom', description: '', parameters: [] },
    { name: 'secretive', description: '', parameters: [] },
    { name: 'sync', description: '', parameters: [] },
    { name: 'tail', description: '', parameters: [] },
    { name: 'arms', description: '', parameters: [] },
    { name: 'emits', description: '', parameters: [] },
  ] } };

const SOURCE = `({
  async listEvents(msg) {
    const echo = await this.dep('Echo');
    const res = await this.call(echo, 'get', { url: 'https://x.test/events?q=' + msg.payload.q });
    return JSON.parse(res.body).map(e => e.id);
  },
  async interleave(msg) {
    const echo = await this.dep('Echo');
    const a = await this.call(echo, 'step', { tag: msg.payload.tag, step: 1, delayMs: msg.payload.d1 });
    const b = await this.call(echo, 'step', { tag: msg.payload.tag, step: 2, delayMs: msg.payload.d2 });
    return [a.tag + ':' + a.step, b.tag + ':' + b.step];
  },
  async boom(msg) {
    try { await this.call(await this.dep('Echo'), 'fail', {}); } catch (err) { throw new Error('boom: ' + err.message); }
  },
  async secretive(msg) { return { token: msg.payload.api_key, n: 1 }; },
  sync(msg) { return msg.payload.n + 1; },
  async tail(msg) {
    const echo = await this.dep('Echo');
    const res = await this.call(echo, 'get', { url: 'a' });
    void this.call(echo, 'step', { tag: 'late', step: 1, delayMs: 30 });
    return res.ok;
  },
  async arms(msg) {
    setTimeout(() => {}, 5);
    const res = await this.call(await this.dep('Echo'), 'get', { url: 'b' });
    return res.ok;
  },
  async emits(msg) {
    const res = await this.call(await this.dep('Echo'), 'get', { url: 'c' });
    this.emit(this.dep('Echo'), 'noted', { url: 'c' }); // not awaited, and its target still resolving
    return res.ok;
  }
})`;

async function fixture(withRecorder: boolean) {
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  const add = async <T extends Abject>(o: T): Promise<T> => {
    o.setRegistryHint(registry.id); await o.init(bus); registry.registerObject(o.id, o.manifest); objects.push(o); return o;
  };
  const recorder = withRecorder ? await add(new FakeRecorder()) : undefined;
  await add(new Echo());
  const client = await add(new Endpoint('Client'));
  const calendar = await add(new ScriptableAbject(manifest, SOURCE, client.id));
  const settle = () => new Promise(r => setTimeout(r, 30));
  return { recorder, client, calendar, settle, add, async stop() { for (const o of objects.reverse()) await o.stop(); } };
}

test('the first request discovers the recorder; from the second on, each request is recorded with its outbound calls', async () => {
  const f = await fixture(true);
  try {
    assert.deepEqual(await f.client.call(f.calendar.id, 'listEvents', { q: 'all' }), [1, 2]);
    await f.settle();
    assert.equal(f.recorder!.received.length, 0, 'discovery is kicked off, not awaited, on a path that must stay synchronous');
    assert.deepEqual(await f.client.call(f.calendar.id, 'listEvents', { q: 'mine' }), [1, 2]);
    await f.settle();
    assert.equal(f.recorder!.received.length, 1);
    const ev = f.recorder!.received[0];
    assert.equal(ev.caller, f.calendar.id);
    assert.equal(ev.method, 'listEvents');
    assert.equal(ev.argsText, '{"q":"mine"}');
    assert.equal(ev.resultText, '[1,2]');
    assert.equal(ev.calls.length, 1);
    assert.equal(ev.calls[0].method, 'get');
    assert.equal(ev.calls[0].payloadText, '{"url":"https://x.test/events?q=mine"}');
    assert.match(ev.calls[0].replyText!, /"body":"\[\{\\"id\\":1\},\{\\"id\\":2\}\]"/);
    assert.equal('errorText' in ev.calls[0], false);
    assert.equal(ev.truncated, undefined);
    assert.ok(typeof ev.durationMs === 'number' && ev.at > 0);
  } finally { await f.stop(); }
});

test('two handlers that overlap on one object are not recorded; the same handler alone is', async () => {
  const f = await fixture(true);
  try {
    await f.client.call(f.calendar.id, 'sync', { n: 1 }); // discovery
    await f.settle();
    const [rA, rB] = await Promise.all([
      f.client.call(f.calendar.id, 'interleave', { tag: 'A', d1: 25, d2: 5 }),
      f.client.call(f.calendar.id, 'interleave', { tag: 'B', d1: 5, d2: 25 }),
    ]);
    assert.deepEqual(rA, ['A:1', 'A:2']);
    assert.deepEqual(rB, ['B:1', 'B:2']);
    await f.settle();
    assert.equal(f.recorder!.received.filter(e => e.method === 'interleave').length, 0,
      'overlapping invocations could have traded calls, so neither is kept');
    assert.deepEqual(await f.client.call(f.calendar.id, 'interleave', { tag: 'C', d1: 5, d2: 5 }), ['C:1', 'C:2']);
    await f.settle();
    const evC = f.recorder!.received.filter(e => e.method === 'interleave');
    assert.equal(evC.length, 1);
    assert.deepEqual(evC[0].calls.map(c => JSON.parse(c.payloadText)), [
      { tag: 'C', step: 1, delayMs: 5 },
      { tag: 'C', step: 2, delayMs: 5 },
    ]);
  } finally { await f.stop(); }
});

test('an invocation during which the object made a call that is not in its trace is not recorded', async () => {
  const f = await fixture(true);
  try {
    await f.client.call(f.calendar.id, 'sync', { n: 1 }); // discovery
    await f.settle();
    // A call made outside any trace (as a timer's or a misattributed one would be) while listEvents runs.
    const p = f.client.call(f.calendar.id, 'interleave', { tag: 'A', d1: 40, d2: 5 });
    await new Promise(r => setTimeout(r, 15)); // interleave is now waiting on its first call
    await (f.calendar as any).tracedRequest(request(f.calendar.id, f.client.id, 'noop', {}), 500).catch(() => {});
    await p;
    await f.settle();
    assert.equal(f.recorder!.received.filter(e => e.method === 'interleave').length, 0);
    // The same handler with nothing else going on is recorded.
    await f.client.call(f.calendar.id, 'interleave', { tag: 'B', d1: 5, d2: 5 });
    await f.settle();
    assert.equal(f.recorder!.received.filter(e => e.method === 'interleave').length, 1);
  } finally { await f.stop(); }
});

test('a handler that throws is recorded with its error, and so is the outbound call that made it throw', async () => {
  const f = await fixture(true);
  try {
    await f.client.call(f.calendar.id, 'sync', { n: 1 }); // discovery
    await f.settle();
    await assert.rejects(() => f.client.call(f.calendar.id, 'boom', {}));
    await f.settle();
    const ev = f.recorder!.received.find(e => e.method === 'boom')!;
    assert.match(ev.errorText!, /boom: .*upstream refused/);
    assert.equal(ev.resultText, undefined);
    assert.equal(ev.calls[0].method, 'fail');
    assert.match(ev.calls[0].errorText!, /upstream refused/);
  } finally { await f.stop(); }
});

test('secret-named fields are redacted in arguments and results before the event leaves the object', async () => {
  const f = await fixture(true);
  try {
    await f.client.call(f.calendar.id, 'sync', { n: 1 });
    await f.settle();
    await f.client.call(f.calendar.id, 'secretive', { api_key: 'sk-live-123', n: 1 });
    await f.settle();
    const ev = f.recorder!.received.find(e => e.method === 'secretive')!;
    assert.equal(ev.argsText, '{"api_key":"REDACTED","n":1}');
    assert.equal(ev.resultText, '{"token":"REDACTED","n":1}');
  } finally { await f.stop(); }
});

test('a synchronous handler stays synchronous and is recorded too', async () => {
  const f = await fixture(true);
  try {
    await f.client.call(f.calendar.id, 'sync', { n: 1 });
    await f.settle();
    assert.equal(await f.client.call(f.calendar.id, 'sync', { n: 41 }), 42);
    await f.settle();
    const ev = f.recorder!.received.find(e => e.argsText === '{"n":41}')!;
    assert.equal(ev.resultText, '42');
    assert.deepEqual(ev.calls, []);
  } finally { await f.stop(); }
});

test('with no recorder registered, handlers run exactly as before and nothing is sent', async () => {
  const f = await fixture(false);
  try {
    for (let i = 0; i < 3; i++) assert.deepEqual(await f.client.call(f.calendar.id, 'listEvents', { q: 'all' }), [1, 2]);
    assert.equal(await f.client.call(f.calendar.id, 'sync', { n: 1 }), 2);
    // Nothing to assert on a recorder; the point is that the object never
    // stalled on discovery and its replies are unchanged.
  } finally { await f.stop(); }
});

test("a source's override of a system verb is not recorded; its own handlers still are", async () => {
  const f = await fixture(true);
  try {
    const m: AbjectManifest = { name: 'Notes', version: '1', description: 'user object',
      interface: { id: 'user:notes', name: 'Notes', description: 'user object', methods: [
        { name: 'count', description: '', parameters: [] },
      ] } };
    const notes = await f.add(new ScriptableAbject(m, `({
      count(msg) { return 3; },
      getUndoState(msg) { return { canUndo: false, own: true }; },
    })`, f.client.id));
    await f.client.call(notes.id, 'count', {}); // discovery
    await f.settle();
    assert.deepEqual(await f.client.call(notes.id, 'getUndoState', {}), { canUndo: false, own: true });
    assert.equal(await f.client.call(notes.id, 'count', {}), 3);
    await f.settle();
    assert.deepEqual(f.recorder!.received.filter(e => e.caller === notes.id).map(e => e.method), ['count']);
  } finally { await f.stop(); }
});

test('a request the object addresses to itself (as afterRestore does) is not recorded; the same handler called by another object is', async () => {
  const f = await fixture(true);
  try {
    await f.client.call(f.calendar.id, 'sync', { n: 1 }); // discovery
    await f.settle();
    const self = f.calendar as unknown as { id: AbjectId; request<T>(m: AbjectMessage, timeoutMs?: number): Promise<T> };
    assert.equal(await self.request<number>(request(self.id, self.id, 'sync', { n: 10 }), 5000), 11);
    assert.equal(await f.client.call(f.calendar.id, 'sync', { n: 20 }), 21);
    await f.settle();
    assert.deepEqual(f.recorder!.received.filter(e => e.method === 'sync').map(e => e.argsText), ['{"n":20}']);
  } finally { await f.stop(); }
});

test('a handler that returns with a call still on its way is recorded once it is answered, with that call; one that set a timer is not; a fire-and-forget emit is fine', async () => {
  const f = await fixture(true);
  try {
    await f.client.call(f.calendar.id, 'sync', { n: 1 }); // discovery
    await f.settle();
    assert.equal(await f.client.call(f.calendar.id, 'tail', {}), true);
    await new Promise(r => setTimeout(r, 120));
    assert.equal(await f.client.call(f.calendar.id, 'arms', {}), true);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(await f.client.call(f.calendar.id, 'emits', {}), true);
    await f.settle();
    const methods = f.recorder!.received.map(e => e.method);
    const tail = f.recorder!.received.find(e => e.method === 'tail');
    assert.ok(tail, 'the recording waited for the un-awaited call instead of storing it without');
    assert.deepEqual(tail!.calls.map(c => c.method), ['get', 'step']);
    assert.ok(tail!.calls.every(c => c.replyText !== undefined), 'both calls carry their answers');
    assert.ok(!methods.includes('arms'), 'a timer runs in the context it was set in');
    assert.ok(methods.includes('emits'), `an un-awaited emit is not a call, so the recording is kept (${methods})`);
  } finally { await f.stop(); }
});

test('back-to-back requests are both recorded when the first one\'s leftover helper calls answer in between', async () => {
  const f = await fixture(true);
  try {
    await f.client.call(f.calendar.id, 'sync', { n: 1 }); // discovery
    await f.settle();
    // The second request arrives as soon as the first replies, before any timer could look again.
    assert.equal(await f.client.call(f.calendar.id, 'emits', {}), true);
    assert.equal(await f.client.call(f.calendar.id, 'emits', {}), true);
    await f.settle();
    assert.equal(f.recorder!.received.filter(e => e.method === 'emits').length, 2);
  } finally { await f.stop(); }
});

test('a handler that starts while another one\'s leftover call is still on its way is not recorded, and neither is the other', async () => {
  const f = await fixture(true);
  try {
    await f.client.call(f.calendar.id, 'sync', { n: 1 }); // discovery
    await f.settle();
    assert.equal(await f.client.call(f.calendar.id, 'tail', {}), true); // leaves a 30 ms call running
    assert.equal(await f.client.call(f.calendar.id, 'emits', {}), true);
    await new Promise(r => setTimeout(r, 120));
    const methods = f.recorder!.received.map(e => e.method);
    assert.ok(!methods.includes('emits'), `emits ran while tail's call was in flight (${methods})`);
    assert.ok(!methods.includes('tail'), 'and tail overlapped emits');
  } finally { await f.stop(); }
});

test('a source swap while a recording waits for its leftover calls drops that recording', async () => {
  const f = await fixture(true);
  try {
    await f.client.call(f.calendar.id, 'sync', { n: 1 }); // discovery
    await f.settle();
    assert.equal(await f.client.call(f.calendar.id, 'tail', {}), true); // leaves a 30 ms call running
    const swapped = await f.client.call<{ success: boolean }>(f.calendar.id, 'updateSource', { source: SOURCE });
    assert.equal(swapped.success, true, JSON.stringify(swapped));
    await new Promise(r => setTimeout(r, 120));
    assert.ok(!f.recorder!.received.some(e => e.method === 'tail'), 'the trace outlived the sandbox it was taken in');
  } finally { await f.stop(); }
});
