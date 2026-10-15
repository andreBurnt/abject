import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Sandbox } from '../core/sandbox.js';
import { ScriptableAbject } from './scriptable-abject.js';
import { request } from '../core/message.js';
import { MessageBus } from '../runtime/message-bus.js';

test('JavaScript helpers receive copies and answers come back as copies', async () => {
  const data = { count: 2, bytes: new Uint8Array([1, 2]) };
  let received: unknown;
  const sandbox = new Sandbox({ filename: 'copies.js', sliceMs: 1000, asyncHelpers: {
    invoke: async (value: unknown) => { received = value; return { count: 3 }; },
  } });
  try {
    sandbox.setGlobals({ data });
    const result = await sandbox.run(sandbox.compileBody('const answer = await invoke(data); data.count = answer.count; return data;')) as typeof data;
    assert.deepEqual(received, data, 'the helper sees the same values');
    assert.notEqual(received, data, 'but not the same object');
    assert.equal(result.count, 3);
    assert.ok(result.bytes instanceof Uint8Array);
    assert.equal(data.count, 2, 'the host value is untouched');
  } finally { sandbox.dispose(); }
});

test('handler compilation supports factories, computed names and synchronous return values', () => {
  const sandbox = new Sandbox({ filename: 'handlers.js', sliceMs: 1000, data: true });
  try {
    sandbox.writeData({ count: 2 });
    sandbox.installHandlers('(() => { let calls = 0; return { ["increment"]() { calls++; return this.data.count += calls; } }; })()');
    assert.deepEqual(sandbox.invoke('increment'), { sync: true, value: 3 });
    assert.deepEqual(sandbox.invoke('increment'), { sync: true, value: 5 });
    assert.equal(sandbox.readData().count, 5);
  } finally { sandbox.dispose(); }
});

test('a runaway loop is stopped, before and after an await', async () => {
  const sandbox = new Sandbox({ filename: 'runaway.js', sliceMs: 25 });
  try {
    await assert.rejects(sandbox.run(sandbox.compileBody('while (true) {}')), /without pausing/);
  } finally { sandbox.dispose(); }
  // After an await the loop runs as a promise continuation. The test runner
  // enables async hooks, and Node aborts the process when such a continuation
  // is stopped while a hook is enabled, so this half runs in a plain process.
  const script = `
    const { Sandbox } = await import(${JSON.stringify(new URL('../core/sandbox.ts', import.meta.url).href)});
    const sandbox = new Sandbox({ filename: 'runaway.js', sliceMs: 25, asyncHelpers: { pause: async () => undefined } });
    const err = await sandbox.run(sandbox.compileBody('await pause(); while (true) {}')).catch(e => e);
    const ok = await sandbox.run(sandbox.compileBody('await pause(); return 7;'));
    process.stdout.write(JSON.stringify({ stopped: /without pausing/.test(err && err.message), ok }));`;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  assert.deepEqual(JSON.parse(out), { stopped: true, ok: 7 });
});

test('scripted message handlers keep synchronous results and track asynchronous lifecycle work', async () => {
  const source = `({ sync() { return 7; }, async asyncResult() { return 8; },
    throws() { throw new Error('sync failure'); }, async rejects() { throw new Error('async failure'); } })`;
  const object: any = new ScriptableAbject({ name: 'HandlerFixture', version: '1', description: 'fixture',
    interface: { id: 'fixture:handler', name: 'HandlerFixture', description: 'fixture', methods: [] } }, source, 'owner');
  await object.init(new MessageBus());
  try {
  const call = (method: string) => object.handlers.get(method)(request(object.id, object.id, method, {}));
  // Exercise initial installation and replacement: both used to force async dispatch.
  for (let pass = 0; pass < 2; pass++) {
    assert.equal(call('sync'), 7, 'no Promise allocated for a synchronous message');
    assert.equal(object.activeUserCalls, 0);
    assert.throws(() => call('throws'), /sync failure/);
    assert.equal(object.activeUserCalls, 0);
    const pending = call('asyncResult');
    assert.equal(object.activeUserCalls, 1, 'cross-realm async work keeps activation blocked');
    assert.equal(await pending, 8);
    assert.equal(object.activeUserCalls, 0);
    await assert.rejects(call('rejects'), /async failure/);
    assert.equal(object.activeUserCalls, 0);
    object.activating = true;
    assert.throws(() => call('sync'), /Source activation in progress/);
    object.activating = false;
    assert.equal(object.applySource(source).success, true);
  }
  } finally { await object.stop(); }
});
