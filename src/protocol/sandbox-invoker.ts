/**
 * SandboxInvoker -- runs a ScriptableAbject handler-map source under
 * runSandboxed with every inter-object call shimmed. HTTP is served from the
 * fitness gate's HttpStub; anything else an object tries to reach throws, so
 * a candidate cannot pass judgment by phoning the real world.
 */
import { runSandboxed } from '../core/sandbox.js';
import type { Invoker, HttpStub } from './fitness.js';

const HTTP_TARGETS = new Set(['HttpClient', 'WebFetch']);

/** A sandboxed candidate gets a bounded synchronous timeout -- generous for
 *  real handler logic, cheap insurance against a mutant that spins. It does
 *  not cover awaited Promises (see runSandboxed's docs), only the
 *  synchronous portions of the compile + call. */
const SANDBOX_TIMEOUT_MS = 5000;

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
    return { status: hit.status, body: hit.body };
  };
}

export function buildSandboxInvoker(): Invoker {
  return async (source, method, args, http) => {
    const call = makeCall(http);
    // runSandboxed wraps its code in `(async () => { CODE })()`; a bare
    // parenthesized object expression as a statement evaluates and discards
    // itself, so the handler map must be explicitly returned to escape the
    // wrapper.
    const handlers = await runSandboxed(`return (${source});`, {
      call,
      dep: (name: string) => name,
      find: () => { throw new Error('fitness: unstubbed I/O -- find()'); },
    }, { timeout: SANDBOX_TIMEOUT_MS }) as Record<string, (msg: { payload: Record<string, unknown> }) => Promise<unknown>>;
    const handler = handlers?.[method] ?? handlers?.['*'];
    if (typeof handler !== 'function') {
      throw new Error(`fitness: source has no handler for '${method}'`);
    }
    return handler({ payload: args });
  };
}
