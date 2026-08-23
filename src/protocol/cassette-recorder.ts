/**
 * CassetteRecorder -- the per-object seam between HttpClient and the
 * cassette store. HttpClient asks it two questions: "should this request be
 * served from a recording?" (replay) and "should this response be kept?"
 * (record). Objects not registered here pass through untouched, so the
 * seam costs nothing for the rest of the system.
 */
import { CassetteStore, HTTP_CASSETTE_METHOD, type CassetteRequest, redactRequest } from './cassette.js';

export type RecorderMode = 'record' | 'replay' | 'live';
export interface RecorderEntry {
  mode: RecorderMode;
  store: CassetteStore;
  onRecord?: (store: CassetteStore) => void;
}

const recorders = new Map<string, RecorderEntry>();

export function setRecorder(objectId: string, entry: RecorderEntry): void {
  recorders.set(objectId, entry);
}
export function clearRecorder(objectId: string): void { recorders.delete(objectId); }

/** `rawBody` is the response text verbatim: HttpClient's contract promises
 *  callers a raw string body, so replay must return the same characters the
 *  world sent rather than a re-stringified parse of them. */
export function beforeRequest(objectId: string | undefined, req: CassetteRequest):
  { status: number; rawBody: string; headers: Record<string, string> } | undefined {
  if (!objectId) return undefined;
  const r = recorders.get(objectId);
  if (!r || r.mode !== 'replay') return undefined;
  const hit = r.store.matchRequest(req);
  if (!hit) throw new Error(`replay miss: no cassette for ${req.method} ${req.url}`);
  return { status: hit.response.status, rawBody: hit.rawBody, headers: {} };
}

export function afterResponse(objectId: string | undefined, req: CassetteRequest,
                              res: { status: number; body: unknown; rawBody: string }): void {
  if (!objectId) return;
  const r = recorders.get(objectId);
  if (!r || r.mode !== 'record') return;
  if (res.status < 200 || res.status >= 300) return;
  r.store.add({
    method: HTTP_CASSETTE_METHOD, args: {},
    request: redactRequest(req),
    response: { status: res.status, body: res.body },
    rawBody: res.rawBody,
    parsedOutput: res.body,
    recordedAt: Date.now(),
  });
  r.onRecord?.(r.store);
}
