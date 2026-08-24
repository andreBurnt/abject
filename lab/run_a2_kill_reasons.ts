/**
 * A2 Kill-Reason Breakdown Instrumenter
 *
 * Evaluates mutants under an instrumented harness to classify every mutant outcome:
 *   - caught_by_replay
 *   - caught_by_schema
 *   - caught_by_relation
 *   - died_on_stub_miss
 *   - died_on_timeout
 *   - runtime_exception
 *   - survived
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv from 'ajv';
import { CassetteStore, type Cassette, HTTP_CASSETTE_METHOD } from '../src/protocol/cassette.js';
import { generateMutants, type Mutant } from '../src/protocol/mutants.js';
import { buildSandboxInvoker } from '../src/protocol/sandbox-invoker.js';
import type { MethodDeclaration, RelationDeclaration } from '../src/core/types.js';
import type { HttpStub, Invoker } from '../src/protocol/fitness.js';
import { GOALS, type GoalSpec } from './run_a1_corpus.js';

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

function fieldValue(el: unknown, field: string): unknown {
  return el !== null && typeof el === 'object'
    ? (el as Record<string, unknown>)[field] : undefined;
}

export async function evaluateMutantOutcome(
  mutantSource: string,
  description: string,
  evidence: { cassettes: CassetteStore; methods: MethodDeclaration[] },
  invoker: Invoker
): Promise<MutantEvaluationDetail> {
  const replayable = evidence.cassettes.all().filter(c => c.method !== HTTP_CASSETTE_METHOD);
  const stub = stubFor(evidence.cassettes);

  // 1. Replay check
  for (const c of replayable) {
    let out: unknown;
    try {
      out = await invoker(mutantSource, c.method, c.args, stub);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/unstubbed I\/O/i.test(msg) || /no cassette for/i.test(msg)) {
        return { description, outcome: 'died_on_stub_miss', killed: true, detail: msg };
      }
      if (/invocation timeout/i.test(msg)) {
        return { description, outcome: 'died_on_timeout', killed: true, detail: msg };
      }
      return { description, outcome: 'runtime_exception', killed: true, detail: msg };
    }

    if (!deepEqual(out, c.parsedOutput)) {
      return {
        description,
        outcome: 'caught_by_replay',
        killed: true,
        detail: `${c.method} output diverged from cassette`,
      };
    }
  }

  // 2. Schema check
  const ajv = new Ajv({ allErrors: true, strict: false });
  for (const m of evidence.methods) {
    if (!m.outputSchema) continue;
    const validate = ajv.compile(m.outputSchema);
    const probes = replayable.filter(c => c.method === m.name).map(c => c.args);
    if (probes.length === 0) probes.push({});

    for (const args of probes) {
      let out: unknown;
      try {
        out = await invoker(mutantSource, m.name, args, stub);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/unstubbed I\/O/i.test(msg) || /no cassette for/i.test(msg)) {
          return { description, outcome: 'died_on_stub_miss', killed: true, detail: msg };
        }
        if (/invocation timeout/i.test(msg)) {
          return { description, outcome: 'died_on_timeout', killed: true, detail: msg };
        }
        return { description, outcome: 'runtime_exception', killed: true, detail: msg };
      }

      if (!validate(out)) {
        return {
          description,
          outcome: 'caught_by_schema',
          killed: true,
          detail: `${m.name}: schema invalid (${ajv.errorsText(validate.errors)})`,
        };
      }
    }
  }

  // 3. Relations check
  for (const m of evidence.methods) {
    if (!m.relations?.length) continue;
    const probes = replayable.filter(c => c.method === m.name).map(c => c.args);
    if (probes.length === 0) probes.push({});

    for (const args of probes) {
      let out: unknown;
      try {
        out = await invoker(mutantSource, m.name, args, stub);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/unstubbed I\/O/i.test(msg) || /no cassette for/i.test(msg)) {
          return { description, outcome: 'died_on_stub_miss', killed: true, detail: msg };
        }
        if (/invocation timeout/i.test(msg)) {
          return { description, outcome: 'died_on_timeout', killed: true, detail: msg };
        }
        return { description, outcome: 'runtime_exception', killed: true, detail: msg };
      }

      for (const rel of m.relations) {
        if (rel.kind === 'no-duplicates' && Array.isArray(out)) {
          const keys = out.map(el => JSON.stringify(el));
          if (new Set(keys).size !== out.length) {
            return { description, outcome: 'caught_by_relation', killed: true, detail: `${m.name}: no-duplicates violated` };
          }
        }
        if (rel.kind === 'sorted-by' && rel.field && Array.isArray(out)) {
          for (let i = 1; i < out.length; i++) {
            const prev = fieldValue(out[i - 1], rel.field);
            const curr = fieldValue(out[i], rel.field);
            if (prev !== undefined && curr !== undefined && String(prev) > String(curr)) {
              return { description, outcome: 'caught_by_relation', killed: true, detail: `${m.name}: sorted-by violated` };
            }
          }
        }
      }
    }
  }

  // If no check failed/caught it
  return { description, outcome: 'survived', killed: false, detail: 'mutant survived all checks' };
}

export function buildSyntheticEvidenceForGoal(g: GoalSpec): { cassettes: CassetteStore; methods: MethodDeclaration[] } {
  const cassettesList: Cassette[] = [];
  const methods: MethodDeclaration[] = [];

  switch (g.id) {
    case '01-http-weather': {
      methods.push({
        name: 'fetchForecast',
        description: 'fetch',
        parameters: [],
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      });
      methods.push({
        name: 'getReport',
        description: 'get',
        parameters: [],
        outputSchema: { type: 'object', properties: { temp: { type: 'number' } } },
      });
      // Outbound HTTP cassette
      cassettesList.push({
        method: HTTP_CASSETTE_METHOD,
        args: {},
        request: { method: 'GET', url: 'https://api.weather.test/forecast?city=Seattle' },
        response: { status: 200, body: { city: 'Seattle', temp: 68, humidity: 55, condition: 'Sunny' } },
        rawBody: '{"city":"Seattle","temp":68,"humidity":55,"condition":"Sunny"}',
        parsedOutput: { city: 'Seattle', temp: 68, humidity: 55, condition: 'Sunny' },
        recordedAt: Date.now(),
      });
      // Method replay cassette
      cassettesList.push({
        method: 'fetchForecast',
        args: { city: 'Seattle' },
        request: { method: 'GET', url: 'https://api.weather.test/forecast?city=Seattle' },
        response: { status: 200, body: { ok: true } },
        rawBody: '{"ok":true}',
        parsedOutput: { ok: true, temp: 68, condition: 'Sunny' },
        recordedAt: Date.now(),
      });
      break;
    }
    case '02-filter-sort-tasks': {
      methods.push({
        name: 'getPrioritizedTasks',
        description: 'tasks',
        parameters: [],
        relations: [{ kind: 'no-duplicates' }],
        outputSchema: { type: 'array' },
      });
      cassettesList.push({
        method: 'getPrioritizedTasks',
        args: { tag: 'work' },
        request: { method: 'INTERNAL', url: 'tasks' },
        response: { status: 200, body: [] },
        rawBody: '[]',
        parsedOutput: [{ id: 't1', title: 'Review PR', priority: 1 }],
        recordedAt: Date.now(),
      });
      break;
    }
    case '05-chained-calls-posts': {
      methods.push({
        name: 'fetchUserFeed',
        description: 'feed',
        parameters: [],
        outputSchema: { type: 'object' },
      });
      cassettesList.push({
        method: HTTP_CASSETTE_METHOD,
        args: {},
        request: { method: 'GET', url: 'https://api.users.test/profile/u123' },
        response: { status: 200, body: { id: 'u123', status: 'active', name: 'Alice' } },
        rawBody: '{"id":"u123","status":"active","name":"Alice"}',
        parsedOutput: { id: 'u123', status: 'active', name: 'Alice' },
        recordedAt: Date.now(),
      });
      cassettesList.push({
        method: HTTP_CASSETTE_METHOD,
        args: {},
        request: { method: 'GET', url: 'https://api.users.test/posts?userId=u123' },
        response: { status: 200, body: [{ id: 'p1', title: 'Hello World' }] },
        rawBody: '[{"id":"p1","title":"Hello World"}]',
        parsedOutput: [{ id: 'p1', title: 'Hello World' }],
        recordedAt: Date.now(),
      });
      cassettesList.push({
        method: 'fetchUserFeed',
        args: { userId: 'u123' },
        request: { method: 'GET', url: 'https://api.users.test/profile/u123' },
        response: { status: 200, body: {} },
        rawBody: '{}',
        parsedOutput: { user: { id: 'u123', name: 'Alice' }, posts: [{ id: 'p1', title: 'Hello World' }] },
        recordedAt: Date.now(),
      });
      break;
    }
    default: {
      const primaryMethod = g.expectedMethods[0] || 'getState';
      methods.push({
        name: primaryMethod,
        description: 'default test method',
        parameters: [],
        outputSchema: { type: ['object', 'array', 'number', 'string', 'boolean'] },
      });
      cassettesList.push({
        method: primaryMethod,
        args: {},
        request: { method: 'INTERNAL', url: g.id },
        response: { status: 200, body: {} },
        rawBody: '{}',
        parsedOutput: {},
        recordedAt: Date.now(),
      });
      break;
    }
  }

  return { cassettes: new CassetteStore(cassettesList), methods };
}

export async function runA2Analysis(): Promise<SourceKillReport[]> {
  console.log('Running A2 Kill-Reason Analysis over A1 corpus + test fixtures...');
  const invoker = buildSandboxInvoker();
  const reports: SourceKillReport[] = [];

  // 1. Existing unit test fixtures from fitness.test.ts
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

  // 2. A1 Corpus files
  if (fs.existsSync(CORPUS_DIR)) {
    for (const g of GOALS) {
      const p = path.join(CORPUS_DIR, `${g.id}.json`);
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const source = data.extracted;
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
      const evidence = buildSyntheticEvidenceForGoal(g);

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
  }

  // Save report
  fs.writeFileSync(path.join(CORPUS_DIR, 'a2_kill_breakdown.json'), JSON.stringify(reports, null, 2));

  console.log('\n=== A2 Kill-Reason Breakdown Summary ===');
  console.log('| ID | Name | Mutants | Kill % | Replay | Schema | Rel | Stub Miss | Timeout | Runtime Err | Survived |');
  console.log('| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');
  for (const r of reports) {
    const b = r.breakdown;
    console.log(`| ${r.id} | ${r.name} | ${r.totalMutants} | ${(r.killRatio * 100).toFixed(0)}% | ${b.caught_by_replay} | ${b.caught_by_schema} | ${b.caught_by_relation} | ${b.died_on_stub_miss} | ${b.died_on_timeout} | ${b.runtime_exception} | ${b.survived} |`);
  }

  return reports;
}

if (process.argv[1]?.endsWith('run_a2_kill_reasons.ts')) {
  runA2Analysis().catch(err => {
    console.error('Fatal error in A2:', err);
    process.exit(1);
  });
}
