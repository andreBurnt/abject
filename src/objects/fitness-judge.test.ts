/**
 * FitnessJudge on a real bus: it reads the recorder's rows from Storage and
 * answers `judge` requests with an honest Verdict.
 *   pnpm tsx --test src/objects/fitness-judge.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId, AbjectMessage, TypeId } from '../core/types.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { FitnessJudge } from './fitness-judge.js';
import type { InvocationCassette } from './cassette-recorder.js';
import type { Verdict } from '../protocol/fitness.js';

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

class FailingStorage extends Endpoint {
  constructor() { super('Storage'); this.on('get', () => { throw new Error('disk on fire'); }); }
}

async function fixture(withStorage: boolean | 'failing' = true) {
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  const add = async <T extends Abject>(o: T): Promise<T> => {
    o.setRegistryHint(registry.id); await o.init(bus); registry.registerObject(o.id, o.manifest); objects.push(o); return o;
  };
  if (withStorage === 'failing') await add(new FailingStorage());
  const storage = withStorage === true ? await add(new MemoryStorage()) : undefined;
  const judge = await add(new FitnessJudge());
  const client = await add(new Endpoint('Client'));
  return { storage, judge, client, async stop() { for (const o of objects.reverse()) await o.stop(); } };
}

const TYPE = 'peer1/ws1/user/Calendar' as TypeId;
const httpReply = { status: 200, statusText: 'OK', headers: {}, body: JSON.stringify([{ id: 1, name: 'Standup' }, { id: 2, name: 'Retro' }]), ok: true };
const recording: InvocationCassette = {
  method: 'listEvents', argsText: '{"q":"all"}',
  calls: [{ target: 'HttpClient', method: 'get', payloadText: '{"url":"https://x.test/events?q=all"}', replyText: JSON.stringify(httpReply) }],
  resultText: JSON.stringify(['Standup', 'Retro']), at: 1,
};
const LIVE = `({
  async listEvents(msg) {
    const res = await this.call(await this.dep('HttpClient'), 'get', { url: 'https://x.test/events?q=' + msg.payload.q });
    return JSON.parse(res.body).map(e => e.name);
  }
})`;
const HEAL_OK = LIVE.replace('map(e => e.name)', 'filter(e => e.id > 0).map(e => e.name)');
const HEAL_BROKEN = LIVE.replace('e.name', 'e.id');

test('a faithful redraft passes, verified', async () => {
  const f = await fixture();
  try {
    f.storage!.values.set(`invocations:${TYPE}`, [recording]);
    const v = await f.client.call<Verdict>(f.judge.id, 'judge', { source: HEAL_OK, typeId: TYPE, liveSource: LIVE });
    assert.equal(v.pass, true, v.summary);
    assert.equal(v.replay.verified, true);
    assert.equal(v.replay.reproduced, 1);
    assert.equal(v.evidence.deterministic, 1);
    assert.match(v.summary, /^fitness: PASS — 1 recording reproduced$/);
  } finally { await f.stop(); }
});

test('a redraft that contradicts the recording fails, and the verdict says where', async () => {
  const f = await fixture();
  try {
    f.storage!.values.set(`invocations:${TYPE}`, [recording]);
    const v = await f.client.call<Verdict>(f.judge.id, 'judge', { source: HEAL_BROKEN, typeId: TYPE, liveSource: LIVE });
    assert.equal(v.pass, false);
    assert.match(v.replay.failures[0], /listEvents\(\{"q":"all"\}\) returned \[1,2\] where the live object returned \["Standup","Retro"\]/);
    assert.match(v.summary, /^fitness: FAIL — 1 of 1 recording contradicted/);
  } finally { await f.stop(); }
});

test('no typeId (a spawn) is an unverified pass that reads nothing', async () => {
  const f = await fixture();
  try {
    const v = await f.client.call<Verdict>(f.judge.id, 'judge', { source: HEAL_BROKEN });
    assert.equal(v.pass, true);
    assert.equal(v.replay.verified, false);
    assert.match(v.summary, /unverified — no typeId/);
  } finally { await f.stop(); }
});

test('a type with no recordings, or no Storage at all, is an unverified pass', async () => {
  const withStorage = await fixture();
  try {
    const v = await withStorage.client.call<Verdict>(withStorage.judge.id, 'judge', { source: HEAL_BROKEN, typeId: TYPE });
    assert.equal(v.pass, true);
    assert.equal(v.summary, 'fitness: unverified — no invocations recorded for this object');
  } finally { await withStorage.stop(); }
  const noStorage = await fixture(false);
  try {
    const v = await noStorage.client.call<Verdict>(noStorage.judge.id, 'judge', { source: HEAL_BROKEN, typeId: TYPE });
    assert.equal(v.pass, true);
    assert.equal(v.replay.verified, false);
    assert.equal(v.summary, 'fitness: unverified — recordings unreadable: no Storage on the bus',
      'absent Storage is not reported as "nothing recorded"');
  } finally { await noStorage.stop(); }
});

test('recordings the live source cannot reproduce are not held against the draft', async () => {
  const f = await fixture();
  try {
    const stamped: InvocationCassette = { method: 'listEvents', argsText: '{"q":"all"}', calls: [],
      resultText: JSON.stringify({ at: 123 }), at: 2 };
    f.storage!.values.set(`invocations:${TYPE}`, [stamped]);
    const clock = `({ async listEvents() { return { at: Date.now() }; } })`;
    const v = await f.client.call<Verdict>(f.judge.id, 'judge', { source: clock, typeId: TYPE, liveSource: clock });
    assert.equal(v.pass, true);
    assert.equal(v.replay.verified, false);
    assert.match(v.summary, /not deterministic, or not replayable by this harness/);
  } finally { await f.stop(); }
});

test('rows that are not recordings are ignored rather than trusted', async () => {
  const f = await fixture();
  try {
    f.storage!.values.set(`invocations:${TYPE}`, [{ garbage: true }, 'nope', recording]);
    const v = await f.client.call<Verdict>(f.judge.id, 'judge', { source: HEAL_OK, typeId: TYPE });
    assert.equal(v.pass, true);
    assert.equal(v.evidence.recordings, 1);
  } finally { await f.stop(); }
});

test('judgments run one at a time: two concurrent asks never overlap on a worker', async () => {
  const f = await fixture();
  try {
    f.storage!.values.set(`invocations:${TYPE}`, [recording]);
    // Spins 300 ms on the worker and returns when it ran; the recording
    // expects names, so the verdict's failure line carries the [start, end] span.
    const SPIN = `({ listEvents(msg) { const s = Date.now(); while (Date.now() - s < 300) {} return [s, Date.now()]; } })`;
    const verdicts = await Promise.all([1, 2].map(() =>
      f.client.call<Verdict>(f.judge.id, 'judge', { source: SPIN, typeId: TYPE })));
    const spans = verdicts.map(v => {
      const m = /returned \[(\d+),(\d+)\]/.exec(v.replay.failures[0] ?? '');
      assert.ok(m, JSON.stringify(v.replay));
      return [Number(m[1]), Number(m[2])] as const;
    }).sort((x, y) => x[0] - y[0]);
    assert.ok(spans[1][0] >= spans[0][1], `the second judgment ran ${spans[1][0]}..${spans[1][1]}, overlapping the first ${spans[0][0]}..${spans[0][1]}`);
  } finally { await f.stop(); }
});

test('a Storage read that fails says so, rather than "no invocations recorded"', async () => {
  const f = await fixture('failing');
  try {
    const v = await f.client.call<Verdict>(f.judge.id, 'judge', { source: HEAL_BROKEN, typeId: TYPE });
    assert.equal(v.pass, true);
    assert.equal(v.replay.verified, false);
    assert.match(v.summary, /^fitness: unverified — recordings unreadable: .*disk on fire/);
  } finally { await f.stop(); }
});

test('a judgment its caller stopped waiting for stops, answers unverified, and frees the queue', async () => {
  const f = await fixture();
  try {
    f.storage!.values.set(`invocations:${TYPE}`, [recording]);
    const HANG = `({ listEvents() { while (true) {} } })`;
    const t0 = Date.now();
    const v = await f.client.call<Verdict>(f.judge.id, 'judge', { source: HANG, typeId: TYPE, deadline: Date.now() + 300 });
    const took = Date.now() - t0;
    assert.equal(v.pass, true, 'a hang cut off by the caller\'s deadline is not a contradiction');
    assert.match(v.summary, /judgment abandoned: the caller's deadline passed during replay/);
    assert.ok(took < 2000, `stopped at the deadline, not at the 5 s invocation timeout (took ${took} ms)`);
  } finally { await f.stop(); }
});

test('a judgment whose deadline passed while it was queued answers at once', async () => {
  const f = await fixture();
  try {
    f.storage!.values.set(`invocations:${TYPE}`, [recording]);
    const SPIN = `({ listEvents() { const s = Date.now(); while (Date.now() - s < 400) {} return []; } })`;
    const first = f.client.call<Verdict>(f.judge.id, 'judge', { source: SPIN, typeId: TYPE });
    const second = f.client.call<Verdict>(f.judge.id, 'judge', { source: HEAL_BROKEN, typeId: TYPE, deadline: Date.now() + 100 });
    const [, v] = await Promise.all([first, second]);
    assert.equal(v.pass, true, 'the broken draft was never replayed');
    assert.match(v.summary, /judgment abandoned: the caller's deadline passed while it was queued/);
  } finally { await f.stop(); }
});
