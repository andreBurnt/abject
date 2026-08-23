/**
 * Fitness -- the judge the object cannot edit.
 *
 * evaluate() decides whether a candidate source is fit to deploy. It never
 * calls an LLM and never touches the network: all I/O is served from
 * recorded cassettes through the caller-supplied Invoker. Checks run in
 * order -- replay, schema, relations, mutation -- and the first hard
 * failure short-circuits.
 */
import Ajv from 'ajv';
import { CassetteStore } from './cassette.js';
import type { MethodDeclaration } from '../core/types.js';

export interface HttpExchange { status: number; body: unknown; }
export type HttpStub = (req: { method: string; url: string }) => HttpExchange | undefined;
export type Invoker = (source: string, method: string,
                       args: Record<string, unknown>, http: HttpStub) => Promise<unknown>;

export interface CheckResult {
  check: 'replay' | 'schema' | 'relations' | 'mutation';
  pass: boolean;
  detail: string;
}
export interface Verdict { pass: boolean; checks: CheckResult[]; killRatio?: number; }
export interface FitnessEvidence { cassettes: CassetteStore; methods: MethodDeclaration[]; }
export interface FitnessOptions { maxMutants?: number; killThreshold?: number; }

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(k =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function stubFor(cassettes: CassetteStore): HttpStub {
  return req => {
    const hit = cassettes.matchRequest({ method: req.method, url: req.url });
    return hit ? { status: hit.response.status, body: hit.response.body } : undefined;
  };
}

async function checkReplay(source: string, ev: FitnessEvidence, invoke: Invoker): Promise<CheckResult> {
  const all = ev.cassettes.all();
  if (all.length === 0) {
    return { check: 'replay', pass: true, detail: 'no cassettes yet (first create); probe required by caller' };
  }
  for (const c of all) {
    let out: unknown;
    try {
      out = await invoke(source, c.method, c.args, stubFor(ev.cassettes));
    } catch (err) {
      return { check: 'replay', pass: false,
        detail: `${c.method}(${JSON.stringify(c.args)}) threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!deepEqual(out, c.parsedOutput)) {
      return { check: 'replay', pass: false,
        detail: `${c.method}(${JSON.stringify(c.args)}) diverged from cassette recorded at ${c.recordedAt}` };
    }
  }
  return { check: 'replay', pass: true, detail: `${all.length} cassette(s) reproduced` };
}

async function checkSchema(source: string, ev: FitnessEvidence, invoke: Invoker): Promise<CheckResult> {
  const ajv = new Ajv({ allErrors: true, strict: false });
  for (const m of ev.methods) {
    if (!m.outputSchema) continue;
    const validate = ajv.compile(m.outputSchema);
    const probes = ev.cassettes.byMethod(m.name).map(c => c.args);
    if (probes.length === 0) probes.push({});
    let validatedCount = 0;
    let firstError: string | undefined;
    for (const args of probes) {
      let out: unknown;
      try {
        out = await invoke(source, m.name, args, stubFor(ev.cassettes));
      } catch (err) {
        if (!firstError) {
          firstError = err instanceof Error ? err.message : String(err);
        }
        continue; // replay already judges throwing; schema judges shape of what returns
      }
      if (!validate(out)) {
        return { check: 'schema', pass: false,
          detail: `${m.name}: ${ajv.errorsText(validate.errors)}` };
      }
      validatedCount++;
    }
    if (validatedCount === 0 && firstError) {
      return { check: 'schema', pass: false,
        detail: `${m.name}: no output could be validated (all probes threw: ${firstError})` };
    }
  }
  return { check: 'schema', pass: true, detail: 'all outputs validate' };
}

export async function evaluate(candidate: { source: string },
                               evidence: FitnessEvidence,
                               invoker: Invoker,
                               opts?: FitnessOptions): Promise<Verdict> {
  const checks: CheckResult[] = [];

  const replay = await checkReplay(candidate.source, evidence, invoker);
  checks.push(replay);
  if (!replay.pass) return { pass: false, checks };

  const schema = await checkSchema(candidate.source, evidence, invoker);
  checks.push(schema);
  if (!schema.pass) return { pass: false, checks };

  // Tasks 4 & 5 replace these:
  checks.push({ check: 'relations', pass: true, detail: 'not yet checked' });
  checks.push({ check: 'mutation', pass: true, detail: 'not yet checked' });
  return { pass: true, checks };
}
