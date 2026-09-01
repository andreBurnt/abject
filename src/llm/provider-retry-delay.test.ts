/**
 * RetryOptions.delayMs override — lets a provider substitute its own
 * per-error delay policy for the exponential backoff.
 * Run: pnpm tsx --test src/llm/provider-retry-delay.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetries, EmptyCompletionError } from './provider.js';

test('delayMs override replaces exponential backoff', async () => {
  const delays: number[] = [];
  let calls = 0;
  const started = Date.now();
  const result = await withRetries(async () => {
    calls++;
    if (calls < 3) throw new EmptyCompletionError('empty', 'stop');
    return 'ok';
  }, {
    isRetryable: () => true,
    delayMs: (err, _attempt, dflt) => (err instanceof EmptyCompletionError ? 0 : dflt),
    onRetry: (_e, _a, d) => { delays.push(d); },
  });
  assert.equal(result, 'ok');
  assert.deepEqual(delays, [0, 0]);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms — backoff not bypassed`);
});

test('without delayMs the exponential defaults stand', async () => {
  const delays: number[] = [];
  let calls = 0;
  await withRetries(async () => {
    calls++;
    if (calls < 2) throw new Error('transient');
    return 'ok';
  }, {
    isRetryable: () => true,
    initialDelayMs: 10,
    onRetry: (_e, _a, d) => { delays.push(d); },
  });
  assert.deepEqual(delays, [10]);
});
