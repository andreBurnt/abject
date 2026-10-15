/**
 * The replay check and its honesty rules. Runs on Node's built-in runner:
 *   pnpm tsx --test src/protocol/fitness.test.ts
 *
 * The invoker here is a plain in-process function: the source is the body of
 * an `async (args, call) => value` function. The worker-thread invoker the
 * judge really uses has its own tests in sandbox-invoker.test.ts; these stay
 * on the check itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, replay, stubFor, usableRecordings, summarizeVerdict,
  type Invoker, type InvocationRecording } from './fitness.js';

const testInvoker: Invoker = async (source, _method, args, stub) => {
  const call = async (target: string, method: string, payload?: unknown) => {
    const hit = stub({ target, method, payloadText: JSON.stringify(payload ?? {}) });
    if (!hit) throw new Error(`fitness: unrecorded call -- call('${target}', '${method}')`);
    if ('errorText' in hit) throw new Error(hit.errorText);
    return JSON.parse(hit.replyText);
  };
  const fn = new Function('args', 'call', `"use strict"; return (async () => { ${source} })();`);
  return fn(args, call);
};

const events = [{ id: 1, name: 'Weekly Standup' }, { id: 2, name: 'Retro' }];
const httpReply = { status: 200, statusText: 'OK', headers: {}, body: JSON.stringify(events), ok: true };

/** The live object was called listEvents({q:'all'}); it asked HttpClient and returned the names. */
const recording: InvocationRecording = {
  method: 'listEvents', argsText: JSON.stringify({ q: 'all' }),
  calls: [{ target: 'HttpClient', method: 'get',
    payloadText: JSON.stringify({ url: 'https://example.test/events?q=all' }),
    replyText: JSON.stringify(httpReply) }],
  resultText: JSON.stringify(events.map(e => e.name)),
  at: 1,
};

const FAITHFUL = `
  const res = await call('HttpClient', 'get', { url: 'https://example.test/events?q=' + args.q });
  return JSON.parse(res.body).map(e => e.name);
`;
const BROKEN = `
  const res = await call('HttpClient', 'get', { url: 'https://example.test/events?q=' + args.q });
  return JSON.parse(res.body).map(e => e.id);
`;

test('a candidate that reproduces the recording passes, verified', async () => {
  const v = await evaluate({ source: FAITHFUL }, { invocations: [recording] }, testInvoker);
  assert.equal(v.pass, true);
  assert.equal(v.replay.verified, true);
  assert.equal(v.replay.reproduced, 1);
  assert.match(v.summary, /^fitness: PASS — 1 recording reproduced/);
});

test('a candidate that contradicts the recording fails, and the failure names the divergence', async () => {
  const v = await evaluate({ source: BROKEN }, { invocations: [recording] }, testInvoker);
  assert.equal(v.pass, false);
  assert.equal(v.replay.verified, true);
  assert.match(v.replay.failures[0], /listEvents\(.*\) returned \[1,2\] where the live object returned \["Weekly Standup","Retro"\]/);
  assert.match(v.summary, /^fitness: FAIL/);
});

test('no recordings is an unverified pass that invokes nothing', async () => {
  const neverInvoked: Invoker = async () => { throw new Error('probed a candidate with no evidence'); };
  const v = await evaluate({ source: BROKEN }, { invocations: [] }, neverInvoked);
  assert.equal(v.pass, true);
  assert.equal(v.replay.verified, false);
  assert.equal(v.summary, 'fitness: unverified — no invocations recorded for this object');
});

test('an unrecorded outbound call is a contradiction, not a wildcard', async () => {
  const phonesElsewhere = `
    const res = await call('WebFetch', 'fetch', { url: 'https://example.test/events?q=' + args.q });
    return res.names;
  `;
  const v = await evaluate({ source: phonesElsewhere }, { invocations: [recording] }, testInvoker);
  assert.equal(v.pass, false);
  assert.match(v.replay.failures[0], /unrecorded call -- call\('WebFetch', 'fetch'\)/);
});

test('the stub is exact on payload: a different question gets no recorded answer', () => {
  const stub = stubFor(recording);
  assert.ok(stub({ target: 'HttpClient', method: 'get', payloadText: '{"url":"https://example.test/events?q=all"}' }));
  assert.equal(stub({ target: 'HttpClient', method: 'get', payloadText: '{"url":"https://example.test/events?q=mine"}' }), undefined);
  assert.equal(stub({ target: 'HttpClient', method: 'get', payloadText: '{}' }), undefined, 'omitting the payload is a miss');
  // key order is accident, not meaning
  const reordered: InvocationRecording = { ...recording, calls: [{ ...recording.calls[0],
    payloadText: '{"url":"https://example.test/events?q=all","headers":{"b":1,"a":2}}' }] };
  assert.ok(stubFor(reordered)({ target: 'HttpClient', method: 'get',
    payloadText: '{"headers":{"a":2,"b":1},"url":"https://example.test/events?q=all"}' }));
});

test('a recorded error is replayed as an error', async () => {
  const errored: InvocationRecording = {
    method: 'listEvents', argsText: '{"q":"all"}',
    calls: [{ target: 'HttpClient', method: 'get', payloadText: '{"url":"https://example.test/events?q=all"}',
      errorText: 'HTTP_ERROR: connection refused' }],
    resultText: JSON.stringify([]), at: 1,
  };
  const swallows = `
    try { await call('HttpClient', 'get', { url: 'https://example.test/events?q=' + args.q }); }
    catch (err) { return []; }
    return ['unreachable'];
  `;
  const v = await evaluate({ source: swallows }, { invocations: [errored] }, testInvoker);
  assert.equal(v.pass, true);
  assert.equal(v.replay.verified, true);
});

test('recordings that cannot be replayed faithfully are set aside, and the verdict says why', async () => {
  const truncated: InvocationRecording = { ...recording, truncated: true };
  const threw: InvocationRecording = { ...recording, resultText: undefined, errorText: 'boom' };
  const halfRecorded: InvocationRecording = { ...recording,
    calls: [{ target: 'HttpClient', method: 'get', payloadText: '{}' }] }; // neither reply nor error
  assert.deepEqual(usableRecordings({ invocations: [truncated, threw, halfRecorded] }), []);
  const v = await evaluate({ source: BROKEN }, { invocations: [truncated, threw] }, testInvoker);
  assert.equal(v.pass, true);
  assert.equal(v.replay.verified, false);
  assert.match(v.summary, /no recording is complete enough to replay/);
  assert.equal(v.evidence.recordings, 2);
  assert.equal(v.evidence.usable, 0);
});

test('usable recordings are capped per method, newest first', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...recording, at: i }));
  const kept = usableRecordings({ invocations: many }, 10);
  assert.equal(kept.length, 10);
  assert.deepEqual(kept.map(r => r.at), [29, 28, 27, 26, 25, 24, 23, 22, 21, 20]);
});

test('evidence the live source itself contradicts is not held against the draft', async () => {
  // The recording carries a timestamp the handler computed at record time.
  // Neither the live source nor any draft can reproduce it; a judge that
  // failed the draft here would be blaming it for the clock.
  const stamped: InvocationRecording = { method: 'now', argsText: '{}', calls: [],
    resultText: JSON.stringify({ at: 1700000000000 }), at: 1 };
  const clock = `return { at: Date.now() };`;
  const withoutControl = await evaluate({ source: clock }, { invocations: [stamped] }, testInvoker);
  assert.equal(withoutControl.pass, false, 'without the live source there is nothing to excuse the mismatch');
  const withControl = await evaluate({ source: clock }, { invocations: [stamped] }, testInvoker,
    { liveSource: clock });
  assert.equal(withControl.pass, true);
  assert.equal(withControl.replay.verified, false);
  assert.equal(withControl.evidence.deterministic, 0);
  assert.match(withControl.summary, /live source reproduces none of its 1 recording — not deterministic, or not replayable by this harness/);
});

test('the control keeps the deterministic recordings and judges the draft on those', async () => {
  const stamped: InvocationRecording = { method: 'now', argsText: '{}', calls: [],
    resultText: JSON.stringify({ at: 1700000000000 }), at: 2 };
  const liveSource = `if (args.which === 'now') return { at: Date.now() }; return args.n + 1;`;
  const inc: InvocationRecording = { method: 'inc', argsText: '{"n":1}', calls: [], resultText: '2', at: 1 };
  const draftBreaksInc = `if (args.which === 'now') return { at: Date.now() }; return args.n - 1;`;
  const v = await evaluate({ source: draftBreaksInc }, { invocations: [stamped, inc] }, testInvoker,
    { liveSource });
  assert.equal(v.evidence.usable, 2);
  assert.equal(v.evidence.deterministic, 1);
  assert.equal(v.pass, false, 'the deterministic recording still convicts the draft');
  assert.match(v.replay.failures[0], /inc\(\{"n":1\}\) returned 0 where the live object returned 2/);
});

test('replay() reports counts, not just a boolean', async () => {
  const r = await replay(BROKEN, [recording, { ...recording, at: 2 }], testInvoker);
  assert.equal(r.judged, 2);
  assert.equal(r.reproduced, 0);
  assert.equal(r.failures.length, 2);
  assert.equal(r.detail, '2 of 2 recordings contradicted');
});

test('redaction is applied to BOTH sides: a secret-named field matches when scrubbed, a real change is still caught', async () => {
  // The recorder scrubs secret-named fields at record time, so the stored
  // outbound payload and result carry REDACTED. The candidate's values are
  // raw. Without redacting the candidate side too, an apiKey/sessionId field
  // could never match and a faithful draft would be convicted.
  const rec: InvocationRecording = {
    method: 'save', argsText: '{"n":1}',
    calls: [{ target: 'Storage', method: 'set', payloadText: '{"apiKey":"REDACTED","value":1}', replyText: 'true' }],
    resultText: '{"sessionId":"REDACTED","ok":true}', at: 1,
  };
  const faithful = `
    await call('Storage', 'set', { apiKey: 'sk-live-xyz', value: args.n });
    return { sessionId: 'tok-' + args.n, ok: true };
  `;
  const v = await evaluate({ source: faithful }, { invocations: [rec] }, testInvoker);
  assert.equal(v.pass, true, v.summary);
  assert.equal(v.replay.verified, true);
  // A divergence in a NON-secret field is still caught.
  const changesOk = `
    await call('Storage', 'set', { apiKey: 'sk-live-xyz', value: args.n });
    return { sessionId: 'tok-' + args.n, ok: false };
  `;
  const bad = await evaluate({ source: changesOk }, { invocations: [rec] }, testInvoker);
  assert.equal(bad.pass, false, 'ok:false vs ok:true is a real contradiction');
});

test('replay stops early once maxFailures contradictions are found', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ ...recording, at: i }));
  const r = await replay(BROKEN, many, testInvoker, 3);
  assert.equal(r.failures.length, 3, 'collected exactly the reportable number');
  assert.equal(r.judged, 3, 'stopped after the third, did not replay all eight');
  assert.equal(r.pass, false);
});

test('the summary line is built from the flags, not the wording', () => {
  assert.equal(summarizeVerdict({ pass: true,
    replay: { pass: true, verified: false, judged: 0, reproduced: 0, failures: [], detail: 'anything' },
    evidence: { recordings: 0, usable: 0, detail: '' }, summary: '' }), 'fitness: unverified — anything');
  assert.equal(summarizeVerdict({ pass: false,
    replay: { pass: false, verified: true, judged: 1, reproduced: 0, failures: ['f(x) threw: boom'], detail: '1 of 1 recording contradicted' },
    evidence: { recordings: 1, usable: 1, detail: '' }, summary: '' }), 'fitness: FAIL — 1 of 1 recording contradicted: f(x) threw: boom');
});

test('a pass says how many recordings the control set aside', async () => {
  // "1 recording reproduced" must not read the same for 1 of 1 and 1 of 50.
  const stamped: InvocationRecording = { method: 'now', argsText: '{}', calls: [],
    resultText: JSON.stringify({ at: 1700000000000 }), at: 2 };
  const inc: InvocationRecording = { method: 'inc', argsText: '{"n":1}', calls: [], resultText: '2', at: 1 };
  const liveSource = `if (args.which === 'now') return { at: Date.now() }; return args.n + 1;`;
  const v = await evaluate({ source: liveSource }, { invocations: [stamped, inc] }, testInvoker, { liveSource });
  assert.equal(v.pass, true);
  assert.equal(v.summary, 'fitness: PASS — 1 recording reproduced (1 of 2 excluded by the control)');
  const all = await evaluate({ source: liveSource }, { invocations: [inc] }, testInvoker, { liveSource });
  assert.equal(all.summary, 'fitness: PASS — 1 recording reproduced', 'nothing excluded, nothing said');
});

/** An invoker whose every invocation is cut off the way a disposed worker
 *  cuts one off: it waits past the deadline, then rejects. */
function cutOffAt(deadline: number, calls: { n: number }): Invoker {
  return async () => {
    calls.n++;
    await new Promise(r => setTimeout(r, Math.max(0, deadline - Date.now()) + 20));
    throw new Error('fitness: invoker disposed');
  };
}

test('a deadline that passes during replay is unverified, never a contradiction, and stops the replay', async () => {
  const deadline = Date.now() + 30;
  const calls = { n: 0 };
  const many = Array.from({ length: 5 }, (_, i) => ({ ...recording, at: i }));
  const v = await evaluate({ source: BROKEN }, { invocations: many }, cutOffAt(deadline, calls), { deadline });
  assert.equal(v.pass, true, 'an invocation cut off by the deadline is not the draft\'s doing');
  assert.equal(v.replay.verified, false);
  assert.match(v.summary, /^fitness: unverified — judgment abandoned: the caller's deadline passed during replay$/);
  assert.equal(calls.n, 1, 'no recording is replayed after the deadline');
});

test('a deadline that passes during the control run is unverified too', async () => {
  const deadline = Date.now() + 30;
  const calls = { n: 0 };
  const many = Array.from({ length: 5 }, (_, i) => ({ ...recording, at: i }));
  const v = await evaluate({ source: BROKEN }, { invocations: many }, cutOffAt(deadline, calls),
    { deadline, liveSource: FAITHFUL });
  assert.equal(v.pass, true);
  assert.match(v.summary, /judgment abandoned: the caller's deadline passed during the control run$/);
  assert.equal(calls.n, 1);
});

test('the name-based scrub also blinds replay to an ordinary field named key (disclosed, not fixed)', async () => {
  // Recorded at record time as REDACTED: the value is gone, so it cannot be compared.
  const rec: InvocationRecording = { method: 'sortKey', argsText: '{}', calls: [],
    resultText: '{"key":"REDACTED","value":1}', at: 1 };
  const v = await evaluate({ source: `return { key: 'wrong', value: 1 };` }, { invocations: [rec] }, testInvoker);
  assert.equal(v.pass, true, 'a wrong key value passes');
  const caught = await evaluate({ source: `return { key: 'wrong', value: 2 };` }, { invocations: [rec] }, testInvoker);
  assert.equal(caught.pass, false, 'a wrong value field is still caught');
});
