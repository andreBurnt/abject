/**
 * MCP HTTP Transport -- JSON-RPC 2.0 with a remote MCP server over HTTP.
 *
 * Speaks the Streamable HTTP transport of the MCP spec: every message the
 * client sends is a POST to the server's one endpoint, and the server answers
 * a request either with a JSON body or with an SSE stream that carries the
 * response (and any notifications it sends along the way). A session id the
 * server hands out on initialize rides on every later request; when the
 * server forgets it (404), the session is started again and the request
 * retried once.
 *
 * A server that refuses that first POST the way an older server would (400,
 * 404, 405) gets the HTTP+SSE transport of the 2024-11-05 spec instead: a GET
 * event stream whose first `endpoint` event names the address to POST to,
 * and which carries every response.
 *
 * Authorization belongs to the caller. `auth.token()` supplies the bearer
 * token for each request, and `auth.refresh()` is asked for a new one when
 * the server refuses it. A refusal a fresh token does not cure surfaces as
 * MCPAuthRequiredError, carrying the server's WWW-Authenticate challenge so
 * the caller can run the sign-in that challenge describes.
 */

import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from '../core/mcp-types.js';
import { require as contractRequire } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import type { MCPClientTransport, MCPTransportEvents, MCPTransportState } from './mcp-transport.js';

const log = new Log('MCPHttpTransport');

/** How many recent failure notes `diagnosticTail` keeps. */
const DIAGNOSTIC_NOTES = 6;
/** How much of an error response body a failure note keeps. */
const DIAGNOSTIC_BODY_CHARS = 400;
/** A session's DELETE on stop is a courtesy; it never holds up a stop. */
const SESSION_CLOSE_MS = 3000;

/** The bearer token source a transport is given. */
export interface MCPHttpAuth {
  /** The token to send, or undefined to send none. */
  token(): Promise<string | undefined>;
  /**
   * The server refused the token it was sent, with this WWW-Authenticate
   * challenge. Resolves true when a fresh token is now available, so the
   * refused request is worth one more try.
   */
  refresh(challenge: string | undefined): Promise<boolean>;
}

export interface MCPHttpTransportOptions {
  /** The server's MCP endpoint. */
  url: string;
  /** Headers sent with every request (an API key, for instance). */
  headers?: Record<string, string>;
  auth?: MCPHttpAuth;
  requestTimeout?: number;
}

/**
 * The server wants credentials it was not given: a 401, or a 403 naming an
 * insufficient scope. `challenge` is its WWW-Authenticate header.
 */
export class MCPAuthRequiredError extends Error {
  constructor(
    message: string,
    readonly challenge: string | undefined,
    readonly status: number,
  ) {
    super(message);
    this.name = 'MCPAuthRequiredError';
  }
}

/** The first POST was refused the way a pre-Streamable-HTTP server refuses it. */
class LegacyServerSignal extends Error {}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SseEvent {
  event: string;
  data: string;
}

/**
 * Talks to one remote MCP server. `start()` only arms the transport; the
 * first request (initialize) is what reaches the server.
 */
export class MCPHttpTransport implements MCPClientTransport {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly auth?: MCPHttpAuth;
  private readonly requestTimeout: number;

  private state: MCPTransportState = 'idle';
  private events: MCPTransportEvents = {};
  private nextId = 1;
  /** Which of the two HTTP transports this server speaks. */
  private mode: 'streamable' | 'sse' = 'streamable';
  private sessionId?: string;
  private protocolVersion?: string;
  /** Replayed to start a new session when the server forgets the old one. */
  private initializeParams?: unknown;
  /** Requests in flight, aborted together on stop. */
  private inflight = new Set<AbortController>();
  private notes: string[] = [];

  // HTTP+SSE only: the open event stream, the address it named for POSTs, and
  // the requests whose responses will arrive on the stream.
  private sseAbort?: AbortController;
  private sseEndpoint?: string;
  private ssePending = new Map<string | number, PendingRequest>();

  constructor(opts: MCPHttpTransportOptions) {
    contractRequire(/^https?:\/\//i.test(opts.url), 'MCP server url must be http(s)');
    this.url = opts.url;
    this.headers = { ...(opts.headers ?? {}) };
    this.auth = opts.auth;
    this.requestTimeout = opts.requestTimeout ?? 60_000;
  }

  get currentState(): MCPTransportState { return this.state; }
  get isConnected(): boolean { return this.state === 'connected'; }

  get diagnosticTail(): string {
    return this.notes.join('\n');
  }

  on(events: MCPTransportEvents): void {
    this.events = { ...this.events, ...events };
  }

  async start(): Promise<void> {
    contractRequire(this.state === 'idle' || this.state === 'closed' || this.state === 'error',
      'Transport must be idle/closed/error to start');
    this.mode = 'streamable';
    this.sessionId = undefined;
    this.protocolVersion = undefined;
    this.notes = [];
    this.setState('connected');
  }

  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    contractRequire(this.state === 'connected',
      `Transport must be connected to send requests (state: ${this.state})`);
    if (method === 'initialize') this.initializeParams = params;

    const message: JsonRpcRequest = { jsonrpc: '2.0', method, id: this.nextId++ };
    if (params !== undefined) message.params = params;

    if (this.mode === 'sse') return this.sseRequest(message);
    try {
      return await this.streamableRequest(message, true);
    } catch (err) {
      if (!(err instanceof LegacyServerSignal)) throw err;
      log.info(`${this.url} refused Streamable HTTP (${err.message}); trying HTTP+SSE`);
      await this.openEventStream();
      return this.sseRequest(message);
    }
  }

  sendNotification(method: string, params?: unknown): void {
    contractRequire(this.state === 'connected', 'Transport must be connected to send notifications');
    const message: JsonRpcRequest = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    this.post(message, this.mode === 'sse' ? this.sseEndpoint! : this.url)
      .then(async (res) => {
        if (!res.ok) this.note(`${method} notification refused: HTTP ${res.status} ${await bodySnippet(res)}`);
        else await res.body?.cancel().catch(() => {});
      })
      .catch((err) => this.note(`${method} notification failed: ${errorText(err)}`));
  }

  async stop(): Promise<void> {
    if (this.state === 'closed') return;
    const sessionId = this.mode === 'streamable' ? this.sessionId : undefined;
    this.setState('closed');
    for (const controller of this.inflight) controller.abort();
    this.inflight.clear();
    this.sseAbort?.abort();
    this.sseAbort = undefined;
    this.rejectSsePending(new Error('Transport stopped'));
    // Tell the server the session is over, so it can let go of it now
    // instead of when it times out. Best effort and bounded.
    if (sessionId) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SESSION_CLOSE_MS);
      try {
        const res = await fetch(this.url, {
          method: 'DELETE',
          headers: await this.requestHeaders({ 'Mcp-Session-Id': sessionId }),
          signal: controller.signal,
        });
        await res.body?.cancel().catch(() => {});
      } catch { /* the server may already be gone */ }
      finally { clearTimeout(timer); }
    }
    this.sessionId = undefined;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Streamable HTTP
  // ═══════════════════════════════════════════════════════════════════

  private async streamableRequest(message: JsonRpcRequest, mayRestartSession: boolean): Promise<unknown> {
    const controller = new AbortController();
    this.inflight.add(controller);
    const timer = setTimeout(() => controller.abort(), this.requestTimeout);
    try {
      const res = await this.post(message, this.url, controller.signal);

      if (res.status === 404 && this.sessionId && message.method !== 'initialize' && mayRestartSession) {
        // The server has forgotten the session: start a new one and try once more.
        await res.body?.cancel().catch(() => {});
        this.note(`session ${this.sessionId} expired; starting a new one`);
        this.sessionId = undefined;
        await this.restartSession();
        return this.streamableRequest(message, false);
      }
      if (!res.ok) {
        const snippet = await bodySnippet(res);
        if (message.method === 'initialize' && [400, 404, 405].includes(res.status)) {
          throw new LegacyServerSignal(`HTTP ${res.status}`);
        }
        this.note(`${message.method}: HTTP ${res.status} ${snippet}`);
        throw new Error(`MCP server answered ${message.method} with HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
      }

      const session = res.headers.get('mcp-session-id');
      if (session) this.sessionId = session;

      const response = await this.responseFrom(res, message);
      if (response.error) {
        throw new Error(`MCP error ${response.error.code}: ${response.error.message}`);
      }
      if (message.method === 'initialize') {
        const version = (response.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        if (typeof version === 'string') this.protocolVersion = version;
      }
      return response.result;
    } catch (err) {
      if (controller.signal.aborted && this.state === 'connected') {
        throw new Error(`MCP request timed out: ${message.method} (${this.requestTimeout}ms)`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      this.inflight.delete(controller);
    }
  }

  /** Read the response to `message` out of a JSON body or an SSE stream. */
  private async responseFrom(res: Response, message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (type.includes('text/event-stream')) {
      if (!res.body) throw new Error(`MCP server sent an empty stream for ${message.method}`);
      for await (const ev of readSse(res.body)) {
        for (const incoming of parseMessages(ev.data)) {
          if (isResponse(incoming) && incoming.id === message.id) return incoming;
          this.dispatch(incoming);
        }
      }
      throw new Error(`MCP server closed the stream before answering ${message.method}`);
    }

    const text = await res.text();
    if (res.status === 202 || !text.trim()) {
      throw new Error(`MCP server accepted ${message.method} but sent no response`);
    }
    let found: JsonRpcResponse | undefined;
    for (const incoming of parseMessages(text)) {
      if (!found && isResponse(incoming) && incoming.id === message.id) found = incoming;
      else this.dispatch(incoming);
    }
    if (!found) throw new Error(`MCP server's reply to ${message.method} held no response to it`);
    return found;
  }

  /** Initialize again, under a new session, with the parameters used the first time. */
  private async restartSession(): Promise<void> {
    contractRequire(this.initializeParams !== undefined, 'a session restarts only after an initialize');
    const message: JsonRpcRequest = {
      jsonrpc: '2.0', method: 'initialize', id: this.nextId++, params: this.initializeParams,
    };
    await this.streamableRequest(message, false);
    this.sendNotification('notifications/initialized');
  }

  // ═══════════════════════════════════════════════════════════════════
  // HTTP+SSE (2024-11-05)
  // ═══════════════════════════════════════════════════════════════════

  /** Open the event stream and wait for the `endpoint` event that names the POST address. */
  private async openEventStream(): Promise<void> {
    const controller = new AbortController();
    this.sseAbort = controller;
    const opening = setTimeout(() => controller.abort(), this.requestTimeout);
    let res: Response;
    try {
      res = await this.fetchAuthorized(token => fetch(this.url, {
        method: 'GET',
        headers: this.requestHeadersWith(token, { Accept: 'text/event-stream' }),
        signal: controller.signal,
      }));
    } catch (err) {
      clearTimeout(opening);
      throw err;
    }
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!res.ok || !type.includes('text/event-stream') || !res.body) {
      clearTimeout(opening);
      const snippet = await bodySnippet(res);
      this.note(`GET event stream: HTTP ${res.status} ${snippet}`);
      throw new Error(`${this.url} speaks neither Streamable HTTP nor HTTP+SSE (GET answered HTTP ${res.status})`);
    }

    const events = readSse(res.body);
    try {
      for (;;) {
        const next = await events.next();
        if (next.done) throw new Error('event stream closed before naming its endpoint');
        if (next.value.event === 'endpoint') {
          this.sseEndpoint = new URL(next.value.data.trim(), this.url).toString();
          break;
        }
      }
    } finally {
      clearTimeout(opening);
    }
    this.mode = 'sse';
    void this.pumpEventStream(events);
  }

  /** Deliver everything else the event stream carries until it ends. */
  private async pumpEventStream(events: AsyncGenerator<SseEvent>): Promise<void> {
    try {
      for await (const ev of events) {
        if (ev.event !== 'message' && ev.event !== '') continue;
        for (const incoming of parseMessages(ev.data)) {
          if (isResponse(incoming) && incoming.id !== undefined && this.ssePending.has(incoming.id)) {
            const pending = this.ssePending.get(incoming.id)!;
            this.ssePending.delete(incoming.id);
            clearTimeout(pending.timer);
            if (incoming.error) pending.reject(new Error(`MCP error ${incoming.error.code}: ${incoming.error.message}`));
            else pending.resolve(incoming.result);
          } else {
            this.dispatch(incoming);
          }
        }
      }
    } catch (err) {
      if (this.state === 'connected') this.note(`event stream failed: ${errorText(err)}`);
    }
    if (this.state === 'connected') {
      this.note('event stream closed by the server');
      this.setState('closed');
      this.rejectSsePending(new Error('MCP server closed its event stream'));
    }
  }

  private sseRequest(message: JsonRpcRequest): Promise<unknown> {
    contractRequire(this.sseEndpoint !== undefined, 'HTTP+SSE requests need the endpoint the stream named');
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ssePending.delete(message.id!);
        reject(new Error(`MCP request timed out: ${message.method} (${this.requestTimeout}ms)`));
      }, this.requestTimeout);
      this.ssePending.set(message.id!, { resolve, reject, timer });
      this.post(message, this.sseEndpoint!)
        .then(async (res) => {
          if (res.ok) { await res.body?.cancel().catch(() => {}); return; }
          const snippet = await bodySnippet(res);
          this.note(`${message.method}: HTTP ${res.status} ${snippet}`);
          throw new Error(`MCP server answered ${message.method} with HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
        })
        .catch((err) => {
          const pending = this.ssePending.get(message.id!);
          if (!pending) return;
          this.ssePending.delete(message.id!);
          clearTimeout(pending.timer);
          pending.reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  private rejectSsePending(error: Error): void {
    for (const pending of this.ssePending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.ssePending.clear();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Shared
  // ═══════════════════════════════════════════════════════════════════

  /** POST one message, with a single retry on a fresh token when the server refuses the first. */
  private post(message: JsonRpcMessage, url: string, signal?: AbortSignal): Promise<Response> {
    const body = JSON.stringify(message);
    return this.fetchAuthorized(token => fetch(url, {
      method: 'POST',
      headers: this.requestHeadersWith(token, {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      }),
      body,
      signal,
    }));
  }

  /**
   * Run a request with the current token; on a refusal, ask for a fresh one
   * and run it once more. A refusal that survives that is the caller's to
   * resolve, so it becomes MCPAuthRequiredError.
   */
  private async fetchAuthorized(send: (token: string | undefined) => Promise<Response>): Promise<Response> {
    let res = await send(await this.auth?.token());
    let challenge = refusal(res);
    if (challenge === null) return res;
    await res.body?.cancel().catch(() => {});
    if (this.auth && await this.auth.refresh(challenge)) {
      res = await send(await this.auth.token());
      challenge = refusal(res);
      if (challenge === null) return res;
      await res.body?.cancel().catch(() => {});
    }
    this.note(`HTTP ${res.status}: the server wants credentials${challenge ? ` (${challenge})` : ''}`);
    throw new MCPAuthRequiredError(
      `${new URL(this.url).host} refused the request (HTTP ${res.status}): it needs a sign-in or credentials`,
      challenge,
      res.status,
    );
  }

  private requestHeadersWith(token: string | undefined, extra: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...this.headers, ...extra };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  private async requestHeaders(extra: Record<string, string>): Promise<Record<string, string>> {
    return this.requestHeadersWith(await this.auth?.token().catch(() => undefined), extra);
  }

  /**
   * A message the server sent that is not the response being waited for:
   * notifications go to the listener, and requests get an answer, since the
   * server may be waiting on it. Only ping is served; this client declares no
   * capabilities, so anything else is answered as unknown.
   */
  private dispatch(message: JsonRpcMessage): void {
    if (!('method' in message) || typeof message.method !== 'string') return;
    if (message.id === undefined) {
      this.events.onNotification?.(message.method, message.params);
      return;
    }
    const answer: JsonRpcResponse = message.method === 'ping'
      ? { jsonrpc: '2.0', id: message.id, result: {} }
      : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not supported by this client: ${message.method}` } };
    const target = this.mode === 'sse' ? this.sseEndpoint : this.url;
    if (!target) return;
    this.post(answer, target)
      .then(res => res.body?.cancel().catch(() => {}))
      .catch(err => this.note(`answering the server's ${message.method}: ${errorText(err)}`));
  }

  private note(text: string): void {
    this.notes.push(text);
    if (this.notes.length > DIAGNOSTIC_NOTES) this.notes.shift();
    log.info(`[${this.url}] ${text}`);
  }

  private setState(state: MCPTransportState): void {
    if (this.state !== state) {
      this.state = state;
      this.events.onStateChange?.(state);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * The challenge when a response refuses the credentials it was sent (401, or
 * 403 for an insufficient scope), or null when it does not.
 */
function refusal(res: Response): string | undefined | null {
  const challenge = res.headers.get('www-authenticate') ?? undefined;
  if (res.status === 401) return challenge;
  if (res.status === 403 && challenge && /insufficient_scope/i.test(challenge)) return challenge;
  return null;
}

function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !('method' in message) && ('result' in message || 'error' in message);
}

/** One JSON-RPC message or a batch of them, from a body or an event's data. */
function parseMessages(text: string): JsonRpcMessage[] {
  if (!text.trim()) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((m): m is JsonRpcMessage => !!m && typeof m === 'object' && (m as { jsonrpc?: unknown }).jsonrpc === '2.0');
  } catch {
    log.warn(`Ignoring a message that is not JSON: ${text.slice(0, 200)}`);
    return [];
  }
}

/** Server-sent events, one per blank-line-terminated block. */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.search(/\r\n|\r|\n/)) >= 0) {
        // A trailing \r may be the first half of a \r\n the next chunk completes.
        if (buffer[newline] === '\r' && newline === buffer.length - 1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer.startsWith('\r\n', newline) ? 2 : 1));
        if (line === '') {
          if (data.length > 0) yield { event, data: data.join('\n') };
          event = '';
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const raw = colon < 0 ? '' : line.slice(colon + 1);
        const content = raw.startsWith(' ') ? raw.slice(1) : raw;
        if (field === 'event') event = content;
        else if (field === 'data') data.push(content);
      }
    }
    if (data.length > 0) yield { event, data: data.join('\n') };
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function bodySnippet(res: Response): Promise<string> {
  try {
    const text = (await res.text()).replace(/\s+/g, ' ').trim();
    return text.length > DIAGNOSTIC_BODY_CHARS ? `${text.slice(0, DIAGNOSTIC_BODY_CHARS)}…` : text;
  } catch {
    return '';
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
