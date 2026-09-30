/**
 * CassetteRecorder: both recording kinds, on a real bus with a real Registry.
 *   pnpm tsx --test src/objects/cassette-recorder.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Abject } from '../core/abject.js';
import { event } from '../core/message.js';
import type { AbjectId, AbjectMessage, TypeId } from '../core/types.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { CassetteRecorder, isUserTypeId, type InvocationCassette, type Cassette } from './cassette-recorder.js';
import type { InvocationEvent } from './scriptable-abject.js';
import type { HttpExchangeEvent } from './capabilities/http-client.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'fixture',
      interface: { id: `fixture:${name}`, name, description: 'fixture', methods: [] } } });
  }
  emitTo(to: AbjectId, name: string, payload: unknown): void { this.send(event(this.id, to, name, payload)); }
}

class MemoryStorage extends Endpoint {
  values = new Map<string, unknown>();
  constructor() {
    super('Storage');
    this.on('get', (m: AbjectMessage) => structuredClone(this.values.get((m.payload as { key: string }).key) ?? null));
    this.on('set', (m: AbjectMessage) => { const { key, value } = m.payload as { key: string; value: unknown }; this.values.set(key, structuredClone(value)); return true; });
  }
}

async function fixture() {
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  return {
    registry,
    async add<T extends Abject>(object: T, typeId?: TypeId): Promise<T> {
      object.setRegistryHint(registry.id);
      await object.init(bus);
      registry.registerObject(object.id, object.manifest, undefined, undefined, undefined, undefined, typeId);
      objects.push(object);
      return object;
    },
    async stop() { for (const object of objects.reverse()) await object.stop(); },
  };
}

const settle = (ms: number) => new Promise(r => setTimeout(r, ms));
const USER_TYPE = 'peer1/ws1/user/Calendar' as TypeId;

function invocation(calls: InvocationEvent['calls'], overrides: Partial<InvocationEvent> = {}): InvocationEvent {
  return { caller: 'ignored' as AbjectId, method: 'listEvents', argsText: '{"q":"all"}', calls,
    resultText: '[1,2]', durationMs: 3, at: Date.now(), ...overrides };
}

test('isUserTypeId distinguishes user objects from system and workspace built-ins', () => {
  assert.equal(isUserTypeId(USER_TYPE), true);
  assert.equal(isUserTypeId('peer1/system/LLMObject' as TypeId), false);
  assert.equal(isUserTypeId('peer1/ws1/Chat' as TypeId), false);
});

test('an invocation is stored under invocations:<typeId> with outbound targets resolved to names', async () => {
  const f = await fixture();
  try {
    const storage = await f.add(new MemoryStorage());
    const recorder = await f.add(new CassetteRecorder({ flushMs: 20 }));
    const http = await f.add(new Endpoint('HttpClient'), 'peer1/system/HttpClient' as TypeId);
    const calendar = await f.add(new Endpoint('Calendar'), USER_TYPE);
    calendar.emitTo(recorder.id, 'invocation', invocation([
      { targetId: http.id, method: 'get', payloadText: '{"url":"https://x.test/e"}', replyText: '{"ok":true,"body":"[1,2]"}' },
    ]));
    await settle(150);
    const stored = storage.values.get(`invocations:${USER_TYPE}`) as InvocationCassette[];
    assert.equal(stored?.length, 1, `stored keys: ${[...storage.values.keys()]}`);
    assert.equal(stored[0].method, 'listEvents');
    assert.deepEqual(stored[0].calls, [{ target: 'HttpClient', method: 'get', payloadText: '{"url":"https://x.test/e"}', replyText: '{"ok":true,"body":"[1,2]"}' }]);
    assert.equal(stored[0].resultText, '[1,2]');
    assert.equal('truncated' in stored[0], false);
  } finally { await f.stop(); }
});

test('the sender is the caller: a system object\'s invocations are not recorded, whatever the payload claims', async () => {
  const f = await fixture();
  try {
    const storage = await f.add(new MemoryStorage());
    const recorder = await f.add(new CassetteRecorder({ flushMs: 20 }));
    const llm = await f.add(new Endpoint('LLMObject'), 'peer1/system/LLMObject' as TypeId);
    const calendar = await f.add(new Endpoint('Calendar'), USER_TYPE);
    llm.emitTo(recorder.id, 'invocation', invocation([], { caller: calendar.id }));
    const anonymous = await f.add(new Endpoint('Nameless')); // registered, no typeId
    anonymous.emitTo(recorder.id, 'invocation', invocation([]));
    await settle(150);
    assert.deepEqual([...storage.values.keys()], []);
  } finally { await f.stop(); }
});

test('an outbound call to an object the registry cannot name makes the recording unreplayable, so it is dropped', async () => {
  const f = await fixture();
  try {
    const storage = await f.add(new MemoryStorage());
    const recorder = await f.add(new CassetteRecorder({ flushMs: 20 }));
    const calendar = await f.add(new Endpoint('Calendar'), USER_TYPE);
    calendar.emitTo(recorder.id, 'invocation', invocation([
      { targetId: 'dead-0000-0000' as AbjectId, method: 'get', payloadText: '{}', replyText: '1' },
    ]));
    await settle(150);
    assert.deepEqual([...storage.values.keys()], []);
  } finally { await f.stop(); }
});

test('a restart never clobbers: existing recordings in Storage are merged ahead of new ones', async () => {
  const f = await fixture();
  try {
    const storage = await f.add(new MemoryStorage());
    const earlier: InvocationCassette = { method: 'listEvents', argsText: '{"q":"old"}', calls: [], resultText: '[]', at: 1 };
    storage.values.set(`invocations:${USER_TYPE}`, [earlier]);
    const recorder = await f.add(new CassetteRecorder({ flushMs: 20 }));
    const calendar = await f.add(new Endpoint('Calendar'), USER_TYPE);
    calendar.emitTo(recorder.id, 'invocation', invocation([]));
    await settle(150);
    const stored = storage.values.get(`invocations:${USER_TYPE}`) as InvocationCassette[];
    assert.deepEqual(stored.map(c => c.argsText), ['{"q":"old"}', '{"q":"all"}']);
  } finally { await f.stop(); }
});

test('a chatty handler cannot evict the only recording of a quiet one', async () => {
  const f = await fixture();
  try {
    const storage = await f.add(new MemoryStorage());
    const recorder = await f.add(new CassetteRecorder({ flushMs: 20 }));
    const calendar = await f.add(new Endpoint('Calendar'), USER_TYPE);
    calendar.emitTo(recorder.id, 'invocation', invocation([], { method: 'rare', at: 1 }));
    for (let i = 0; i < 60; i++) calendar.emitTo(recorder.id, 'invocation', invocation([], { method: 'hot', at: 10 + i }));
    await settle(300);
    const stored = storage.values.get(`invocations:${USER_TYPE}`) as InvocationCassette[];
    assert.equal(stored.filter(c => c.method === 'rare').length, 1);
    assert.equal(stored.filter(c => c.method === 'hot').length, 5, 'per-method bucket cap');
  } finally { await f.stop(); }
});

test('HTTP exchanges still land under cassettes:<typeId>, attributed by the payload caller HttpClient vouches for', async () => {
  const f = await fixture();
  try {
    const storage = await f.add(new MemoryStorage());
    const recorder = await f.add(new CassetteRecorder({ flushMs: 20 }));
    const http = await f.add(new Endpoint('HttpClient'), 'peer1/system/HttpClient' as TypeId);
    const calendar = await f.add(new Endpoint('Calendar'), USER_TYPE);
    const exchange: HttpExchangeEvent = { caller: calendar.id,
      request: { method: 'GET', url: 'https://x.test/e?q=1' }, response: { status: 200, bodyText: '[1]' }, durationMs: 1, at: 5 };
    http.emitTo(recorder.id, 'httpExchange', exchange);
    await settle(150);
    const stored = storage.values.get(`cassettes:${USER_TYPE}`) as Cassette[];
    assert.equal(stored?.length, 1);
    assert.equal(stored[0].method, '_http');
    assert.equal(stored[0].request.url, 'https://x.test/e?q=1');
    assert.equal(storage.values.has(`invocations:${USER_TYPE}`), false);
  } finally { await f.stop(); }
});
