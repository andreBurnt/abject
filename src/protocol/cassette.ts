/**
 * Cassette -- the evidence the fitness gate judges a candidate against.
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
  /** The response body EXACTLY as the world sent it, before any parsing.
   *  HttpClient's contract says `body` is always a raw string, so replay must
   *  hand back the same characters — `JSON.stringify(parsed)` is not the same
   *  text for a JSON string primitive, and the round-trip loses meaning. */
  rawBody: string;
  parsedOutput: unknown;
  recordedAt: number;
}

export const CASSETTE_CAP_PER_METHOD = 20;

/** The method name recorded for raw HTTP traffic. These cassettes are stubs
 *  for the object's own calls, never a method the fitness gate can replay. */
export const HTTP_CASSETTE_METHOD = '_http';

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

/** Cassettes recorded before `rawBody` existed derive it from the parsed
 *  body. Lossy for a JSON string primitive, but honest and never undefined. */
function rawBodyOf(c: Cassette): string {
  return typeof c.rawBody === 'string' ? c.rawBody : (JSON.stringify(c.response.body) ?? '');
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
    this.cassettes.push({ ...c, request: redactRequest(c.request), rawBody: rawBodyOf(c) });
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

  /** Exact method+url only. Replay is argument-dependent: `?q=1` and
   *  `?q=other` are different questions, and answering one with the other's
   *  recording would let a candidate "reproduce" traffic it never made. */
  matchRequest(req: CassetteRequest): Cassette | undefined {
    return this.cassettes.find(
      c => c.request.method === req.method && c.request.url === req.url);
  }

  /** Exact match, else any recording of the same host+path. Deliberately NOT
   *  used by the replay seam — kept for callers that want a representative
   *  sample of an endpoint rather than an answer to a specific question. */
  matchRequestLoose(req: CassetteRequest): Cassette | undefined {
    const exact = this.matchRequest(req);
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
