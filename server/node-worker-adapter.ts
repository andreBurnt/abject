/**
 * Node.js worker_threads adapter for WorkerLike interface.
 *
 * Wraps a Node.js Worker (from worker_threads) to implement the
 * cross-platform WorkerLike interface used by WorkerBridge.
 */

import { Worker as NodeWorker } from 'node:worker_threads';
import * as os from 'node:os';
import type { WorkerLike } from '../src/runtime/worker-bridge.js';
import { sharedHeapCageMb } from '../src/runtime/heap-cage.js';

/** Workers the process will run (pool plus dedicated), for sizing heaps. */
let plannedWorkers = 1;

/**
 * Tell the adapter how many workers the process will run, before creating
 * any. The heap ceiling per worker is sized from it (see workerHeapMb).
 */
export function planWorkerHeaps(totalWorkers: number): void {
  plannedWorkers = Math.max(1, Math.floor(totalWorkers));
}

/** Kept for the main thread out of a shared heap cage, with GC headroom. */
const CAGE_MAIN_RESERVE_MB = 512;
/**
 * The part of a shared cage (after the main thread's reserve) one worker may
 * grow into. A runaway worker stops at it, while the rest of the threads still
 * have the other 55% between them: about 2 GB, where each rests near 35 MB
 * (measured Oct 2026, desktop edition, 11 isolates, 331 MB together).
 */
const CAGE_RUNAWAY_SHARE = 0.45;

/**
 * The heap ceiling for each worker: ABJECTS_WORKER_MAX_OLD_SPACE_MB if set,
 * otherwise three quarters of the machine's memory (less 512 MB for the main
 * thread and the system) shared across the planned workers, between 512 MB
 * and 8 GB. A fixed 8 GB on a 2 to 4 GB VM let a runaway worker take the
 * whole machine down rather than be stopped at its own limit.
 *
 * Where every isolate shares one heap cage (the desktop app, see
 * src/runtime/heap-cage.ts), a ceiling the cage cannot hold never fires: the
 * cage fills first and V8 aborts the whole process. There the ceiling is the
 * runaway share of the cage instead, so a worker that keeps growing is stopped
 * at its own limit and recovered while the process lives.
 */
export function workerHeapMb(totalMemBytes = os.totalmem(), workers = plannedWorkers, cageMb = sharedHeapCageMb()): number {
  const envMb = Number(process.env.ABJECTS_WORKER_MAX_OLD_SPACE_MB);
  if (Number.isFinite(envMb) && envMb > 0) return envMb;
  const totalMb = totalMemBytes / (1024 * 1024);
  const share = Math.floor(((totalMb - 512) * 0.75) / Math.max(1, workers));
  const ceiling = Math.min(8192, Math.max(512, share));
  if (cageMb === undefined) return ceiling;
  return Math.min(ceiling, Math.floor((cageMb - CAGE_MAIN_RESERVE_MB) * CAGE_RUNAWAY_SHARE));
}

/** Running compiled (dist-server or the desktop app): workers are .js, not .ts. */
const compiled = !!process.env.ELECTRON_PACKAGED || import.meta.url.endsWith('.js');

export class NodeWorkerAdapter implements WorkerLike {
  private worker: NodeWorker;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onexit: ((event: { code: number }) => void) | null = null;

  constructor(scriptPath: string | URL) {
    const href = scriptPath instanceof URL ? scriptPath.href : new URL(scriptPath).href;

    const resourceLimits = { maxOldGenerationSizeMb: workerHeapMb() };

    if (compiled) {
      // Compiled mode: workers are pre-compiled JS. Swap .ts extension to .js.
      const jsHref = href.replace(/\.ts$/, '.js');
      this.worker = new NodeWorker(new URL(jsHref), { resourceLimits });
    } else {
      // Dev mode: worker_threads doesn't inherit tsx's TypeScript loader,
      // so we use eval mode to register tsx/esm/api inside the worker
      // before importing the actual script.
      this.worker = new NodeWorker(
        `import('tsx/esm/api').then(({ register }) => { register(); return import('${href}') })`,
        { eval: true, resourceLimits },
      );
    }

    this.worker.on('message', (data) => {
      // tsx/Node `--watch` mode instruments worker threads to report every
      // module they import/require back to the parent via the worker's parent
      // port (e.g. `{ 'watch:import': [...] }`). These internal watch messages
      // are not part of the Abject worker protocol — drop them so they don't
      // flood the bridge as "Unknown message type from worker".
      if (data && typeof data === 'object') {
        const keys = Object.keys(data as Record<string, unknown>);
        if (keys.length === 1 && keys[0].startsWith('watch:')) {
          return;
        }
      }
      this.onmessage?.({ data });
    });

    this.worker.on('error', (err: Error) => {
      this.onerror?.({ message: err.message });
    });

    this.worker.on('exit', (code: number) => {
      this.onexit?.({ code });
    });
  }

  postMessage(data: unknown, transferList?: unknown[]): void {
    if (transferList && transferList.length > 0) {
      this.worker.postMessage(data, transferList as import('node:worker_threads').TransferListItem[]);
    } else {
      this.worker.postMessage(data);
    }
  }

  terminate(): void {
    this.worker.terminate();
  }
}
