/**
 * HeapMonitor — watches every isolate's heap usage.
 *
 * Each worker (the pool's, and the dedicated UI and P2P workers) measures its
 * own V8 isolate (only code inside an isolate can read its heap) and reports
 * a sample every 30s through its bridge; the WorkerPool keeps the pool's
 * latest readings, boot keeps the dedicated workers', and this abject holds
 * the policy: what counts as elevated, what counts as critical, and what gets
 * logged when an isolate moves between those regimes.
 *
 * The main thread is watched too, and it is not an afterthought: on plain
 * Node its ceiling is roughly half a worker's, so it has the least headroom
 * in the system despite hosting the least. Running here is what makes
 * reading it free.
 *
 * In the desktop app every isolate also draws from one shared heap cage
 * (src/runtime/heap-cage.ts): ~4 GB for the main thread and all workers
 * together, and when it fills, the whole process aborts from whichever
 * isolate allocates next. Each isolate can sit far below its own ceiling
 * while the sum reaches the cage, so the monitor watches the sum as well,
 * and names who holds it when it climbs.
 *
 * It also acts, on user abjects only. Generated and package abjects run in
 * sandboxes, and every thread reports what each one's sandbox holds
 * (src/core/sandbox-memory.ts). One holding more than a quarter of its
 * thread's ceiling, or the largest on a thread or cage gone critical, is
 * asked to restart in a fresh sandbox with its data (`freeMemory` on
 * ScriptableAbject). One that needs it again within ten minutes is stopped,
 * its saved copy kept: the restart did not free what it holds. Built-in
 * objects are never restarted here; they are expected not to leak, and a
 * thread that fills with no user abject to blame meets its own ceiling.
 *
 * Main-thread only, and absent from workerEligible on purpose: it reads the
 * pool's heap reports, and an object watching for a worker to die cannot
 * live inside one.
 */

import { AbjectId, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { invariant } from '../core/contracts.js';
import { request } from '../core/message.js';
import { Log } from '../core/timed-log.js';
import { SandboxMeter, type SandboxHeap } from '../core/sandbox-memory.js';
import type { WorkerPool } from '../runtime/worker-pool.js';
import type { WorkerHeapSample } from '../runtime/worker-bridge.js';
import { sharedHeapCageMb } from '../runtime/heap-cage.js';

const log = new Log('HeapMonitor');

export const HEAP_MONITOR_ID = 'abjects:heap-monitor' as AbjectId;

const HEAP_MONITOR_INTERFACE: InterfaceId = 'abjects:heap-monitor';

/** How often the monitor looks at the pool's latest readings. */
const POLL_MS = 15_000;

/** Fraction of the isolate's ceiling at which usage is logged as elevated. */
const ELEVATED_FRACTION = 0.75;

/** Fraction of the ceiling at which usage is logged as critical. */
const CRITICAL_FRACTION = 0.9;

/**
 * Share of its thread's heap ceiling one user abject's sandbox may hold;
 * past it the abject is restarted with its data. A quarter catches one
 * leaking object well before its thread, and every object on it, is at risk
 * (about 430 MB in the desktop app).
 */
const USER_ABJECT_SHARE = 0.25;

/**
 * When a thread, or the cage every thread shares, is critical, its largest
 * user abject is restarted if it holds at least this share of its thread's
 * ceiling; restarting a smaller one would not free enough to matter.
 */
const RELIEF_MIN_SHARE = 0.1;

/**
 * A user abject needing a restart again this soon after its last one is
 * stopped instead: the restart did not free what it holds, so what it holds
 * is its data, or it fills up as fast as it is restarted.
 */
const RESTART_WINDOW_MS = 10 * 60_000;

type Regime = 'nominal' | 'elevated' | 'critical';

const megabytes = (n: number): string => `${(n / (1024 * 1024)).toFixed(0)}MB`;

/** The user abjects a reading names, largest first, for a log line. */
function userAbjects(sample: WorkerHeapSample, top = 3): string {
  const owners = sample.sandboxes?.owners ?? [];
  if (owners.length === 0) return '';
  const largest = owners.slice(0, top).map(o => `${o.name} ${megabytes(o.bytes)}`).join(', ');
  return `; ${owners.length} user abject${owners.length === 1 ? '' : 's'}, largest ${largest}`;
}

/** Watch key for the main thread; pool workers use `worker-<index>`. */
const MAIN_SOURCE = 'main';

/** One isolate's latest reading plus the regime the monitor assigned to it. */
export interface HeapWatch {
  /** 'main', 'worker-<index>' for a pool worker, or a dedicated worker's name ('ui', 'p2p'). */
  source: string;
  /** Pool slot. Absent for the main thread, which has no slot. */
  workerIndex?: number;
  sample: WorkerHeapSample;
  /** usedBytes / limitBytes, in [0, 1+]. Values above 1 should not happen. */
  fraction: number;
  regime: Regime;
}

/** The slice of node:v8 this needs, so the import can stay dynamic. */
interface HeapStatsSource {
  getHeapStatistics(): { used_heap_size: number; total_heap_size: number; heap_size_limit: number };
}

/**
 * The process's shared heap cage and how full it is: every isolate's
 * committed heap summed against the cage. Present only where isolates share
 * one (the desktop app).
 */
export interface CageWatch {
  /** Committed heap of every isolate the monitor can read, summed. */
  usedBytes: number;
  limitBytes: number;
  fraction: number;
  regime: Regime;
  /** Isolates counted in usedBytes. */
  isolates: number;
  at: number;
}

export interface HeapMonitorOptions {
  /** The pool to watch. Optional because workers can be disabled. */
  pool?: WorkerPool;
  /** The dedicated workers' latest readings, by name ('ui', 'p2p'), kept current by boot. */
  dedicated?: ReadonlyMap<string, WorkerHeapSample>;
}

function regimeFor(fraction: number): Regime {
  if (fraction >= CRITICAL_FRACTION) return 'critical';
  if (fraction >= ELEVATED_FRACTION) return 'elevated';
  return 'nominal';
}

export class HeapMonitor extends Abject {
  private pool?: WorkerPool;
  private dedicated?: ReadonlyMap<string, WorkerHeapSample>;
  /** Latest reading per source ('main', 'worker-<n>', 'ui', 'p2p'), refreshed on each poll. */
  private watches: Map<string, HeapWatch> = new Map();
  /** The shared heap cage's size, where isolates share one; undefined on plain Node. */
  private readonly cageBytes?: number;
  /** The cage's latest reading, when there is a cage. */
  private cage?: CageWatch;
  private pollTimer?: ReturnType<typeof setInterval>;
  /** The main thread's sandboxes; each worker measures its own. */
  private readonly mainSandboxes = new SandboxMeter();
  /** When each user abject was last restarted or stopped for its memory, within RESTART_WINDOW_MS. */
  private relieved: Map<AbjectId, number> = new Map();
  /**
   * node:v8, when running on Node. Held rather than imported at the top
   * because this module is re-exported from the browser barrel, where a
   * static 'node:v8' import breaks the bundle.
   */
  private heapStats?: HeapStatsSource;

  constructor(options: HeapMonitorOptions = {}) {
    super({
      manifest: {
        name: 'HeapMonitor',
        description:
          'Watches heap usage of the main thread and every worker. Workers sample their own V8 isolate and report through their bridges; this object holds the thresholds and reports the readings. In the desktop app it also watches the sum of all isolates against the heap cage they share. It restarts a user abject (generated or package code) whose sandbox holds more than a quarter of its thread\'s heap, keeping its data, and stops one that fills up again within ten minutes, keeping its saved copy. Built-in objects are never restarted.',
        version: '1.0.0',
        interface: {
          id: HEAP_MONITOR_INTERFACE,
          name: 'HeapMonitor',
          description: 'Worker heap usage monitor',
          methods: [
            {
              name: 'sampleNow',
              description: 'Read every isolate now and return the latest watch for the main thread and each worker, and the shared heap cage reading where there is one',
              parameters: [],
              returns: { kind: 'object', properties: {
                watches: { kind: 'array', elementType: { kind: 'object', properties: {} } },
                cage: { kind: 'object', properties: {} },
              }},
            },
            {
              name: 'getState',
              description: 'Return current watches (each with what its user abjects\' sandboxes hold), the shared heap cage reading (desktop app only), thresholds, and the user abjects restarted or stopped for their memory in the last ten minutes',
              parameters: [],
              returns: { kind: 'object', properties: {
                watches: { kind: 'array', elementType: { kind: 'object', properties: {} } },
                cage: { kind: 'object', properties: {} },
                elevatedFraction: { kind: 'primitive', primitive: 'number' },
                criticalFraction: { kind: 'primitive', primitive: 'number' },
                userAbjectShare: { kind: 'primitive', primitive: 'number' },
                reliefMinShare: { kind: 'primitive', primitive: 'number' },
                restartWindowMs: { kind: 'primitive', primitive: 'number' },
                relieved: { kind: 'array', elementType: { kind: 'object', properties: {
                  id: { kind: 'primitive', primitive: 'string' },
                  at: { kind: 'primitive', primitive: 'number' },
                } } },
                poolAttached: { kind: 'primitive', primitive: 'boolean' },
              }},
            },
          ],
        },
        tags: ['system', 'monitoring'],
      },
    });

    this.pool = options.pool;
    this.dedicated = options.dedicated;
    const cageMb = sharedHeapCageMb();
    if (cageMb !== undefined) this.cageBytes = cageMb * 1024 * 1024;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('sampleNow', async () => {
      const watches = this.readSamples();
      return { watches, cage: this.cage };
    });

    this.on('getState', async () => {
      this.checkInvariants();
      return {
        watches: [...this.watches.values()],
        cage: this.cage,
        elevatedFraction: ELEVATED_FRACTION,
        criticalFraction: CRITICAL_FRACTION,
        userAbjectShare: USER_ABJECT_SHARE,
        reliefMinShare: RELIEF_MIN_SHARE,
        restartWindowMs: RESTART_WINDOW_MS,
        relieved: [...this.relieved].map(([id, at]) => ({ id, at })),
        poolAttached: this.pool !== undefined,
      };
    });
  }

  protected override async onInit(): Promise<void> {
    try {
      this.heapStats = await import('node:v8') as HeapStatsSource;
    } catch {
      // Not on Node — the pool's worker reports still arrive.
    }
    // Take a first reading right away so nothing is unobserved for its first
    // poll interval, then keep polling. Guarded like the poll itself: a
    // monitor that cannot take a reading must still come up, or the one
    // object meant to explain a memory problem is the one that fails to
    // start because of it. The unref keeps an idle runtime able to exit.
    this.pollOnce();
    this.pollTimer = setInterval(() => this.pollOnce(), POLL_MS);
    this.pollTimer.unref?.();
  }

  /** One sweep, with any failure contained to this tick. */
  private pollOnce(): void {
    try {
      this.relieve(this.readSamples());
    } catch (err) {
      log.warn(`Heap poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.mainSandboxes.measure();
  }

  /**
   * Restart, or stop, the user abjects whose sandboxes hold too much: each
   * one past its share of its thread's ceiling, and where a thread or the
   * cage is critical with none past it, the largest one there.
   */
  private relieve(watches: HeapWatch[]): void {
    const now = Date.now();
    for (const [id, at] of this.relieved) if (now - at > RESTART_WINDOW_MS) this.relieved.delete(id);
    let cageRelief: { watch: HeapWatch; reading: SandboxHeap; owner: SandboxHeap['owners'][number] } | undefined;
    for (const watch of watches) {
      const reading = watch.sample.sandboxes;
      if (!reading) continue;
      const ceiling = watch.sample.limitBytes;
      const over = reading.owners.filter(o => o.bytes >= ceiling * USER_ABJECT_SHARE);
      for (const owner of over) {
        this.free(owner, watch, reading, `past the ${megabytes(ceiling * USER_ABJECT_SHARE)} one object may hold`);
      }
      if (over.length > 0) continue;
      const largest = reading.owners[0];
      if (!largest || largest.bytes < ceiling * RELIEF_MIN_SHARE) continue;
      if (watch.regime === 'critical') {
        this.free(largest, watch, reading, `the largest user abject on ${watch.source}, which is nearly full`);
      } else if (this.cage?.regime === 'critical' && (!cageRelief || largest.bytes > cageRelief.owner.bytes)) {
        cageRelief = { watch, reading, owner: largest };
      }
    }
    if (cageRelief) {
      this.free(cageRelief.owner, cageRelief.watch, cageRelief.reading, 'the largest user abject while the heap every thread shares is nearly full');
    }
  }

  /**
   * Ask one user abject to restart with its data, or, when it was restarted
   * within RESTART_WINDOW_MS, to stop. Only a reading begun after the last
   * request is judged, since an earlier one cannot show its effect.
   */
  private free(owner: SandboxHeap['owners'][number], watch: HeapWatch, reading: SandboxHeap, why: string): void {
    const last = this.relieved.get(owner.id);
    if (last !== undefined && reading.startedAt <= last) return;
    const stop = last !== undefined;
    this.relieved.set(owner.id, Date.now());
    const held = `${owner.name} (${owner.id}) on ${watch.source} holds ${megabytes(owner.bytes)} in its sandbox, ${why}`;
    if (stop) log.error(`${held}, again within ${RESTART_WINDOW_MS / 60_000} minutes of a restart; stopping it, its saved copy kept`);
    else log.warn(`${held}; restarting it with its data`);
    const verb = stop ? 'stopped' : 'restarted';
    this.request<{ success?: boolean; error?: string }>(
      request(this.id, owner.id, 'freeMemory', { stop, heldBytes: owner.bytes, limitBytes: watch.sample.limitBytes * USER_ABJECT_SHARE }),
      60_000,
    ).then(
      answer => { if (!answer?.success) log.warn(`${owner.name} was not ${verb}: ${answer?.error ?? 'no answer'}`); },
      err => log.warn(`${owner.name} could not be ${verb}: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  protected override async onStop(): Promise<void> {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.watches.clear();
    this.cage = undefined;
    this.relieved.clear();
  }

  /**
   * Read the main thread, the pool's latest per-worker samples and the
   * dedicated workers', update the watches, and where isolates share a heap
   * cage, the cage's reading.
   *
   * A slot that stops reporting (worker died and its replacement has not
   * sampled yet) drops out of the watches rather than lingering with a stale
   * reading — absence of data is reported as absence.
   */
  private readSamples(): HeapWatch[] {
    const readings: Array<{ source: string; workerIndex?: number; sample: WorkerHeapSample }> = [];

    const local = this.localSample();
    if (local) readings.push({ source: MAIN_SOURCE, sample: local });

    if (this.pool !== undefined) {
      for (const [index, sample] of this.pool.heapSamples()) {
        readings.push({ source: `worker-${index}`, workerIndex: index, sample });
      }
    }
    for (const [name, sample] of this.dedicated ?? []) readings.push({ source: name, sample });

    const reporting = new Set(readings.map((r) => r.source));
    for (const source of [...this.watches.keys()]) {
      if (!reporting.has(source)) this.watches.delete(source);
    }

    const result: HeapWatch[] = [];
    for (const { source, workerIndex, sample } of readings) {
      // A malformed reading is skipped, never thrown on. These numbers cross
      // a thread boundary, so they are input rather than our own state, and
      // a contract violation here would abandon the rest of the sweep and
      // leave every later isolate unread — a monitor that stops monitoring
      // precisely when something has gone wrong.
      if (!(sample.limitBytes > 0) || !(sample.usedBytes >= 0)) {
        log.warn(`${source} reported an unusable heap sample ` +
          `(used=${sample.usedBytes}, limit=${sample.limitBytes}); skipping it this poll`);
        this.watches.delete(source);
        continue;
      }

      const fraction = sample.usedBytes / sample.limitBytes;
      const regime = regimeFor(fraction);
      const previous = this.watches.get(source);
      const watch: HeapWatch = { source, workerIndex, sample, fraction, regime };
      this.watches.set(source, watch);

      // Log on regime change only: an isolate sitting at 80% for an hour is
      // one log entry, not one every poll.
      if (previous === undefined || previous.regime !== regime) {
        this.announce(watch, previous !== undefined);
      }
      result.push(watch);
    }

    if (this.cageBytes !== undefined) this.readCage(result);

    this.checkInvariants();
    return result;
  }

  /**
   * Sum every isolate's committed heap against the shared cage and log when
   * the sum changes regime, naming who holds it. Committed rather than used
   * heap, because committed pages are what the cage hands out; a sum short of
   * an isolate that has not reported yet reads low, never high.
   */
  private readCage(watches: HeapWatch[]): void {
    const limitBytes = this.cageBytes!;
    const usedBytes = watches.reduce((sum, w) => sum + w.sample.totalBytes, 0);
    const fraction = usedBytes / limitBytes;
    const previous = this.cage;
    const cage: CageWatch = { usedBytes, limitBytes, fraction, regime: regimeFor(fraction), isolates: watches.length, at: Date.now() };
    this.cage = cage;
    if (previous === undefined ? cage.regime !== 'nominal' : previous.regime !== cage.regime) this.announceCage(cage, watches);
  }

  /** Say that the cage changed regime, with every isolate's share, largest first. */
  private announceCage(cage: CageWatch, watches: HeapWatch[]): void {
    const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(0)}MB`;
    const usage = `${mb(cage.usedBytes)} of the ${mb(cage.limitBytes)} heap cage every thread shares (${(cage.fraction * 100).toFixed(0)}%)`;
    const shares = [...watches].sort((a, b) => b.sample.totalBytes - a.sample.totalBytes)
      .map(w => {
        const largest = w.sample.sandboxes?.owners[0];
        return `${w.source} ${mb(w.sample.totalBytes)} (${w.sample.objectCount} objects${largest ? `; ${largest.name} ${mb(largest.bytes)}` : ''})`;
      }).join(', ');
    if (cage.regime === 'critical') {
      log.error(`Process heap CRITICAL: ${usage}. When the cage fills, the next allocation on any thread aborts the whole app. Held by: ${shares}`);
    } else if (cage.regime === 'elevated') {
      log.warn(`Process heap elevated: ${usage}. Held by: ${shares}`);
    } else {
      log.info(`Process heap back to nominal: ${usage}`);
    }
  }

  /**
   * The main thread's own reading. Absent off Node, and absent before init,
   * since the object count comes from the bus.
   */
  private localSample(): WorkerHeapSample | undefined {
    if (this.heapStats === undefined) return undefined;
    const stats = this.heapStats.getHeapStatistics();
    return {
      usedBytes: stats.used_heap_size,
      totalBytes: stats.total_heap_size,
      limitBytes: stats.heap_size_limit,
      objectCount: (this.bus as unknown as { objectCount?: number }).objectCount ?? 0,
      at: Date.now(),
      ...(this.mainSandboxes.latest ? { sandboxes: this.mainSandboxes.latest } : {}),
    };
  }

  /** Say that an isolate changed regime, at the volume the new regime warrants. */
  private announce(watch: HeapWatch, hadPrevious: boolean): void {
    const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)}MB`;
    const usage = `${mb(watch.sample.usedBytes)} / ${mb(watch.sample.limitBytes)}`;
    const pct = `${(watch.fraction * 100).toFixed(0)}%`;
    if (watch.regime === 'critical') {
      log.error(`${watch.source} heap CRITICAL: ${usage} (${pct}), ${watch.sample.objectCount} objects${userAbjects(watch.sample)}. ` +
        `At the ceiling the thread is terminated and every object on it is lost.`);
    } else if (watch.regime === 'elevated') {
      log.warn(`${watch.source} heap elevated: ${usage} (${pct}), ${watch.sample.objectCount} objects${userAbjects(watch.sample)}`);
    } else if (hadPrevious) {
      log.info(`${watch.source} heap back to nominal: ${usage} (${pct})`);
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    for (const watch of this.watches.values()) {
      invariant(watch.fraction >= 0, `${watch.source} heap fraction is negative`);
      invariant(watch.sample.at > 0, `${watch.source} sample has no timestamp`);
    }
    invariant(this.cage === undefined || this.cageBytes !== undefined, 'HeapMonitor: a cage reading without a shared cage');
    invariant(this.cage === undefined || this.cage.usedBytes >= 0, 'HeapMonitor: cage usage is negative');
    for (const at of this.relieved.values()) invariant(at > 0, 'HeapMonitor: a relief with no time');
  }
}
