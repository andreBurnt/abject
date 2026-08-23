/**
 * Cassette -- the ratchet's memory.
 *
 * A cassette is one recorded truth: a request the object made, the response
 * the world gave, and the parsed answer the object produced from it. The
 * fitness gate replays cassettes against every candidate source; a candidate
 * that cannot reproduce recorded meaning does not deploy. Requests are
 * redacted before storage so a cassette can never leak a credential.
 */

export interface CassetteRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface Cassette {
  method: string;
  args: Record<string, unknown>;
  request: CassetteRequest;
  response: { status: number; body: unknown };
  parsedOutput: unknown;
  recordedAt: number;
}

export const CASSETTE_CAP_PER_METHOD = 20;

const REDACTED_HEADERS = new Set(['authorization', 'cookie', 'set-cookie']);

export function redactRequest(req: CassetteRequest): CassetteRequest {
  if (!req.headers) return req;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!REDACTED_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  return { ...req, headers };
}

function hostPath(url: string): string | undefined {
  try { const u = new URL(url); return `${u.host}${u.pathname}`; } catch { return undefined; }
}

function isCassette(c: unknown): c is Cassette {
  if (c === null || typeof c !== 'object') return false;
  const x = c as Record<string, unknown>;
  return typeof x.method === 'string'
    && x.args !== null && typeof x.args === 'object'
    && x.request !== null && typeof x.request === 'object'
    && typeof (x.request as Record<string, unknown>).url === 'string'
    && x.response !== null && typeof x.response === 'object'
    && typeof x.recordedAt === 'number';
}

export class CassetteStore {
  private cassettes: Cassette[] = [];

  constructor(initial?: Cassette[]) {
    for (const c of initial ?? []) this.add(c);
  }

  add(c: Cassette): void {
    this.cassettes.push({ ...c, request: redactRequest(c.request) });
    const forMethod = this.cassettes.filter(x => x.method === c.method);
    if (forMethod.length > CASSETTE_CAP_PER_METHOD) {
      const evict = forMethod
        .sort((a, b) => a.recordedAt - b.recordedAt)
        .slice(0, forMethod.length - CASSETTE_CAP_PER_METHOD);
      this.cassettes = this.cassettes.filter(x => !evict.includes(x));
    }
  }

  byMethod(method: string): Cassette[] {
    return this.cassettes
      .filter(c => c.method === method)
      .sort((a, b) => a.recordedAt - b.recordedAt);
  }

  all(): Cassette[] { return [...this.cassettes]; }

  matchRequest(req: CassetteRequest): Cassette | undefined {
    const exact = this.cassettes.find(
      c => c.request.method === req.method && c.request.url === req.url);
    if (exact) return exact;
    const hp = hostPath(req.url);
    if (!hp) return undefined;
    return this.cassettes.find(
      c => c.request.method === req.method && hostPath(c.request.url) === hp);
  }

  toJSON(): Cassette[] { return this.all(); }

  static fromJSON(json: unknown): CassetteStore {
    const arr = Array.isArray(json) ? json.filter(isCassette) : [];
    return new CassetteStore(arr);
  }
}
