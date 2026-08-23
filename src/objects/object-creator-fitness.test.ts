// Run: pnpm tsx --test src/objects/object-creator-fitness.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildSandboxInvoker } from '../protocol/sandbox-invoker.js';
import { deployGate, evaluate } from '../protocol/fitness.js';
import { CassetteStore, type Cassette } from '../protocol/cassette.js';
import type { MethodDeclaration } from '../core/types.js';

const HANDLER_MAP = `{
  async listEvents(msg) {
    const res = await call('HttpClient', 'get', { url: 'https://example.test/events' });
    return res.body;
  }
}`;

const cassette: Cassette = {
  method: 'listEvents', args: {},
  request: { method: 'GET', url: 'https://example.test/events' },
  response: { status: 200, body: [{ id: 1 }] },
  parsedOutput: [{ id: 1 }],
  recordedAt: 1,
};
const methods: MethodDeclaration[] = [{ name: 'listEvents', description: '', parameters: [] }];

test('sandbox invoker runs a handler map with HTTP served from cassettes', async () => {
  const invoker = buildSandboxInvoker();
  const v = await evaluate({ source: HANDLER_MAP },
    { cassettes: new CassetteStore([cassette]), methods }, invoker, { maxMutants: 0 });
  assert.equal(v.pass, true);
});

test('sandbox invoker refuses unstubbed I/O', async () => {
  const leaky = `{
    async listEvents(msg) { return call('ShellExecutor', 'run', { command: 'ls' }); }
  }`;
  const invoker = buildSandboxInvoker();
  const v = await evaluate({ source: leaky },
    { cassettes: new CassetteStore([cassette]), methods }, invoker, { maxMutants: 0 });
  assert.equal(v.pass, false);
  assert.match(v.checks[0].detail, /unstubbed I\/O/);
});

test('deployGate refuses without a verdict, with a failed verdict, and on a stale digest', () => {
  const src = 'return 1;';
  const digest = createHash('sha256').update(src).digest('hex');
  assert.equal(deployGate({}, src).ok, false);
  assert.equal(deployGate({ fitnessVerdict: { pass: false, checks: [] }, fitnessSourceDigest: digest }, src).ok, false);
  assert.equal(deployGate({ fitnessVerdict: { pass: true, checks: [] }, fitnessSourceDigest: digest }, 'return 2;').ok, false);
  assert.equal(deployGate({ fitnessVerdict: { pass: true, checks: [] }, fitnessSourceDigest: digest }, src).ok, true);
});
