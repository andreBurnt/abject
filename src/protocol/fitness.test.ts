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
