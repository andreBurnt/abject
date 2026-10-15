/**
 * A handler that calls an object by an id it was handed (a window from
 * createWindowAbject, the WidgetManager workflow) is recorded under that id
 * and replayed against it, so a broken draft of a UI object is refused
 * rather than deployed "unverified".
 *   pnpm tsx --test src/objects/fitness-judge.handed-ids.test.ts
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
class Win extends Endpoint { constructor() { super('Window'); this.on('addLabel', () => true); } }

/** WidgetManager stand-in: createWindowAbject spawns a window on the bus and returns its id. */
class FakeWidgetManager extends Endpoint {
  constructor(spawn: () => Promise<AbjectId>) { super('WidgetManager'); this.on('createWindowAbject', () => spawn()); }
}

/** HeadlessCreator: ObjectCreator without its boot-time dependency hunt. */
class HeadlessCreator extends ObjectCreator { protected override async onInit(): Promise<void> {} }

const TYPE = 'peer1/ws1/user/Panel' as TypeId;
const manifest: AbjectManifest = { name: 'Panel', version: '1', description: 'user object',
  interface: { id: 'user:panel', name: 'Panel', description: 'user object',
    methods: [{ name: 'show', description: 'show', parameters: [] }] } };

/** The workflow WidgetManager's manifest teaches. */
const LIVE = `({ async show(msg) {
  const w = await this.call(this.dep('WidgetManager'), 'createWindowAbject', { title: 'Tasks' });
  await this.call(w, 'addLabel', { text: 'Hello' });
  return msg.payload.n * 2;
} })`;

/**
 * A bus with a WidgetManager stand-in whose windows, like the real ones, are
 * init'd on the bus and not registered (unless `registerWindows`). `stray`
 * is an unregistered object nothing hands to the Panel.
 */
async function fixture(source: string, opts: { registerWindows?: boolean } = {}) {
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  const add = async <T extends Abject>(o: T, typeId?: TypeId): Promise<T> => {
    o.setRegistryHint(registry.id); await o.init(bus);
    registry.registerObject(o.id, o.manifest, undefined, undefined, undefined, undefined, typeId);
    objects.push(o); return o;
  };
  const storage = await add(new MemoryStorage());
  const store = await add(new FakeStore());
  await add(new CassetteRecorder({ flushMs: 20 }));
  await add(new FitnessJudge());
  await add(new FakeWidgetManager(async () => {
    const win = new Win(); win.setRegistryHint(registry.id); await win.init(bus); objects.push(win);
    if (opts.registerWindows) registry.registerObject(win.id, win.manifest);
    return win.id;
  }), 'peer1/system/WidgetManager' as TypeId);
  const stray = new Win(); stray.setRegistryHint(registry.id); await stray.init(bus); objects.push(stray);
  const client = await add(new Endpoint('Client'));
  const panel = await add(new ScriptableAbject(manifest, source, client.id), TYPE);
  registry.registerObject(panel.id, panel.manifest, undefined, client.id, source, undefined, TYPE);
  const creator: any = await add(new HeadlessCreator());
  creator.registryId = registry.id;
  creator.abjectStoreId = store.id;
  /** Call show() for each payload (the first call only discovers the recorder), then let it flush. */
  const drive = async (...payloads: Array<Record<string, unknown>>) => {
    for (const p of [payloads[0], ...payloads]) await client.call(panel.id, 'show', p);
    await new Promise(r => setTimeout(r, 200));
    return (storage.values.get(`invocations:${TYPE}`) ?? []) as InvocationCassette[];
  };
  const deploy = (draft: string, extra: Record<string, unknown> = {}) => creator.opDeployUpdate(
    { kind: 'modify', goal: 'x', deps: new Map(), draftSource: draft, usedObjects: [], turn: 1, turnLog: [],
      renderedGuides: new Set(), lastValidation: {}, targetObjectId: panel.id, targetSource: source },
    { action: 'deploy_update', ...extra }) as Promise<{ ok: boolean; summary: string; data?: any }>;
  return { client, panel, stray, drive, deploy,
    async stop() { for (const o of objects.reverse()) await o.stop(); } };
}

test('an id the invocation got back from an earlier call is recorded as that id', async () => {
  const f = await fixture(LIVE);
  try {
    const rows = await f.drive({ n: 1 }, { n: 2 });
    assert.equal(rows.length, 2, 'the unregistered window no longer drops the invocation');
    for (const row of rows) {
      assert.equal(row.calls[0].target, 'WidgetManager', 'a dep() target is still keyed by name');
      assert.equal(row.calls[1].target, JSON.parse(row.calls[0].replyText!), 'the window is keyed by the id the reply carried');
    }
  } finally { await f.stop(); }
});

test('a registered object reached by a handed id is keyed by the id, not its name', async () => {
  const f = await fixture(LIVE, { registerWindows: true });
  try {
    const [row] = await f.drive({ n: 1 });
    assert.equal(row.calls[1].target, JSON.parse(row.calls[0].replyText!));
  } finally { await f.stop(); }
});

test('an id handed in the arguments is recorded as that id; an unregistered id nobody handed is still dropped', async () => {
  const viaArgs = `({ async show(msg) { await this.call(msg.payload.win, 'addLabel', { text: 'x' }); return true; } })`;
  const f = await fixture(viaArgs);
  try {
    const rows = await f.drive({ win: f.stray.id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].calls[0].target, f.stray.id);
  } finally { await f.stop(); }
  const unhanded = await fixture('({ async show() { return true; } })');
  try {
    // Kept from somewhere else (state, a literal): neither registered nor handed.
    const swapped = unhanded.panel.applySource(`({ async show() { await this.call(${JSON.stringify(unhanded.stray.id)}, 'addLabel', {}); return true; } })`);
    assert.equal(swapped.success, true, JSON.stringify(swapped));
    assert.deepEqual(await unhanded.drive({}), []);
  } finally { await unhanded.stop(); }
});

test('a broken draft of a UI object is refused; a faithful one passes', async () => {
  const f = await fixture(LIVE);
  try {
    await f.drive({ n: 1 }, { n: 2 }, { n: 3 });
    const broken = await f.deploy(LIVE.replace('msg.payload.n * 2', 'msg.payload.n * 3'));
    assert.equal(broken.ok, false, JSON.stringify(broken));
    assert.match(broken.summary, /refused — the draft contradicts what Panel was recorded doing \(3 of 3 recordings contradicted\)/);
    assert.equal(await f.client.call(f.panel.id, 'getSource'), LIVE, 'the live object is untouched');
    const faithful = await f.deploy(LIVE.replace('msg.payload.n * 2', 'msg.payload.n + msg.payload.n'));
    assert.equal(faithful.ok, true, JSON.stringify(faithful));
    assert.equal(faithful.data.fitness, 'fitness: PASS — 3 recordings reproduced');
  } finally { await f.stop(); }
});
