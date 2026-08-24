/**
 * A1 Corpus Generator & Dialect Analyzer
 *
 * Generates 20 real model outputs using Antigravity CLI at the `code` tier,
 * saves them to disk under `lab/corpus/`, and analyzes:
 *   1. parseCandidate / generateMutants null rate
 *   2. Specific syntactic deviations for any nulls
 *   3. Mutation site counts and distributions
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as acorn from 'acorn';
import { AntigravityCliProvider } from '../src/llm/antigravity-cli.js';
import { systemMessage, userMessage } from '../src/llm/provider.js';
import { generateMutants } from '../src/protocol/mutants.js';

const CORPUS_DIR = path.resolve(process.cwd(), 'lab/corpus');

const DRAFT_SOURCE_SYSTEM_PROMPT = [
  'You are drafting handler-map JavaScript for a ScriptableAbject. Output ONE ```javascript code block.',
  'Format: a single parenthesized object literal: ({ method(msg) { ... }, ... }).',
  'Each handler takes a single `msg` argument; payload is `msg.payload`. Inter-object work is `await this.call(target, method, payload)` where `target` is a RESOLVED AbjectId.',
  'RUNTIME: handler code runs in a sandboxed backend (a Node vm inside a worker thread), NOT in a browser. There is NO `window`, `document`, `navigator`, `localStorage`, `fetch`, `WebSocket`, `AudioContext`, `Image`, DOM, or `setTimeout`/`setInterval` as globals. The only ambient globals are `Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp` plus your `this.*` helpers (`this.call`, `this.dep`, `this.data`, `this.changed`, `this.ensure`, `this.invariant`). Reaching for a browser API silently does nothing (or is caught and dropped), so the feature never runs — do not write it.',
  'Every capability a browser would give you — sound, speech, HTTP, persistence, files, timers/scheduling, clipboard, drawing — is instead provided by some other Abject you reach by message. You do not know their names a priori: discover the right object and how to drive it through the ask/discover protocol (`call("Registry", "discover", { ... })` to find it, `call("<object>", "ask", { question })` to learn its methods and read its usage guide), then `await this.call(id, method, payload)`. When a goal needs a capability, discover its provider first rather than assuming a browser API exists or hardcoding an object name.',
  'In generated handler code, `this.call(target, …)` routes by AbjectId only — the bus does NOT resolve names on the send path. Resolve a dependency to its id first: `const id = await this.dep("Name")` (or `this.find("Name")`), then `await this.call(id, method, payload)` — or inline `await this.call(this.dep("Name"), method, payload)`. NEVER pass a bare name string as the recipient (e.g. `this.call("WidgetManager", …)`); that call is delivered nowhere and times out. (This differs from the ObjectCreator `call` ACTION you use to investigate, which DOES accept a bare name — generated code does not.) Ids returned at runtime (window/canvas/layout ids from create*) are already resolved; pass them directly.',
  'Build windows/canvas from an async handler and AWAIT each step in order. Awaiting an inter-object call inside your own handler is correct and does NOT deadlock — the reply is delivered while the handler is suspended. A build that times out means a wrong recipient or a missing await, never the awaiting itself; do not detach the build into a fire-and-forget chain to "avoid a deadlock". Ask the window/canvas factory for its build recipe before drafting.',
  'Use ONLY methods listed in the provided dependency manifests / usage guides. Do not invent method names.',
  'Method names that are not in the framework or in a dependency\'s manifest do not exist — pick a real one or restructure.',
  'When a dependency\'s usage guide documents a higher-level building block that fits the need, compose it rather than re-implementing equivalent behavior from low-level primitives. Reuse the building blocks; drop to primitives only for what the building blocks do not cover.',
  'Prefer composing high-level building blocks over hand-writing equivalents — e.g. render markdown with a markdown-capable label/widget rather than writing your own parser and text-layout engine on a canvas. This keeps the object small and the formatting correct.',
  'Keep each object focused. When a single object would grow very large (many hundreds of lines) or bundles a reusable sub-capability (a parser, a layout engine, a data store), split that capability into its own Abject and call it. Smaller, composed objects are easier to verify and keep the build loop fast (a huge source blows the context budget and makes the loop lose track of what it already tried).',
  'Structure any object that has a UI as Model and View, in the original Smalltalk sense.',
  'MODEL: this.data holds the domain document (the plain data the object IS), and pure helper methods hold the domain rules (validate input, compute results, apply a change to this.data). The model never draws and never references a window, canvas, or widget. Keep transient/view state (window/canvas/layout ids, hover, scroll, cursor, drag, animation clocks) in this._ instance fields, out of this.data.',
  'VIEW: one render method (e.g. _draw / _render) DISPLAYS the model, and the input/event handlers HANDLE the user\'s interaction with that display. In this sense the view both shows the model and handles interaction; input handling belongs to the view, not to a separate controller. On an interaction, apply the change through a model helper, then re-render. The view carries no domain rules of its own.',
  'CONTROLLER (only when there is more than one view or mode): a controller selects the KIND of view of the model (which view/mode is shown, switching modes, coordinating multiple views over one model). It is NOT the input path; that is the view\'s job. A single-view object needs no controller, so do not invent one.',
  'Keep the flow one-directional: interaction in the view leads to a model helper mutating this.data, then a re-display. For any other view or observer, the model announces a change with this.changed(aspect, value); the model never calls into a view.',
  'DCI: name each user-facing use case as the handler that performs that scenario (the context), and express behavior as small role helpers (what the object DOES), while this.data stays plain data (what the object IS). Prefer scenario names over generic CRUD.',
  'Design by Contract on every public handler: open with a precondition using this.ensure(condition, message) (the caller\'s obligation); guarantee a result with a postcondition this.ensure(...) before returning; keep object-state invariants in a _checkInvariants() helper that uses this.invariant(condition, message), and call _checkInvariants() after each mutation. this.ensure and this.invariant are provided and throw a clear ContractViolation when the condition is false. Use these, because the sandbox forbids the require() token.',
  'Make UI look designed, not like a debug view. Before drawing a window/canvas UI, ask the rendering object (the window/canvas factory) "how do I make this look good?" to get its design guide, and use theme colors so the app is cohesive with the user\'s desktop — for canvas draws this means theme tokens like fill: "$accent" / "$textPrimary" / "$windowBg" rather than hardcoded hex. Reserve hand-picked colors for genuine illustration the theme can\'t express.',
].join('\n');

export interface GoalSpec {
  id: string;
  name: string;
  category: string;
  goal: string;
  expectedMethods: string[];
}

export const GOALS: GoalSpec[] = [
  {
    id: '01-http-weather',
    name: 'WeatherFetcher',
    category: 'HTTP Fetcher',
    goal: 'Create an object WeatherFetcher that fetches current weather and forecast from https://api.weather.test/forecast?city={city} using HttpClient, parses temperature, humidity, and conditions, and stores the latest report in this.data.',
    expectedMethods: ['fetchForecast', 'getReport', 'getState'],
  },
  {
    id: '02-filter-sort-tasks',
    name: 'TaskPrioritizer',
    category: 'Filter/Sort',
    goal: 'Create an object TaskPrioritizer that manages prioritized tasks with tags and due dates. Provide getPrioritizedTasks({ tag, dueBefore, limit }) sorting by priority descending and date ascending.',
    expectedMethods: ['addTask', 'getPrioritizedTasks', 'completeTask'],
  },
  {
    id: '03-multi-method-inventory',
    name: 'InventoryManager',
    category: 'Multi-Method',
    goal: 'Create an object InventoryManager with methods addItem({ id, name, qty, price }), removeItem({ id, qty }), searchItems({ query, inStockOnly }), listItems({ offset, limit }), and getValuation().',
    expectedMethods: ['addItem', 'removeItem', 'searchItems', 'listItems', 'getValuation'],
  },
  {
    id: '04-date-scheduler',
    name: 'AppointmentScheduler',
    category: 'Date Parameter',
    goal: 'Create an object AppointmentScheduler with scheduleAppointment({ id, title, startIso, endIso }), hasConflict({ startIso, endIso }), and listBetween({ fromIso, toIso }).',
    expectedMethods: ['scheduleAppointment', 'hasConflict', 'listBetween'],
  },
  {
    id: '05-chained-calls-posts',
    name: 'UserProfileFeed',
    category: 'Chained HTTP Calls',
    goal: 'Create an object UserProfileFeed that fetches user profile from https://api.users.test/profile/{userId} via HttpClient, and if status is active, makes a second call to fetch recent posts from https://api.users.test/posts?userId={userId}.',
    expectedMethods: ['fetchUserFeed', 'getCachedFeed'],
  },
  {
    id: '06-counter-accumulator',
    name: 'MetricsAccumulator',
    category: 'Stateful Accumulator',
    goal: 'Create an object MetricsAccumulator with recordMetric({ name, value, timestamp }), getStats({ name }) (returning min, max, avg, count), and resetMetrics({ name }).',
    expectedMethods: ['recordMetric', 'getStats', 'resetMetrics'],
  },
  {
    id: '07-text-analyzer',
    name: 'TextAnalyzer',
    category: 'Data Processing',
    goal: 'Create an object TextAnalyzer with analyzeText({ text }) that computes word count, average word length, reading time, and exposes topWords({ limit }).',
    expectedMethods: ['analyzeText', 'topWords', 'getSummary'],
  },
  {
    id: '08-key-value-ttl-cache',
    name: 'TtlCache',
    category: 'Cache / Expiration',
    goal: 'Create an object TtlCache with set({ key, value, ttlMs }), get({ key }), pruneExpired(), and getStats().',
    expectedMethods: ['set', 'get', 'pruneExpired', 'getStats'],
  },
  {
    id: '09-currency-converter',
    name: 'CurrencyConverter',
    category: 'Calculation',
    goal: 'Create an object CurrencyConverter with setRate({ from, to, rate }), convert({ amount, from, to }), and convertMultiple({ amount, from, targets }).',
    expectedMethods: ['setRate', 'convert', 'convertMultiple'],
  },
  {
    id: '10-rate-limiter',
    name: 'RateLimiter',
    category: 'Sliding Window',
    goal: 'Create an object RateLimiter with checkLimit({ clientId, limit, windowMs }) returning { allowed, remaining, resetAt } tracking request timestamps in this.data.',
    expectedMethods: ['checkLimit', 'resetClient', 'getUsage'],
  },
  {
    id: '11-notification-pubsub',
    name: 'NotificationHub',
    category: 'PubSub Coordinator',
    goal: 'Create an object NotificationHub with subscribe({ topic, subscriberId }), unsubscribe({ topic, subscriberId }), publish({ topic, message }), and getSubscribers({ topic }).',
    expectedMethods: ['subscribe', 'unsubscribe', 'publish', 'getSubscribers'],
  },
  {
    id: '12-geo-distance',
    name: 'GeoDistanceCalculator',
    category: 'Geospatial',
    goal: 'Create an object GeoDistanceCalculator with addLocation({ name, lat, lon }), getDistance({ locA, locB, unit }), and findNearby({ lat, lon, radiusKm }).',
    expectedMethods: ['addLocation', 'getDistance', 'findNearby'],
  },
  {
    id: '13-rss-feed-normalizer',
    name: 'RssFeedNormalizer',
    category: 'Parser / Dedup',
    goal: 'Create an object RssFeedNormalizer with parseFeed({ xmlText }) that parses items into { title, link, pubDate, guid }, stores them in this.data, and filters out duplicates against known GUIDs.',
    expectedMethods: ['parseFeed', 'getRecentItems', 'clearHistory'],
  },
  {
    id: '14-bookmark-manager',
    name: 'BookmarkRepository',
    category: 'CRUD / Search',
    goal: 'Create an object BookmarkRepository with addBookmark({ url, title, tags }), searchByTags({ tags, matchAll }), updateBookmark({ id, ... }), and deleteBookmark({ id }).',
    expectedMethods: ['addBookmark', 'searchByTags', 'updateBookmark', 'deleteBookmark'],
  },
  {
    id: '15-math-evaluator',
    name: 'ExpressionEvaluator',
    category: 'Tokenizer / Interpreter',
    goal: 'Create an object ExpressionEvaluator with evaluate({ expr, vars }) supporting basic arithmetic (+, -, *, /) and variable lookup from vars dictionary.',
    expectedMethods: ['evaluate', 'validateExpression'],
  },
  {
    id: '16-temperature-logger',
    name: 'TemperatureLogger',
    category: 'Logging / Aggregation',
    goal: 'Create an object TemperatureLogger with recordTemp({ value, unit, timestamp }), convertUnit({ value, from, to }), and getHistorySummary().',
    expectedMethods: ['recordTemp', 'convertUnit', 'getHistorySummary'],
  },
  {
    id: '17-markdown-link-extractor',
    name: 'MarkdownLinkExtractor',
    category: 'Text Analysis',
    goal: 'Create an object MarkdownLinkExtractor with extractLinks({ markdown }) returning { text, url, isAnchor }[], and validateUrls({ urls }).',
    expectedMethods: ['extractLinks', 'validateUrls'],
  },
  {
    id: '18-shopping-cart',
    name: 'ShoppingCart',
    category: 'E-commerce',
    goal: 'Create an object ShoppingCart with addItem({ sku, price, qty, taxable }), applyDiscount({ code, percent }), and calculateTotal({ taxRate, shippingCost }).',
    expectedMethods: ['addItem', 'applyDiscount', 'calculateTotal', 'getSummary'],
  },
  {
    id: '19-pagination-helper',
    name: 'PaginationHelper',
    category: 'Collection Utility',
    goal: 'Create an object PaginationHelper with paginate({ items, page, pageSize }) returning { items, page, pageSize, totalItems, totalPages, hasNext, hasPrev }.',
    expectedMethods: ['paginate', 'getPageBounds'],
  },
  {
    id: '20-uptime-monitor',
    name: 'UptimeMonitor',
    category: 'Rolling Window Monitor',
    goal: 'Create an object UptimeMonitor with recordPing({ serviceId, ok, latencyMs }), getReport({ serviceId }) (uptime percentage, p95 latency), and resetHistory({ serviceId }).',
    expectedMethods: ['recordPing', 'getReport', 'resetHistory'],
  },
];

function buildUserPrompt(g: GoalSpec): string {
  return [
    `Goal: ${g.goal}`,
    `Kind: create`,
    `Target: ${g.name}`,
    `Instructions: Author the complete handler map for ${g.name}. Output ONE \`\`\`javascript code block formatted as a single parenthesized object literal ({ method(msg) { ... } }).`,
  ].join('\n');
}

export function extractCode(raw: string): string {
  const codeMatch = raw.match(/```(?:javascript|js)\s*([\s\S]*?)```/);
  return codeMatch ? codeMatch[1].trim() : raw.trim();
}

export interface DialectAnalysis {
  goalId: string;
  name: string;
  rawOutputLength: number;
  extractedCodeLength: number;
  hasFences: boolean;
  rawStartsParen: boolean;
  rawEndsParen: boolean;
  hasTrailingSemicolon: boolean;
  directParseOk: boolean;
  generateMutantsResult: {
    isNull: boolean;
    mutantCount: number;
  };
  deviations: string[];
}

export function analyzeDialect(source: string, raw: string, goalId: string, name: string): DialectAnalysis {
  const deviations: string[] = [];

  // Check raw formatting
  const hasFences = /```(?:javascript|js)/.test(raw);
  if (!hasFences) deviations.push('no_code_fence_in_raw');

  const trimmedRaw = raw.trim();
  const rawStartsParen = trimmedRaw.startsWith('(');
  const rawEndsParen = trimmedRaw.endsWith(')');
  const hasTrailingSemicolon = trimmedRaw.endsWith(';') || source.trim().endsWith(';');

  if (hasTrailingSemicolon) {
    deviations.push('trailing_semicolon');
  }
  if (!source.trim().startsWith('(')) {
    deviations.push('bare_braces_no_leading_paren');
  }
  if (!source.trim().endsWith(')')) {
    deviations.push('no_trailing_paren');
  }
  if (/^export\s+default/m.test(source)) {
    deviations.push('export_default');
  }
  if (/^module\.exports\s*=/m.test(source)) {
    deviations.push('module_exports');
  }

  // Test generateMutants
  const mutants = generateMutants(source, 12);
  const isNull = mutants === null;
  const mutantCount = mutants ? mutants.length : 0;

  if (isNull) {
    // Determine why it failed parsing
    try {
      acorn.parse(`(${source})`, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true });
    } catch (e1) {
      try {
        acorn.parse(`async function __m__(args, http) {\n${source}\n}`, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true });
      } catch (e2) {
        deviations.push(`parse_fail_both_wraps: wrap1=(${(e1 as Error).message.slice(0, 40)}), wrap2=(${(e2 as Error).message.slice(0, 40)})`);
      }
    }
  }

  return {
    goalId,
    name,
    rawOutputLength: raw.length,
    extractedCodeLength: source.length,
    hasFences,
    rawStartsParen,
    rawEndsParen,
    hasTrailingSemicolon,
    directParseOk: !isNull,
    generateMutantsResult: {
      isNull,
      mutantCount,
    },
    deviations,
  };
}

async function main() {
  if (!fs.existsSync(CORPUS_DIR)) {
    fs.mkdirSync(CORPUS_DIR, { recursive: true });
  }

  console.log(`Starting A1 Corpus generation for ${GOALS.length} goals...`);
  const provider = new AntigravityCliProvider();
  const analyses: DialectAnalysis[] = [];

  for (let i = 0; i < GOALS.length; i++) {
    const g = GOALS[i];
    const corpusFilePath = path.join(CORPUS_DIR, `${g.id}.json`);

    let raw = '';
    let extracted = '';

    if (fs.existsSync(corpusFilePath)) {
      console.log(`[${i + 1}/${GOALS.length}] Loading cached corpus for ${g.id} (${g.name})...`);
      const cached = JSON.parse(fs.readFileSync(corpusFilePath, 'utf8'));
      raw = cached.raw;
      extracted = cached.extracted;
    } else {
      console.log(`[${i + 1}/${GOALS.length}] Calling agy (code tier) for ${g.id} (${g.name})...`);
      const t0 = performance.now();
      const res = await provider.complete(
        [
          systemMessage(DRAFT_SOURCE_SYSTEM_PROMPT),
          userMessage(buildUserPrompt(g)),
        ],
        { tier: 'code', maxTokens: 16384, cacheKey: g.id }
      );
      const elapsed = Math.round(performance.now() - t0);
      raw = res.content ?? '';
      extracted = extractCode(raw);
      console.log(`  -> Completed in ${elapsed}ms (${raw.length} chars raw, ${extracted.length} chars code)`);

      fs.writeFileSync(corpusFilePath, JSON.stringify({
        goal: g,
        raw,
        extracted,
        usage: res.usage,
        elapsedMs: elapsed,
        generatedAt: new Date().toISOString(),
      }, null, 2));
    }

    const analysis = analyzeDialect(extracted, raw, g.id, g.name);
    analyses.push(analysis);
  }

  // Summary output
  const summaryFile = path.join(CORPUS_DIR, `summary.json`);
  fs.writeFileSync(summaryFile, JSON.stringify(analyses, null, 2));

  console.log('\n=== A1 Dialect Analysis Summary ===');
  console.log(`Total samples: ${analyses.length}`);
  const parseNulls = analyses.filter(a => a.generateMutantsResult.isNull);
  console.log(`Parse-null count: ${parseNulls.length} / ${analyses.length} (${((parseNulls.length / analyses.length) * 100).toFixed(1)}%)`);

  console.log('\nResults Table:');
  console.log('| ID | Goal Name | Parses? | Mutants | Deviations |');
  console.log('| :--- | :--- | :---: | :---: | :--- |');
  for (const a of analyses) {
    console.log(`| ${a.goalId} | ${a.name} | ${a.directParseOk ? '✅' : '❌'} | ${a.generateMutantsResult.mutantCount} | ${a.deviations.join(', ') || 'none'} |`);
  }

  const mutantCounts = analyses.map(a => a.generateMutantsResult.mutantCount).sort((a, b) => a - b);
  const min = mutantCounts[0];
  const max = mutantCounts[mutantCounts.length - 1];
  const mean = (mutantCounts.reduce((sum, n) => sum + n, 0) / mutantCounts.length).toFixed(2);
  const median = mutantCounts[Math.floor(mutantCounts.length / 2)];
  console.log(`\nMutant Site Distribution: min=${min}, max=${max}, median=${median}, mean=${mean}`);
}

main().catch(err => {
  console.error('Fatal error in A1:', err);
  process.exit(1);
});
