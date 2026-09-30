/**
 * SandboxInvoker -- runs one handler of a ScriptableAbject handler-map source
 * with every outbound `call()` answered by the judge's stub. Nothing the
 * candidate does reaches another object: a call the recording never saw
 * throws, so a candidate cannot pass judgment by phoning the real world.
 *
 * Each invocation runs on a dedicated WORKER THREAD, inside a vm context that
 * exposes the same builtins the live sandbox does. The worker is what makes
 * the deadline real: `worker.terminate()` preempts anything -- a synchronous
 * spin, a spin after an await, even `Atomics.wait` -- where a vm-level
 * timeout covers only the evaluation it was handed, and an in-process
 * microtask drain (`microtaskMode: 'afterEvaluate'`) corrupts async_hooks
 * when a consumer such as AsyncLocalStorage is active. `resourceLimits`
 * bounds the candidate's heap, so an allocation bomb kills the worker, not
 * the judge. Timers work normally -- the worker has its own event loop --
 * so a retry-with-backoff candidate is judged, not killed.
 *
 * Fidelity: the NAMES of the builtins and of the `this`-proxy members come
 * from core/sandbox.ts (the same lists the live ScriptableAbject reads), and
 * the worker rebuilds the builtins from its own realm. The proxy member
 * BODIES below are the harness's own stand-ins (`call` answers from the
 * recording, `data` is empty, state-mutating members are inert), so a
 * handler whose result depends on `this.data` is not reproduced here and is
 * excluded by the control run rather than judged.
 *
 * The stub crosses the thread boundary synchronously: the worker posts the
 * request and blocks on Atomics.wait while the host answers on its own event
 * loop. Everything that crosses is structured-clone data; no host closure is
 * reachable from the candidate.
 *
 * What the worker gives the judge: a hard deadline (`terminate()`), a heap
 * cap, an empty `process.env` (`env: {}`), its own stdio, and a message-only
 * interface. It is not a confidentiality boundary: Node's docs say `vm` is
 * not a security mechanism, and that holds inside a worker too.
 */
import { Worker, MessageChannel, type MessagePort } from 'node:worker_threads';
import { validateCode, SANDBOX_BUILTIN_NAMES, HANDLER_PROXY_BUILTINS } from '../core/sandbox.js';
import type { Invoker, CallStub, CallStubRequest } from './fitness.js';

/** Wall-clock ceiling on ONE judged invocation, compile included. On expiry
 *  the worker is terminated -- preempting even blocked threads -- and the
 *  invocation fails: a timing-out candidate contradicts its recording. */
export const FITNESS_INVOCATION_TIMEOUT_MS = 5000;

/** Candidate heap ceiling. Generous for handler logic; an allocation bomb
 *  (one `new Array(1e9)` needs no loop to OOM) kills the worker instead of
 *  the process that judges. */
const WORKER_MAX_OLD_SPACE_MB = 256;

/** The worker body, evaluated as CommonJS via `new Worker(code, {eval:true})`
 *  so it needs no loader. One job at a time: build a vm context from the
 *  builtin names the host passed, compile the handler map, bind it to a
 *  runtime-shaped proxy, invoke, post the outcome back. */
const WORKER_SOURCE = `
'use strict';
const { parentPort, workerData, receiveMessageOnPort } = require('node:worker_threads');
const vm = require('node:vm');

const signal = new Int32Array(workerData.signal);
const stubPort = workerData.stubPort;

// Rebuilt from THIS realm by name: live host functions cannot cross the
// thread boundary, and the names are the runtime's own list.
const BUILTINS = {};
for (const name of workerData.builtinNames) {
  if (!(name in globalThis)) throw new Error('fitness worker: no such builtin in this realm: ' + name);
  BUILTINS[name] = globalThis[name];
}
BUILTINS.console = { log() {}, warn() {}, error() {} };
const PROXY_BUILTINS = new Set(workerData.proxyBuiltins);

// Ask the host's stub, synchronously: post the request, sleep on the
// signal until the host has written the reply to the port.
function askStub(req) {
  Atomics.store(signal, 0, 0);
  stubPort.postMessage(req);
  Atomics.wait(signal, 0, 0);
  const m = receiveMessageOnPort(stubPort);
  return m ? m.message : undefined;
}

function harness(source) {
  return \`
    // Every outbound call is answered from the recording or refused. No
    // object is special here: HttpClient, Storage, a sibling user object --
    // the recording either has the answer or the candidate is asking the
    // world something the live object never asked.
    const call = async (target, method, payload) => {
      // The live proxy awaits its target, and the prompt teaches
      // this.call(this.dep('X'), ...) where dep() returns a promise, so the
      // harness must await it too or every such call stubs as [object Promise].
      const t = await target;
      const hit = __stub({ target: String(t), method: String(method),
                           payloadText: JSON.stringify(payload === undefined ? {} : payload) });
      if (!hit) throw new Error("fitness: unrecorded call -- call('" + t + "', '" + method + "')");
      if (hit.errorText !== undefined) throw new Error(hit.errorText);
      return JSON.parse(hit.replyText);
    };
    // Names stand for themselves: the recording keys outbound calls by the
    // registered name, and dep()/find() at runtime resolve a name to an id
    // that would mean nothing here. An id the handler got from a stubbed
    // reply or its arguments is the recorded id, and the recording keeps
    // that id as the target, so it matches as it is.
    const dep = async (name) => name;
    const find = async (name) => name;
    // The stand-in for ScriptableAbject's handler proxy. Handlers are bound
    // to it so \\\`this.sibling(...)\\\` resolves the way it does live.
    // State-mutating members are inert: judgment must not persist anything.
    const proxy = {
      call, dep, find,
      data: {},
      saveData: async () => {},
      emit: async () => {}, changed: () => {}, observe: async () => {},
      ensure: (cond, message) => {
        if (!cond) throw new Error('ContractViolation (ensure): ' + (message ?? 'condition failed'));
      },
      invariant: (cond, message) => {
        if (!cond) throw new Error('ContractViolation (invariant): ' + (message ?? 'invariant failed'));
      },
      id: 'fitness-candidate',
    };
    const handlers = (\${source});
    if (handlers === null || typeof handlers !== 'object') throw new Error('fitness: source must evaluate to a handler map');
    const bound = new Map();
    for (const [key, value] of Object.entries(handlers)) {
      if (typeof value === 'function') {
        const fn = value.bind(proxy);
        bound.set(key, fn);
        if (!__proxyBuiltins.has(key)) proxy[key] = fn;
      } else if (!__proxyBuiltins.has(key)) {
        proxy[key] = value; // state property, same as the runtime does
      }
    }
    const handler = bound.get(__method) ?? bound.get('*');
    if (!handler) throw new Error("fitness: source has no handler for '" + __method + "'");
    return handler({ payload: __args, routing: { from: 'fitness-judge', to: 'fitness-candidate', method: __method } });
  \`;
}

parentPort.on('message', async (job) => {
  try {
    const ctx = vm.createContext({
      ...BUILTINS,
      __stub: askStub,
      __method: job.method,
      __args: job.args,
      __proxyBuiltins: PROXY_BUILTINS,
    });
    const script = new vm.Script('(async () => {' + harness(job.source) + '})()',
      { filename: 'fitness-invoker.js' });
    const value = await script.runInContext(ctx);
    // Outcomes must survive structured clone; a candidate returning a
    // function or symbol is returning something no message can carry.
    parentPort.postMessage({ id: job.id, ok: true, value: JSON.parse(JSON.stringify(value === undefined ? null : value)) });
  } catch (err) {
    parentPort.postMessage({ id: job.id, ok: false,
      error: String((err && err.message) || err) });
  }
});
`;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  stub: CallStub;
  timer: ReturnType<typeof setTimeout>;
}

/** One spawned worker and everything scoped to it. The pending map and the
 *  event handlers belong to THIS worker: a stale worker's exit/error must
 *  never touch the entries of the replacement that took its place after a
 *  timeout, or it rejects a live job and leaks the new thread. */
interface WorkerConn {
  worker: Worker;
  signal: Int32Array;
  stubPort: MessagePort;
  pending: Map<number, Pending>;
  nextId: number;
  /** Cleared the instant this worker is abandoned (timeout/dispose/exit), so
   *  invoke() never hands a job to a worker that is on its way out. */
  alive: boolean;
}

/** One worker, reused across the sequential invocations of an evaluate()
 *  run; respawned lazily after a termination. */
class WorkerInvoker {
  private conn: WorkerConn | undefined;

  constructor(private timeoutMs: number) {}

  private spawn(): WorkerConn {
    const sab = new SharedArrayBuffer(4);
    const signal = new Int32Array(sab);
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      // Empty environment and own stdio: the candidate realm cannot read the
      // host's process.env, and the worker carries no secrets to leak.
      env: {},
      stdout: true,
      stderr: true,
      workerData: {
        signal: sab,
        stubPort: port2,
        builtinNames: [...SANDBOX_BUILTIN_NAMES],
        proxyBuiltins: [...HANDLER_PROXY_BUILTINS],
      },
      transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_SPACE_MB },
    });
    worker.unref();
    const conn: WorkerConn = { worker, signal, stubPort: port1, pending: new Map(), nextId: 1, alive: true };
    port1.on('message', (req: CallStubRequest) => {
      // Exactly one invocation is in flight per worker, so the sole pending
      // entry owns every stub request.
      const inflight = [...conn.pending.values()][0];
      let hit: unknown;
      try { hit = inflight?.stub(req) ?? null; } catch { hit = null; }
      port1.postMessage(hit);
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
    });
    // Attaching the listener re-refs the port; without this, an idle judge
    // never lets the process exit.
    port1.unref();
    worker.on('message', (msg: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const p = conn.pending.get(msg.id);
      if (!p) return;
      conn.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error));
    });
    worker.on('error', (err: Error) => this.failConn(conn, new Error(`fitness: worker error -- ${err.message}`)));
    worker.on('exit', (code) => {
      // An OOM-killed or crashed worker exits without answering; terminate()
      // after a timeout lands here too, but its pending entry is already
      // rejected and cleared. Only the handlers bound to THIS conn run, and
      // they touch only this conn's pending -- never the replacement's.
      if (code !== 0) this.failConn(conn, new Error('fitness: worker died while judging (resource limit or crash)'));
      conn.alive = false;
      if (this.conn === conn) this.conn = undefined;
    });
    return conn;
  }

  private failConn(conn: WorkerConn, err: Error): void {
    for (const [id, p] of conn.pending) {
      conn.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  invoke(source: string, method: string, args: Record<string, unknown>, stub: CallStub): Promise<unknown> {
    const check = validateCode(source);
    if (!check.valid) {
      return Promise.reject(new Error(`fitness: blocked construct -- ${check.blocked}`));
    }
    if (!this.conn || !this.conn.alive) this.conn = this.spawn();
    const conn = this.conn;
    conn.worker.ref();
    const id = conn.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        conn.alive = false;                 // this worker is abandoned...
        if (this.conn === conn) this.conn = undefined; // ...and the next invoke respawns
        void conn.worker.terminate();
        reject(new Error('fitness: invocation timeout'));
      }, this.timeoutMs);
      conn.pending.set(id, { resolve, reject, stub, timer });
      conn.worker.postMessage({ id, source, method, args });
    }).finally(() => { if (this.conn === conn && conn.pending.size === 0) conn.worker.unref(); });
  }

  /** Release the worker. Idempotent; a later invoke respawns. */
  dispose(): void {
    const conn = this.conn;
    this.conn = undefined;
    if (conn) {
      conn.alive = false;
      this.failConn(conn, new Error('fitness: invoker disposed'));
      void conn.worker.terminate();
    }
  }
}

export interface SandboxInvoker extends Invoker {
  dispose(): void;
}

export function buildSandboxInvoker(opts?: { timeoutMs?: number }): SandboxInvoker {
  const invoker = new WorkerInvoker(opts?.timeoutMs ?? FITNESS_INVOCATION_TIMEOUT_MS);
  const fn = ((source, method, args, stub) => invoker.invoke(source, method, args, stub)) as SandboxInvoker;
  fn.dispose = () => invoker.dispose();
  return fn;
}
