/** Run: pnpm tsx --test src/protocol/cassette-recorder.test.ts */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setRecorder, clearRecorder, beforeRequest, afterResponse } from './cassette-recorder.js';
import { CassetteStore, HTTP_CASSETTE_METHOD } from './cassette.js';

afterEach(() => clearRecorder('obj-1'));

test('record mode captures 2xx with raw AND parsed body; non-2xx is not recorded', () => {
  const store = new CassetteStore();
  let persisted = 0;
  setRecorder('obj-1', { mode: 'record', store, onRecord: () => persisted++ });
  afterResponse('obj-1', { method: 'GET', url: 'https://example.test/a' },
    { status: 200, body: { ok: 1 }, rawBody: '{"ok":1}' });
  afterResponse('obj-1', { method: 'GET', url: 'https://example.test/b' },
    { status: 500, body: 'boom', rawBody: 'boom' });
  assert.equal(store.all().length, 1);
  assert.equal(persisted, 1);
  const [c] = store.all();
  assert.equal(c.method, HTTP_CASSETTE_METHOD);
  assert.equal(c.rawBody, '{"ok":1}');
  assert.deepEqual(c.parsedOutput, { ok: 1 });
});

test('a JSON string primitive survives the record/replay round-trip verbatim', () => {
  const store = new CassetteStore();
  setRecorder('obj-1', { mode: 'record', store });
  // The world sent the four characters `"hi"`; JSON.parse of that is `hi`.
  afterResponse('obj-1', { method: 'GET', url: 'https://example.test/s' },
    { status: 200, body: 'hi', rawBody: '"hi"' });
  setRecorder('obj-1', { mode: 'replay', store });
  const hit = beforeRequest('obj-1', { method: 'GET', url: 'https://example.test/s' });
  assert.equal(hit?.rawBody, '"hi"');
});

test('replay mode serves recorded responses and throws on a miss', () => {
  const store = new CassetteStore();
  setRecorder('obj-1', { mode: 'record', store });
  afterResponse('obj-1', { method: 'GET', url: 'https://example.test/a' },
    { status: 200, body: { ok: 1 }, rawBody: '{"ok":1}' });
  setRecorder('obj-1', { mode: 'replay', store });
  const hit = beforeRequest('obj-1', { method: 'GET', url: 'https://example.test/a' });
  assert.equal(hit?.status, 200);
  assert.equal(hit?.rawBody, '{"ok":1}');
  assert.throws(() => beforeRequest('obj-1', { method: 'GET', url: 'https://example.test/miss' }),
    /replay miss/);
});

test('unknown object id and live mode pass through', () => {
  assert.equal(beforeRequest(undefined, { method: 'GET', url: 'https://x.test/' }), undefined);
  assert.equal(beforeRequest('never-registered', { method: 'GET', url: 'https://x.test/' }), undefined);
});
