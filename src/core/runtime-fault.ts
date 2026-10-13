/**
 * Runtime faults: a task that ended because of the object system itself (an
 * inactivity watchdog, a plan that replaced it, a worker that died), not
 * because of the world it acted on.
 *
 * They are written into a task's error with a fixed prefix so whoever reads
 * the record later, above all the TaskReviewer, can tell the runtime apart
 * from the world. A world model learns from what happened in the world; a
 * watchdog firing teaches it nothing about that, and is reported to the
 * person instead.
 */

import { require as precondition } from './contracts.js';

export type RuntimeFaultCode =
  /** A delegating agent's inactivity watchdog cancelled the task. */
  | 'inactivity-timeout'
  /** A newer plan replaced the task before it finished. */
  | 'superseded'
  /** The worker running the task died. */
  | 'worker-died';

const PREFIX = '[runtime:';
const CODES: readonly RuntimeFaultCode[] = ['inactivity-timeout', 'superseded', 'worker-died'];

/** The error text for a runtime fault. */
export function runtimeFault(code: RuntimeFaultCode, detail: string): string {
  precondition(CODES.includes(code), `unknown runtime fault code: ${code}`);
  return `${PREFIX}${code}] ${detail}`;
}

/** The runtime fault an error names, if it names one. */
export function parseRuntimeFault(error: unknown): { code: RuntimeFaultCode; detail: string } | undefined {
  if (typeof error !== 'string') return undefined;
  const at = error.indexOf(PREFIX);
  if (at < 0) return undefined;
  const end = error.indexOf(']', at);
  if (end < 0) return undefined;
  const code = error.slice(at + PREFIX.length, end) as RuntimeFaultCode;
  if (!CODES.includes(code)) return undefined;
  return { code, detail: error.slice(end + 1).trim() };
}
