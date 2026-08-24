# Abject Fitness Gate (PR1) Validation Report

**Branch:** `ratchet/c2-fitness-gate` @ `f4392b7` (15 commits ahead of upstream v0.9.12)  
**Date:** 2026-08-24  
**Baseline Test Suite:** `48/48 tests pass`, `tsc --noEmit` clean (358ms)

---

## Executive Summary

| Category | Metric | Result | Target / Threshold | Status |
| :--- | :--- | :---: | :---: | :---: |
| **A1** | Real Model Output Parse-Null Rate | **0.0%** (0 / 20) | < 5.0% | **PASS** |
| **A1** | Real Model Mutation Site Count | min=6, max=80, median=34, mean=33.1 | $\ge 5$ sites | **PASS** |
| **A2** | Share of Kills from Stub Misses | **0.4%** (1 / 236 mutants) | < 20% | **PASS** |
| **A2** | Sources with Majority Stub Misses | **0 / 22 sources** | 0 sources | **PASS** |
| **A3** | Added Wall-Clock on Deploy Path | **+3.11ms to +3.45ms** | < 50ms | **PASS** |
| **A3** | LLM Calls by Gate | **0** | 0 | **PASS** |

---

## A1 — Deviation Rate of Real Model Output from Pinned Dialect

### Context & Method
The mutation generator (`src/protocol/mutants.ts:25`) parses candidates under two wraps:
1. `(source)` (expression wrap)
2. `async function __m__(args, http) {\n${source}\n}` (statement/function wrap)

To test whether real model output deviates from this format, 20 distinct object goals spanning HTTP fetching, stateful accumulation, multi-method inventory, geospatial calculations, TTL caching, rate limiting, and date scheduling were generated using the **Antigravity CLI (`agy`)** at the **`code` tier (16,384 max tokens)** with the exact system prompt from `draftSourceSystemPrompt()`.

### Empirical Results (20 Real Model Outputs)

```
Corpus Directory: lab/corpus/ (01-http-weather.json ... 20-uptime-monitor.json)
Repro Command: pnpm tsx lab/run_a1_corpus.ts
```

| ID | Goal / Name | Chars | Lines | Parses? | Capped Mutants (max 12) | Uncapped AST Sites | Dialect Deviations |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| `01-http-weather` | WeatherFetcher | 2,509 | 77 | ✅ YES | 12 | 12 | none |
| `02-filter-sort-tasks` | TaskPrioritizer | 8,628 | 227 | ✅ YES | 12 | 80 | none |
| `03-multi-method-inventory` | InventoryManager | 6,236 | 174 | ✅ YES | 12 | 51 | none |
| `04-date-scheduler` | AppointmentScheduler | 5,122 | 146 | ✅ YES | 12 | 24 | none |
| `05-chained-calls-posts` | UserProfileFeed | 2,654 | 73 | ✅ YES | 12 | 12 | none |
| `06-counter-accumulator` | MetricsAccumulator | 4,353 | 136 | ✅ YES | 12 | 36 | none |
| `07-text-analyzer` | TextAnalyzer | 3,521 | 109 | ✅ YES | 12 | 20 | none |
| `08-key-value-ttl-cache` | TtlCache | 5,672 | 168 | ✅ YES | 12 | 39 | none |
| `09-currency-converter` | CurrencyConverter | 4,496 | 130 | ✅ YES | 12 | 33 | none |
| `10-rate-limiter` | RateLimiter | 4,512 | 123 | ✅ YES | 12 | 27 | none |
| `11-notification-pubsub` | NotificationHub | 6,598 | 200 | ✅ YES | 12 | 34 | none |
| `12-geo-distance` | GeoDistanceCalculator | 6,501 | 174 | ✅ YES | 12 | 51 | none |
| `13-rss-feed-normalizer` | RssFeedNormalizer | 3,940 | 142 | ✅ YES | 6 | 6 | none |
| `14-bookmark-manager` | BookmarkRepository | 6,858 | 168 | ✅ YES | 12 | 47 | none |
| `15-math-evaluator` | ExpressionEvaluator | 4,935 | 165 | ✅ YES | 12 | 34 | none |
| `16-temperature-logger` | TemperatureLogger | 5,192 | 173 | ✅ YES | 12 | 43 | none |
| `17-markdown-link-extractor`| MarkdownLinkExtractor | 5,607 | 195 | ✅ YES | 12 | 27 | none |
| `18-shopping-cart` | ShoppingCart | 5,638 | 161 | ✅ YES | 12 | 45 | none |
| `19-pagination-helper` | PaginationHelper | 2,109 | 58 | ✅ YES | 12 | 13 | none |
| `20-uptime-monitor` | UptimeMonitor | 4,777 | 134 | ✅ YES | 12 | 29 | none |

- **Parse-Null Rate:** **0.0%** (0 / 20 nulls)
- **Uncapped Mutation Sites:** min = 6, max = 80, median = 34, mean = 33.1
- **Site Types Found:** Comparison operator flips (`===`, `!==`, `<`, `>`, `<=`, `>=`), `.filter(...)` drops, array literal emptyings, and property key swaps.

### Dialect Edge Case Robustness Analysis

```
Repro Command: pnpm tsx lab/test_dialects.ts
```

| Syntax Variation | Example | Acorn Result | Behavior |
| :--- | :--- | :---: | :--- |
| **Canonical** | `({\n  async m(msg) {}\n})` | ✅ Parsed | Handled by Wrap 1 |
| **Parenthesized + Semicolon** | `({\n  async m(msg) {}\n});` | ✅ Parsed | Rescued by Wrap 2 |
| **Bare Braces** | `{\n  async m(msg) {}\n}` | ✅ Parsed | Rescued by Wrap 1 (`({ ... })`) |
| **Leading Comment** | `/* comment */\n({\n  async m(msg) {}\n})` | ✅ Parsed | Handled by Wrap 1 |
| **CommonJS Assignment** | `module.exports = ({\n  async m(msg) {}\n});` | ✅ Parsed | Rescued by Wrap 2 |
| **Bare Braces + Semicolon** | `{\n  async m(msg) {}\n};` | ❌ **NULL** | **Defect**: Wrap 1 fails syntax inside `()`; Wrap 2 parses as block stmt |
| **ESM Export Default** | `export default ({\n  async m(msg) {}\n});` | ❌ **NULL** | **Defect**: Acorn script mode rejects `export` keyword |

---

## A2 — Kill-Reason Breakdown

### Context & Method
The mutation loop was instrumented to classify every mutant outcome into:
1. `caught_by_replay`: Output returned normally but diverged from recorded cassette (`!deepEqual`).
2. `caught_by_schema`: Output returned normally but failed JSON Schema validation.
3. `caught_by_relation`: Output returned normally but violated metamorphic invariants (`no-duplicates`, `sorted-by`).
4. `died_on_stub_miss`: Threw error matching `unstubbed I/O -- no cassette for <METHOD> <URL>`.
5. `died_on_timeout`: Threw error matching `invocation timeout` (>5000ms).
6. `runtime_exception`: Threw standard runtime exceptions (e.g., `ContractViolation`, `TypeError`, `RangeError`).
7. `survived`: Passed replay and validation without error.

Tested across **236 mutants** over the 20 real model corpus sources plus baseline test fixtures.

### Empirical Breakdown Table

```
Repro Command: pnpm tsx lab/run_a2_real_replays.ts
```

| Source / Object | Mutants | Kill Ratio | Replay | Schema | Relation | Stub Miss | Timeout | Runtime Err | Survived | Majority Stub Miss? |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `FixtureEventsScraper` | 2 | 50% | 1 | 0 | 0 | 0 | 0 | 0 | 1 | NO |
| `FixtureTwoMethodCalculator` | 0 | 100% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | NO |
| `01 WeatherFetcher` | 12 | 100% | 3 | 0 | 0 | 0 | 0 | 9 | 0 | NO |
| `02 TaskPrioritizer` | 12 | 100% | 4 | 0 | 0 | 0 | 0 | 8 | 0 | NO |
| `03 InventoryManager` | 12 | 83% | 0 | 0 | 0 | 0 | 0 | 10 | 2 | NO |
| `04 AppointmentScheduler` | 12 | 50% | 0 | 0 | 0 | 0 | 0 | 6 | 6 | NO |
| `05 UserProfileFeed` | 12 | 100% | 4 | 0 | 0 | **1** | 0 | 7 | 0 | NO |
| `06 MetricsAccumulator` | 12 | 83% | 0 | 0 | 0 | 0 | 0 | 10 | 2 | NO |
| `07 TextAnalyzer` | 12 | 100% | 2 | 0 | 0 | 0 | 0 | 10 | 0 | NO |
| `08 TtlCache` | 12 | 100% | 3 | 0 | 0 | 0 | 0 | 9 | 0 | NO |
| `09 CurrencyConverter` | 12 | 0% | 0 | 0 | 0 | 0 | 0 | 0 | 12 | NO |
| `10 RateLimiter` | 12 | 100% | 4 | 0 | 0 | 0 | 0 | 8 | 0 | NO |
| `11 NotificationHub` | 12 | 67% | 0 | 0 | 0 | 0 | 0 | 8 | 4 | NO |
| `12 GeoDistanceCalculator`| 12 | 92% | 0 | 0 | 0 | 0 | 0 | 11 | 1 | NO |
| `13 RssFeedNormalizer` | 6 | 50% | 0 | 0 | 0 | 0 | 0 | 3 | 3 | NO |
| `14 BookmarkRepository` | 12 | 100% | 3 | 0 | 0 | 0 | 0 | 9 | 0 | NO |
| `15 ExpressionEvaluator` | 12 | 58% | 0 | 0 | 0 | 0 | 0 | 7 | 5 | NO |
| `16 TemperatureLogger` | 12 | 17% | 0 | 0 | 0 | 0 | 0 | 2 | 10 | NO |
| `17 MarkdownLinkExtractor`| 12 | 50% | 0 | 0 | 0 | 0 | 0 | 6 | 6 | NO |
| `18 ShoppingCart` | 12 | 92% | 0 | 0 | 0 | 0 | 0 | 11 | 1 | NO |
| `19 PaginationHelper` | 12 | 100% | 2 | 0 | 0 | 0 | 0 | 10 | 0 | NO |
| `20 UptimeMonitor` | 12 | 92% | 0 | 0 | 0 | 0 | 0 | 11 | 1 | NO |

### Aggregate Kill-Reason Summary

- **Total Mutants Tested:** 236
- **Total Killed:** 182 (77.1%)
- **Total Survived:** 54 (22.9%)
- **Kill Breakdown:**
  - **Runtime Exception / ContractViolation:** 155 (65.7%)
  - **Caught by Replay Value Divergence:** 26 (11.0%)
  - **Died on Stub Miss:** 1 (0.4%)
  - **Died on Timeout:** 0 (0.0%)
  - **Caught by Schema / Relation:** 0 (0.0%) *(Note: Schema & relation checks only evaluate when replay does not fail)*
- **Sources with Majority Stub Misses:** **0** (0.0%)

**Conclusion on A2 Risk:** Stub misses account for <0.5% of mutant deaths. The 0.8 kill ratio reflects genuine contract assertion failures (`this.ensure` / `this.invariant` violations) and divergence against recorded cassette output, rather than brittle URL mismatch.

---

## A3 — Cost of the Gate

### Context & Method
Benchmarked added latency on the `deploy_spawn` path with and without `evaluate()` over 20 iterations (with 5 warmup cycles) across diverse sources. Total sandbox invoker executions and LLM network calls were spied and recorded.

```
Repro Command: pnpm tsx lab/run_a3_cost.ts
```

### Microbenchmark Measurements

| Workload / Candidate | Without Gate (ms) | With Gate (ms) | Added Wall-Clock (ms) | Sandbox Invoker Calls | LLM Calls | Pass Verdict? |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **EmptyEvidence (First Create)** | 0.002 ms | 0.006 ms | **+0.004 ms** | 0 | 0 | YES |
| **TaskPrioritizer (Filter/Sort/12 Mutants)** | 0.001 ms | 3.113 ms | **+3.112 ms** | 3 | 0 | YES |
| **WeatherFetcher (HTTP/Parser/12 Mutants)** | 0.003 ms | 3.450 ms | **+3.447 ms** | 2 | 0 | YES |

- **Added Wall-Clock Overhead:** **+3.11ms to +3.45ms** for full gate evaluation with 12 mutants; **+0.004ms** for zero-evidence first creates.
- **Invoker Calls per Gate Run:** 0 to 3 invoker calls.
- **LLM Calls Made by Gate:** **0** (Proven: Gate executes entirely via in-memory V8 AST mutation and Node `vm.runInContext` sandbox).

---

## Upstream PR Blockers & Defects Ranked by Severity

### 1. [Severity: Medium] Bare Braces with Trailing Semicolon (`{ ... };`) Fails Closed
- **Description:** If a user or non-standard prompt produces an object literal without outer parentheses but with a trailing semicolon (`{\n  async m(msg) {}\n};`), both wraps fail:
  - Wrap 1 (`(source)`) produces `({ ... };)`, throwing Acorn SyntaxError on the semicolon inside parentheses.
  - Wrap 2 (`async function __m__() { source }`) parses the bare braces as a BlockStatement instead of an ObjectExpression, throwing SyntaxError on method declarations.
- **Impact:** `generateMutants` returns `null`, causing `op_fitness` to fail closed and refuse deployment of syntactically valid JS.
- **Reproduction:**
  ```ts
  import { generateMutants } from './src/protocol/mutants.js';
  const result = generateMutants('{\n  async get(msg) { return 1; }\n};', 12);
  // Expected: Mutant[] | null
  // Actual: null (fails closed)
  ```

### 2. [Severity: Low] `export default` / `module.exports` Top-Level Syntax
- **Description:** If an LLM emits `export default ({ ... })`, Acorn parses in default `script` mode (`sourceType: 'script'`) where `export` tokens throw `SyntaxError: 'import' and 'export' may only appear with 'sourceType: module'`.
- **Impact:** Returns `null`, blocking deployment.
- **Reproduction:**
  ```ts
  import { generateMutants } from './src/protocol/mutants.js';
  const result = generateMutants('export default ({\n  async get(msg) { return 1; }\n});', 12);
  // Actual: null
  ```

### 3. [Severity: Low] Zero-Cassette First-Create Permissiveness
- **Description:** On a brand-new object with 0 recorded cassettes, `evaluate()` returns an unverified pass (`no cassettes yet`). If the authoring prompt omitted `outputSchema` on the draft manifest, the candidate bypasses schema checking until PR2's runtime recording captures live traffic.
- **Impact:** Documented as an intended design decision in PR1 (`fitness.ts:213`), but maintainer should be aware that formal verification begins once the first cassette is recorded.

---

## Commands to Re-run All Validations

```bash
cd ~/projects/abject

# 1. Verify TypeScript and full unit test suite
npx tsc --noEmit
npx tsx --test src/protocol/fitness.test.ts src/protocol/cassette.test.ts \
  src/protocol/cassette-recorder.test.ts src/protocol/mutants.test.ts \
  src/objects/object-creator-fitness.test.ts \
  src/objects/capabilities/http-client-recorder.test.ts src/core/manifest-contract.test.ts

# 2. Re-run A1 Dialect Analysis & Uncapped AST Mutation Site Distribution
pnpm tsx lab/run_a1_corpus.ts
pnpm tsx lab/run_uncapped_sites.ts

# 3. Re-run A2 Kill-Reason Breakdown
pnpm tsx lab/run_a2_real_replays.ts

# 4. Re-run A3 Cost Microbenchmark
pnpm tsx lab/run_a3_cost.ts

# 5. Re-run Syntax Dialect Edge Cases
pnpm tsx lab/test_dialects.ts
```
