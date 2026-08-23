/**
 * CassetteRecorder -- the per-object seam between HttpClient and the
 * cassette store. HttpClient asks it two questions: "should this request be
 * served from a recording?" (replay) and "should this response be kept?"
 * (record). Objects not registered here pass through untouched, so the
 * seam costs nothing for the rest of the system.
 */
import { CassetteStore, type CassetteRequest, redactRequest } from './cassette.js';

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
export function getRecorder(objectId: string): RecorderEntry | undefined {
  return recorders.get(objectId);
}

export function beforeRequest(objectId: string | undefined, req: CassetteRequest):
  { status: number; body: unknown; headers: Record<string, string> } | undefined {
  if (!objectId) return undefined;
  const r = recorders.get(objectId);
  if (!r || r.mode !== 'replay') return undefined;
  const hit = r.store.matchRequest(req);
  if (!hit) throw new Error(`replay miss: no cassette for ${req.method} ${req.url}`);
  return { status: hit.response.status, body: hit.response.body, headers: {} };
}

export function afterResponse(objectId: string | undefined, req: CassetteRequest,
                              res: { status: number; body: unknown }): void {
  if (!objectId) return;
  const r = recorders.get(objectId);
  if (!r || r.mode !== 'record') return;
  if (res.status < 200 || res.status >= 300) return;
  r.store.add({
    method: '_http', args: {},
    request: redactRequest(req),
    response: res,
    parsedOutput: res.body,
    recordedAt: Date.now(),
  });
  r.onRecord?.(r.store);
}
