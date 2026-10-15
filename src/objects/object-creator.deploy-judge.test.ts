/**
 * deploy_update judges the staged draft against the target it RESOLVES, at
 * the moment it deploys - there is no verdict to carry and no digest to
 * bind, so the create -> deploy_update {objectId} pivot mempko traced on
 * PR #11 cannot deadlock: the same action that resolves the target is the
 * one that asks about it.
 *
 *   pnpm tsx --test src/objects/object-creator.deploy-judge.test.ts
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
import type { InvocationCassette } from './cassette-recorder.js';

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
  reads: string[] = [];
  constructor() {
    super('Storage');
    this.on('get', (m: AbjectMessage) => { const { key } = m.payload as { key: string }; this.reads.push(key); return structuredClone(this.values.get(key) ?? null); });
    this.on('set', (m: AbjectMessage) => { const { key, value } = m.payload as { key: string; value: unknown }; this.values.set(key, structuredClone(value)); return true; });
  }
}

class FakeStore extends Endpoint {
  saved: unknown[] = [];
  constructor() { super('AbjectStore'); this.on('save', (m: AbjectMessage) => { this.saved.push(m.payload); return { ok: true }; }); }
}

/** ObjectCreator without its boot-time dependency hunt (LLM, Factory, AgentAbject). */
class HeadlessCreator extends ObjectCreator { protected override async onInit(): Promise<void> {} }

const TYPE = 'peer1/ws1/user/Calendar' as TypeId;
const manifest: AbjectManifest = { name: 'Calendar', version: '1', description: 'user object',
  interface: { id: 'user:calendar', name: 'Calendar', description: 'user object',
    methods: [{ name: 'listEvents', description: 'list', parameters: [] }] } };

const LIVE = `({
  async listEvents(msg) {
    const res = await this.call(await this.dep('HttpClient'), 'get', { url: 'https://x.test/events?q=' + msg.payload.q });
    return JSON.parse(res.body).map(e => e.name);
  }
})`;
const HEAL_OK = LIVE.replace('map(e => e.name)', 'filter(e => e && e.name).map(e => e.name)');
const HEAL_BROKEN = LIVE.replace('e.name', 'e.id');

const httpReply = { status: 200, statusText: 'OK', headers: {}, body: JSON.stringify([{ id: 1, name: 'Standup' }, { id: 2, name: 'Retro' }]), ok: true };
const recording: InvocationCassette = {
  method: 'listEvents', argsText: '{"q":"all"}',
  calls: [{ target: 'HttpClient', method: 'get', payloadText: '{"url":"https://x.test/events?q=all"}', replyText: JSON.stringify(httpReply) }],
  resultText: JSON.stringify(['Standup', 'Retro']), at: 1,
};

async function fixture(opts: { judge?: boolean; recordings?: InvocationCassette[]; noLiveSource?: boolean } = {}) {
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  const add = async <T extends Abject>(o: T, typeId?: TypeId): Promise<T> => {
    o.setRegistryHint(registry.id); await o.init(bus);
    registry.registerObject(o.id, o.manifest, undefined, undefined, undefined, undefined, typeId);
    objects.push(o); return o;
  };
  const storage = await add(new MemoryStorage());
  if (opts.recordings) storage.values.set(`invocations:${TYPE}`, opts.recordings);
  const store = await add(new FakeStore());
  if (opts.judge !== false) await add(new FitnessJudge());
  await add(new Endpoint('HttpClient'), 'peer1/system/HttpClient' as TypeId);
  const client = await add(new Endpoint('Client'));
  const target = await add(new ScriptableAbject(manifest, LIVE, client.id), TYPE);
  registry.registerObject(target.id, target.manifest, undefined, client.id, opts.noLiveSource ? undefined : LIVE, undefined, TYPE);
  const creator: any = await add(new HeadlessCreator());
  creator.registryId = registry.id;
  creator.abjectStoreId = store.id;
  creator.factoryId = 'factory-not-needed';
  /** A loop that started as kind:create and staged a draft; it never called load_target. */
  const pivotState = (draftSource: string) => ({
    kind: 'create', goal: 'fix listEvents', deps: new Map(), draftSource, usedObjects: [],
    turn: 3, turnLog: [], renderedGuides: new Set(), lastValidation: {},
  });
  const deployUpdate = (draft: string, extra: Record<string, unknown> = {}) =>
    creator.opDeployUpdate(pivotState(draft), { action: 'deploy_update', objectId: target.id, ...extra }) as Promise<{ ok: boolean; summary: string; error?: string; data?: any }>;
  return { storage, store, client, target, creator, deployUpdate, async stop() { for (const o of objects.reverse()) await o.stop(); } };
}

test('create -> deploy_update {objectId}: the draft is judged against the RESOLVED target, in the same action, with no prior step', async () => {
  const f = await fixture({ recordings: [recording] });
  try {
    const res = await f.deployUpdate(HEAL_BROKEN);
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.match(res.summary, /deploy_update: refused — .*contradicts what .* was recorded doing/);
    assert.match(res.error!, /Nothing was deployed/);
    assert.match(res.error!, /listEvents\(\{"q":"all"\}\) returned \[1,2\] where the live object returned \["Standup","Retro"\]/);
    // The evidence read was for the target the action named, resolved right here -
    // not for whatever the loop's state happened to hold (nothing, in a create loop).
    assert.ok(f.storage.reads.includes(`invocations:${TYPE}`), `storage reads: ${f.storage.reads}`);
    assert.equal(await f.client.call(f.target.id, 'getSource'), LIVE, 'the live object is untouched');
    assert.equal(f.store.saved.length, 0);
  } finally { await f.stop(); }
});

test('the refusal is not a fixed point: a corrected draft deploys on the very next action, with the verdict on the result', async () => {
  const f = await fixture({ recordings: [recording] });
  try {
    const refused = await f.deployUpdate(HEAL_BROKEN);
    assert.equal(refused.ok, false);
    const res = await f.deployUpdate(HEAL_OK);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.match(res.data.fitness, /^fitness: PASS — 1 recording reproduced/);
    assert.equal(await f.client.call(f.target.id, 'getSource'), HEAL_OK);
    assert.equal(f.store.saved.length, 1);
  } finally { await f.stop(); }
});

test('a deliberate behaviour change is not a wall: stating the intent deploys and puts the contradiction on record', async () => {
  const f = await fixture({ recordings: [recording] });
  try {
    const res = await f.deployUpdate(HEAL_BROKEN, { intendedChange: 'the user asked for ids, not names' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.match(res.data.fitness, /contradicted 1 of 1 recording.*deployed on stated intent: the user asked for ids, not names/);
    assert.equal(await f.client.call(f.target.id, 'getSource'), HEAL_BROKEN);
  } finally { await f.stop(); }
});

test('with no recordings for the target the deploy proceeds and says the verdict is unverified', async () => {
  const f = await fixture();
  try {
    const res = await f.deployUpdate(HEAL_BROKEN);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.match(res.data.fitness, /^fitness: unverified — no invocations recorded/);
  } finally { await f.stop(); }
});

test('with no judge on the bus the deploy proceeds and says so, rather than bricking every modify', async () => {
  const f = await fixture({ judge: false, recordings: [recording] });
  try {
    const res = await f.deployUpdate(HEAL_BROKEN);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.match(res.data.fitness, /judge unavailable/);
  } finally { await f.stop(); }
});

test('with no live source to run as the control the deploy proceeds, unverified, rather than refusing on evidence nothing excused', async () => {
  const f = await fixture({ recordings: [recording], noLiveSource: true });
  try {
    const res = await f.deployUpdate(HEAL_BROKEN);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.match(res.data.fitness, /^fitness: unverified — no live source to run as the control/);
  } finally { await f.stop(); }
});

test('a refusal names the target by its registered name when the action passed a bare id', async () => {
  const f = await fixture({ recordings: [recording] });
  try {
    const res = await f.deployUpdate(HEAL_BROKEN);
    assert.equal(res.ok, false);
    assert.match(res.summary, /contradicts what Calendar was recorded doing/);
    assert.doesNotMatch(res.summary, new RegExp(f.target.id));
  } finally { await f.stop(); }
});

test('a Registry lookup that fails is reported as such, not as "no durable typeId"', async () => {
  const f = await fixture({ recordings: [recording] });
  try {
    // The judge's lookup is the first one on the modify path; later lookups (persistence) succeed.
    const send = f.creator.sendRequest.bind(f.creator);
    let failed = false;
    f.creator.sendRequest = (to: AbjectId, method: string, payload: unknown, timeoutMs?: number) => {
      if (method === 'lookup' && !failed) { failed = true; return Promise.reject(new Error('registry down')); }
      return send(to, method, payload, timeoutMs);
    };
    const modify = { kind: 'modify', goal: 'fix listEvents', deps: new Map(), draftSource: HEAL_BROKEN, usedObjects: [],
      turn: 3, turnLog: [], renderedGuides: new Set(), lastValidation: {}, targetObjectId: f.target.id, targetSource: LIVE };
    const res = await f.creator.opDeployUpdate(modify, { action: 'deploy_update' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.match(res.data.fitness, /^fitness: unverified — registry lookup failed \(registry down\)$/);
  } finally { await f.stop(); }
});

test('the judge is asked with the deploy\'s own deadline, so an abandoned judgment stops', async () => {
  const f = await fixture({ recordings: [recording] });
  try {
    const asked: Array<{ payload: any; timeoutMs?: number }> = [];
    const send = f.creator.sendRequest.bind(f.creator);
    f.creator.sendRequest = (to: AbjectId, method: string, payload: unknown, timeoutMs?: number) => {
      if (method === 'judge') asked.push({ payload, timeoutMs });
      return send(to, method, payload, timeoutMs);
    };
    const before = Date.now();
    await f.deployUpdate(HEAL_OK);
    assert.equal(asked.length, 1);
    const { payload, timeoutMs } = asked[0];
    assert.equal(typeof payload.deadline, 'number');
    assert.ok(payload.deadline >= before + timeoutMs! && payload.deadline <= Date.now() + timeoutMs!,
      `deadline ${payload.deadline - before} ms out, request timeout ${timeoutMs} ms`);
    assert.equal(payload.maxMutants, undefined, 'no evidence-strength knob on the deploy path');
  } finally { await f.stop(); }
});
