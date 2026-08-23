/** Run: pnpm tsx --test src/protocol/cassette.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CassetteStore, redactRequest, CASSETTE_CAP_PER_METHOD, type Cassette } from './cassette.js';

function mk(n: number, method = 'listEvents'): Cassette {
  return {
    method, args: { q: n },
    request: { method: 'GET', url: `https://example.test/events?q=${n}` },
    response: { status: 200, body: [{ id: n }] },
    parsedOutput: [{ id: n }],
    recordedAt: n,
  };
}

test('redactRequest strips credential headers case-insensitively', () => {
  const r = redactRequest({
    method: 'GET', url: 'https://example.test/x',
    headers: { Authorization: 'Bearer s3cret', 'X-Ok': 'yes', COOKIE: 'a=1', 'set-cookie': 'b=2' },
  });
  assert.deepEqual(r.headers, { 'X-Ok': 'yes' });
});

test('store caps per method with LRU eviction', () => {
  const s = new CassetteStore();
  for (let i = 0; i < CASSETTE_CAP_PER_METHOD + 5; i++) s.add(mk(i));
  const kept = s.byMethod('listEvents');
  assert.equal(kept.length, CASSETTE_CAP_PER_METHOD);
  assert.equal(kept[0].recordedAt, 5); // 0..4 evicted
});

test('matchRequest finds exact url, then host+path fallback', () => {
  const s = new CassetteStore([mk(1)]);
  assert.ok(s.matchRequest({ method: 'GET', url: 'https://example.test/events?q=1' }));
  assert.ok(s.matchRequest({ method: 'GET', url: 'https://example.test/events?q=other' }));
  assert.equal(s.matchRequest({ method: 'GET', url: 'https://elsewhere.test/events' }), undefined);
});

test('toJSON/fromJSON round-trips and skips malformed entries', () => {
  const s = new CassetteStore([mk(1), mk(2)]);
  const back = CassetteStore.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(back.all().length, 2);
  const dirty = CassetteStore.fromJSON([mk(3), { junk: true }, 42]);
  assert.equal(dirty.all().length, 1);
});
