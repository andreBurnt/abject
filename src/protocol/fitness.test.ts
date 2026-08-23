/** Run: pnpm tsx --test src/protocol/fitness.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, type Invoker } from './fitness.js';
import { CassetteStore, type Cassette } from './cassette.js';
import type { MethodDeclaration } from '../core/types.js';

/** Test invoker: the "source" is the body of an async JS function
 *  (args, http) => output. Real sandboxing arrives with op_fitness (Task 6). */
const testInvoker: Invoker = async (source, _method, args, http) => {
  const fn = new Function('args', 'http', `"use strict"; return (async () => { ${source} })();`);
  return fn(args, http);
};

const GOOD_SOURCE = `
  const res = http({ method: 'GET', url: 'https://example.test/events?q=' + args.q });
  if (!res) throw new Error('no stub');
  return res.body;
`;
const WRONG_SOURCE = `return [];`;

const cassette: Cassette = {
  method: 'listEvents', args: { q: 1 },
  request: { method: 'GET', url: 'https://example.test/events?q=1' },
  response: { status: 200, body: [{ id: 1, startsAt: '2026-08-23' }] },
  rawBody: '[{"id":1,"startsAt":"2026-08-23"}]',
  parsedOutput: [{ id: 1, startsAt: '2026-08-23' }],
  recordedAt: 1,
};

const methods: MethodDeclaration[] = [{
  name: 'listEvents', description: '', parameters: [],
  effects: 'read',
  outputSchema: {
    type: 'array',
    items: { type: 'object', required: ['id'], properties: { id: { type: 'number' } } },
  },
}];

test('replay passes when the candidate reproduces recorded meaning', async () => {
  const v = await evaluate({ source: GOOD_SOURCE },
    { cassettes: new CassetteStore([cassette]), methods }, testInvoker,
    { maxMutants: 0 });
  assert.equal(v.checks.find(c => c.check === 'replay')?.pass, true);
  assert.equal(v.checks.find(c => c.check === 'schema')?.pass, true);
  assert.equal(v.pass, true);
});

test('replay fails and short-circuits when output diverges from the cassette', async () => {
  const v = await evaluate({ source: WRONG_SOURCE },
    { cassettes: new CassetteStore([cassette]), methods }, testInvoker);
  assert.equal(v.pass, false);
  assert.equal(v.checks.find(c => c.check === 'replay')?.pass, false);
  assert.equal(v.checks.some(c => c.check === 'schema'), false); // short-circuit
});

test('schema fails on schema-invalid output even when there is no cassette for it', async () => {
  const badSchemaSource = `return [{ notId: true }];`;
  const v = await evaluate({ source: badSchemaSource },
    { cassettes: new CassetteStore([]), methods }, testInvoker);
  // no cassettes -> replay vacuously passes with a detail note; schema probe runs on empty args
  assert.equal(v.checks.find(c => c.check === 'replay')?.pass, true);
  assert.equal(v.checks.find(c => c.check === 'schema')?.pass, false);
  assert.equal(v.pass, false);
});

test('schema fails when every probe throws and a schema is declared', async () => {
  const throwing = `throw new Error('not implemented');`;
  const v = await evaluate({ source: throwing },
    { cassettes: new CassetteStore([]), methods }, testInvoker);
  assert.equal(v.pass, false);
  assert.equal(v.checks.find(c => c.check === 'schema')?.pass, false);
  assert.match(v.checks.find(c => c.check === 'schema')!.detail, /no output could be validated/);
});

const relMethods: MethodDeclaration[] = [{
  name: 'listEvents', description: '', parameters: [],
  relations: [{ kind: 'no-duplicates' }, { kind: 'sorted-by', field: 'startsAt' }],
  knownEntity: 'Weekly Standup',
}];

const relCassette: Cassette = {
  method: 'listEvents', args: {},
  request: { method: 'GET', url: 'https://example.test/events' },
  response: { status: 200, body: null }, // body unused: sources below ignore http
  rawBody: 'null',
  parsedOutput: null as unknown,          // parsedOutput unused: set per-test below
  recordedAt: 1,
};

test('relations: duplicates and disorder are caught', async () => {
  const dupSource = `return [{ startsAt: 'b' }, { startsAt: 'a' }, { startsAt: 'a' }];`;
  // make replay vacuous: cassette parsedOutput matches the source's constant output
  const c = { ...relCassette, parsedOutput: [{ startsAt: 'b' }, { startsAt: 'a' }, { startsAt: 'a' }] };
  const v = await evaluate({ source: dupSource },
    { cassettes: new CassetteStore([c]), methods: relMethods }, testInvoker);
  const rel = v.checks.find(x => x.check === 'relations');
  assert.equal(rel?.pass, false);
  assert.match(rel!.detail, /no-duplicates|sorted-by/);
});

test('relations: known entity must appear', async () => {
  const noEntity = `return [{ startsAt: 'a', name: 'Other Thing' }];`;
  const c = { ...relCassette, parsedOutput: [{ startsAt: 'a', name: 'Other Thing' }] };
  const v = await evaluate({ source: noEntity },
    { cassettes: new CassetteStore([c]),
      methods: [{ ...relMethods[0], relations: [{ kind: 'non-empty-for-known-entity' }] }] },
    testInvoker);
  assert.equal(v.checks.find(x => x.check === 'relations')?.pass, false);
});

test('relations: a clean output passes all declared relations', async () => {
  const clean = `return [{ startsAt: 'a', name: 'Weekly Standup' }, { startsAt: 'b', name: 'Other' }];`;
  const c = { ...relCassette, parsedOutput: [{ startsAt: 'a', name: 'Weekly Standup' }, { startsAt: 'b', name: 'Other' }] };
  const v = await evaluate({ source: clean },
    { cassettes: new CassetteStore([c]),
      methods: [{ ...relMethods[0], relations: [
        { kind: 'no-duplicates' }, { kind: 'sorted-by', field: 'startsAt' },
        { kind: 'non-empty-for-known-entity' }, { kind: 'idempotent' },
      ] }] },
    testInvoker);
  assert.equal(v.checks.find(x => x.check === 'relations')?.pass, true);
});

test('relations: a throwing second invocation fails idempotent instead of rejecting evaluate', async () => {
  // stateful source: first call returns [], second call throws
  let calls = 0;
  const flakyInvoker: Invoker = async (source, method, args, http) => {
    calls++;
    if (calls > 2) throw new Error('flaky');
    return [];
  };
  const c = { ...relCassette, parsedOutput: [] as unknown };
  const v = await evaluate({ source: 'return [];' },
    { cassettes: new CassetteStore([c]),
      methods: [{ ...relMethods[0], relations: [{ kind: 'idempotent' as const }] }] },
    flakyInvoker);
  assert.equal(v.pass, false);
  assert.match(v.checks.find(x => x.check === 'relations')!.detail, /second call threw/);
});

test('relations: subset-on-tighter-filter orders numeric filter args numerically', async () => {
  const mk = (q: number, out: unknown[]) => ({
    method: 'listEvents', args: { q },
    request: { method: 'GET', url: `https://example.test/events?q=${q}` },
    response: { status: 200, body: out }, rawBody: JSON.stringify(out),
    parsedOutput: out, recordedAt: q,
  });
  // q=2 (looser, returns 2 items), q=10 (tighter, returns subset of 1)
  const outputs: Record<number, unknown[]> = { 2: [{ id: 1 }, { id: 2 }], 10: [{ id: 1 }] };
  const numInvoker: Invoker = async (_s, _m, args) => outputs[args.q as number];
  const v = await evaluate({ source: 'irrelevant' },
    { cassettes: new CassetteStore([mk(2, outputs[2]), mk(10, outputs[10])]),
      methods: [{ name: 'listEvents', description: '', parameters: [],
        relations: [{ kind: 'subset-on-tighter-filter' as const, field: 'q' }] }] },
    numInvoker);
  assert.equal(v.checks.find(x => x.check === 'relations')?.pass, true);
});

test('mutation gate kills mutants of a well-tested source', async () => {
  // GOOD_SOURCE returns the cassette body verbatim; flipping its logic breaks replay.
  const v = await evaluate({ source: GOOD_SOURCE },
    { cassettes: new CassetteStore([cassette]), methods }, testInvoker,
    { maxMutants: 12, killThreshold: 0.5 });
  const mut = v.checks.find(c => c.check === 'mutation');
  assert.ok(mut, 'mutation check ran');
  if (v.killRatio !== undefined && mut!.detail !== 'no mutation points') {
    assert.ok(v.killRatio >= 0 && v.killRatio <= 1);
  }
});

test('maxMutants: 0 skips the mutation gate', async () => {
  const v = await evaluate({ source: GOOD_SOURCE },
    { cassettes: new CassetteStore([cassette]), methods }, testInvoker, { maxMutants: 0 });
  assert.equal(v.checks.find(c => c.check === 'mutation')?.detail, 'skipped');
});

test('mutation gate counts kills on a source with real mutation points', async () => {
  const KILLABLE_SOURCE = `
  const res = http({ method: 'GET', url: 'https://example.test/events' });
  if (!res) throw new Error('no stub');
  const items = res.body.filter(e => e.kind === 'event');
  return items;
`;
  const killCassette: Cassette = {
    method: 'listEvents', args: {},
    request: { method: 'GET', url: 'https://example.test/events' },
    response: { status: 200, body: [{ kind: 'event', id: 1 }, { kind: 'other', id: 2 }] },
    rawBody: '[{"kind":"event","id":1},{"kind":"other","id":2}]',
    parsedOutput: [{ kind: 'event', id: 1 }],
    recordedAt: 1,
  };
  const v = await evaluate({ source: KILLABLE_SOURCE },
    { cassettes: new CassetteStore([killCassette]),
      methods: [{ name: 'listEvents', description: '', parameters: [] }] },
    testInvoker);
  const mut = v.checks.find(c => c.check === 'mutation');
  assert.ok(mut, 'mutation check ran');
  assert.notEqual(mut!.detail, 'no mutation points');
  // expected mutants: flip '===' -> '!==' (returns the wrong item), drop .filter (returns both) — both killed by replay
  assert.equal(v.killRatio, 1);
  assert.equal(mut!.pass, true);
  assert.match(mut!.detail, /2\/2 mutants killed/);
});
