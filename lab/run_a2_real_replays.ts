/**
 * A2 Kill-Reason Breakdown with Dynamic Replay Generation
 *
 * For each candidate source:
 *  1. Introspects public handlers from the candidate AST / object literal
 *  2. Evaluates the candidate with sample inputs and records authentic Baseline Cassettes (HTTP + method replay)
 *  3. Generates AST mutants for the candidate
 *  4. Evaluates each mutant against the baseline evidence and classifies the exact kill reason
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as acorn from 'acorn';
import Ajv from 'ajv';
import { CassetteStore, type Cassette, HTTP_CASSETTE_METHOD } from '../src/protocol/cassette.js';
import { generateMutants } from '../src/protocol/mutants.js';
import { buildSandboxInvoker } from '../src/protocol/sandbox-invoker.js';
import type { MethodDeclaration } from '../src/core/types.js';
import type { HttpStub, Invoker } from '../src/protocol/fitness.js';
import { GOALS } from './run_a1_corpus.js';
import { evaluateMutantOutcome } from './run_a2_kill_reasons.js';

const CORPUS_DIR = path.resolve(process.cwd(), 'lab/corpus');

export type KillOutcome =
  | 'caught_by_replay'
  | 'caught_by_schema'
  | 'caught_by_relation'
  | 'died_on_stub_miss'
  | 'died_on_timeout'
  | 'runtime_exception'
  | 'survived';

export interface MutantEvaluationDetail {
  description: string;
  outcome: KillOutcome;
  killed: boolean;
  detail: string;
}

export interface SourceKillReport {
  id: string;
  name: string;
  totalMutants: number;
  killedCount: number;
  survivedCount: number;
  killRatio: number;
  breakdown: Record<KillOutcome, number>;
  majorityStubMiss: boolean;
  details: MutantEvaluationDetail[];
}

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
    return hit
      ? { status: hit.response.status, body: hit.response.body, rawBody: hit.rawBody }
      : undefined;
  };
}

export function extractPublicMethods(source: string): string[] {
  try {
    const ast = acorn.parse(`(${source})`, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true }) as any;
    const objExpr = ast.body[0]?.expression;
    if (objExpr && objExpr.type === 'ObjectExpression') {
      return objExpr.properties
        .filter((p: any) => p.type === 'Property' && p.key && !String(p.key.name || p.key.value).startsWith('_'))
        .map((p: any) => String(p.key.name || p.key.value));
    }
  } catch {}
  return [];
}

const COMMON_HTTP_RESPONSES: Record<string, { status: number; body: unknown; rawBody: string }> = {
  'https://api.weather.test/forecast?city=Seattle': {
    status: 200,
    body: { city: 'Seattle', temperature: 68, humidity: 55, conditions: 'Sunny', current: { temperature: 68, humidity: 55 } },
    rawBody: JSON.stringify({ city: 'Seattle', temperature: 68, humidity: 55, conditions: 'Sunny', current: { temperature: 68, humidity: 55 } }),
  },
  'https://api.users.test/profile/u123': {
    status: 200,
    body: { id: 'u123', name: 'Alice', status: 'active', active: true },
    rawBody: JSON.stringify({ id: 'u123', name: 'Alice', status: 'active', active: true }),
  },
  'https://api.users.test/posts?userId=u123': {
    status: 200,
    body: [{ id: 'p1', title: 'First Post', content: 'Hello World' }],
    rawBody: JSON.stringify([{ id: 'p1', title: 'First Post', content: 'Hello World' }]),
  },
  'https://api.users.test/posts?author=u123': {
    status: 200,
    body: [{ id: 'p1', title: 'First Post', content: 'Hello World' }],
    rawBody: JSON.stringify([{ id: 'p1', title: 'First Post', content: 'Hello World' }]),
  },
};

function createRecordingStub(recordedCalls: Cassette[]): HttpStub {
  return (req) => {
    const url = req.url;
    // Find matching mock response or provide default
    let mock = COMMON_HTTP_RESPONSES[url];
    if (!mock) {
      // Generic mock response
      mock = {
        status: 200,
        body: { ok: true, url, items: [] },
        rawBody: JSON.stringify({ ok: true, url, items: [] }),
      };
    }
    recordedCalls.push({
      method: HTTP_CASSETTE_METHOD,
      args: {},
      request: { method: req.method, url: req.url },
      response: { status: mock.status, body: mock.body },
      rawBody: mock.rawBody,
      parsedOutput: mock.body,
      recordedAt: Date.now(),
    });
    return mock;
  };
}

export function samplePayloadForMethod(methodName: string): Record<string, unknown> {
  const m = methodName.toLowerCase();
  if (m.includes('weather') || m.includes('forecast')) return { city: 'Seattle' };
  if (m.includes('task')) return { title: 'Write tests', priority: 1, tag: 'dev', id: 't1' };
  if (m.includes('item') || m.includes('inventory')) return { id: 'i1', name: 'Widget', qty: 10, price: 5, sku: 'W1' };
  if (m.includes('appointment') || m.includes('schedule')) return { id: 'a1', title: 'Meeting', startIso: '2026-08-25T10:00:00Z', endIso: '2026-08-25T11:00:00Z' };
  if (m.includes('user') || m.includes('feed')) return { userId: 'u123' };
  if (m.includes('metric')) return { name: 'cpu', value: 42, timestamp: Date.now() };
  if (m.includes('text') || m.includes('analyze')) return { text: 'The quick brown fox jumps over the lazy dog.' };
  if (m.includes('cache') || m === 'set') return { key: 'foo', value: 'bar', ttlMs: 60000 };
  if (m === 'get') return { key: 'foo' };
  if (m.includes('rate') || m.includes('limit')) return { clientId: 'c1', limit: 10, windowMs: 60000 };
  if (m.includes('convert')) return { amount: 100, from: 'USD', to: 'EUR', rate: 0.9, value: 32, unit: 'C' };
  if (m.includes('subscribe')) return { topic: 'news', subscriberId: 'sub1' };
  if (m.includes('publish')) return { topic: 'news', message: 'Hello' };
  if (m.includes('location') || m.includes('distance')) return { name: 'Seattle', lat: 47.6062, lon: -122.3321, locA: { lat: 47.6, lon: -122.3 }, locB: { lat: 37.7, lon: -122.4 } };
  if (m.includes('rss') || m.includes('feed')) return { xmlText: '<rss><channel><item><title>News</title><guid>1</guid></item></channel></rss>' };
  if (m.includes('bookmark')) return { id: 'b1', url: 'https://example.com', title: 'Example', tags: ['web'] };
  if (m.includes('evaluate') || m.includes('expr')) return { expr: '2 + 3 * 4', vars: { x: 10 } };
  if (m.includes('markdown') || m.includes('link')) return { markdown: 'Check [Google](https://google.com) and [Docs](https://docs.test)' };
  if (m.includes('cart') || m.includes('discount')) return { sku: 'A1', price: 20, qty: 2, taxable: true, code: 'SAVE10', percent: 10, taxRate: 0.1, shippingCost: 5 };
  if (m.includes('paginate')) return { items: [1, 2, 3, 4, 5], page: 1, pageSize: 2 };
  if (m.includes('ping') || m.includes('report')) return { serviceId: 's1', ok: true, latencyMs: 25 };
  return {};
}

export async function recordEvidenceForCandidate(
  source: string,
  invoker: Invoker
): Promise<{ cassettes: CassetteStore; methods: MethodDeclaration[] } | null> {
  const methodNames = extractPublicMethods(source);
  if (methodNames.length === 0) return null;

  const cassettesList: Cassette[] = [];
  const methods: MethodDeclaration[] = [];
  const recordingStub = createRecordingStub(cassettesList);

  for (const name of methodNames) {
    const payload = samplePayloadForMethod(name);
    try {
      const out = await invoker(source, name, payload, recordingStub);
      cassettesList.push({
        method: name,
        args: payload,
        request: { method: 'DIRECT', url: name },
        response: { status: 200, body: out },
        rawBody: JSON.stringify(out ?? null),
        parsedOutput: out,
        recordedAt: Date.now(),
      });

      methods.push({
        name,
        description: name,
        parameters: [],
        outputSchema: out !== undefined && out !== null ? { type: Array.isArray(out) ? 'array' : typeof out } : undefined,
        relations: Array.isArray(out) ? [{ kind: 'no-duplicates' }] : undefined,
      });
    } catch {
      // If initial probe throws (e.g. requires specific state), still register method declaration
      methods.push({
        name,
        description: name,
        parameters: [],
      });
    }
  }

  return { cassettes: new CassetteStore(cassettesList), methods };
}

async function main() {
  console.log('Running A2 Kill-Reason Analysis with Dynamic Replay Generation...\n');
  const invoker = buildSandboxInvoker();
  const reports: SourceKillReport[] = [];

  // 1. Fixtures
  const FIXTURES = [
    {
      id: 'fixture-events-scraper',
      name: 'FixtureEventsScraper',
      source: `({
        async listEvents(msg) {
          const res = await this.call('HttpClient', 'get', { url: 'https://example.test/events' });
          if (!res.ok) throw new Error('http ' + res.status);
          const data = JSON.parse(res.body);
          return data.filter(e => e.id > 0);
        }
      })`,
      evidence: {
        cassettes: new CassetteStore([
          {
            method: HTTP_CASSETTE_METHOD, args: {},
            request: { method: 'GET', url: 'https://example.test/events' },
            response: { status: 200, body: [{ id: 1, name: 'Concert' }] },
            rawBody: '[{"id":1,"name":"Concert"}]',
            parsedOutput: [{ id: 1, name: 'Concert' }],
            recordedAt: 1,
          },
          {
            method: 'listEvents', args: {},
            request: { method: 'GET', url: 'https://example.test/events' },
            response: { status: 200, body: [{ id: 1, name: 'Concert' }] },
            rawBody: '[{"id":1,"name":"Concert"}]',
            parsedOutput: [{ id: 1, name: 'Concert' }],
            recordedAt: 1,
          },
        ]),
        methods: [
          {
            name: 'listEvents',
            description: '',
            parameters: [],
            outputSchema: { type: 'array', items: { type: 'object' } },
            relations: [{ kind: 'no-duplicates' }],
          },
        ],
      },
    },
    {
      id: 'fixture-two-method-calculator',
      name: 'FixtureTwoMethodCalculator',
      source: `({
        async calculate(msg) {
          const { a, b } = msg.payload || {};
          return this.add(a, b);
        },
        add(x, y) {
          return (Number(x) || 0) + (Number(y) || 0);
        }
      })`,
      evidence: {
        cassettes: new CassetteStore([
          {
            method: 'calculate', args: { a: 5, b: 10 },
            request: { method: 'INTERNAL', url: 'calc' },
            response: { status: 200, body: 15 },
            rawBody: '15',
            parsedOutput: 15,
            recordedAt: 1,
          },
        ]),
        methods: [
          {
            name: 'calculate',
            description: '',
            parameters: [],
            outputSchema: { type: 'number' },
          },
        ],
      },
    },
  ];

  for (const f of FIXTURES) {
    const mutants = generateMutants(f.source, 12) || [];
    const breakdown: Record<KillOutcome, number> = {
      caught_by_replay: 0,
      caught_by_schema: 0,
      caught_by_relation: 0,
      died_on_stub_miss: 0,
      died_on_timeout: 0,
      runtime_exception: 0,
      survived: 0,
    };
    const details: MutantEvaluationDetail[] = [];

    for (const m of mutants) {
      const res = await evaluateMutantOutcome(m.source, m.description, f.evidence, invoker);
      breakdown[res.outcome]++;
      details.push(res);
    }

    const killedCount = mutants.length - breakdown.survived;
    const killRatio = mutants.length > 0 ? killedCount / mutants.length : 1;
    const majorityStubMiss = killedCount > 0 && breakdown.died_on_stub_miss > (killedCount / 2);

    reports.push({
      id: f.id,
      name: f.name,
      totalMutants: mutants.length,
      killedCount,
      survivedCount: breakdown.survived,
      killRatio,
      breakdown,
      majorityStubMiss,
      details,
    });
  }

  // 2. Real Model Output Corpus (A1)
  for (const g of GOALS) {
    const p = path.join(CORPUS_DIR, `${g.id}.json`);
    if (!fs.existsSync(p)) continue;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const source = data.extracted;
    const evidence = await recordEvidenceForCandidate(source, invoker);
    if (!evidence) continue;

    const mutants = generateMutants(source, 12) || [];
    const breakdown: Record<KillOutcome, number> = {
      caught_by_replay: 0,
      caught_by_schema: 0,
      caught_by_relation: 0,
      died_on_stub_miss: 0,
      died_on_timeout: 0,
      runtime_exception: 0,
      survived: 0,
    };
    const details: MutantEvaluationDetail[] = [];

    for (const m of mutants) {
      const res = await evaluateMutantOutcome(m.source, m.description, evidence, invoker);
      breakdown[res.outcome]++;
      details.push(res);
    }

    const killedCount = mutants.length - breakdown.survived;
    const killRatio = mutants.length > 0 ? killedCount / mutants.length : 1;
    const majorityStubMiss = killedCount > 0 && breakdown.died_on_stub_miss > (killedCount / 2);

    reports.push({
      id: g.id,
      name: g.name,
      totalMutants: mutants.length,
      killedCount,
      survivedCount: breakdown.survived,
      killRatio,
      breakdown,
      majorityStubMiss,
      details,
    });
  }

  // Save report
  fs.writeFileSync(path.join(CORPUS_DIR, 'a2_kill_breakdown_dynamic.json'), JSON.stringify(reports, null, 2));

  console.log('=== A2 Kill-Reason Breakdown Table ===');
  console.log('| ID | Name | Mutants | Kill Ratio | Replay | Schema | Relation | Stub Miss | Timeout | Runtime Err | Survived | Majority Stub Miss? |');
  console.log('| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');
  for (const r of reports) {
    const b = r.breakdown;
    console.log(`| ${r.id} | ${r.name} | ${r.totalMutants} | ${(r.killRatio * 100).toFixed(0)}% | ${b.caught_by_replay} | ${b.caught_by_schema} | ${b.caught_by_relation} | ${b.died_on_stub_miss} | ${b.died_on_timeout} | ${b.runtime_exception} | ${b.survived} | ${r.majorityStubMiss ? '⚠️ YES' : 'NO'} |`);
  }

  // Aggregates
  const totalMutants = reports.reduce((s, r) => s + r.totalMutants, 0);
  const totalKilled = reports.reduce((s, r) => s + r.killedCount, 0);
  const totalSurvived = reports.reduce((s, r) => s + r.survivedCount, 0);
  const totalReplay = reports.reduce((s, r) => s + r.breakdown.caught_by_replay, 0);
  const totalSchema = reports.reduce((s, r) => s + r.breakdown.caught_by_schema, 0);
  const totalRelation = reports.reduce((s, r) => s + r.breakdown.caught_by_relation, 0);
  const totalStubMiss = reports.reduce((s, r) => s + r.breakdown.died_on_stub_miss, 0);
  const totalTimeout = reports.reduce((s, r) => s + r.breakdown.died_on_timeout, 0);
  const totalRuntimeErr = reports.reduce((s, r) => s + r.breakdown.runtime_exception, 0);

  console.log('\n=== A2 Aggregate Totals & Percentages ===');
  console.log(`Total Mutants Tested: ${totalMutants}`);
  console.log(`Total Killed: ${totalKilled} (${((totalKilled / totalMutants) * 100).toFixed(1)}%)`);
  console.log(`Total Survived: ${totalSurvived} (${((totalSurvived / totalMutants) * 100).toFixed(1)}%)`);
  console.log(`- Caught by Replay: ${totalReplay} (${((totalReplay / totalMutants) * 100).toFixed(1)}%)`);
  console.log(`- Caught by Schema: ${totalSchema} (${((totalSchema / totalMutants) * 100).toFixed(1)}%)`);
  console.log(`- Caught by Relation: ${totalRelation} (${((totalRelation / totalMutants) * 100).toFixed(1)}%)`);
  console.log(`- Died on Stub Miss: ${totalStubMiss} (${((totalStubMiss / totalMutants) * 100).toFixed(1)}%)`);
  console.log(`- Died on Timeout: ${totalTimeout} (${((totalTimeout / totalMutants) * 100).toFixed(1)}%)`);
  console.log(`- Runtime Exception: ${totalRuntimeErr} (${((totalRuntimeErr / totalMutants) * 100).toFixed(1)}%)`);

  const stubMissSources = reports.filter(r => r.majorityStubMiss);
  console.log(`\nSources with Majority Stub Misses: ${stubMissSources.length} (${stubMissSources.map(s => s.name).join(', ') || 'none'})`);
}

main().catch(err => {
  console.error('Fatal error in A2 dynamic:', err);
  process.exit(1);
});
