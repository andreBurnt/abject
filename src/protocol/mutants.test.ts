/** Run: pnpm tsx --test src/protocol/mutants.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMutants } from './mutants.js';

const SRC = `
  const res = http({ method: 'GET', url: 'https://example.test/events' });
  const items = res.body.filter(e => e.kind === 'event');
  if (items.length > 0) { return items; }
  return [];
`;

test('generates deterministic, distinct mutants up to max', () => {
  const a = generateMutants(SRC, 12);
  const b = generateMutants(SRC, 12);
  assert.deepEqual(a.map(m => m.source), b.map(m => m.source));
  assert.ok(a.length >= 3, `expected >=3 mutants, got ${a.length}`);
  assert.equal(new Set(a.map(m => m.source)).size, a.length);
  for (const m of a) assert.notEqual(m.source, SRC);
});

test('respects max', () => {
  assert.ok(generateMutants(SRC, 2).length <= 2);
});

test('source with no mutation points yields none', () => {
  assert.equal(generateMutants(`return 42;`, 12).length, 0);
});
