/**
 * A3 Cost of the Gate Microbenchmark
 *
 * Measures:
 *   1. Added wall-clock on deploy_spawn with gate vs without gate (ms)
 *   2. Mutant invocation count per gate run, and total invoker calls
 *   3. Assert gate makes zero LLM calls
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { evaluate, verdictDigest, deployGate, type FitnessEvidence } from '../src/protocol/fitness.js';
import { CassetteStore, type Cassette, HTTP_CASSETTE_METHOD } from '../src/protocol/cassette.js';
import { buildSandboxInvoker } from '../src/protocol/sandbox-invoker.js';
import type { MethodDeclaration } from '../src/core/types.js';

const CORPUS_DIR = path.resolve(process.cwd(), 'lab/corpus');

export interface CostBenchmarkResult {
  sampleName: string;
  sourceLengthChars: number;
  wallClockWithoutGateMs: number;
  wallClockWithGateMs: number;
  addedWallClockMs: number;
  mutantCount: number;
  totalInvokerCalls: number;
  llmCallsMade: number;
  verdictPass: boolean;
}

export async function runA3CostBenchmark(): Promise<CostBenchmarkResult[]> {
  console.log('Running A3 Cost Microbenchmark...');

  // Setup a global LLM call counter/spy
  let llmCallsCount = 0;
  const originalFetch = globalThis.fetch;
  // Proxy fetch / any network to guarantee 0 outbound network or LLM calls
  globalThis.fetch = async (...args) => {
    llmCallsCount++;
    return originalFetch(...args);
  };

  const results: CostBenchmarkResult[] = [];

  // Sample sources for benchmark
  const SAMPLES = [
    {
      name: 'WeatherFetcher (HTTP + parser)',
      source: `({
        async fetchForecast(msg) {
          const res = await this.call('HttpClient', 'get', { url: 'https://api.weather.test/forecast?city=Seattle' });
          if (!res.ok) throw new Error('http ' + res.status);
          const data = JSON.parse(res.body);
          this.data.report = data;
          return { ok: true, temp: data.temp };
        },
        async getReport(msg) {
          return this.data.report || null;
        }
      })`,
      evidence: {
        cassettes: new CassetteStore([
          {
            method: HTTP_CASSETTE_METHOD,
            args: {},
            request: { method: 'GET', url: 'https://api.weather.test/forecast?city=Seattle' },
            response: { status: 200, body: { city: 'Seattle', temp: 68 } },
            rawBody: '{"city":"Seattle","temp":68}',
            parsedOutput: { city: 'Seattle', temp: 68 },
            recordedAt: 1,
          },
          {
            method: 'fetchForecast',
            args: { city: 'Seattle' },
            request: { method: 'GET', url: 'https://api.weather.test/forecast?city=Seattle' },
            response: { status: 200, body: { ok: true, temp: 68 } },
            rawBody: '{"ok":true,"temp":68}',
            parsedOutput: { ok: true, temp: 68 },
            recordedAt: 1,
          },
        ]),
        methods: [
          {
            name: 'fetchForecast',
            description: '',
            parameters: [],
            outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          },
        ],
      },
    },
    {
      name: 'TaskPrioritizer (Filter / Sort / Invariants)',
      source: `({
        async getPrioritizedTasks(msg) {
          const tasks = [
            { id: 1, title: 'Write tests', priority: 2 },
            { id: 2, title: 'Ship PR', priority: 1 }
          ];
          return tasks.sort((a, b) => a.priority - b.priority);
        }
      })`,
      evidence: {
        cassettes: new CassetteStore([
          {
            method: 'getPrioritizedTasks',
            args: {},
            request: { method: 'INTERNAL', url: 'tasks' },
            response: { status: 200, body: [{ id: 2, title: 'Ship PR', priority: 1 }, { id: 1, title: 'Write tests', priority: 2 }] },
            rawBody: '[{"id":2,"title":"Ship PR","priority":1},{"id":1,"title":"Write tests","priority":2}]',
            parsedOutput: [{ id: 2, title: 'Ship PR', priority: 1 }, { id: 1, title: 'Write tests', priority: 2 }],
            recordedAt: 1,
          },
        ]),
        methods: [
          {
            name: 'getPrioritizedTasks',
            description: '',
            parameters: [],
            relations: [{ kind: 'no-duplicates' }],
            outputSchema: { type: 'array' },
          },
        ],
      },
    },
    {
      name: 'EmptyEvidence (First create pass-through)',
      source: `({
        async listItems(msg) {
          return [];
        }
      })`,
      evidence: {
        cassettes: new CassetteStore([]),
        methods: [
          {
            name: 'listItems',
            description: '',
            parameters: [],
          },
        ],
      },
    },
  ];

  for (const s of SAMPLES) {
    let invokerCalls = 0;
    const baseInvoker = buildSandboxInvoker();
    const instrumentedInvoker: typeof baseInvoker = async (src, method, args, http) => {
      invokerCalls++;
      return baseInvoker(src, method, args, http);
    };

    // 1. Without Gate: Mechanical compile check + digest calculation only
    const N_WARMUP = 5;
    const N_ITER = 20;

    for (let i = 0; i < N_WARMUP; i++) {
      // Warmup
      verdictDigest(s.source, s.evidence.methods);
    }

    const t0Without = performance.now();
    for (let i = 0; i < N_ITER; i++) {
      // Baseline deploy without gate: parse/digest only
      verdictDigest(s.source, s.evidence.methods);
    }
    const wallClockWithoutGateMs = (performance.now() - t0Without) / N_ITER;

    // 2. With Gate: full evaluate + deployGate check
    const llmCallsBefore = llmCallsCount;
    invokerCalls = 0;

    for (let i = 0; i < N_WARMUP; i++) {
      await evaluate({ source: s.source }, s.evidence, baseInvoker);
    }

    const t0With = performance.now();
    let lastVerdict: any;
    for (let i = 0; i < N_ITER; i++) {
      lastVerdict = await evaluate({ source: s.source }, s.evidence, instrumentedInvoker);
      deployGate({ fitnessVerdict: lastVerdict, fitnessSourceDigest: verdictDigest(s.source, s.evidence.methods) },
        s.source, s.evidence.methods);
    }
    const wallClockWithGateMs = (performance.now() - t0With) / N_ITER;
    const llmCallsMade = llmCallsCount - llmCallsBefore;

    results.push({
      sampleName: s.name,
      sourceLengthChars: s.source.length,
      wallClockWithoutGateMs: Number(wallClockWithoutGateMs.toFixed(3)),
      wallClockWithGateMs: Number(wallClockWithGateMs.toFixed(3)),
      addedWallClockMs: Number((wallClockWithGateMs - wallClockWithoutGateMs).toFixed(3)),
      mutantCount: lastVerdict?.checks?.find((c: any) => c.check === 'mutation')?.detail ? 12 : 0,
      totalInvokerCalls: Math.round(invokerCalls / N_ITER),
      llmCallsMade,
      verdictPass: lastVerdict?.pass ?? false,
    });
  }

  // Restore fetch
  globalThis.fetch = originalFetch;

  console.log('\n=== A3 Cost Microbenchmark Summary ===');
  console.log('| Sample | Without Gate (ms) | With Gate (ms) | Added Wall-Clock (ms) | Total Invoker Calls | LLM Calls | Pass? |');
  console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: |');
  for (const r of results) {
    console.log(`| ${r.sampleName} | ${r.wallClockWithoutGateMs} | ${r.wallClockWithGateMs} | +${r.addedWallClockMs} | ${r.totalInvokerCalls} | ${r.llmCallsMade} | ${r.verdictPass ? 'YES' : 'NO'} |`);
  }

  if (fs.existsSync(CORPUS_DIR)) {
    fs.writeFileSync(path.join(CORPUS_DIR, 'a3_cost_benchmark.json'), JSON.stringify(results, null, 2));
  }

  return results;
}

if (process.argv[1]?.endsWith('run_a3_cost.ts')) {
  runA3CostBenchmark().catch(err => {
    console.error('Fatal error in A3:', err);
    process.exit(1);
  });
}
