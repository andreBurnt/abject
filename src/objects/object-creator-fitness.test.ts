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
    if (!res.ok) throw new Error('http ' + res.status);
    return JSON.parse(res.body);
  }
}`;

const cassette: Cassette = {
  method: 'listEvents', args: {},
  request: { method: 'GET', url: 'https://example.test/events' },
  response: { status: 200, body: [{ id: 1 }] },
  rawBody: '[{"id":1}]',
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

test("the HttpClient shim returns the shape HttpClient's ask guide teaches", async () => {
  // { status, statusText, headers, body, ok } with body ALWAYS a raw string.
  const echoShape = `{
    async listEvents(msg) {
      const res = await call('HttpClient', 'get', { url: 'https://example.test/events' });
      return { keys: Object.keys(res).sort(), bodyType: typeof res.body, body: res.body, ok: res.ok, status: res.status };
    }
  }`;
  const out = await buildSandboxInvoker()(echoShape, 'listEvents', {},
    () => ({ status: 200, body: [{ id: 1 }], rawBody: '[{"id":1}]' }));
  // Structural, not deepEqual: the value crosses out of the vm realm, so its
  // prototype is not this realm's Object.prototype.
  const got = out as Record<string, unknown>;
  assert.deepEqual([...(got.keys as string[])], ['body', 'headers', 'ok', 'status', 'statusText']);
  assert.equal(got.bodyType, 'string');
  assert.equal(got.body, '[{"id":1}]');
  assert.equal(got.ok, true);
  assert.equal(got.status, 200);
});

test('WebFetch is not stubbed: its live shape is not an HttpResponse', async () => {
  const webFetcher = `{
    async listEvents(msg) { return call('WebFetch', 'fetch', { url: 'https://example.test/events' }); }
  }`;
  const v = await evaluate({ source: webFetcher },
    { cassettes: new CassetteStore([cassette]), methods }, buildSandboxInvoker(), { maxMutants: 0 });
  assert.equal(v.pass, false);
  assert.match(v.checks[0].detail, /unstubbed I\/O -- call\('WebFetch'/);
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
