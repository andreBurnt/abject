/**
 * The bounds on what an invocation recording may hold: error text is
 * scrubbed and capped like every other recorded text, the outbound-call list
 * is capped, and a user handler map cannot replace the internal
 * `recipientGone` handler that re-finds a restarted recorder.
 *   pnpm tsx --test src/objects/scriptable-abject.recording-limits.test.ts
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

class FakeRecorder extends Endpoint {
  received: InvocationEvent[] = [];
  constructor() {
    super('CassetteRecorder');
    this.on('invocation', (m: AbjectMessage) => { this.received.push(m.payload as InvocationEvent); return true; });
  }
}

/** An upstream whose errors echo a credential, or run long. */
class Upstream extends Endpoint {
  constructor() {
    super('Upstream');
    this.on('get', () => ({ ok: true }));
    this.on('leak', () => { throw new Error('HTTP 401: {"access_token":"sk-live-777","detail":"expired"}'); });
    this.on('huge', () => { throw new Error('x'.repeat(70 * 1024)); });
  }
}

const manifest: AbjectManifest = { name: 'Calendar', version: '1', description: 'user object',
  interface: { id: 'user:calendar', name: 'Calendar', description: 'user object', methods: [
    { name: 'sync', description: '', parameters: [] },
    { name: 'leaky', description: '', parameters: [] },
    { name: 'long', description: '', parameters: [] },
    { name: 'chatty', description: '', parameters: [] },
  ] } };

const SOURCE = `({
  sync(msg) { return msg.payload.n + 1; },
  async leaky(msg) {
    try { await this.call(await this.dep('Upstream'), 'leak', {}); } catch (err) { throw new Error('wrapped: ' + err.message); }
  },
  async long(msg) {
    try { await this.call(await this.dep('Upstream'), 'huge', {}); } catch (err) { return 'handled'; }
  },
  async chatty(msg) {
    const up = await this.dep('Upstream');
    for (let i = 0; i < 150; i++) await this.call(up, 'get', { i });
    return 150;
  },
  recipientGone(msg) { return 'the user handler'; }
})`;

async function fixture() {
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  const add = async <T extends Abject>(o: T): Promise<T> => {
    o.setRegistryHint(registry.id); await o.init(bus); registry.registerObject(o.id, o.manifest); objects.push(o); return o;
  };
  const recorder = await add(new FakeRecorder());
  await add(new Upstream());
  const client = await add(new Endpoint('Client'));
  const calendar = await add(new ScriptableAbject(manifest, SOURCE, client.id));
  const settle = () => new Promise(r => setTimeout(r, 30));
  await client.call(calendar.id, 'sync', { n: 1 }); // the first request only discovers the recorder
  await settle();
  return { bus, registry, recorder, client, calendar, settle, add, objects,
    async stop() { for (const o of objects.reverse()) await o.stop(); } };
}

test('error text is scrubbed by field name and capped, on the handler and on the outbound call', async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.client.call(f.calendar.id, 'leaky', {}));
    assert.equal(await f.client.call(f.calendar.id, 'long', {}), 'handled');
    await f.settle();
    const leaky = f.recorder.received.find(e => e.method === 'leaky')!;
    for (const text of [leaky.errorText!, leaky.calls[0].errorText!]) {
      assert.match(text, /"access_token":"REDACTED"/);
      assert.doesNotMatch(text, /sk-live-777/);
      assert.match(text, /"detail":"expired"/);
    }
    const long = f.recorder.received.find(e => e.method === 'long')!;
    assert.ok(long.calls[0].errorText!.length <= 64 * 1024, `errorText is ${long.calls[0].errorText!.length} chars`);
    assert.equal(long.truncated, true, 'a cut error text makes the recording unreplayable');
  } finally { await f.stop(); }
});

test('an invocation keeps at most 100 outbound calls and is then marked truncated', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.client.call(f.calendar.id, 'chatty', {}), 150, 'the handler itself is unaffected');
    await f.settle();
    const ev = f.recorder.received.find(e => e.method === 'chatty')!;
    assert.equal(ev.calls.length, 100);
    assert.equal(ev.truncated, true);
  } finally { await f.stop(); }
});

test('a user recipientGone handler cannot replace the one that re-finds a restarted recorder', async () => {
  const f = await fixture();
  try {
    // A hot swap (updateSource / deploy_update) re-installs the user's handlers
    // after the internal ones, so that is where a user recipientGone would win.
    assert.equal(f.calendar.applySource(SOURCE).success, true);
    await f.client.call(f.calendar.id, 'sync', { n: 2 });
    await f.settle();
    assert.equal(f.recorder.received.length, 1);
    // The recorder restarts under a new id.
    f.registry.unregisterObject(f.recorder.id);
    await f.recorder.stop();
    const next = await f.add(new FakeRecorder());
    // One request bounces off the dead id, one re-discovers, the rest land on the new recorder.
    for (let n = 3; n < 7; n++) { await f.client.call(f.calendar.id, 'sync', { n }); await f.settle(); }
    assert.ok(next.received.length >= 1, 'invocations never reached the restarted recorder');
  } finally { await f.stop(); }
});
