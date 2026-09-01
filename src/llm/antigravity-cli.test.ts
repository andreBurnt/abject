/**
 * AntigravityCliProvider latency remediation (LINC#571):
 * explicit tier defaults + zero-delay empty-completion resample.
 * Run: pnpm tsx --test src/llm/antigravity-cli.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AntigravityCliProvider, AGY_TIER_MODELS, agyRetryDelayMs,
} from './antigravity-cli.js';
import { EmptyCompletionError } from './provider.js';

const provider = new AntigravityCliProvider();

test('tier defaults are explicit effort-suffixed models, never auto', async () => {
  const ids = new Set((await provider.listModels()).map(m => m.id));
  for (const [tier, model] of Object.entries(AGY_TIER_MODELS)) {
    assert.notEqual(model, 'auto', `${tier} must not default to auto`);
    assert.match(model, /-(low|medium|high)$/, `${tier} model ${model} lacks effort suffix`);
    assert.ok(ids.has(model), `${tier} model ${model} not in AGY_MODELS`);
  }
  assert.deepEqual(provider.describe().defaultTierModels, AGY_TIER_MODELS);
});

test('resolveModel: explicit model > tier default > auto', () => {
  assert.equal(provider.resolveModel({ model: 'gemini-3.1-pro-low' }), 'gemini-3.1-pro-low');
  assert.equal(provider.resolveModel({ tier: 'fast' }), 'gemini-3.7-flash-low');
  assert.equal(provider.resolveModel({ model: 'claude-sonnet-4-6', tier: 'fast' }), 'claude-sonnet-4-6');
  assert.equal(provider.resolveModel(), 'auto');
});

test('agyRetryDelayMs: empty completions resample instantly, transient errors keep backoff', () => {
  assert.equal(agyRetryDelayMs(new EmptyCompletionError('empty', 'stop'), 1, 1000), 0);
  assert.equal(agyRetryDelayMs(new EmptyCompletionError('empty', 'stop'), 3, 4000), 0);
  assert.equal(agyRetryDelayMs(new Error('idle for 360000ms'), 1, 1000), 1000);
  assert.equal(agyRetryDelayMs(new Error('boom'), 3, 4000), 4000);
});

/** A fake agy that ends a turn cleanly with an empty response every time. */
function fakeEmptyAgy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-agy-'));
  const bin = join(dir, 'agy');
  writeFileSync(bin, '#!/bin/sh\n'
    + 'echo \'{"event":"result","result":{"status":"SUCCESS","response":"","usage":{"input_tokens":1,"output_tokens":0}}}\'\n');
  chmodSync(bin, 0o755);
  return bin;
}

test('empty-completion retries resample instantly on the stream path', async () => {
  const p = new AntigravityCliProvider({ bin: fakeEmptyAgy() });
  const started = Date.now();
  const chunks = [];
  for await (const c of p.stream([{ role: 'user', content: 'hi' }])) chunks.push(c);
  const elapsed = Date.now() - started;
  const last = chunks[chunks.length - 1];
  assert.equal(last.done, true);
  assert.equal(last.stopReason, 'stop');
  // 3 attempts with the old 1s+2s ladder floor at >=3000ms; instant resample
  // is spawn-bound (~tens of ms per attempt).
  assert.ok(elapsed < 1500, `3 empty attempts took ${elapsed}ms — backoff not bypassed`);
});

test('empty-completion retries resample instantly on the complete path', async () => {
  const p = new AntigravityCliProvider({ bin: fakeEmptyAgy() });
  const started = Date.now();
  await assert.rejects(
    () => p.complete([{ role: 'user', content: 'hi' }]),
    (e: unknown) => e instanceof EmptyCompletionError,
  );
  assert.ok(Date.now() - started < 1500, 'complete() backoff not bypassed');
});

test('sunset gemini-3.5 ids migrate saved routing to live models', async () => {
  const migrations = provider.describe().modelMigrations ?? {};
  const ids = new Set((await provider.listModels()).map(m => m.id));
  for (const suffix of ['high', 'medium', 'low']) {
    const from = `gemini-3.5-flash-${suffix}`;
    const to = migrations[from];
    assert.ok(to, `no migration for sunset id ${from}`);
    assert.ok(ids.has(to), `migration target ${to} not in AGY_MODELS`);
  }
});

// Staleness tripwire (council ask): the hardcoded registry must match the
// live CLI. Skips when agy is unavailable — it fires only on a successful
// listing that lacks one of our IDs (e.g. Google sunsets the 3.7 line).
test('AGY_MODELS matches live `agy models` output', async (t) => {
  let out: string;
  try {
    out = execFileSync('agy', ['models'], { encoding: 'utf8', timeout: 30_000 });
  } catch {
    t.skip('agy binary unavailable — tripwire needs a live CLI');
    return;
  }
  const live = new Set(
    out.split('\n').filter(l => l.includes('\t')).map(l => l.split('\t')[0].trim()),
  );
  for (const m of await provider.listModels()) {
    if (m.id === 'auto') continue;
    assert.ok(live.has(m.id), `${m.id} vanished from \`agy models\` — update AGY_MODELS + AGY_TIER_MODELS`);
  }
});
