import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { ScrumMaster } from './scrum-master.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Synthesis fixture',
      interface: { id: `fixture:${name}`, name, description: 'fixture', methods: [] } } });
  }
  public override on(method: string, fn: MessageHandlerFn): void { super.on(method, fn); }
  call(to: AbjectId, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id, to, method, payload), 2000); }
}
class Scrum extends ScrumMaster { protected override async onInit(): Promise<void> {} }

const run = (command: string, at: number, tests: number, passed: number) =>
  ({ command, exitCode: 0, at, passed: true, testSummary: { tests, passed, failed: tests - passed }, newFailures: 0, foreignFailures: 0, preExisting: 0 });

/** Two rounds: an implementation task that saw 285 tests, then a test task that added five and saw 290. */
function scratchpad() {
  return {
    'implementation/browser': 'Implemented inline editing. `pnpm test` → exit 0, 285 tests / 285 passed / 0 failed.',
    'verification/impl-task': { taskId: 'impl-task', agent: 'ExternalCreator', project: 'abjects', at: 1000, outcome: 'complete',
      filesModified: 1, mutationsSinceVerify: 0, gate: { ok: true, note: 'verified' }, verify: run('pnpm test', 900, 285, 285) },
    'verification/test-task': { taskId: 'test-task', agent: 'ExternalCreator', project: 'abjects', at: 2000, outcome: 'complete',
      filesModified: 1, mutationsSinceVerify: 0, gate: { ok: true, note: 'verified' }, verify: run('pnpm test', 1900, 290, 290) },
    'verification/test-results': 'pnpm typecheck exit 0; pnpm test exit 0 with 290/290 passing. Not covered: layout at window size.',
  };
}

test('a synthesis that quotes a stale test count is corrected once against the newest receipt', async () => {
  const bus = new MessageBus(), registry = new Registry(); await registry.init(bus);
  const objects: Abject[] = [registry];
  const add = async <T extends Abject>(o: T): Promise<T> => { o.setRegistryHint(registry.id); await o.init(bus); registry.registerObject(o.id, o.manifest); objects.push(o); return o; };
  try {
    const goals = await add(new Endpoint('GoalManager')), llm = await add(new Endpoint('LLMObject'));
    const scrum: any = await add(new Scrum()); scrum.goalManagerId = goals.id; scrum.llmId = llm.id;
    goals.on('getGoal', () => ({ title: 'Editable configuration', description: 'Make it editable', scratchpad: scratchpad(),
      scratchpadUpdatedAt: { 'implementation/browser': 1000, 'verification/test-results': 2000 } }));
    const prompts: string[] = [];
    llm.on('complete', msg => {
      const prompt = (msg.payload as any).messages[0].content as string; prompts.push(prompt);
      return { content: prompts.length === 1
        ? '### Done\n- pnpm test passed 285/285 tests with zero regressions.'
        : '### Done\n- pnpm test passed 290/290 tests with zero regressions.' };
    });
    const text = await scrum.synthesizeCompletionText('goal-1');
    assert.equal(prompts.length, 2, 'one draft, one correction');
    assert.match(prompts[0], /Verification record[\s\S]*NEWEST — ExternalCreator test-tas[\s\S]*290 passed of 290/);
    assert.ok(prompts[0].indexOf('implementation/browser') < prompts[0].indexOf('verification/test-results'), 'oldest scratchpad entry first');
    assert.match(prompts[0], /newest run supersedes/);
    assert.match(prompts[1], /Discrepancy: text quotes 285, a count from an older run/);
    assert.match(prompts[1], /Change nothing else/);
    assert.match(text, /290\/290/);
  } finally { for (const o of objects.reverse()) await o.stop(); }
});

test('a synthesis that agrees with the record is used as written', async () => {
  const bus = new MessageBus(), registry = new Registry(); await registry.init(bus);
  const objects: Abject[] = [registry];
  const add = async <T extends Abject>(o: T): Promise<T> => { o.setRegistryHint(registry.id); await o.init(bus); registry.registerObject(o.id, o.manifest); objects.push(o); return o; };
  try {
    const goals = await add(new Endpoint('GoalManager')), llm = await add(new Endpoint('LLMObject'));
    const scrum: any = await add(new Scrum()); scrum.goalManagerId = goals.id; scrum.llmId = llm.id;
    goals.on('getGoal', () => ({ title: 't', description: 'd', scratchpad: scratchpad() }));
    let calls = 0;
    llm.on('complete', () => { calls++; return { content: 'All 290 tests pass.\n\n**Not verified**: layout at window size.' }; });
    const text = await scrum.synthesizeCompletionText('goal-1');
    assert.equal(calls, 1);
    assert.match(text, /290 tests/);
  } finally { for (const o of objects.reverse()) await o.stop(); }
});
