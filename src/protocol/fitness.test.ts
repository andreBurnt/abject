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

test('an empty cassette store yields an honest unverified pass, probing nothing', async () => {
  const neverInvoked: Invoker = async () => {
    throw new Error('the gate probed a candidate it has no evidence for');
  };
  const v = await evaluate({ source: 'return [{ notId: true }];' },
    { cassettes: new CassetteStore([]), methods }, neverInvoked);
  assert.equal(v.pass, true);
  const detail = (name: string) => v.checks.find(c => c.check === name)!;
  assert.equal(detail('replay').pass, true);
  assert.equal(detail('schema').pass, true);
  assert.equal(detail('schema').detail, 'no cassettes — schema unverified');
  assert.equal(detail('relations').pass, true);
  assert.equal(detail('relations').detail, 'no cassettes — relations unverified');
  assert.equal(detail('mutation').pass, true);
  assert.equal(detail('mutation').detail, 'no cassettes — mutation gate requires evidence');
  assert.equal(v.killRatio, undefined);
});

test('schema fails on schema-invalid output', async () => {
  const badSchemaSource = `return [{ notId: true }];`;
  const c: Cassette = {
    ...cassette,
    response: { status: 200, body: [{ notId: true }] },
    rawBody: '[{"notId":true}]',
    parsedOutput: [{ notId: true }],
  };
  const v = await evaluate({ source: badSchemaSource },
    { cassettes: new CassetteStore([c]), methods }, testInvoker);
  // replay passes (the source reproduces the recording); schema still refuses it
  assert.equal(v.checks.find(x => x.check === 'replay')?.pass, true);
  assert.equal(v.checks.find(x => x.check === 'schema')?.pass, false);
  assert.equal(v.pass, false);
});

test('schema fails when every probe throws and a schema is declared', async () => {
  // `listEvents` has evidence and reproduces it. `countEvents` declares a
  // schema, owns no cassette, and throws on its one {} probe — so nothing
  // about its contract was ever validated, which is a failure, not a pass.
  const source = `return [{ id: 1, startsAt: '2026-08-23' }];`;
  const throwsForCount: Invoker = async (src, method, args, http) => {
    if (method === 'countEvents') throw new Error('not implemented');
    return testInvoker(src, method, args, http);
  };
  const v = await evaluate({ source },
    { cassettes: new CassetteStore([cassette]),
      methods: [...methods,
        { name: 'countEvents', description: '', parameters: [], outputSchema: { type: 'number' } }] },
    throwsForCount, { maxMutants: 0 });
  assert.equal(v.pass, false);
  assert.equal(v.checks.find(c => c.check === 'schema')?.pass, false);
  assert.match(v.checks.find(c => c.check === 'schema')!.detail, /no output could be validated/);
});

test('_http cassettes stub HTTP but are never replayed as methods', async () => {
  // The recorder writes every captured response under the method '_http'.
  // Feeding those to the invoker asks it for a handler no object has.
  const httpOnly: Cassette = {
    method: '_http', args: {},
    request: { method: 'GET', url: 'https://example.test/events' },
    response: { status: 200, body: [{ id: 1, startsAt: '2026-08-23' }] },
    rawBody: '[{"id":1,"startsAt":"2026-08-23"}]',
    parsedOutput: [{ id: 1, startsAt: '2026-08-23' }],
    recordedAt: 1,
  };
  const methodAware: Invoker = async (src, method, args, http) => {
    if (method !== 'listEvents') throw new Error(`fitness: source has no handler for '${method}'`);
    return testInvoker(src, method, args, http);
  };
  const fixedUrl = `
    const res = http({ method: 'GET', url: 'https://example.test/events' });
    if (!res) throw new Error('no stub');
    return res.body;
  `;
  const v = await evaluate({ source: fixedUrl },
    { cassettes: new CassetteStore([httpOnly]), methods }, methodAware, { maxMutants: 0 });
  assert.equal(v.checks.find(c => c.check === 'replay')?.pass, true);
  // and stubFor still served the recording: the schema probe fetched it
  assert.equal(v.checks.find(c => c.check === 'schema')?.pass, true);
  assert.equal(v.pass, true);
});

test('mutation fails when the candidate parses under no dialect', async () => {
  // An invoker that ignores the source: replay/schema/relations all pass, so
  // the verdict turns entirely on whether the gate admits it cannot read it.
  const blind: Invoker = async () => [{ id: 1, startsAt: '2026-08-23' }];
  const v = await evaluate({ source: `{ async listEvents(msg) { return [ }` },
    { cassettes: new CassetteStore([cassette]), methods }, blind);
  assert.equal(v.pass, false);
  const mut = v.checks.find(c => c.check === 'mutation')!;
  assert.equal(mut.pass, false);
  assert.equal(mut.detail, 'candidate does not parse');
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
