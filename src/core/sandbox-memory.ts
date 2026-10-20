/**
 * How much memory each sandbox in this thread holds.
 *
 * Every Sandbox is a V8 context of its own, and V8 can measure the memory
 * each context holds (vm.measureMemory). It does not say which context each
 * number is for: it answers with every context the thread has, newest first
 * (verified on Node 24 and Electron 44's V8, Oct 2026). So each sandbox's
 * context is recorded here as it is made, oldest first and held weakly, and a
 * measurement is read against that record. The record has to cover every
 * context in the thread; when the counts differ, some other code made a
 * context, and the reading is left unattributed rather than pinned on the
 * wrong sandbox.
 *
 * A measurement waits for V8's next garbage collection instead of forcing
 * one, so it takes seconds and costs no extra pause.
 */

import * as vm from 'node:vm';
import type { AbjectId } from './types.js';
import { Log } from './timed-log.js';

const log = new Log('SandboxMemory');

/** The abject whose code a sandbox runs. */
export interface SandboxOwner {
  id: AbjectId;
  name: string;
}

/** What the sandboxes in one thread hold. */
export interface SandboxHeap {
  /** When the measurement was asked for: anything done before then shows in it. */
  startedAt: number;
  at: number;
  /** Each abject whose code runs in a sandbox here, largest first. */
  owners: Array<SandboxOwner & { bytes: number }>;
  /** Sandboxes no abject owns (jobs, trigger expressions, compile checks) and stopped ones not yet collected. */
  otherBytes: number;
  /** Sandbox contexts measured. */
  contexts: number;
}

/** What this module needs of a Sandbox; structural, so sandbox.ts can import this file. */
export interface MeasuredSandbox {
  readonly stopped: boolean;
  /** The owning abject, asked when memory is measured. */
  readonly owner: SandboxOwner | undefined;
}

interface Tracked {
  context: WeakRef<object>;
  sandbox: WeakRef<MeasuredSandbox>;
}

/** Every sandbox context made in this thread and not yet collected, oldest first. */
let tracked: Tracked[] = [];
let pruneAt = 256;
let warnedUnattributed = false;

/** Record a sandbox's context the moment it is made, before any other context can be. */
export function trackSandbox(context: object, sandbox: MeasuredSandbox): void {
  tracked.push({ context: new WeakRef(context), sandbox: new WeakRef(sandbox) });
  if (tracked.length >= pruneAt) {
    prune();
    pruneAt = Math.max(256, tracked.length * 2);
  }
}

/** Sandbox contexts in this thread not yet collected. */
export function sandboxCount(): number {
  prune();
  return tracked.length;
}

function prune(): void {
  tracked = tracked.filter(t => t.context.deref() !== undefined);
}

interface ContextMeasurement {
  other: Array<{ jsMemoryEstimate: number }>;
}

/**
 * Ask V8 for every context's size. vm.measureMemory is still marked
 * experimental and says so on stderr the first time each thread calls it; that
 * one notice is held back here, every other warning passes.
 */
function measureContexts(): Promise<ContextMeasurement> | undefined {
  const measure = (vm as unknown as { measureMemory?: (options: object) => Promise<ContextMeasurement> }).measureMemory;
  if (typeof measure !== 'function') return undefined;
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (text.includes('vm.measureMemory')) return;
    (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return measure({ mode: 'detailed', execution: 'default' });
  } finally {
    process.emitWarning = emitWarning;
  }
}

/**
 * Measure every sandbox in this thread and add up what each owning abject
 * holds. Undefined when there are none, when V8 cannot measure, or when the
 * contexts V8 reports are not exactly the recorded ones.
 */
export async function measureSandboxMemory(): Promise<SandboxHeap | undefined> {
  prune();
  // Held until the answer arrives: V8 leaves a context collected midway out
  // of its answer, which would shift every number after it onto the wrong
  // sandbox.
  const held = tracked.flatMap(t => {
    const context = t.context.deref();
    return context ? [{ context, sandbox: t.sandbox }] : [];
  });
  if (held.length === 0) return undefined;
  const startedAt = Date.now();
  let measured: ContextMeasurement | undefined;
  try {
    measured = await measureContexts();
  } catch {
    return undefined;
  }
  if (!measured) return undefined;
  if (measured.other.length !== held.length) {
    if (!warnedUnattributed) {
      warnedUnattributed = true;
      log.warn(`V8 reported ${measured.other.length} contexts beside this thread's own and ${held.length} sandboxes are recorded; ` +
        'something other than Sandbox made a context, so sandbox memory here is not attributed');
    }
    return undefined;
  }

  const byOwner = new Map<AbjectId, SandboxOwner & { bytes: number }>();
  let otherBytes = 0;
  for (let i = 0; i < held.length; i++) {
    // V8 answers newest first; the record is oldest first.
    const bytes = measured.other[held.length - 1 - i].jsMemoryEstimate;
    const sandbox = held[i].sandbox.deref();
    const owner = sandbox && !sandbox.stopped ? sandbox.owner : undefined;
    if (!owner) {
      otherBytes += bytes;
      continue;
    }
    const entry = byOwner.get(owner.id);
    if (entry) entry.bytes += bytes;
    else byOwner.set(owner.id, { id: owner.id, name: owner.name, bytes });
  }
  return {
    startedAt,
    at: Date.now(),
    owners: [...byOwner.values()].sort((a, b) => b.bytes - a.bytes),
    otherBytes,
    contexts: held.length,
  };
}

/** Keeps the latest reading of this thread's sandboxes, one measurement at a time. */
export class SandboxMeter {
  private measuring = false;
  private reading?: SandboxHeap;

  /** `onReading` hears each finished measurement, so a fresh one can be reported at once. */
  constructor(private readonly onReading?: (reading: SandboxHeap | undefined) => void) {}

  get latest(): SandboxHeap | undefined {
    return this.reading;
  }

  /** Start a measurement unless one is under way. With no sandboxes there is nothing to read. */
  measure(): void {
    if (this.measuring) return;
    if (sandboxCount() === 0) {
      this.reading = undefined;
      return;
    }
    this.measuring = true;
    measureSandboxMemory().then(
      reading => {
        this.reading = reading;
        try { this.onReading?.(reading); } catch { /* a listener's failure is its own */ }
      },
      () => { this.reading = undefined; },
    ).finally(() => { this.measuring = false; });
  }
}
