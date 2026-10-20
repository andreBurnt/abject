/**
 * The V8 heap budget every isolate in this process shares, when there is one.
 *
 * Electron builds V8 with pointer compression in a single shared cage, so the
 * main thread and every worker thread allocate their JavaScript heaps from the
 * same ~4 GB. Measured on Electron 35 and 44 (Oct 2026): one worker allowed
 * 8 GB dies near 3.9 GB, three together near 1.4 GB each. A worker's own
 * `resourceLimits` above what is left in the cage never fire; the cage runs
 * out first, and V8 then aborts the whole process from whichever isolate
 * allocates next, often a small one. Below the cage a worker's limit works:
 * the worker is stopped (`ERR_WORKER_OUT_OF_MEMORY`) and the process lives.
 *
 * Plain Node (the headless edition, dev servers) gives each isolate its own
 * space, so there is no shared budget there.
 */

/** The shared cage's size in MB: V8's pointer-compression cage is 4 GB. */
export const SHARED_HEAP_CAGE_MB = 4096;

/** The shared heap budget in MB, or undefined when isolates do not share one. */
export function sharedHeapCageMb(): number | undefined {
  const versions = typeof process !== 'undefined' ? process.versions as Record<string, string | undefined> | undefined : undefined;
  return typeof versions?.electron === 'string' ? SHARED_HEAP_CAGE_MB : undefined;
}
