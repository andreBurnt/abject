/**
 * The whole loop, nothing seeded by hand: a user object answers real
 * requests, its invocations reach the CassetteRecorder and land in Storage,
 * and deploy_update asks the FitnessJudge about a redraft against exactly
 * that evidence.
 *   pnpm tsx --test src/objects/fitness-loop.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId, AbjectMessage, AbjectManifest, TypeId } from '../core/types.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { ObjectCreator } from './object-creator.js';
import { ScriptableAbject } from './scriptable-abject.js';
import { FitnessJudge } from './fitness-judge.js';
import { CassetteRecorder, type InvocationCassette } from './cassette-recorder.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'fixture',
      interface: { id: `fixture:${name}`, name, description: 'fixture', methods: [] } } });
  }
  call<T = unknown>(to: AbjectId, method: string, payload: unknown = {}): Promise<T> {
    return this.request<T>(request(this.id, to, method, payload), 20000);
  }
}
class MemoryStorage extends Endpoint {
  values = new Map<string, unknown>();
  constructor() {
    super('Storage');
    this.on('get', (m: AbjectMessage) => structuredClone(this.values.get((m.payload as { key: string }).key) ?? null));
    this.on('set', (m: AbjectMessage) => { const { key, value } = m.payload as { key: string; value: unknown }; this.values.set(key, structuredClone(value)); return true; });
  }
}
class FakeStore extends Endpoint { constructor() { super('AbjectStore'); this.on('save', () => ({ ok: true })); } }
/** Stands in for HttpClient's `get`: a fixed upstream answer. */
class FakeHttp extends Endpoint {
  constructor() {
    super('HttpClient');
    this.on('get', () => ({ status: 200, statusText: 'OK', headers: {}, ok: true,
      body: JSON.stringify([{ id: 1, name: 'Standup' }, { id: 2, name: 'Retro' }]) }));
  }
}
class HeadlessCreator extends ObjectCreator { protected override async onInit(): Promise<void> {} }

const TYPE = 'peer1/ws1/user/Calendar' as TypeId;
const manifest: AbjectManifest = { name: 'Calendar', version: '1', description: 'user object',
  interface: { id: 'user:calendar', name: 'Calendar', description: 'user object',
    methods: [{ name: 'listEvents', description: 'list', parameters: [] }] } };
const LIVE = `({
  async listEvents(msg) {
    const res = await this.call(await this.dep('HttpClient'), 'get', { url: 'https://x.test/events?q=' + msg.payload.q });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return JSON.parse(res.body).map(e => e.name);
  }
})`;
const HEAL_OK = LIVE.replace('map(e => e.name)', 'filter(e => e && e.name).map(e => e.name)');
const HEAL_BROKEN = LIVE.replace('e.name', 'e.id');
const settle = (ms: number) => new Promise(r => setTimeout(r, ms));

test('record live, then judge a redraft against those recordings inside deploy_update', async () => {
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  const add = async <T extends Abject>(o: T, typeId?: TypeId): Promise<T> => {
    o.setRegistryHint(registry.id); await o.init(bus);
    registry.registerObject(o.id, o.manifest, undefined, undefined, undefined, undefined, typeId);
    objects.push(o); return o;
  };
  try {
    const storage = await add(new MemoryStorage());
    const store = await add(new FakeStore());
    await add(new CassetteRecorder({ flushMs: 20 }));
    await add(new FitnessJudge());
    await add(new FakeHttp(), 'peer1/system/HttpClient' as TypeId);
    const client = await add(new Endpoint('Client'));
    const calendar = await add(new ScriptableAbject(manifest, LIVE, client.id), TYPE);
    registry.registerObject(calendar.id, calendar.manifest, undefined, client.id, LIVE, undefined, TYPE);

    // Real traffic. The first request discovers the recorder; the next ones are recorded.
    for (const q of ['all', 'mine', 'today']) {
      assert.deepEqual(await client.call(calendar.id, 'listEvents', { q }), ['Standup', 'Retro']);
    }
    await settle(200);
    const recorded = storage.values.get(`invocations:${TYPE}`) as InvocationCassette[];
    assert.equal(recorded?.length, 2, `recorder wrote: ${[...storage.values.keys()]}`);
    assert.deepEqual(recorded.map(r => r.argsText), ['{"q":"mine"}', '{"q":"today"}']);
    assert.equal(recorded[0].calls[0].target, 'HttpClient');

    const creator: any = await add(new HeadlessCreator());
    creator.registryId = registry.id;
    creator.abjectStoreId = store.id;
    const pivot = (draftSource: string) => ({ kind: 'create', goal: 'heal', deps: new Map(), draftSource, usedObjects: [],
      turn: 1, turnLog: [], renderedGuides: new Set(), lastValidation: {} });
    const deploy = (draft: string) => creator.opDeployUpdate(pivot(draft), { action: 'deploy_update', objectId: calendar.id });

    const refused = await deploy(HEAL_BROKEN);
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.match(refused.summary, /refused — the draft contradicts what .* was recorded doing \(2 of 2 recordings contradicted\)/);
    assert.match(refused.error, /listEvents\(\{"q":"mine"\}\) returned \[1,2\] where the live object returned \["Standup","Retro"\]/);
    assert.match(refused.error, /listEvents\(\{"q":"today"\}\) returned \[1,2\]/);
    assert.equal(await client.call(calendar.id, 'getSource'), LIVE);

    const accepted = await deploy(HEAL_OK);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.match(accepted.data.fitness, /^fitness: PASS — 2 recordings reproduced/);
    assert.equal(await client.call(calendar.id, 'getSource'), HEAL_OK);
    // and the healed object still answers the same way
    assert.deepEqual(await client.call(calendar.id, 'listEvents', { q: 'all' }), ['Standup', 'Retro']);
  } finally { for (const o of objects.reverse()) await o.stop(); }
});
