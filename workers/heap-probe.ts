/**
 * Heap probe for a worker thread.
 *
 * Only code inside an isolate can read its heap, so every worker (the pool's,
 * and the dedicated UI and P2P workers) measures itself and posts
 * `worker:heap` to its bridge every 30s; the HeapMonitor abject on main holds
 * every judgement about the numbers. In the desktop app all isolates draw
 * from one shared heap cage (src/runtime/heap-cage.ts), so a thread left
 * unmeasured is a share of the budget nobody can see.
 *
 * Where the thread runs sandboxes (generated and package abjects, jobs), each
 * report also carries what every sandbox's abject holds
 * (src/core/sandbox-memory.ts). That measurement waits for the next garbage
 * collection, so it is started with each report and posted in a report of
 * its own as soon as it is in.
 *
 * Unref'd so an idle worker can still exit, and wrapped because a worker
 * being torn down mid-post is ordinary, not an error.
 */

import * as v8 from 'node:v8';
import type { MessagePort } from 'node:worker_threads';
import { SandboxMeter } from '../src/core/sandbox-memory.js';

const HEAP_SAMPLE_MS = 30_000;

/** Report this isolate's heap now and every HEAP_SAMPLE_MS; `objectCount` attributes growth. */
export function startHeapProbe(port: Pick<MessagePort, 'postMessage'>, objectCount: () => number): void {
  const sandboxes = new SandboxMeter(() => report());
  function report(): void {
    const stats = v8.getHeapStatistics();
    const reading = sandboxes.latest;
    try {
      port.postMessage({
        type: 'worker:heap',
        heap: {
          usedBytes: stats.used_heap_size,
          totalBytes: stats.total_heap_size,
          limitBytes: stats.heap_size_limit,
          objectCount: objectCount(),
          at: Date.now(),
          ...(reading ? { sandboxes: reading } : {}),
        },
      });
    } catch { /* worker going down */ }
  }
  function tick(): void {
    report();
    sandboxes.measure();
  }
  const timer = setInterval(tick, HEAP_SAMPLE_MS);
  timer.unref?.();
  // A baseline right away, so a worker is never unobserved for its first
  // half-minute and the monitor has something to compare against.
  tick();
}
