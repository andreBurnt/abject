/**
 * Standing regression guards for AntigravityCliProvider's model registry
 * and retry policy. Runs on Node's built-in test runner, no new deps:
 *   pnpm tsx --test src/llm/antigravity-cli.test.ts
 *
 * The live-CLI check skips cleanly when `agy` is not installed, so this
 * file costs nothing on a machine without Antigravity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

test('sunset gemini-3.5 ids migrate saved routing to the current line, same effort', async () => {
  const migrations = provider.describe().modelMigrations ?? {};
  const ids = new Set((await provider.listModels()).map(m => m.id));
  for (const suffix of ['high', 'medium', 'low']) {
    const from = `gemini-3.5-flash-${suffix}`;
    const to = migrations[from];
    assert.equal(to, `gemini-3.7-flash-${suffix}`, `sunset id ${from} should migrate to the 3.7 line`);
    assert.ok(ids.has(to), `migration target ${to} not in AGY_MODELS`);
  }
});

// Registry staleness tripwire: the hardcoded catalog must match the live
// CLI. It fires only on a successful listing that lacks one of our ids —
// exactly how it caught the gemini-3.5 sunset the day this file was
// written. Skips when the binary is absent.
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
