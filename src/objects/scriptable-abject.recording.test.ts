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
    this.on('fail', () => { throw new Error('upstream refused'); });
  }
}

const manifest: AbjectManifest = { name: 'Calendar', version: '1', description: 'user object',
  interface: { id: 'user:calendar', name: 'Calendar', description: 'user object', methods: [
    { name: 'listEvents', description: '', parameters: [] },
    { name: 'boom', description: '', parameters: [] },
    { name: 'secretive', description: '', parameters: [] },
    { name: 'sync', description: '', parameters: [] },
  ] } };

const SOURCE = `({
  async listEvents(msg) {
    const echo = await this.dep('Echo');
    const res = await this.call(echo, 'get', { url: 'https://x.test/events?q=' + msg.payload.q });
    return JSON.parse(res.body).map(e => e.id);
  },
  async boom(msg) {
    try { await this.call(await this.dep('Echo'), 'fail', {}); } catch (err) { throw new Error('boom: ' + err.message); }
  },
  async secretive(msg) { return { token: msg.payload.api_key, n: 1 }; },
  sync(msg) { return msg.payload.n + 1; }
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
  return { recorder, client, calendar, settle, async stop() { for (const o of objects.reverse()) await o.stop(); } };
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
