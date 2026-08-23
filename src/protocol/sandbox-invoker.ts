/**
 * SandboxInvoker -- runs a ScriptableAbject handler-map source under
 * runSandboxed with every inter-object call shimmed. HTTP is served from the
 * fitness gate's HttpStub; anything else an object tries to reach throws, so
 * a candidate cannot pass judgment by phoning the real world.
 */
import { runSandboxed } from '../core/sandbox.js';
import type { Invoker, HttpStub } from './fitness.js';

// HttpClient only. WebFetch's live return shape (FetchResult) is nothing
// like an HttpResponse, so shimming it here would teach a candidate a
// contract the runtime does not honour; a WebFetch-using candidate fails
// with a plain unstubbed-I/O message until a real stub exists.
const HTTP_TARGETS = new Set(['HttpClient']);

/** A sandboxed candidate gets a bounded synchronous timeout -- generous for
 *  real handler logic, cheap insurance against a mutant that spins. It does
 *  not cover awaited Promises (see runSandboxed's docs), only the
 *  synchronous portions of the compile + call. */
const SANDBOX_TIMEOUT_MS = 5000;

/** Wall-clock ceiling on ONE judged invocation, compile included. The vm's
 *  own timeout is synchronous-only, so a mutant that flips a loop guard and
 *  awaits inside it hangs evaluate forever with nothing to interrupt it.
 *  A timing-out mutant is thereby killed; a timing-out candidate fails. */
export const FITNESS_INVOCATION_TIMEOUT_MS = 5000;

/** Members the handler proxy owns; user members never shadow them.
 *  Mirrors ScriptableAbject.PROXY_BUILTINS. */
const PROXY_BUILTINS = new Set([
  'call', 'dep', 'find', 'changed', 'emit', 'observe', 'id',
  'data', 'saveData', 'ensure', 'invariant',
]);

function makeCall(http: HttpStub) {
  return async (target: string, method: string, payload: Record<string, unknown>) => {
    if (!HTTP_TARGETS.has(target)) {
      throw new Error(`fitness: unstubbed I/O -- call('${target}', '${method}')`);
    }
    const url = String(payload?.url ?? '');
    const httpMethod = method === 'post' || method === 'postJson' ? 'POST'
      : String(payload?.method ?? 'GET').toUpperCase();
    const hit = http({ method: httpMethod, url });
    if (!hit) throw new Error(`fitness: unstubbed I/O -- no cassette for ${httpMethod} ${url}`);
    // The exact shape HttpClient's ask guide teaches objects: body is ALWAYS
    // a raw string (`JSON.parse(result.body)`), ok is 2xx. A candidate judged
    // against any other shape is judged against a runtime that does not exist.
    return {
      status: hit.status,
      statusText: '',
      headers: {} as Record<string, string>,
      body: hit.rawBody,
      ok: hit.status >= 200 && hit.status < 300,
    };
  };
}

/** Reject if `p` has not settled within `ms`. The hung promise is abandoned,
 *  not cancelled -- nothing in a vm can be cancelled -- but it holds no timer
 *  of its own, so it never keeps the process alive. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('fitness: invocation timeout')), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/**
 * A minimal stand-in for ScriptableAbject's handler proxy. Handlers are bound
 * to it, so `this.sibling(...)` resolves the way it does in the live runtime
 * -- without one, a two-method object (the house style: a thin handler over a
 * private helper) failed judgment on a `this` the gate itself withheld.
 * State-mutating members are inert: judgment must not persist anything.
 */
function buildHandlerProxy(call: ReturnType<typeof makeCall>): Record<string, unknown> {
  return {
    call,
    dep: (name: string) => name,
    find: () => { throw new Error('fitness: unstubbed I/O -- find()'); },
    data: {},
    saveData: async () => {},
    emit: () => {},
    changed: () => {},
    observe: () => {},
    ensure: (cond: unknown, message?: string) => {
      if (!cond) throw new Error(`ContractViolation (ensure): ${message ?? 'condition failed'}`);
    },
    invariant: (cond: unknown, message?: string) => {
      if (!cond) throw new Error(`ContractViolation (invariant): ${message ?? 'invariant failed'}`);
    },
    id: 'fitness-candidate',
  };
}

export function buildSandboxInvoker(opts?: { timeoutMs?: number }): Invoker {
  const timeoutMs = opts?.timeoutMs ?? FITNESS_INVOCATION_TIMEOUT_MS;
  return (source, method, args, http) => withDeadline((async () => {
    const call = makeCall(http);
    // runSandboxed wraps its code in `(async () => { CODE })()`; a bare
    // parenthesized object expression as a statement evaluates and discards
    // itself, so the handler map must be explicitly returned to escape the
    // wrapper.
    const handlers = await runSandboxed(`return (${source});`, {
      call,
      dep: (name: string) => name,
      find: () => { throw new Error('fitness: unstubbed I/O -- find()'); },
    }, { timeout: SANDBOX_TIMEOUT_MS }) as Record<string, unknown> | null;

    const proxy = buildHandlerProxy(call);
    const bound = new Map<string, (msg: { payload: Record<string, unknown> }) => Promise<unknown>>();
    for (const [key, value] of Object.entries(handlers ?? {})) {
      if (typeof value === 'function') {
        const fn = (value as (...a: unknown[]) => unknown).bind(proxy) as
          (msg: { payload: Record<string, unknown> }) => Promise<unknown>;
        bound.set(key, fn);
        if (!PROXY_BUILTINS.has(key)) proxy[key] = fn;
      } else if (!PROXY_BUILTINS.has(key)) {
        proxy[key] = value; // state property, same as the runtime does
      }
    }

    const handler = bound.get(method) ?? bound.get('*');
    if (!handler) throw new Error(`fitness: source has no handler for '${method}'`);
    return handler({ payload: args });
  })(), timeoutMs);
}
