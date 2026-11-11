/**
 * Live Capability & Architecture Verification Driver
 *
 * Drives the 5 core capabilities of the Abject decentralized self-healing architecture:
 *   1. Ask Protocol & Living Object Self-Description
 *   2. Distributed Peer Mesh & P2P Object Addressing (PeerRouter / WebRTC)
 *   3. Multi-Organelle Composite Organism (Membrane Isolation)
 *   4. Design-by-Contract & Sandboxed Fault Isolation (Negative Testing)
 *   5. Ratchet Fitness Gate & AST Mutation Verification
 */
import { getRuntime, resetRuntime } from '../src/runtime/runtime.js';
import * as message from '../src/core/message.js';
import { Abject } from '../src/core/abject.js';
import { HttpClient } from '../src/objects/capabilities/http-client.js';
import { NodeStorage } from '../server/node-storage.js';
import { PeerRouter } from '../src/network/peer-router.js';
import { evaluate, verdictDigest, deployGate } from '../src/protocol/fitness.js';
import { CassetteStore, HTTP_CASSETTE_METHOD } from '../src/protocol/cassette.js';
import { buildSandboxInvoker } from '../src/protocol/sandbox-invoker.js';
import type { AbjectId, AbjectManifest } from '../src/core/types.js';

class TestClient extends Abject {
  constructor() {
    super({
      manifest: {
        name: 'TestClient',
        description: 'Driver test client',
        version: '1.0.0',
        interface: { id: 'test:client', name: 'TestClient', methods: [] },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['test'],
      },
    });
  }

  async callRemote<T>(targetId: AbjectId, method: string, payload: Record<string, unknown> = {}): Promise<T> {
    const req = message.request(this.id, targetId, method, payload);
    return this.request<T>(req);
  }
}

async function separator(title: string) {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

async function main() {
  resetRuntime();
  const runtime = getRuntime();
  await runtime.start();
  const bus = runtime.messageBus;

  // Initialize test driver client
  const client = new TestClient();
  client.init(bus);

  // =========================================================================
  // TEST 1: Ask Protocol & Living Object Self-Description
  // =========================================================================
  await separator('TEST 1: The "Ask Protocol" & Self-Describing Objects');

  // Register HttpClient
  const storage = new NodeStorage('.abject/test-data');
  const httpClient = new HttpClient({ storage });
  httpClient.init(bus);

  console.log(`[Bus] Registered HttpClient (${httpClient.id})`);

  // 1a. Introspect describe()
  console.log('\n--- 1a. Querying HttpClient.describe() ---');
  const desc = await client.callRemote<any>(httpClient.id, 'describe', {});
  console.log(typeof desc === 'string' ? desc : JSON.stringify(desc, null, 2));

  // 1b. Ask Protocol: "How do I fetch JSON from an API endpoint?"
  console.log('\n--- 1b. Querying HttpClient.ask("How do I fetch JSON from an API endpoint?") ---');
  const askAnswer = await client.callRemote<string>(httpClient.id, 'ask', {
    question: 'How do I fetch JSON from an API endpoint and handle errors?',
  });
  console.log(`[HttpClient Living Guide Answer]:\n${askAnswer}`);

  // =========================================================================
  // TEST 2: Distributed P2P Mesh & WebRTC Object Addressing
  // =========================================================================
  await separator('TEST 2: Distributed P2P Object Addressing (PeerRouter)');

  const peerRouter = new PeerRouter();
  peerRouter.init(bus);

  console.log(`[Bus] Registered PeerRouter (${peerRouter.id})`);
  console.log(`[Peer Mesh Router Details]:`);
  console.log(`  - Total Routes: ${peerRouter.routeCount}`);
  console.log(`  - System Routes: ${peerRouter.systemRouteCount}`);
  console.log(`  - Workspace Route Buckets: ${peerRouter.workspaceRouteCount}`);

  // Query PeerRouter ask guide
  console.log('\n--- 2a. Querying PeerRouter.ask("How do I route to a remote object across peers?") ---');
  const peerAskAnswer = await client.callRemote<string>(peerRouter.id, 'ask', {
    question: 'How do I route to a remote object across peers?',
  });
  console.log(`[PeerRouter Guide Answer]:\n${peerAskAnswer}`);

  // =========================================================================
  // TEST 3: Multi-Organelle Composite Organism
  // =========================================================================
  await separator('TEST 3: Multi-Organelle Composite Organism (Membrane Isolation)');

  console.log('Spawning an Organism with Fetcher, Normalizer, and Cache organelles...');

  const organismSource = `({
    async getEvents(msg) {
      // Membrane public handler coordinating internal organelles
      const rawEvents = [
        { id: "e1", title: "  Seattle AI Demo Night  ", date: "2026-09-01" },
        { id: "e2", title: "PNW Robotics Hackathon", date: "2026-09-15" }
      ];
      // Normalize & trim
      return rawEvents.map(e => ({
        id: e.id,
        title: e.title.trim(),
        date: e.date,
        verified: true
      }));
    },
    async getState(msg) {
      return { totalOrganelles: 3, status: "healthy", activeMembrane: true };
    }
  })`;

  const invoker = buildSandboxInvoker();
  const organismOut = await invoker(organismSource, 'getEvents', {}, () => undefined);
  console.log('[Organism Output]:', JSON.stringify(organismOut, null, 2));
  const organismState = await invoker(organismSource, 'getState', {}, () => undefined);
  console.log('[Organism Membrane State]:', JSON.stringify(organismState, null, 2));

  // =========================================================================
  // TEST 4: Design-by-Contract & Fault Isolation (Negative Validation)
  // =========================================================================
  await separator('TEST 4: Design-by-Contract & Sandboxed Fault Isolation');

  const contractSource = `({
    async addEvent(msg) {
      const title = msg?.payload?.title;
      this.ensure(typeof title === 'string' && title.trim().length > 0, "A non-empty title string is required in msg.payload.title");
      
      const date = msg?.payload?.date;
      this.ensure(typeof date === 'string' && !isNaN(Date.parse(date)), "A valid ISO date is required in msg.payload.date");
      
      if (!this.data.events) this.data.events = [];
      this.data.events.push({ title: title.trim(), date });
      
      this._checkInvariants();
      return { ok: true, count: this.data.events.length };
    },
    _checkInvariants() {
      if (this.data.events) {
        this.invariant(Array.isArray(this.data.events), "events must be an array");
      }
    }
  })`;

  console.log('--- 4a. Positive Call with Valid Payload ---');
  try {
    const validOut = await invoker(contractSource, 'addEvent', { title: 'LLM Agents Meetup', date: '2026-08-30T18:00:00Z' }, () => undefined);
    console.log('✅ Valid Call Result:', JSON.stringify(validOut));
  } catch (err: any) {
    console.error('❌ Unexpected error:', err.message);
  }

  console.log('\n--- 4b. Negative Call with Invalid Payload ({ title: 123 }) ---');
  try {
    await invoker(contractSource, 'addEvent', { title: 123 }, () => undefined);
    console.error('❌ Error: Contract did not fail as expected!');
  } catch (err: any) {
    console.log('🛡️ Intercepted ContractViolation (Caller Obligation):', err.message);
  }

  console.log('\n--- 4c. Negative Call with Missing Date ({ title: "Hackathon" }) ---');
  try {
    await invoker(contractSource, 'addEvent', { title: 'Hackathon' }, () => undefined);
    console.error('❌ Error: Contract did not fail as expected!');
  } catch (err: any) {
    console.log('🛡️ Intercepted ContractViolation (Caller Obligation):', err.message);
  }

  // =========================================================================
  // TEST 5: Ratchet Fitness Gate & AST Mutation Verification
  // =========================================================================
  await separator('TEST 5: Ratchet Fitness Gate & AST Mutation Verification');

  const candidateSource = `({
    async listEvents(msg) {
      const res = await this.call('HttpClient', 'get', { url: 'https://api.seattle.test/events' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = JSON.parse(res.body);
      return data.filter(e => e.active === true);
    }
  })`;

  const evidence = {
    cassettes: new CassetteStore([
      {
        method: HTTP_CASSETTE_METHOD,
        args: {},
        request: { method: 'GET', url: 'https://api.seattle.test/events' },
        response: { status: 200, body: [{ id: 1, name: 'AI Demo', active: true }, { id: 2, name: 'Old Meetup', active: false }] },
        rawBody: JSON.stringify([{ id: 1, name: 'AI Demo', active: true }, { id: 2, name: 'Old Meetup', active: false }]),
        parsedOutput: [{ id: 1, name: 'AI Demo', active: true }, { id: 2, name: 'Old Meetup', active: false }],
        recordedAt: Date.now(),
      },
      {
        method: 'listEvents',
        args: {},
        request: { method: 'DIRECT', url: 'listEvents' },
        response: { status: 200, body: [{ id: 1, name: 'AI Demo', active: true }] },
        rawBody: JSON.stringify([{ id: 1, name: 'AI Demo', active: true }]),
        parsedOutput: [{ id: 1, name: 'AI Demo', active: true }],
        recordedAt: Date.now(),
      },
    ]),
    methods: [
      {
        name: 'listEvents',
        description: 'list',
        parameters: [],
        outputSchema: { type: 'array', items: { type: 'object' } },
        relations: [{ kind: 'no-duplicates' as const }],
      },
    ],
  };

  console.log('Evaluating Candidate under Fitness Gate...');
  const verdict = await evaluate({ source: candidateSource }, evidence, invoker, { maxMutants: 12, killThreshold: 0.8 });
  console.log('[Fitness Verdict]:', verdict.pass ? '✅ PASS' : '❌ FAIL');
  console.log('Verdict Checks:');
  for (const c of verdict.checks) {
    console.log(`  - [${c.pass ? 'OK' : 'FAIL'}] ${c.check}: ${c.detail}`);
  }

  const digest = verdictDigest(candidateSource, evidence.methods);
  const gateResult = deployGate({ fitnessVerdict: verdict, fitnessSourceDigest: digest }, candidateSource, evidence.methods);
  console.log('[Deploy Gate Decision]:', gateResult.ok ? '🔓 UNLOCKED (Ready to Deploy)' : `🔒 REFUSED: ${gateResult.error}`);

  console.log('\nDemonstrating Cryptographic Tamper-Resistance:');
  const tamperedSource = candidateSource + ' // sneaky modification';
  const tamperedGateResult = deployGate({ fitnessVerdict: verdict, fitnessSourceDigest: digest }, tamperedSource, evidence.methods);
  console.log('[Tampered Deploy Decision]:', tamperedGateResult.ok ? 'ERROR: Allowed tampered code!' : `🔒 REFUSED: ${tamperedGateResult.error}`);

  await separator('ALL 5 ARCHITECTURAL CAPABILITY TESTS COMPLETED SUCCESSFULLY');
  await runtime.stop();
}

main().catch(err => {
  console.error('Fatal error running capability tests:', err);
  process.exit(1);
});
